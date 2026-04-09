"use strict";

const crypto = require("crypto");
const config = require("./config");
const TradeTicket = require("../models/TradeTicket");
const CloseAttempt = require("../models/CloseAttempt");
const MonitorLease = require("../models/MonitorLease");
const SystemSetting = require("../models/SystemSetting");

// ---------------------------------------------------------------------------
// In-memory state (exposed for /system observability)
// ---------------------------------------------------------------------------
const monitorState = {
  enabled: config.AUTO_MODE_ENABLED,
  leaseOwnerId: crypto.randomUUID(),
  leaseHeld: false,
  leaseExpiresAt: null,
  lastLoopAt: null,
  lastLoopDurationMs: null,
  backoffMs: 0,
  lastError: null,
  lastErrorAt: null,
  openMonitored: 0,
  intentsToday: 0,
  closesToday: 0,
  failuresToday: 0,
  counterResetDate: todayDateStr(),
  running: false,

  // Per-tick diagnostic counters (reset each tick)
  lastTickBatchSize: 0,
  lastTickPriceOk: 0,
  lastTickPriceNull: 0,
  lastTickPriceError: 0,
  lastTickCooldownSkip: 0,
  lastTickTriggerHit: 0,
  lastTickTriggerMiss: 0,
  lastTickDebounceHold: 0,
  lastTickCloseAttempt: 0,
  lastTickIdentitySkip: 0,         // tickets skipped: missing valid conditionId
  // Sample: first null-price ticket per tick for debugging
  lastTickNullPriceSample: null,
};

/**
 * Per-ticket debounce/cooldown tracking.
 * Map<ticketIdStr, { consecutiveHits, firstHitAt, lastFailAt }>
 */
const ticketDebounce = new Map();

/**
 * Idempotency set: prevents duplicate auto-close attempts for the same
 * ticket + reason + calendar day.
 * Set<"ticketId:reason:YYYY-MM-DD">
 */
const idempotencyKeys = new Set();

/** Round-robin offset for batching tickets */
let rrOffset = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function todayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function resetDailyCountersIfNeeded() {
  const today = todayDateStr();
  if (monitorState.counterResetDate !== today) {
    monitorState.intentsToday = 0;
    monitorState.closesToday = 0;
    monitorState.failuresToday = 0;
    monitorState.counterResetDate = today;
    idempotencyKeys.clear();
  }
}

function resetTickDiagnostics() {
  monitorState.lastTickBatchSize = 0;
  monitorState.lastTickPriceOk = 0;
  monitorState.lastTickPriceNull = 0;
  monitorState.lastTickPriceError = 0;
  monitorState.lastTickCooldownSkip = 0;
  monitorState.lastTickTriggerHit = 0;
  monitorState.lastTickTriggerMiss = 0;
  monitorState.lastTickDebounceHold = 0;
  monitorState.lastTickCloseAttempt = 0;
  monitorState.lastTickIdentitySkip = 0;
  monitorState.lastTickNullPriceSample = null;
}

function jitteredTick() {
  const base = config.AUTO_MODE_TICK_MS;
  const jitter = base * config.AUTO_MODE_JITTER_PCT;
  return base + (Math.random() * 2 - 1) * jitter;
}

/** Returns true if the ticket has a valid conditionId (0x…) suitable for strict monitoring. */
function hasValidConditionId(ticket) {
  const cid = (ticket.conditionId || "");
  return cid.startsWith("0x");
}

// ---------------------------------------------------------------------------
// A5) Mongo lease lock
// ---------------------------------------------------------------------------
async function tryAcquireLease() {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.AUTO_MODE_LEASE_TTL_MS);

  try {
    // Try to acquire: upsert if no doc or expired doc
    const result = await MonitorLease.findOneAndUpdate(
      {
        key: "monitor",
        $or: [
          { expiresAt: { $lte: now } },           // lease expired
          { ownerId: monitorState.leaseOwnerId },  // we already own it
        ],
      },
      {
        $set: {
          ownerId: monitorState.leaseOwnerId,
          expiresAt,
          acquiredAt: now,
        },
        $setOnInsert: { key: "monitor" },
      },
      { upsert: true, new: true }
    );

    if (result && result.ownerId === monitorState.leaseOwnerId) {
      monitorState.leaseHeld = true;
      monitorState.leaseExpiresAt = expiresAt;
      return true;
    }
  } catch (err) {
    // Duplicate key on upsert race → another instance holds it
    if (err.code === 11000) {
      monitorState.leaseHeld = false;
      return false;
    }
    console.error(JSON.stringify({ msg: "lease acquire error", err: err.message, ts: new Date().toISOString() }));
  }

  // Fallback: check if we already hold it
  try {
    const doc = await MonitorLease.findOne({ key: "monitor" }).lean();
    if (doc && doc.ownerId === monitorState.leaseOwnerId && doc.expiresAt > now) {
      monitorState.leaseHeld = true;
      monitorState.leaseExpiresAt = doc.expiresAt;
      return true;
    }
  } catch (_) {}

  monitorState.leaseHeld = false;
  return false;
}

async function renewLease() {
  const expiresAt = new Date(Date.now() + config.AUTO_MODE_LEASE_TTL_MS);
  try {
    await MonitorLease.updateOne(
      { key: "monitor", ownerId: monitorState.leaseOwnerId },
      { $set: { expiresAt } }
    );
    monitorState.leaseExpiresAt = expiresAt;
  } catch (err) {
    console.warn(JSON.stringify({ msg: "lease renew error", err: err.message, ts: new Date().toISOString() }));
  }
}

async function releaseLease() {
  try {
    await MonitorLease.deleteOne({ key: "monitor", ownerId: monitorState.leaseOwnerId });
  } catch (_) {}
  monitorState.leaseHeld = false;
  monitorState.leaseExpiresAt = null;
}

// ---------------------------------------------------------------------------
// A2) Current closeable price
// ---------------------------------------------------------------------------

/**
 * Pick the correct market from a Gamma API array response (strict, fail-closed).
 *
 * The condition_id query-param endpoint may return multiple market objects
 * (e.g. different outcomes sharing an event).  We match ONLY by exact
 * conditionId (case-insensitive hex match).
 *
 * Fail-closed: if no exact conditionId match is found, returns null.
 * No question-text fallback. No arr[0] fallback.
 * A missed close is acceptable; a wrong close is not.
 *
 * @param {Array} arr — Gamma API array response
 * @param {Object} ticket — TradeTicket document (has conditionId, marketId)
 * @returns {Object|null}
 */
function matchMarketFromArray(arr, ticket) {
  if (!arr || arr.length === 0) return null;

  // Use ONLY the dedicated conditionId field — no marketId fallback (fail-closed)
  const wantId = (ticket.conditionId || "").toLowerCase();
  if (!wantId) return null;

  // Single-element array still requires exact conditionId match (fail-closed)
  const match = arr.find(
    (m) => (m.conditionId || m.condition_id || "").toLowerCase() === wantId
  );

  return match || null;
}

/**
 * Fetch the current closeable price for a ticket (strict, fail-closed).
 *
 * Price source: Gamma Markets API.
 *   - conditionId (0x…) → GET /markets?condition_id={id}  (returns array)
 *
 * Only tickets with a valid conditionId are eligible for price lookup.
 * Slug-based or question-based identifiers are NOT used for monitoring.
 *
 *   - BUY_YES closes by selling YES shares → best executable sell price = bestBid
 *   - BUY_NO closes by selling NO shares → best executable sell price for NO = (1 - bestAsk)
 *     (Since the API returns YES-side bestBid/bestAsk, the NO-side sell price is derived
 *      as 1 - bestAsk, which represents the best available price to exit a NO position.)
 *
 * If the API cannot provide executable bid/ask, we fall back to outcomePrices (last-trade
 * midpoint-like prices). This is documented as an approximation, not a guaranteed fill price.
 *
 * Returns { price: number, source: string } or null on failure.
 */
async function getCurrentCloseablePrice(ticket) {
  // Strict: only conditionId (0x…) is acceptable for monitoring lookup — no marketId fallback
  if (!hasValidConditionId(ticket)) return null;
  const cid = ticket.conditionId;

  const url = `https://gamma-api.polymarket.com/markets?condition_id=${encodeURIComponent(cid)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (res.status === 429 || res.status >= 500) {
      const err = new Error(`API ${res.status}`);
      err.statusCode = res.status;
      throw err;
    }
    if (!res.ok) {
      return null;
    }

    const raw = await res.json();
    // condition_id query always returns an array; match strictly by conditionId
    const data = Array.isArray(raw)
      ? matchMarketFromArray(raw, ticket)
      : null;   // non-array response from condition_id query is unexpected → fail-closed
    if (!data) return null;

    const bestBid = parseFloat(data.bestBid);
    const bestAsk = parseFloat(data.bestAsk);

    if (ticket.action === "BUY_YES" && Number.isFinite(bestBid) && bestBid > 0) {
      // Selling YES shares → receive bestBid price
      return { price: bestBid, source: "gamma_bestBid" };
    }

    if (ticket.action === "BUY_NO" && Number.isFinite(bestAsk)) {
      // Selling NO shares → the NO sell price is (1 - bestAsk) on the YES orderbook
      const noSellPrice = 1 - bestAsk;
      if (noSellPrice > 0) {
        return { price: noSellPrice, source: "gamma_derived_no_sell" };
      }
    }

    // Fallback: use outcomePrices if available (approximation only)
    let outcomePrices = data.outcomePrices;
    if (typeof outcomePrices === "string") {
      try { outcomePrices = JSON.parse(outcomePrices); } catch (_) { outcomePrices = null; }
    }
    if (Array.isArray(outcomePrices) && outcomePrices.length >= 2) {
      if (ticket.action === "BUY_YES") {
        const yesPrice = parseFloat(outcomePrices[0]);
        if (Number.isFinite(yesPrice) && yesPrice > 0) {
          return { price: yesPrice, source: "gamma_outcomePrices_approx" };
        }
      }
      if (ticket.action === "BUY_NO") {
        const noPrice = parseFloat(outcomePrices[1]);
        if (Number.isFinite(noPrice) && noPrice > 0) {
          return { price: noPrice, source: "gamma_outcomePrices_approx" };
        }
      }
    }

    return null;
  } catch (err) {
    clearTimeout(timer);
    if (err.statusCode === 429 || (err.statusCode && err.statusCode >= 500)) {
      throw err; // propagate for backoff handling
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// A3) Trigger rules + debounce
// ---------------------------------------------------------------------------

/**
 * Check if a ticket triggers TP or EXIT conditions.
 * Returns { triggered: boolean, reason: "TP_HIT"|"EXIT_HIT"|null }
 */
function checkTrigger(ticket, currentPrice) {
  if (typeof ticket.takeProfit === "number" && currentPrice >= ticket.takeProfit) {
    return { triggered: true, reason: "TP_HIT" };
  }
  if (typeof ticket.riskExitLimit === "number" && currentPrice <= ticket.riskExitLimit) {
    return { triggered: true, reason: "EXIT_HIT" };
  }
  return { triggered: false, reason: null };
}

/**
 * Debounce/hysteresis: require condition true for 2 consecutive checks
 * OR >= 15 seconds before triggering intent.
 * Returns true if debounce condition is satisfied.
 */
function debounceCheck(ticketId, triggered) {
  const key = String(ticketId);

  if (!triggered) {
    // Reset consecutive counter
    ticketDebounce.delete(key);
    return false;
  }

  let state = ticketDebounce.get(key);
  if (!state) {
    state = { consecutiveHits: 0, firstHitAt: Date.now() };
    ticketDebounce.set(key, state);
  }

  state.consecutiveHits++;

  if (state.consecutiveHits >= config.AUTO_MODE_DEBOUNCE_CHECKS) {
    return true;
  }

  const elapsedSec = (Date.now() - state.firstHitAt) / 1000;
  if (elapsedSec >= config.AUTO_MODE_DEBOUNCE_SEC) {
    return true;
  }

  return false;
}

/**
 * Check per-ticket cooldown after failed attempt.
 * Returns true if still in cooldown.
 */
function isInCooldown(ticketId) {
  const key = String(ticketId);
  const state = ticketDebounce.get(key);
  if (!state || !state.lastFailAt) return false;
  return (Date.now() - state.lastFailAt) < config.AUTO_MODE_COOLDOWN_MS;
}

function markFailed(ticketId) {
  const key = String(ticketId);
  let state = ticketDebounce.get(key);
  if (!state) {
    state = { consecutiveHits: 0, firstHitAt: Date.now() };
    ticketDebounce.set(key, state);
  }
  state.lastFailAt = Date.now();
}

// ---------------------------------------------------------------------------
// A6) Close execution behavior
// ---------------------------------------------------------------------------

/**
 * Attempt auto-close for a ticket.
 * Always writes a CloseAttempt log.
 *
 * When AUTO_MODE_PAPER_CLOSE=true: immediately marks the ticket CLOSED with
 * closePrice = observedPrice, isSimulated = true (paper close).
 *
 * When paper close is inactive (default): records intent and sets CLOSING.
 * Does NOT mark CLOSED without real confirmation.
 *
 * @param {boolean} [effectivePaperClose] — resolved paper-close state (env && db).
 *   Falls back to config.AUTO_MODE_PAPER_CLOSE for backward compat.
 */
async function attemptAutoClose(ticket, observedPrice, reason, effectivePaperClose) {
  if (typeof effectivePaperClose !== "boolean") effectivePaperClose = config.AUTO_MODE_PAPER_CLOSE;
  const ticketId = ticket._id;
  const idempKey = `${ticketId}:${reason}:${todayDateStr()}`;

  // Idempotency guard: skip if already attempted for same ticket+reason+day
  if (idempotencyKeys.has(idempKey)) {
    await CloseAttempt.create({
      ticketId,
      observedPrice,
      reason,
      result: "IDEMPOTENT_SKIP",
    });
    return "IDEMPOTENT_SKIP";
  }

  idempotencyKeys.add(idempKey);

  try {
    // Check if a real execution function exists.
    const hasRealExecution = false;

    if (hasRealExecution) {
      // Future: call real execution function here
      // If successful, update ticket to CLOSED with real confirmation
      // ticket.status = "CLOSED";
      // ticket.closeReason = reason;
      // ticket.closedAt = new Date();
      // ticket.closePrice = observedPrice;
      // await ticket.save();
      //
      // await CloseAttempt.create({ ticketId, observedPrice, reason, result: "CLOSE_EXECUTED" });
      // monitorState.closesToday++;
      // return "CLOSE_EXECUTED";
    }

    // --- Paper close mode ---
    if (effectivePaperClose) {
      // Compute approximate realized PnL if entry data is available
      let realizedPnlUsd = null;
      let realizedPnlPct = null;
      if (typeof ticket.entryLimit === "number" && ticket.entryLimit > 0 &&
          typeof ticket.maxSizeUsd === "number" && ticket.maxSizeUsd > 0) {
        const shares = ticket.maxSizeUsd / ticket.entryLimit;
        const valueExit = shares * observedPrice;
        realizedPnlUsd = valueExit - ticket.maxSizeUsd;
        realizedPnlPct = realizedPnlUsd / ticket.maxSizeUsd;
      }

      await TradeTicket.updateOne(
        { _id: ticketId, status: { $in: ["OPEN", "CLOSING"] } },
        {
          $set: {
            status: "CLOSED",
            closeReason: reason,
            closedAt: new Date(),
            closePrice: observedPrice,
            isSimulated: true,
            lastObservedPrice: observedPrice,
            ...(realizedPnlUsd !== null ? { realizedPnlUsd, realizedPnlPct } : {}),
          },
        }
      );

      await CloseAttempt.create({
        ticketId,
        observedPrice,
        reason,
        result: "PAPER_CLOSED",
      });

      monitorState.closesToday++;
      // Reset debounce after successful paper close
      ticketDebounce.delete(String(ticketId));
      return "PAPER_CLOSED";
    }

    // --- Default: No real execution, record intent, set CLOSING ---
    await TradeTicket.updateOne(
      { _id: ticketId },
      {
        $set: {
          status: "CLOSING",
          autoCloseIntentAt: new Date(),
          autoCloseIntentReason: reason,
          lastObservedPrice: observedPrice,
        },
      }
    );

    await CloseAttempt.create({
      ticketId,
      observedPrice,
      reason,
      result: "INTENT_RECORDED",
    });

    monitorState.intentsToday++;
    // Reset debounce after successful intent
    ticketDebounce.delete(String(ticketId));
    return "INTENT_RECORDED";
  } catch (err) {
    markFailed(ticketId);
    monitorState.failuresToday++;

    await CloseAttempt.create({
      ticketId,
      observedPrice,
      reason,
      result: "FAILED",
      error: err.message,
    }).catch(() => {});

    return "FAILED";
  }
}

// ---------------------------------------------------------------------------
// A4) Monitor loop (adaptive + rate-limit safe)
// ---------------------------------------------------------------------------

/**
 * Process one tick of the monitor loop.
 * Fetches up to BATCH_SIZE OPEN tickets (round-robin), checks prices,
 * applies trigger rules + debounce, attempts close if conditions met.
 */
async function monitorTick() {
  resetDailyCountersIfNeeded();
  resetTickDiagnostics();

  // Check DB-level auto-mode toggle — if disabled, skip this tick entirely
  let dbSettings;
  try {
    dbSettings = await SystemSetting.getSettings();
  } catch (err) {
    console.warn(JSON.stringify({ msg: "failed to fetch SystemSetting, defaulting to disabled", err: err.message, ts: new Date().toISOString() }));
    dbSettings = { autoModeEnabled: false, paperCloseEnabled: false };
  }
  if (!dbSettings.autoModeEnabled) {
    monitorState.openMonitored = 0;
    return;
  }

  const openTickets = await TradeTicket.find({
    status: "OPEN",
    tradeability: "EXECUTE",
    action: { $in: ["BUY_YES", "BUY_NO"] },
    takeProfit: { $ne: null },
    riskExitLimit: { $ne: null },
    autoCloseEnabled: true,
  })
    .sort({ _id: 1 })
    .lean();

  monitorState.openMonitored = openTickets.length;

  if (openTickets.length === 0) return;

  // Resolve effective paper-close state: env must allow AND DB must enable
  const effectivePaperClose = config.AUTO_MODE_PAPER_CLOSE && dbSettings.paperCloseEnabled;

  // Round-robin batch
  const batchSize = config.AUTO_MODE_BATCH_SIZE;
  if (rrOffset >= openTickets.length) rrOffset = 0;
  const batch = openTickets.slice(rrOffset, rrOffset + batchSize);
  rrOffset += batchSize;

  monitorState.lastTickBatchSize = batch.length;

  for (const ticket of batch) {
    // Strict identity gate: skip tickets without a valid conditionId (fail-closed)
    if (!hasValidConditionId(ticket)) {
      monitorState.lastTickIdentitySkip++;
      console.warn(JSON.stringify({
        msg: "monitor-identity-skip",
        reason: "missing_conditionId",
        ticketId: String(ticket._id).slice(-6),
        marketId: ticket.marketId || "—",
        conditionId: ticket.conditionId || null,
        ts: new Date().toISOString(),
      }));
      continue;
    }

    // Rate limiting: space out requests (min ~50ms gap = max ~20 rps within burst,
    // but overall avg is well under 1 rps due to 15s tick interval)
    await new Promise((r) => setTimeout(r, 50));

    if (isInCooldown(ticket._id)) {
      monitorState.lastTickCooldownSkip++;
      continue;
    }

    let priceResult;
    try {
      priceResult = await getCurrentCloseablePrice(ticket);
    } catch (err) {
      // 429/5xx → trigger backoff
      if (err.statusCode === 429 || (err.statusCode && err.statusCode >= 500)) {
        monitorState.lastTickPriceError++;
        applyBackoff();
        monitorState.lastError = `API ${err.statusCode}`;
        monitorState.lastErrorAt = new Date();
        logTickDiagnostics();
        return; // abort this tick
      }
      monitorState.lastTickPriceError++;
      continue;
    }

    if (!priceResult) {
      monitorState.lastTickPriceNull++;
      // Capture the first null-price sample for debugging
      if (!monitorState.lastTickNullPriceSample) {
        monitorState.lastTickNullPriceSample = {
          conditionId: ticket.conditionId || "—",
          action: ticket.action || "—",
          ticketId: String(ticket._id).slice(-6),
        };
      }
      continue;
    }

    monitorState.lastTickPriceOk++;

    // Update last observed price on the ticket
    await TradeTicket.updateOne(
      { _id: ticket._id },
      { $set: { lastPriceCheckAt: new Date(), lastObservedPrice: priceResult.price } }
    ).catch(() => {});

    const { triggered, reason } = checkTrigger(ticket, priceResult.price);

    if (triggered) {
      monitorState.lastTickTriggerHit++;
      if (debounceCheck(ticket._id, true)) {
        monitorState.lastTickCloseAttempt++;
        await attemptAutoClose(ticket, priceResult.price, reason, effectivePaperClose);
      } else {
        monitorState.lastTickDebounceHold++;
      }
    } else {
      monitorState.lastTickTriggerMiss++;
      debounceCheck(ticket._id, false);
    }
  }

  // Successful tick: reset backoff
  monitorState.backoffMs = 0;

  logTickDiagnostics();
}

/** Emit a structured JSON log once per tick with diagnostic breakdown. */
function logTickDiagnostics() {
  const s = monitorState;
  console.log(JSON.stringify({
    msg: "monitor-tick",
    open: s.openMonitored,
    batch: s.lastTickBatchSize,
    priceOk: s.lastTickPriceOk,
    priceNull: s.lastTickPriceNull,
    priceErr: s.lastTickPriceError,
    cooldown: s.lastTickCooldownSkip,
    triggerHit: s.lastTickTriggerHit,
    triggerMiss: s.lastTickTriggerMiss,
    debounceHold: s.lastTickDebounceHold,
    closeAttempt: s.lastTickCloseAttempt,
    identitySkip: s.lastTickIdentitySkip,
    nullSample: s.lastTickNullPriceSample,
    ts: new Date().toISOString(),
  }));
}

function applyBackoff() {
  if (monitorState.backoffMs === 0) {
    monitorState.backoffMs = config.AUTO_MODE_BACKOFF_INITIAL_MS;
  } else {
    monitorState.backoffMs = Math.min(monitorState.backoffMs * 2, config.AUTO_MODE_BACKOFF_MAX_MS);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let leaseRenewInterval = null;

async function startMonitorLoop() {
  if (!config.AUTO_MODE_ENABLED) {
    console.log(JSON.stringify({ msg: "auto-mode disabled", ts: new Date().toISOString() }));
    return;
  }

  console.log(JSON.stringify({
    msg: "auto-mode starting",
    ownerId: monitorState.leaseOwnerId,
    ts: new Date().toISOString(),
  }));

  monitorState.running = true;

  // Start lease renewal interval
  leaseRenewInterval = setInterval(async () => {
    if (monitorState.leaseHeld) {
      await renewLease();
    }
  }, config.AUTO_MODE_LEASE_RENEW_MS);

  while (monitorState.running) {
    try {
      const hasLease = await tryAcquireLease();
      if (!hasLease) {
        // Another instance holds the lease; wait and retry
        await new Promise((r) => setTimeout(r, config.AUTO_MODE_LEASE_TTL_MS));
        continue;
      }

      const tickStart = Date.now();
      await monitorTick();
      monitorState.lastLoopAt = new Date();
      monitorState.lastLoopDurationMs = Date.now() - tickStart;
    } catch (err) {
      monitorState.lastError = err.message;
      monitorState.lastErrorAt = new Date();
      console.error(JSON.stringify({
        msg: "monitor tick error",
        err: err.message,
        ts: new Date().toISOString(),
      }));
    }

    // Wait: base tick + jitter + any backoff
    const waitMs = jitteredTick() + monitorState.backoffMs;
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

function stopMonitorLoop() {
  monitorState.running = false;
  if (leaseRenewInterval) {
    clearInterval(leaseRenewInterval);
    leaseRenewInterval = null;
  }
  releaseLease().catch(() => {});
}

/** Return a snapshot of monitor state for /system observability. */
function getMonitorStatus() {
  resetDailyCountersIfNeeded();
  return { ...monitorState, paperCloseEnabled: config.AUTO_MODE_PAPER_CLOSE };
}

module.exports = {
  startMonitorLoop,
  stopMonitorLoop,
  getMonitorStatus,
  getCurrentCloseablePrice,
  matchMarketFromArray,
  checkTrigger,
  debounceCheck,
  attemptAutoClose,
  monitorState,
};
