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
  lastTickEndedMarkets: 0,         // tickets where market is ended (auto-closed or blocked)
  lastTickSettledMarkets: 0,       // tickets where market is settled (auto-closed or blocked)
  // CLOB diagnostics
  lastTickClobPriceOk: 0,          // tickets where CLOB orderbook price was successfully fetched
  lastTickClobPriceNull: 0,        // tickets where CLOB returned no usable price
  lastTickClobPrice404: 0,         // tickets where CLOB /book returned 404 (no orderbook)
  lastTickClobRateLimit: 0,        // tickets where CLOB returned 429 (rate limit)
  lastTickClobTokenIdMissing: 0,   // tickets lacking token IDs → blocked
  // Sample: first null-price ticket per tick for debugging (rich diagnostic)
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
  monitorState.lastTickEndedMarkets = 0;
  monitorState.lastTickSettledMarkets = 0;
  monitorState.lastTickClobPriceOk = 0;
  monitorState.lastTickClobPriceNull = 0;
  monitorState.lastTickClobPrice404 = 0;
  monitorState.lastTickClobRateLimit = 0;
  monitorState.lastTickClobTokenIdMissing = 0;
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
// A2) Current closeable price — CLOB primary + Gamma fallback
// ---------------------------------------------------------------------------

/**
 * Resolve the CLOB token ID for the ticket's held outcome.
 *
 * Token ID mapping:
 *   BUY_YES → ticket.yesTokenId  (selling YES shares → need YES token orderbook)
 *   BUY_NO  → ticket.noTokenId   (selling NO shares → need NO token orderbook)
 *
 * Returns the token ID string or null if not available.
 */
function resolveTokenId(ticket) {
  if (ticket.action === "BUY_YES" && ticket.yesTokenId) return ticket.yesTokenId;
  if (ticket.action === "BUY_NO" && ticket.noTokenId) return ticket.noTokenId;
  return null;
}

/**
 * Fetch executable close price from CLOB orderbook (primary monitoring source).
 *
 * Uses GET https://clob.polymarket.com/book?token_id={tokenId}
 *
 * For a held position:
 *   BUY_YES → selling YES shares → executable price = top bid on YES token
 *   BUY_NO  → selling NO shares  → executable price = top bid on NO token
 *
 * Unlike Gamma-based monitoring, we do NOT use `1 - bestAsk` hacks for NO pricing.
 * Each outcome has its own CLOB orderbook with native bid/ask.
 *
 * Returns { price, source, bestBid, bestAsk, spread, topBidSize, topAskSize, timestamp }
 * or null on failure. Populates getClobPrice._lastDiag for debugging.
 */
async function getClobPrice(ticket) {
  const tokenId = resolveTokenId(ticket);
  if (!tokenId) return null;

  const url = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`;

  const diag = {
    ticketId: String(ticket._id || "").slice(-6),
    tokenId,
    action: ticket.action || "—",
    url,
    httpStatus: null,
    bidsCount: null,
    asksCount: null,
    bestBid: null,
    bestAsk: null,
    topBidSize: null,
    topAskSize: null,
    spread: null,
    timestamp: null,
    source: "CLOB",
    nullReason: null,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    diag.httpStatus = res.status;

    if (res.status === 404) {
      diag.nullReason = "NO_ORDERBOOK_404";
      getClobPrice._lastDiag = diag;
      return null;
    }

    if (res.status === 429) {
      diag.nullReason = "RATE_LIMIT_429";
      getClobPrice._lastDiag = diag;
      const err = new Error(`CLOB API 429`);
      err.statusCode = 429;
      throw err;
    }

    if (res.status >= 500) {
      diag.nullReason = `CLOB_API_${res.status}`;
      getClobPrice._lastDiag = diag;
      const err = new Error(`CLOB API ${res.status}`);
      err.statusCode = res.status;
      throw err;
    }

    if (!res.ok) {
      diag.nullReason = `CLOB_HTTP_${res.status}`;
      getClobPrice._lastDiag = diag;
      return null;
    }

    const data = await res.json();
    const bids = Array.isArray(data.bids) ? data.bids : [];
    const asks = Array.isArray(data.asks) ? data.asks : [];
    diag.bidsCount = bids.length;
    diag.asksCount = asks.length;
    diag.timestamp = data.timestamp || null;

    // Extract top-of-book
    const topBid = bids.length > 0 ? parseFloat(bids[0].price) : NaN;
    const topAsk = asks.length > 0 ? parseFloat(asks[0].price) : NaN;
    const topBidSize = bids.length > 0 ? parseFloat(bids[0].size) : NaN;
    const topAskSize = asks.length > 0 ? parseFloat(asks[0].size) : NaN;

    diag.bestBid = Number.isFinite(topBid) ? topBid : null;
    diag.bestAsk = Number.isFinite(topAsk) ? topAsk : null;
    diag.topBidSize = Number.isFinite(topBidSize) ? topBidSize : null;
    diag.topAskSize = Number.isFinite(topAskSize) ? topAskSize : null;

    if (Number.isFinite(topBid) && Number.isFinite(topAsk)) {
      diag.spread = Math.round((topAsk - topBid) * 10000) / 10000;
    }

    // Selling shares → executable price is top bid (best price someone will buy at)
    if (!Number.isFinite(topBid) || topBid <= 0) {
      diag.nullReason = bids.length === 0 ? "NO_BIDS" : "INVALID_TOP_BID";
      getClobPrice._lastDiag = diag;
      return null;
    }

    getClobPrice._lastDiag = diag;
    return {
      price: topBid,
      source: "CLOB",
      bestBid: diag.bestBid,
      bestAsk: diag.bestAsk,
      spread: diag.spread,
      topBidSize: diag.topBidSize,
      topAskSize: diag.topAskSize,
      timestamp: diag.timestamp,
      tokenId,
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.statusCode === 429 || (err.statusCode && err.statusCode >= 500)) {
      throw err; // propagate for backoff handling
    }
    if (!diag.nullReason) diag.nullReason = "CLOB_FETCH_ERROR";
    getClobPrice._lastDiag = diag;
    return null;
  }
}
getClobPrice._lastDiag = null;

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
 * Detect ended / settled / closed state from Gamma API market object.
 * Returns { ended: bool, settled: bool, closed: bool } based on actual response fields.
 *
 * Gamma API fields observed:
 *   - closed (bool)        — market closed for trading
 *   - resolved (bool)      — market outcome determined
 *   - end_date_iso / endDate — market end timestamp (if in the past → ended)
 *   - active (bool)        — false when market is no longer active
 */
function detectMarketEndState(data) {
  if (!data || typeof data !== "object") return { ended: false, settled: false, closed: false };

  const settled = !!(data.resolved);
  const closed  = !!(data.closed);

  // ended: endDate/end_date_iso is in the past, OR active===false (but not merely closed)
  let ended = false;
  const endDateRaw = data.end_date_iso || data.endDate || null;
  if (endDateRaw) {
    const endTs = new Date(endDateRaw).getTime();
    if (Number.isFinite(endTs) && endTs < Date.now()) ended = true;
  }
  if (data.active === false && !settled) ended = true;

  return { ended, settled, closed };
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
 * Returns { price: number, source: string, marketEndState?: object } or null on failure.
 * On null return, populates `_lastDiag` on the function for structured debugging.
 *
 * @param {object} ticket  - TradeTicket lean doc
 * @param {object} [opts]  - { paperClose: boolean } — gates SIM-only fallbacks (lastTradePrice)
 */
async function getCurrentCloseablePrice(ticket, opts) {
  const paperClose = !!(opts && opts.paperClose);
  // Strict: only conditionId (0x…) is acceptable for monitoring lookup — no marketId fallback
  if (!hasValidConditionId(ticket)) return null;
  const cid = ticket.conditionId;

  const url = `https://gamma-api.polymarket.com/markets?condition_id=${encodeURIComponent(cid)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.FETCH_TIMEOUT_MS);

  // Diagnostic scaffold — populated on null-return paths
  const diag = {
    ticketId: String(ticket._id || "").slice(-6),
    conditionId: cid,
    action: ticket.action || "—",
    url,
    httpStatus: null,
    responseIsArray: null,
    responseLength: null,
    matchedMarket: false,
    bestBidRaw: null,
    bestAskRaw: null,
    bestBidValid: false,
    bestAskValid: false,
    outcomePricesRaw: null,
    lastTradePriceRaw: null,
    updatedAtRaw: null,              // Gamma API updatedAt (ISO 8601)
    lastTradeAgeSec: null,           // seconds since Gamma `updatedAt` (market-level proxy, NOT trade-specific)
    ltpGatedReason: null,            // why lastTradePrice was NOT used for triggers
    marketEndState: null,            // { ended, settled, closed }
    nullReason: null,                // classified cause
  };

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    diag.httpStatus = res.status;

    if (res.status === 429 || res.status >= 500) {
      diag.nullReason = `API_${res.status}`;
      getCurrentCloseablePrice._lastDiag = diag;
      const err = new Error(`API ${res.status}`);
      err.statusCode = res.status;
      throw err;
    }
    if (!res.ok) {
      diag.nullReason = `HTTP_${res.status}`;
      getCurrentCloseablePrice._lastDiag = diag;
      return null;
    }

    const raw = await res.json();
    diag.responseIsArray = Array.isArray(raw);
    diag.responseLength = Array.isArray(raw) ? raw.length : null;

    // condition_id query always returns an array; match strictly by conditionId
    const data = Array.isArray(raw)
      ? matchMarketFromArray(raw, ticket)
      : null;   // non-array response from condition_id query is unexpected → fail-closed
    if (!data) {
      diag.nullReason = Array.isArray(raw) ? "NO_CONDITIONID_MATCH" : "RESPONSE_NOT_ARRAY";
      getCurrentCloseablePrice._lastDiag = diag;
      return null;
    }
    diag.matchedMarket = true;

    // Detect ended / settled / closed state
    const endState = detectMarketEndState(data);
    diag.marketEndState = endState;

    const bestBid = parseFloat(data.bestBid);
    const bestAsk = parseFloat(data.bestAsk);
    diag.bestBidRaw = data.bestBid ?? null;
    diag.bestAskRaw = data.bestAsk ?? null;
    diag.bestBidValid = Number.isFinite(bestBid) && bestBid > 0;
    diag.bestAskValid = Number.isFinite(bestAsk);
    diag.outcomePricesRaw = data.outcomePrices ?? null;
    diag.lastTradePriceRaw = data.lastTradePrice ?? null;
    diag.updatedAtRaw = data.updatedAt ?? null;

    // Compute age of market data via `updatedAt` (market-level proxy).
    // Note: Gamma API has no trade-specific timestamp; `updatedAt` is the
    // best available freshness signal but may not reflect actual last trade time.
    let lastTradeAgeSec = null;
    if (data.updatedAt) {
      const updatedMs = new Date(data.updatedAt).getTime();
      if (Number.isFinite(updatedMs)) {
        lastTradeAgeSec = Math.round((Date.now() - updatedMs) / 1000);
      }
    }
    diag.lastTradeAgeSec = lastTradeAgeSec;

    if (ticket.action === "BUY_YES" && Number.isFinite(bestBid) && bestBid > 0) {
      // Selling YES shares → receive bestBid price
      return { price: bestBid, source: "gamma_bestBid", marketEndState: endState };
    }

    if (ticket.action === "BUY_NO" && Number.isFinite(bestAsk)) {
      // Selling NO shares → the NO sell price is (1 - bestAsk) on the YES orderbook
      const noSellPrice = 1 - bestAsk;
      if (noSellPrice > 0) {
        return { price: noSellPrice, source: "gamma_derived_no_sell", marketEndState: endState };
      }
    }

    // Fallback 1: use outcomePrices if available (approximation only)
    let outcomePrices = data.outcomePrices;
    if (typeof outcomePrices === "string") {
      try { outcomePrices = JSON.parse(outcomePrices); } catch (_) { outcomePrices = null; }
    }
    if (Array.isArray(outcomePrices) && outcomePrices.length >= 2) {
      if (ticket.action === "BUY_YES") {
        const yesPrice = parseFloat(outcomePrices[0]);
        if (Number.isFinite(yesPrice) && yesPrice > 0) {
          return { price: yesPrice, source: "gamma_outcomePrices_approx", marketEndState: endState };
        }
      }
      if (ticket.action === "BUY_NO") {
        const noPrice = parseFloat(outcomePrices[1]);
        if (Number.isFinite(noPrice) && noPrice > 0) {
          return { price: noPrice, source: "gamma_outcomePrices_approx", marketEndState: endState };
        }
      }
    }

    // Fallback 2 (SIM-only, freshness-gated): lastTradePrice.
    // lastTradePrice is NOT an executable close price — it is the last matched
    // trade price. It may be stale or unrepresentative and must NEVER be
    // treated as equivalent to an executable bid/ask.
    //
    // IMPORTANT: The Gamma API does NOT provide a trade-specific timestamp
    // (no `lastTradeTime` / `lastTradeTimestamp` field). We use `updatedAt`
    // as a market-level object-freshness proxy, but this reflects when the
    // Gamma record was last refreshed — not necessarily when the last trade
    // occurred. Therefore lastTradePrice is a best-effort SIM-only heuristic.
    //
    // Gates (all must pass, else diagnostics-only):
    //   (a) Paper Close is ON (SIM mode)
    //   (b) numeric and > 0
    //   (c) Gamma `updatedAt` is within AUTO_MODE_LTP_MAX_AGE_SEC seconds
    // If any gate fails, lastTradePrice is captured in diagnostics only.
    const ltp = parseFloat(data.lastTradePrice);
    const ltpNumericValid = Number.isFinite(ltp) && ltp > 0;

    if (ltpNumericValid) {
      let ltpGatedReason = null;

      if (!paperClose) {
        ltpGatedReason = "NOT_PAPER_CLOSE";
      } else if (lastTradeAgeSec === null) {
        ltpGatedReason = "NO_UPDATED_AT";
      } else if (lastTradeAgeSec > config.AUTO_MODE_LTP_MAX_AGE_SEC) {
        ltpGatedReason = `STALE_${lastTradeAgeSec}s`;
      }

      diag.ltpGatedReason = ltpGatedReason;

      if (!ltpGatedReason) {
        // All gates passed → use lastTradePrice as SIM fallback
        if (ticket.action === "BUY_YES") {
          return { price: ltp, source: "gamma_lastTradePrice", lastTradeAgeSec, marketEndState: endState };
        }
        if (ticket.action === "BUY_NO") {
          const noLtp = 1 - ltp;
          if (noLtp > 0) {
            return { price: noLtp, source: "gamma_lastTradePrice_no_derived", lastTradeAgeSec, marketEndState: endState };
          }
        }
      }
      // If gated → fall through to null (diagnostics captured above)
    }

    // No valid price found — classify the null reason
    if (endState.settled) {
      diag.nullReason = "MARKET_SETTLED";
    } else if (endState.ended || endState.closed) {
      diag.nullReason = "MARKET_ENDED";
    } else if (ltpNumericValid && diag.ltpGatedReason) {
      diag.nullReason = `LTP_GATED:${diag.ltpGatedReason}`;
    } else {
      diag.nullReason = "MISSING_ORDERBOOK";
    }
    getCurrentCloseablePrice._lastDiag = diag;
    return null;
  } catch (err) {
    clearTimeout(timer);
    if (err.statusCode === 429 || (err.statusCode && err.statusCode >= 500)) {
      throw err; // propagate for backoff handling
    }
    if (!diag.nullReason) diag.nullReason = `FETCH_ERROR`;
    getCurrentCloseablePrice._lastDiag = diag;
    return null;
  }
}
// Initialize diagnostic slot
getCurrentCloseablePrice._lastDiag = null;

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
      // Guard: observedPrice can be null for settled markets with no orderbook
      if (typeof observedPrice === "number" &&
          typeof ticket.entryLimit === "number" && ticket.entryLimit > 0 &&
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
            ...(observedPrice !== null ? { lastObservedPrice: observedPrice } : {}),
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
    // CLOB primary: use CLOB orderbook if the ticket has the required token ID
    const hasTokenId = !!resolveTokenId(ticket);

    if (hasTokenId) {
      // --- CLOB path (primary) ---
      try {
        priceResult = await getClobPrice(ticket);
      } catch (err) {
        if (err.statusCode === 429) {
          monitorState.lastTickClobRateLimit++;
          monitorState.lastTickPriceError++;
          applyBackoff();
          monitorState.lastError = `CLOB API 429`;
          monitorState.lastErrorAt = new Date();
          logTickDiagnostics();
          return; // abort this tick
        }
        if (err.statusCode && err.statusCode >= 500) {
          monitorState.lastTickPriceError++;
          applyBackoff();
          monitorState.lastError = `CLOB API ${err.statusCode}`;
          monitorState.lastErrorAt = new Date();
          logTickDiagnostics();
          return;
        }
        monitorState.lastTickPriceError++;
        continue;
      }

      if (priceResult) {
        monitorState.lastTickClobPriceOk++;
      } else {
        monitorState.lastTickClobPriceNull++;
        const clobDiag = getClobPrice._lastDiag;
        if (clobDiag && clobDiag.nullReason === "NO_ORDERBOOK_404") {
          monitorState.lastTickClobPrice404++;
          // Block auto-close: no orderbook for this token
          await TradeTicket.updateOne(
            { _id: ticket._id },
            { $set: { autoCloseBlockedReason: "NO_ORDERBOOK" } }
          ).catch(() => {});
        }
        if (!monitorState.lastTickNullPriceSample && clobDiag) {
          monitorState.lastTickNullPriceSample = { ...clobDiag, capturedAt: new Date().toISOString() };
        }
        // Do NOT fall back to Gamma for close decisions when CLOB is the primary source
        monitorState.lastTickPriceNull++;
        continue;
      }
    } else {
      // --- No CLOB token ID: block auto-close with clear reason ---
      monitorState.lastTickClobTokenIdMissing++;
      // Disable auto-close for this ticket — missing token IDs
      await TradeTicket.updateOne(
        { _id: ticket._id },
        { $set: { autoCloseEnabled: false, autoCloseBlockedReason: "MISSING_TOKEN_ID" } }
      ).catch(() => {});
      continue;
    }

    // priceResult is guaranteed non-null here (from CLOB path above)
    monitorState.lastTickPriceOk++;

    // Update last observed price + price source on the ticket
    await TradeTicket.updateOne(
      { _id: ticket._id },
      { $set: { lastPriceCheckAt: new Date(), lastObservedPrice: priceResult.price, priceSource: "CLOB" } }
    ).catch(() => {});

    const { triggered, reason } = checkTrigger(ticket, priceResult.price);

    // Structured logging for CLOB-sourced triggers
    if (triggered) {
      console.log(JSON.stringify({
        msg: "monitor-clob-trigger",
        ticketId: String(ticket._id).slice(-6),
        action: ticket.action,
        priceSource: priceResult.source,
        price: priceResult.price,
        tokenId: priceResult.tokenId || null,
        bestBid: priceResult.bestBid,
        bestAsk: priceResult.bestAsk,
        spread: priceResult.spread,
        reason,
        ts: new Date().toISOString(),
      }));
    }

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

  // Persist null-price debug sample to Mongo (rate-limited: max once per 60s)
  await persistDebugSnapshot().catch(() => {});

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
    endedMarkets: s.lastTickEndedMarkets,
    settledMarkets: s.lastTickSettledMarkets,
    clobOk: s.lastTickClobPriceOk,
    clobNull: s.lastTickClobPriceNull,
    clob404: s.lastTickClobPrice404,
    clobRateLimit: s.lastTickClobRateLimit,
    clobTokenMissing: s.lastTickClobTokenIdMissing,
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
// Debug snapshot persistence (rate-limited)
// ---------------------------------------------------------------------------
const DEBUG_SNAPSHOT_INTERVAL_MS = 60_000; // max 1 write per 60s
let _lastDebugSnapshotAt = 0;

/**
 * Persist the latest null-price debug sample + tick summary to Mongo
 * via SystemSetting, rate-limited to avoid write churn.
 */
async function persistDebugSnapshot() {
  const now = Date.now();
  if (now - _lastDebugSnapshotAt < DEBUG_SNAPSHOT_INTERVAL_MS) return;

  const sample = monitorState.lastTickNullPriceSample;
  const snapshot = {
    nullPriceSample: sample || null,
    tickSummary: {
      priceNull: monitorState.lastTickPriceNull,
      priceOk: monitorState.lastTickPriceOk,
      priceError: monitorState.lastTickPriceError,
      endedMarkets: monitorState.lastTickEndedMarkets,
      settledMarkets: monitorState.lastTickSettledMarkets,
      batchSize: monitorState.lastTickBatchSize,
      clobOk: monitorState.lastTickClobPriceOk,
      clobNull: monitorState.lastTickClobPriceNull,
      clob404: monitorState.lastTickClobPrice404,
      clobRateLimit: monitorState.lastTickClobRateLimit,
      clobTokenMissing: monitorState.lastTickClobTokenIdMissing,
    },
    capturedAt: new Date().toISOString(),
  };

  await SystemSetting.updateOne(
    { _id: "system" },
    { $set: { debugNullPriceSample: snapshot } }
  );
  _lastDebugSnapshotAt = now;
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
  getClobPrice,
  resolveTokenId,
  matchMarketFromArray,
  detectMarketEndState,
  checkTrigger,
  debounceCheck,
  attemptAutoClose,
  monitorState,
};
