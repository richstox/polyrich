"use strict";

const http = require("http");
const mongoose = require("mongoose");

const config = require("./src/config");
const { fetchPolymarkets, fetchTags, fetchSports } = require("./src/fetcher");
const { normalizeMarket, formatHoursLeft, formatVolume, asNumber } = require("./src/normalizer");
const {
  MarketSnapshot,
  ShownCandidate,
  Scan,
  TagCache,
  upsertSnapshots,
  insertScanRecord,
  updateScanRecord,
  getLastScan,
  persistShownCandidates,
  getCachedTagData,
  setCachedTagData,
} = require("./src/persistence");
const TradeTicket = require("./models/TradeTicket");
const CloseAttempt = require("./models/CloseAttempt");
const AutoSaveLog = require("./models/AutoSaveLog");
const SystemSetting = require("./models/SystemSetting");
const crypto = require("crypto");
const { buildIdeas } = require("./src/signal_engine");
const {
  renderCandidate,
  renderTopPick,
  renderTodayActions,
  renderWhyNoMovers,
  renderHealthUi,
  renderMetricsUi,
  renderFilterBar,
  renderBucketSection,
  renderTradePage,
  renderExplorePage,
  renderSystemPage,
  renderHistoryPage,
  renderTicketsPage,
  renderTicketDetailPage,
  renderWatchlistPage,
  pageShell,
  inferDirection,
  inferEntry,
  inferSize,
  inferExit,
  polymarketUrl,
  safeQuestion,
  whyNowSummary,
} = require("./src/html_renderer");
const { startMonitorLoop, getMonitorStatus, fetchClobBook } = require("./src/auto_monitor");

const MonitorLease = require("./models/MonitorLease");
const PaperRunnerLog = require("./models/PaperRunnerLog");
const DANGER_ZONE_VALID_ACTIONS = ["RESET_ALL", "DELETE_CLOSED", "DELETE_OPEN", "RESET_TRADES", "FACTORY_RESET"];

// ---------------------------------------------------------------------------
// Node version check — warn-only, never crash
// ---------------------------------------------------------------------------
{
  const major = parseInt(process.version.replace("v", ""), 10);
  console.log(JSON.stringify({ msg: "node version", version: process.version, ts: new Date().toISOString() }));
  if (major !== 20) {
    console.warn(JSON.stringify({
      msg: "WARNING: expected Node 20.x (production pin), running " + process.version,
      ts: new Date().toISOString(),
    }));
  }
}

/** Read a numeric DB field, falling back to the legacy string alias. */
function numField(item, numKey, strKey) {
  return typeof item[numKey] === "number" ? item[numKey] : asNumber(item[strKey], 0);
}

/**
 * Compute a snapshot-level deduplication key.
 * sha1(marketId|tradeability|action|entryLimit|takeProfit|riskExitLimit|maxSizeUsd|scanId)
 * Canonicalization: null/undefined → "null"; numbers → Number(x).toString(); strings → trimmed.
 */
function computeDedupeKey(data) {
  function canon(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") return Number(v).toString();
    return String(v).trim();
  }
  const parts = [
    canon(data.marketId),
    canon(data.tradeability),
    canon(data.action),
    canon(data.entryLimit),
    canon(data.takeProfit),
    canon(data.riskExitLimit),
    canon(data.maxSizeUsd),
    canon(data.scanId),
  ].join("|");
  return crypto.createHash("sha1").update(parts).digest("hex");
}

/**
 * Cross-scan deduplication key for auto-save.
 * Excludes scanId so the same trade idea across scans maps to the same key.
 * sha1(marketId|action|entryLimit|takeProfit|riskExitLimit|maxSizeUsd)
 */
function computeAutoSaveDedupeKey(data) {
  function canon(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "number") return Number(v).toString();
    return String(v).trim();
  }
  const parts = [
    canon(data.marketId),
    canon(data.action),
    canon(data.entryLimit),
    canon(data.takeProfit),
    canon(data.riskExitLimit),
    canon(data.maxSizeUsd),
  ].join("|");
  return crypto.createHash("sha1").update(parts).digest("hex");
}

// ---------------------------------------------------------------------------
// DB connection
// ---------------------------------------------------------------------------
mongoose.connect(config.MONGO_URL)
  .then(() => console.log(JSON.stringify({ msg: "mongo connected", ts: new Date().toISOString() })))
  .catch((err) => console.error(JSON.stringify({ msg: "mongo error", err: err.message, ts: new Date().toISOString() })));

// ---------------------------------------------------------------------------
// In-memory state (augmented from DB on start-up)
// ---------------------------------------------------------------------------
let scanStatus = {
  lastScanAt: null,
  nextScanAt: null,
  previousScanId: null,
  lastScanId: null,
  lastSavedCount: 0,
  lastTotalFetched: 0,
  lastSavedTarget: 0,
  lastEventsFetched: 0,
  lastMarketsFlattened: 0,
  lastPagesFetched: 0,
  lastWatchlistCount: 0,
  lastSignalsCount: 0,
  lastInterestingCount: 0,
  lastMoverCount: 0,
  lastMispricingCount: 0,
  lastFilteredOutByGuardrails: 0,
  lastEligibleForMispricing: 0,
  lastError: null,
  lastDurationMs: null,
};

// Mutex to prevent overlapping scans
let scanRunning = false;

// ---------------------------------------------------------------------------
// runScan: idempotent — re-running the same scanId creates no duplicates
// ---------------------------------------------------------------------------
async function runScan() {
  if (scanRunning) {
    console.log(JSON.stringify({ msg: "scan skipped: already running", ts: new Date().toISOString() }));
    return [];
  }

  scanRunning = true;
  const startedAt = new Date();
  const scanId = startedAt.toISOString();

  console.log(JSON.stringify({ msg: "scan started", scanId, ts: startedAt.toISOString() }));

  try {
    await insertScanRecord(scanId, startedAt);
  } catch (err) {
    // Non-fatal: scan record may already exist (idempotent restart)
    console.warn(JSON.stringify({ msg: "insertScanRecord warn", scanId, err: err.message }));
  }

  let data = [];
  let candidates = [];
  let fetchStats = { eventsFetched: 0, marketsFlattened: 0, pagesFetched: 0 };

  try {
    const result = await fetchPolymarkets();
    data = result.markets;
    fetchStats = result.stats;

    candidates = data
      .filter((item) =>
        item.acceptingOrders === true &&
        item.active === true &&
        item.closed === false &&
        item.bestBid !== null &&
        item.bestAsk !== null &&
        item.spread !== null
      )
      .map(normalizeMarket)
      .sort((a, b) => {
        const aScore = Math.log(a.volume24hr + 1) * 100 + Math.log(a.liquidity + 1) * 50 - a.spread * 1000;
        const bScore = Math.log(b.volume24hr + 1) * 100 + Math.log(b.liquidity + 1) * 50 - b.spread * 1000;
        return bScore - aScore;
      });

    // Dynamic saving: save more snapshots when fetched count is large
    let saveLimit = config.SAVED_PER_SCAN;
    if (data.length > config.SAVED_DYNAMIC_THRESHOLD) {
      const pctBased = Math.ceil(data.length * config.SAVED_PER_SCAN_PCT);
      saveLimit = Math.min(Math.max(config.SAVED_PER_SCAN_MIN, pctBased), config.SAVED_PER_SCAN_CAP);
    }
    const savedTarget = saveLimit;
    candidates = candidates.slice(0, saveLimit);

    const previousScanId = scanStatus.lastScanId || null;
    const upserted = await upsertSnapshots(candidates, scanId);

    const now = new Date();
    const durationMs = now - startedAt;
    const next = new Date(now.getTime() + config.SCAN_INTERVAL_MS);

    scanStatus.previousScanId = previousScanId;
    scanStatus.lastScanId = scanId;
    scanStatus.lastScanAt = now;
    scanStatus.nextScanAt = next;
    scanStatus.lastSavedCount = candidates.length;
    scanStatus.lastTotalFetched = data.length;
    scanStatus.lastSavedTarget = savedTarget;
    scanStatus.lastEventsFetched = fetchStats.eventsFetched;
    scanStatus.lastMarketsFlattened = fetchStats.marketsFlattened;
    scanStatus.lastPagesFetched = fetchStats.pagesFetched;
    scanStatus.lastError = null;
    scanStatus.lastDurationMs = durationMs;

    // Refresh tags/sports cache in the background (non-blocking)
    refreshTagsCache().catch(() => {});

    await updateScanRecord(scanId, {
      finishedAt: now,
      fetchedCount: data.length,
      savedCount: candidates.length,
      durationMs,
    });

    console.log(JSON.stringify({
      msg: "scan done",
      scanId,
      fetched: data.length,
      saved: candidates.length,
      upserted,
      durationMs,
      eventsFetched: fetchStats.eventsFetched,
      marketsFlattened: fetchStats.marketsFlattened,
      pagesFetched: fetchStats.pagesFetched,
    }));

    // Auto-save EXECUTE tickets (non-blocking, fire-and-forget).
    // IMPORTANT: This is the ONLY call site for autoSaveExecuteTickets().
    // It runs exclusively inside runScan() after a successful new scan —
    // NOT from the /trade route, page refresh, or any HTTP handler.
    // The /trade route (line ~497) only calls buildIdeas() + renderTradePage()
    // and never invokes autoSaveExecuteTickets().
    // Additionally, the scanRunning mutex (line 149) prevents overlapping scans,
    // and the atomic lastAutoSaveScanId guard inside autoSaveExecuteTickets()
    // prevents duplicate auto-saves even across process instances.
    autoSaveExecuteTickets(scanId).catch((err) => {
      console.warn(JSON.stringify({ msg: "autoSave error", scanId, err: err.message }));
    });

    return candidates;
  } catch (err) {
    const durationMs = Date.now() - startedAt.getTime();
    scanStatus.lastError = err.message;
    scanStatus.lastDurationMs = durationMs;

    await updateScanRecord(scanId, {
      finishedAt: new Date(),
      fetchedCount: data.length,
      savedCount: candidates.length,
      durationMs,
      error: err.message,
    }).catch(() => {});

    console.error(JSON.stringify({ msg: "scan error", scanId, err: err.message, durationMs }));
    throw err;
  } finally {
    scanRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Auto-Save EXECUTE tickets after a successful scan
// ---------------------------------------------------------------------------
async function autoSaveExecuteTickets(scanId) {
  // ── Atomic once-per-scan idempotency guard ──────────────────────────
  // Prevents duplicate auto-saves if the same scanId is processed twice
  // (e.g. overlapping instances, retries). Uses a single Mongo atomic
  // findOneAndUpdate with a condition: only proceeds if lastAutoSaveScanId
  // differs from the current scanId. Safe across multiple processes.
  let guardResult;
  try {
    guardResult = await SystemSetting.findOneAndUpdate(
      { _id: "system", lastAutoSaveScanId: { $ne: scanId } },
      { $set: { lastAutoSaveScanId: scanId } },
      { new: true, lean: true }
    );
  } catch (err) {
    console.warn(JSON.stringify({ msg: "autoSave: idempotency guard error", scanId, err: err.message }));
    return;
  }
  if (!guardResult) {
    console.log(JSON.stringify({ msg: "autoSave: already processed this scanId, skipping", scanId }));
    return;
  }

  let settings;
  try {
    settings = await SystemSetting.getSettings();
  } catch (err) {
    console.warn(JSON.stringify({ msg: "autoSave: cannot read settings", err: err.message }));
    return;
  }
  if (!settings.autoSaveExecuteEnabled) return;

  let tradeCandidates;
  try {
    const result = await buildIdeas(scanStatus, {});
    tradeCandidates = result.tradeCandidates || [];
  } catch (err) {
    console.warn(JSON.stringify({ msg: "autoSave: buildIdeas failed", err: err.message }));
    return;
  }

  // Derive EXECUTE cards using the same logic as renderTradePage
  // Apply user's risk/sizing settings from SystemSetting (synced from Trade page)
  const userCap = typeof settings.maxTradeCapUsd === "number" && settings.maxTradeCapUsd > 0
    ? settings.maxTradeCapUsd : null;
  const userBankroll = typeof settings.bankrollUsd === "number" && settings.bankrollUsd > 0
    ? settings.bankrollUsd : null;
  const userRiskPct = typeof settings.riskPct === "number" && settings.riskPct > 0
    ? settings.riskPct : null;

  const cards = tradeCandidates.slice(0, 20);
  const sizingOpts = { bankrollUsd: userBankroll, riskPct: userRiskPct, maxTradeCapUsd: userCap };
  const executeItems = [];
  for (const item of cards) {
    try {
      const dir = inferDirection(item);
      if (dir.action === "WATCH") continue;
      const entryNum = inferEntry(item, dir.action);
      if (entryNum === null) continue;
      const sizeNum = inferSize(item, sizingOpts);
      if (sizeNum === null) continue;

      // Skip if below min limit order ($5)
      if (sizeNum < 5) continue;

      // Entry-based TP/SL (volatility-adaptive)
      const entryBidNum = (item.bestBidNum > 0) ? item.bestBidNum : null;
      const exits = inferExit(entryNum, { volatility: item.volatility });
      if (exits.tp === null || exits.stop === null) continue;
      executeItems.push({ item, dir, entryNum, sizeNum, tpNum: exits.tp, stopNum: exits.stop, entryBidNum });
    } catch (_) { /* skip */ }
  }

  const limit = config.AUTO_SAVE_EXECUTE_LIMIT;
  const toSave = executeItems.slice(0, limit);
  if (toSave.length === 0) return;

  const defaultAutoClose = settings.defaultAutoCloseEnabled || false;
  let created = 0;
  let dupes = 0;

  for (let { item, dir, entryNum, sizeNum, tpNum, stopNum, entryBidNum } of toSave) {
    const qText = safeQuestion(item);
    const link = polymarketUrl(item);
    const actionEnum = dir.action === "BUY YES" ? "BUY_YES" : dir.action === "BUY NO" ? "BUY_NO" : "WATCH";
    const rawConditionId = (item.conditionId || "").trim() || null;
    const rawMarketSlug = (item.marketSlug || "").trim() || null;
    // marketId stays as primary required field (prefer conditionId, fall back to slug)
    const marketId = rawConditionId || rawMarketSlug || item.question;

    // Strict identity gate: block auto-close if no valid conditionId
    const hasCanonicalId = rawConditionId && rawConditionId.startsWith("0x");
    let effectiveAutoClose = defaultAutoClose;
    let autoCloseBlockedReason = null;
    if (!hasCanonicalId) {
      effectiveAutoClose = false;
      autoCloseBlockedReason = "no_conditionId";
    }

    // --- Fetch CLOB book for real bid/ask sizes ---
    const tokenId = actionEnum === "BUY_YES" ? ((item.yesTokenId || "").trim() || null)
                  : actionEnum === "BUY_NO" ? ((item.noTokenId || "").trim() || null)
                  : null;
    let bidSizeRaw = null;
    let askSizeRaw = null;
    if (tokenId) {
      try {
        const book = await fetchClobBook(tokenId);
        if (book) {
          // Override bid from CLOB only if normalized value is non-null
          if (book.bestBid !== null) entryBidNum = book.bestBid;
          bidSizeRaw = book.topBidSize;
          askSizeRaw = book.topAskSize;
        }
      } catch (_) { /* CLOB fetch failed — use Gamma data */ }
      await new Promise((r) => setTimeout(r, 50)); // rate-limit CLOB calls
    }

    // Structured traceability: log CLOB book state at ticket creation
    console.log(JSON.stringify({
      msg: "autoSave-clob-book",
      tokenId: tokenId || null,
      entryBid: entryBidNum, entryAsk: entryNum,
      bidSize: bidSizeRaw, askSize: askSizeRaw,
      ts: new Date().toISOString(),
    }));

    // TP/SL are entry-based — computed from entryNum during initial calculation
    // and remain constant based on entry price regardless of CLOB bid.

    // ---------------------------------------------------------------------------
    // HARD INVARIANT: Fail-closed on missing executable bid
    // ---------------------------------------------------------------------------
    // An EXECUTE ticket with auto-close REQUIRES:
    //  1. entryBid: finite > 0 (valid executable bid from CLOB)
    //  2. entryAsk: finite > 0 (entry price)
    //  3. entryBidSize: finite > 0 (liquidity exists at that bid level)
    //  4. TP and SL: finite > 0
    // If ANY is missing → block auto-close with NO_EXECUTABLE_BID.
    const hasValidBid  = Number.isFinite(entryBidNum) && entryBidNum > 0;
    const hasValidAsk  = Number.isFinite(entryNum) && entryNum > 0;
    const hasValidSize = Number.isFinite(bidSizeRaw) && bidSizeRaw > 0;
    const hasValidTP   = Number.isFinite(tpNum) && tpNum > 0;
    const hasValidSL   = Number.isFinite(stopNum) && stopNum > 0;

    if (effectiveAutoClose && !(hasValidBid && hasValidAsk && hasValidSize && hasValidTP && hasValidSL)) {
      effectiveAutoClose = false;
      autoCloseBlockedReason = autoCloseBlockedReason || "NO_EXECUTABLE_BID";
    }

    // --- Entry microstructure snapshot ---
    const entryAskNum = entryNum; // inferEntry returns bestAsk
    const midNum = (hasValidBid && entryAskNum) ? (entryAskNum + entryBidNum) / 2 : null;
    const spreadAbs = (hasValidBid && entryAskNum) ? (entryAskNum - entryBidNum) : null;
    const spreadPct = (midNum && midNum > 0 && spreadAbs !== null) ? spreadAbs / midNum : null;

    // --- Spread gate: SKIP wide-spread tickets entirely ---
    // Do NOT create tickets for markets where the spread is too wide.
    // Previously these were created with autoClose disabled (SPREAD_TOO_WIDE),
    // but that just clutters the ticket list with un-closeable positions.
    if (spreadPct !== null && spreadPct > config.MAX_ENTRY_SPREAD_PCT) {
      console.log(JSON.stringify({
        msg: "autoSave-spread-skip",
        marketId, spreadPct: Math.round(spreadPct * 10000) / 10000,
        threshold: config.MAX_ENTRY_SPREAD_PCT,
        ts: new Date().toISOString(),
      }));
      continue; // skip — do not create ticket
    }

    // --- Safety: bid already below SL → skip ---
    // With entry-based TP/SL, a wide spread can mean the current bid is already
    // at or below the stop-loss. Don't open a position that instantly triggers EXIT.
    if (hasValidBid && stopNum > 0 && entryBidNum <= stopNum) {
      console.log(JSON.stringify({
        msg: "autoSave-bid-below-sl-skip",
        marketId, entryBid: entryBidNum, stop: stopNum,
        ts: new Date().toISOString(),
      }));
      continue; // skip — would trigger EXIT_HIT immediately
    }

    // --- Admission gates: liquidity ---
    // Liquidity gate: close-side = bid (selling shares). Check notional at top bid.
    // Threshold scales with position size: max(flat floor, sizeNum × ratio)
    if (effectiveAutoClose && hasValidBid && bidSizeRaw !== null) {
      const bidNotionalUsd = entryBidNum * bidSizeRaw;
      const minBidRequired = Math.max(config.MIN_BID_SIZE_USD, sizeNum * config.MIN_BID_NOTIONAL_RATIO);
      if (bidNotionalUsd < minBidRequired) {
        effectiveAutoClose = false;
        autoCloseBlockedReason = autoCloseBlockedReason || "INSUFFICIENT_BID_SIZE";
      }
    }

    const pnlTpPct = (tpNum - entryNum) / entryNum * 100;
    const pnlStopPct = (stopNum - entryNum) / entryNum * 100;
    const pnlTpUsd = sizeNum * (tpNum - entryNum) / entryNum;
    const pnlStopUsd = sizeNum * (stopNum - entryNum) / entryNum;

    const ticketData = {
      scanId,
      source: "TRADE_PAGE",
      marketId,
      conditionId: rawConditionId,
      marketSlug: rawMarketSlug,
      yesTokenId: (item.yesTokenId || "").trim() || null,
      noTokenId: (item.noTokenId || "").trim() || null,
      eventSlug: item.eventSlug || null,
      eventTitle: item.eventTitle || null,
      groupItemTitle: item.groupItemTitle || null,
      marketUrl: link || null,
      question: qText,
      tradeability: "EXECUTE",
      action: actionEnum,
      reasonCodes: item.reasonCodes || [],
      whyNow: whyNowSummary(item),
      planTbd: false,
      entryLimit: entryNum,
      takeProfit: tpNum,
      riskExitLimit: stopNum,
      maxSizeUsd: sizeNum,
      bankrollUsd: userBankroll,
      riskPct: userRiskPct,
      maxTradeCapUsd: userCap,
      minLimitOrderUsd: 5,
      pnlTpUsd: Math.round(pnlTpUsd * 100) / 100,
      pnlTpPct: Math.round(pnlTpPct * 10) / 1000,
      pnlExitUsd: Math.round(pnlStopUsd * 100) / 100,
      pnlExitPct: Math.round(pnlStopPct * 10) / 1000,
      endDate: item.endDate || null,
      // Entry microstructure snapshot
      entryBid: entryBidNum,
      entryAsk: entryAskNum,
      entryMid: midNum ? Math.round(midNum * 10000) / 10000 : null,
      entrySpreadAbs: spreadAbs !== null ? Math.round(spreadAbs * 10000) / 10000 : null,
      entrySpreadPct: spreadPct !== null ? Math.round(spreadPct * 10000) / 10000 : null,
      entryBidSize: bidSizeRaw,
      entryAskSize: askSizeRaw,
      entryExecutionBasis: "ASK",
      triggerReferenceBasis: "BID",
      autoCloseEnabled: effectiveAutoClose,
      autoCloseBlockedReason,
    };

    // Cross-scan dedupe key (excludes scanId)
    const autoDedupeKey = computeAutoSaveDedupeKey({
      marketId,
      action: actionEnum,
      entryLimit: entryNum,
      takeProfit: tpNum,
      riskExitLimit: stopNum,
      maxSizeUsd: sizeNum,
    });

    try {
      // Check for existing OPEN or CLOSING ticket with same cross-scan key
      const existing = await TradeTicket.findOne({
        dedupeKey: autoDedupeKey,
        status: { $in: ["OPEN", "CLOSING"] },
      }).lean();

      if (existing) {
        dupes++;
        await AutoSaveLog.create({
          scanId,
          ticketId: existing._id,
          marketId,
          action: actionEnum,
          dedupeKey: autoDedupeKey,
          result: "DUPLICATE",
        }).catch(() => {});
        continue;
      }

      // Use cross-scan dedupeKey + store scanId as metadata (sourceScanId)
      ticketData.dedupeKey = autoDedupeKey;
      const ticket = await TradeTicket.create(ticketData);
      created++;
      await AutoSaveLog.create({
        scanId,
        ticketId: ticket._id,
        marketId,
        action: actionEnum,
        dedupeKey: autoDedupeKey,
        result: "CREATED",
      }).catch(() => {});
    } catch (err) {
      // Duplicate key error from unique index — treat as dedupe
      if (err.code === 11000) {
        dupes++;
        await AutoSaveLog.create({
          scanId, marketId, action: actionEnum, dedupeKey: autoDedupeKey, result: "DUPLICATE",
        }).catch(() => {});
      } else {
        await AutoSaveLog.create({
          scanId, marketId, action: actionEnum, dedupeKey: autoDedupeKey, result: "ERROR", error: err.message,
        }).catch(() => {});
      }
    }
  }

  console.log(JSON.stringify({
    msg: "autoSave done",
    scanId,
    created,
    dupes,
    total: toSave.length,
    ts: new Date().toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Scan loop: wait-then-sleep avoids setInterval drift and overlapping runs
// ---------------------------------------------------------------------------
async function scanLoop() {
  // Restore scanStatus from DB so a restart picks up where it left off
  try {
    const lastScan = await getLastScan();
    if (lastScan && !scanStatus.lastScanId) {
      scanStatus.lastScanId = lastScan.scanId;
      scanStatus.lastScanAt = lastScan.finishedAt || lastScan.startedAt;
      scanStatus.lastTotalFetched = lastScan.fetchedCount || 0;
      scanStatus.lastSavedCount = lastScan.savedCount || 0;
      scanStatus.lastError = lastScan.error || null;
      scanStatus.lastDurationMs = lastScan.durationMs || null;
      console.log(JSON.stringify({ msg: "restored scanStatus from DB", scanId: lastScan.scanId }));
    }
  } catch (err) {
    console.warn(JSON.stringify({ msg: "could not restore scanStatus from DB", err: err.message }));
  }

  while (true) {
    try {
      await runScan();
    } catch (_) {
      // already logged in runScan
    }
    await new Promise((r) => setTimeout(r, config.SCAN_INTERVAL_MS));
  }
}

// ---------------------------------------------------------------------------
// Tags / Sports cache — refreshed once per scan (TTL in Mongo).
// Sports data is pre-fetched for future sports-specific filtering.
// ---------------------------------------------------------------------------
async function refreshTagsCache() {
  try {
    const [tags, sports] = await Promise.all([fetchTags(), fetchSports()]);
    if (tags.length > 0) await setCachedTagData("tags", tags);
    if (sports.length > 0) await setCachedTagData("sports", sports);
  } catch (err) {
    console.warn(JSON.stringify({ msg: "refreshTagsCache error", err: err.message }));
  }
}

/** Load cached tags list (returns array of tag objects or []). */
async function loadCachedTags() {
  try {
    return (await getCachedTagData("tags")) || [];
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // ── / ──────────────────────────────────────────────────────────────────
  if (url.pathname === "/") {
    res.writeHead(302, { Location: "/trade" });
    res.end();
    return;
  }

  // ── /trade ─────────────────────────────────────────────────────────────
if (url.pathname === "/trade") {
  try {
    const [{ tradeCandidates: rawCandidates, relaxedMode }, systemSettings] = await Promise.all([
      buildIdeas(scanStatus, {}),
      SystemSetting.getSettings(),
    ]);

    if (scanStatus.lastScanId && rawCandidates.length > 0) {
      await persistShownCandidates(scanStatus.lastScanId, rawCandidates).catch(() => {});
    }

    scanStatus.lastInterestingCount = rawCandidates.length;

    const body = renderTradePage(scanStatus, rawCandidates, relaxedMode, systemSettings);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageShell("Trade", "/trade", body));
    return;
  } catch (err) {
    scanStatus.lastError = err.message;
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`trade error: ${err.message}`);
    return;
  }
}
  
  // ── /explore ───────────────────────────────────────────────────────────
  if (url.pathname === "/explore") {
    try {
      const forceRelaxed = url.searchParams.get("forceRelaxed") === "1";
      const filterCatRaw = url.searchParams.get("cat") || "";
      const filterSubRaw = url.searchParams.get("sub") || "";
      const filterTagRaw = url.searchParams.get("tag") || "";
      const filterTradeabilityRaw = url.searchParams.get("tradeability") || "";
      const filterSignalTagRaw = url.searchParams.get("signalTag") || "";
      const filterCat = filterCatRaw.toLowerCase();
      const filterSub = filterSubRaw.toLowerCase();
      const filterTag = filterTagRaw.toLowerCase();

      const {
        tradeCandidates: rawCandidates, movers: rawMovers, mispricing: rawMispricing, funnel,
        watchlistCount, signalsCount, mispricingCount,
        filteredOutByGuardrails, eligibleForMispricing,
        relaxedMode, thresholds, closestToThreshold,
        buckets,
      } = await buildIdeas(scanStatus, { forceRelaxed });

      function matchesFilter(item) {
        if (filterCat && (item.category || "").toLowerCase() !== filterCat) return false;
        if (filterSub && (item.subcategory || "").toLowerCase() !== filterSub) return false;
        if (filterTag && !(item.tagSlugs || []).some((t) => t.toLowerCase() === filterTag)) return false;
        if (filterSignalTagRaw) {
          const codes = Array.isArray(item.reasonCodes) && item.reasonCodes.length > 0
            ? item.reasonCodes
            : (item.signalType ? [item.signalType] : []);
          if (!codes.some((t) => String(t).trim().toLowerCase() === filterSignalTagRaw)) return false;
        }
        if (filterTradeabilityRaw) {
          const isExec = isItemExecutable(item);
          if (filterTradeabilityRaw === "EXECUTE" && !isExec) return false;
          if (filterTradeabilityRaw === "WATCH" && isExec) return false;
        }
        return true;
      }

      function isItemExecutable(item) {
        try {
          const dir = inferDirection(item);
          if (dir.action === "WATCH") return false;
          const entryNum = inferEntry(item, dir.action);
          if (entryNum === null) return false;
          const sizeNum = inferSize(item);
          const exits = inferExit(entryNum, { volatility: item.volatility });
          return sizeNum !== null && exits.tp !== null && exits.stop !== null;
        } catch (_) { return false; }
      }

      const tradeCandidates = rawCandidates.filter(matchesFilter);
      const movers = rawMovers.filter(matchesFilter);
      const mispricing = rawMispricing.filter(matchesFilter);

      if (scanStatus.lastScanId && rawCandidates.length > 0) {
        await persistShownCandidates(scanStatus.lastScanId, rawCandidates).catch(() => {});
      }

      scanStatus.lastWatchlistCount = watchlistCount || 0;
      scanStatus.lastSignalsCount = signalsCount || 0;
      scanStatus.lastInterestingCount = rawCandidates.length;
      scanStatus.lastMoverCount = rawMovers.length;
      scanStatus.lastMispricingCount = mispricingCount || 0;
      scanStatus.lastFilteredOutByGuardrails = filteredOutByGuardrails || 0;
      scanStatus.lastEligibleForMispricing = eligibleForMispricing || 0;

      const allItems = [...rawCandidates, ...rawMovers, ...rawMispricing];
      const categories = [...new Set(allItems.map((x) => x.category).filter(Boolean))].sort();
      const subcategories = [...new Set(allItems.map((x) => x.subcategory).filter(Boolean))].sort();
      const tagSlugsAll = [...new Set(allItems.flatMap((x) => x.tagSlugs || []).filter(Boolean))].sort();

      const filteredBuckets = {
        INTRADAY: (buckets ? buckets.INTRADAY : []).filter(matchesFilter),
        THIS_WEEK: (buckets ? buckets.THIS_WEEK : []).filter(matchesFilter),
        WATCH: (buckets ? buckets.WATCH : []).filter(matchesFilter),
      };

      const body = renderExplorePage({
        categories, subcategories, tagSlugsAll,
        filterActive: { cat: filterCatRaw, sub: filterSubRaw, tag: filterTagRaw, tradeability: filterTradeabilityRaw, signalTag: filterSignalTagRaw },
        tradeCandidates, movers, mispricing,
        buckets, filteredBuckets,
        thresholds, closestToThreshold,
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageShell("Explore", "/explore", body));
      return;
    } catch (err) {
      scanStatus.lastError = err.message;
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`explore error: ${err.message}`);
      return;
    }
  }

  // ── /system ────────────────────────────────────────────────────────────
  if (url.pathname === "/system") {
    const mongoOk = mongoose.connection.readyState === 1;
    const healthData = {
      ok: mongoOk,
      mongoConnected: mongoOk,
      lastScanAt: scanStatus.lastScanAt ? scanStatus.lastScanAt.toISOString() : null,
      scanRunning,
      ts: new Date().toISOString(),
    };

    let dbSnapshotCount = null;
    let dbScanCount = null;
    let recentScans = [];
    let recentCloseAttempts = [];
    let systemSettings = { autoModeEnabled: false, paperCloseEnabled: false };
    let autoSavedToday = 0;
    let ticketCloseStats = { total: 0, auto: 0, manual: 0, other: 0 };
    try {
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      [dbSnapshotCount, dbScanCount, recentScans, recentCloseAttempts, systemSettings, autoSavedToday] = await Promise.all([
        MarketSnapshot.estimatedDocumentCount(),
        Scan.estimatedDocumentCount(),
        Scan.find().sort({ startedAt: -1 }).limit(3).lean(),
        CloseAttempt.find().sort({ createdAt: -1 }).limit(10).lean(),
        SystemSetting.getSettings(),
        AutoSaveLog.countDocuments({ result: "CREATED", createdAt: { $gte: todayStart } }),
      ]);
      // Fetch ticket close breakdown
      const [totalClosed, autoClosed, manualClosed] = await Promise.all([
        TradeTicket.countDocuments({ status: "CLOSED" }),
        TradeTicket.countDocuments({ status: "CLOSED", closeReason: { $in: ["TP_HIT", "EXIT_HIT"] } }),
        TradeTicket.countDocuments({ status: "CLOSED", closeReason: "MANUAL" }),
      ]);
      ticketCloseStats = { total: totalClosed, auto: autoClosed, manual: manualClosed, other: totalClosed - autoClosed - manualClosed };
    } catch (_) {}

    const last3Scans = (recentScans || []).map((s) => ({
      scanId: s.scanId,
      durationMs: s.durationMs ?? null,
    }));

    const metrics = {
      lastScanAt: scanStatus.lastScanAt ? scanStatus.lastScanAt.toISOString() : null,
      lastScanId: scanStatus.lastScanId,
      lastTotalFetched: scanStatus.lastTotalFetched,
      savedTarget: scanStatus.lastSavedTarget,
      savedActual: scanStatus.lastSavedCount,
      lastSavedCount: scanStatus.lastSavedCount,
      lastDurationMs: scanStatus.lastDurationMs,
      eventsFetched: scanStatus.lastEventsFetched,
      marketsFlattened: scanStatus.lastMarketsFlattened,
      pagesFetched: scanStatus.lastPagesFetched,
      lastWatchlistCount: scanStatus.lastWatchlistCount,
      lastSignalsCount: scanStatus.lastSignalsCount,
      lastInterestingCount: scanStatus.lastInterestingCount,
      lastMoverCount: scanStatus.lastMoverCount,
      lastMispricingCount: scanStatus.lastMispricingCount,
      filteredOutByGuardrails: scanStatus.lastFilteredOutByGuardrails,
      eligibleForMispricing: scanStatus.lastEligibleForMispricing,
      lastError: scanStatus.lastError,
      scanRunning,
      dbSnapshotCount,
      dbScanCount,
      last3Scans,
      ts: new Date().toISOString(),
    };

    const autoModeStatus = getMonitorStatus();

    const envKillSwitches = {
      autoModeEnv: config.AUTO_MODE_ENABLED,
      paperCloseEnv: config.AUTO_MODE_PAPER_CLOSE,
    };

    // Extract persisted debug snapshot from system settings
    const debugSnapshot = systemSettings.debugNullPriceSample || null;

    const body = renderSystemPage(healthData, metrics, autoModeStatus, recentCloseAttempts, systemSettings, envKillSwitches, autoSavedToday, ticketCloseStats, debugSnapshot);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageShell("System", "/system", body));
    return;
  }

  // ── /health ────────────────────────────────────────────────────────────
  if (url.pathname === "/health") {
    const mongoOk = mongoose.connection.readyState === 1;
    const status = {
      ok: mongoOk,
      mongoConnected: mongoOk,
      lastScanAt: scanStatus.lastScanAt ? scanStatus.lastScanAt.toISOString() : null,
      scanRunning,
      ts: new Date().toISOString(),
    };
    res.writeHead(mongoOk ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
    return;
  }

  // ── /metrics ───────────────────────────────────────────────────────────
  if (url.pathname === "/metrics") {
    let dbSnapshotCount = null;
    let dbScanCount = null;
    let recentScans = [];
    try {
      [dbSnapshotCount, dbScanCount, recentScans] = await Promise.all([
        MarketSnapshot.estimatedDocumentCount(),
        Scan.estimatedDocumentCount(),
        Scan.find().sort({ startedAt: -1 }).limit(3).lean(),
      ]);
    } catch (_) {}

    const last3Scans = (recentScans || []).map((s) => ({
      scanId: s.scanId,
      durationMs: s.durationMs ?? null,
    }));

    const metrics = {
      lastScanAt: scanStatus.lastScanAt ? scanStatus.lastScanAt.toISOString() : null,
      lastScanId: scanStatus.lastScanId,
      lastTotalFetched: scanStatus.lastTotalFetched,
      savedTarget: scanStatus.lastSavedTarget,
      savedActual: scanStatus.lastSavedCount,
      lastSavedCount: scanStatus.lastSavedCount,
      lastDurationMs: scanStatus.lastDurationMs,
      eventsFetched: scanStatus.lastEventsFetched,
      marketsFlattened: scanStatus.lastMarketsFlattened,
      pagesFetched: scanStatus.lastPagesFetched,
      lastWatchlistCount: scanStatus.lastWatchlistCount,
      lastSignalsCount: scanStatus.lastSignalsCount,
      lastInterestingCount: scanStatus.lastInterestingCount,
      lastMoverCount: scanStatus.lastMoverCount,
      lastMispricingCount: scanStatus.lastMispricingCount,
      filteredOutByGuardrails: scanStatus.lastFilteredOutByGuardrails,
      eligibleForMispricing: scanStatus.lastEligibleForMispricing,
      lastError: scanStatus.lastError,
      scanRunning,
      dbSnapshotCount,
      dbScanCount,
      last3Scans,
      ts: new Date().toISOString(),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(metrics, null, 2));
    return;
  }

  // ── /scan ──────────────────────────────────────────────────────────────
  if (url.pathname === "/scan") {
    let candidates = [];
    let scanError = null;
    try {
      candidates = await runScan();
    } catch (err) {
      scanError = err.message;
      scanStatus.lastError = err.message;
    }

    // If a returnTo param is present, redirect back instead of rendering the scan page
    const ALLOWED_RETURN_PATHS = new Set(["/trade", "/ideas", "/explore"]);
    const returnTo = url.searchParams.get("returnTo");
    if (returnTo && ALLOWED_RETURN_PATHS.has(returnTo)) {
      res.writeHead(302, { Location: returnTo });
      res.end();
      return;
    }

    const failBanner = scanError
      ? `<div class="error-banner">SCAN FAILED: ${scanError}</div>`
      : "";

    const runningBanner = scanRunning
      ? '<div class="info-banner">⚠️ Scan právě probíhá na pozadí.</div>'
      : "";

    const body = `
      <h1>Scan trhu</h1>
      ${failBanner}
      ${runningBanner}
      <div class="card"><p>Scan byl právě spuštěn ručně.</p><p><a href="/ideas" style="color:#2563eb;font-weight:600;">Otevřít dashboard →</a></p></div>
      <ol class="candidates">
        ${candidates.slice(0, 30).map((item) => `
          <li class="snapshot-item">
            <strong>${item.question}</strong>
            <div class="snapshot-grid">
              <div><span class="label">YES</span> <span class="val">${item.priceYes.toFixed(3)}</span></div>
              <div><span class="label">NO</span> <span class="val">${item.priceNo.toFixed(3)}</span></div>
              <div><span class="label">spread</span> <span class="val">${item.spread.toFixed(4)}</span></div>
              <div><span class="label">liquidity</span> <span class="val">${Math.round(item.liquidity).toLocaleString("en-US")}</span></div>
              <div><span class="label">24h Vol</span> <span class="val" style="font-weight:700;">${formatVolume(item.volume24hr)}</span></div>
              <div><span class="label">endDate</span> <span class="val">${item.endDate || "-"}</span></div>
              <div><span class="label">time left</span> <span class="val">${formatHoursLeft(item.hoursLeft)}</span></div>
            </div>
          </li>
        `).join("")}
      </ol>
    `;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageShell("Scan", "/scan", body));
    return;
  }

  // ── /snapshots ─────────────────────────────────────────────────────────
  if (url.pathname === "/snapshots") {
    const items = await MarketSnapshot.find(
      {},
      {
        question: 1, marketSlug: 1, scanId: 1,
        priceYesNum: 1, priceYes: 1,
        spreadNum: 1, spread: 1,
        liquidityNum: 1, liquidity: 1,
        volume24hrNum: 1, volume24hr: 1,
        endDate: 1, hoursLeft: 1, createdAt: 1,
      }
    ).sort({ _id: -1 }).limit(100).lean();

    const body = `
      <h1>Snapshoty</h1>
      <p style="color:#6b7280;font-size:0.88rem;margin-bottom:16px;">Posledních ${items.length} záznamů</p>
      <div>
        ${items.map((item) => `
          <div class="snapshot-item">
            <strong style="font-size:0.92rem;">${item.question}</strong>
            <div class="snapshot-grid">
              <div><span class="label">scanId</span> <span class="val">${item.scanId || "-"}</span></div>
              <div><span class="label">slug</span> <span class="val">${item.marketSlug || "-"}</span></div>
              <div><span class="label">YES</span> <span class="val">${numField(item, "priceYesNum", "priceYes")}</span></div>
              <div><span class="label">spread</span> <span class="val">${numField(item, "spreadNum", "spread")}</span></div>
              <div><span class="label">liquidity</span> <span class="val">${Math.round(numField(item, "liquidityNum", "liquidity")).toLocaleString("en-US")}</span></div>
              <div><span class="label">24h Vol</span> <span class="val" style="font-weight:700;">${formatVolume(numField(item, "volume24hrNum", "volume24hr"))}</span></div>
              <div><span class="label">endDate</span> <span class="val">${item.endDate || "-"}</span></div>
              <div><span class="label">time left</span> <span class="val">${formatHoursLeft(item.hoursLeft)}</span></div>
              <div><span class="label">createdAt</span> <span class="val">${new Date(item.createdAt).toLocaleString("cs-CZ")}</span></div>
            </div>
          </div>
        `).join("")}
      </div>
    `;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageShell("Snapshoty", "/snapshots", body));
    return;
  }

  // ── /ideas ─────────────────────────────────────────────────────────────
  if (url.pathname === "/ideas") {
    try {
      const forceRelaxed = url.searchParams.get("forceRelaxed") === "1";
      const filterCatRaw = url.searchParams.get("cat") || "";
      const filterSubRaw = url.searchParams.get("sub") || "";
      const filterTagRaw = url.searchParams.get("tag") || "";
      const filterCat = filterCatRaw.toLowerCase();
      const filterSub = filterSubRaw.toLowerCase();
      const filterTag = filterTagRaw.toLowerCase();

      const {
        tradeCandidates: rawCandidates, movers: rawMovers, mispricing: rawMispricing, funnel,
        watchlistCount, signalsCount, mispricingCount,
        filteredOutByGuardrails, eligibleForMispricing,
        relaxedMode, thresholds, closestToThreshold,
        buckets,
      } = await buildIdeas(scanStatus, { forceRelaxed });

      // Apply query-param filters
      function matchesFilter(item) {
        if (filterCat && (item.category || "").toLowerCase() !== filterCat) return false;
        if (filterSub && (item.subcategory || "").toLowerCase() !== filterSub) return false;
        if (filterTag && !(item.tagSlugs || []).some((t) => t.toLowerCase() === filterTag)) return false;
        return true;
      }

      const tradeCandidates = rawCandidates.filter(matchesFilter);
      const movers = rawMovers.filter(matchesFilter);
      const mispricing = rawMispricing.filter(matchesFilter);

      if (scanStatus.lastScanId && rawCandidates.length > 0) {
        await persistShownCandidates(scanStatus.lastScanId, rawCandidates).catch(() => {});
      }

      scanStatus.lastWatchlistCount = watchlistCount || 0;
      scanStatus.lastSignalsCount = signalsCount || 0;
      scanStatus.lastInterestingCount = rawCandidates.length;
      scanStatus.lastMoverCount = rawMovers.length;
      scanStatus.lastMispricingCount = mispricingCount || 0;
      scanStatus.lastFilteredOutByGuardrails = filteredOutByGuardrails || 0;
      scanStatus.lastEligibleForMispricing = eligibleForMispricing || 0;

      const funnelWithMispricing = { ...funnel, mispricing: mispricingCount || 0 };

      // Collect distinct categories/subcategories/tags for the filter bar
      const allItems = [...rawCandidates, ...rawMovers, ...rawMispricing];
      const categories = [...new Set(allItems.map((x) => x.category).filter(Boolean))].sort();
      const subcategories = [...new Set(allItems.map((x) => x.subcategory).filter(Boolean))].sort();
      const tagSlugsAll = [...new Set(allItems.flatMap((x) => x.tagSlugs || []).filter(Boolean))].sort();

      // Apply filter to buckets too
      const filteredBuckets = {
        INTRADAY: (buckets ? buckets.INTRADAY : []).filter(matchesFilter),
        THIS_WEEK: (buckets ? buckets.THIS_WEEK : []).filter(matchesFilter),
        WATCH: (buckets ? buckets.WATCH : []).filter(matchesFilter),
      };

      const topPicks = tradeCandidates.slice(0, 10);

      const body = `
        <h1>Scanner dashboard</h1>

        ${renderTodayActions(scanStatus, funnelWithMispricing, signalsCount, relaxedMode)}

        ${renderFilterBar(categories, subcategories, tagSlugsAll, { cat: filterCatRaw, sub: filterSubRaw, tag: filterTagRaw })}

        ${buckets ? renderBucketSection("INTRADAY", filteredBuckets.INTRADAY, buckets.counts.INTRADAY, buckets.gates.INTRADAY, false) : ""}
        ${buckets ? renderBucketSection("THIS_WEEK", filteredBuckets.THIS_WEEK, buckets.counts.THIS_WEEK, buckets.gates.THIS_WEEK, false) : ""}
        ${buckets ? renderBucketSection("WATCH", filteredBuckets.WATCH.slice(0, 10), buckets.counts.WATCH, buckets.gates.WATCH, true) : ""}

        <details class="section-toggle" open>
          <summary>Top Picks (micro-trade ready) <span class="badge-count">${topPicks.length}</span></summary>
          <p style="color:#6b7280;font-size:0.85rem;margin:0 0 8px;">Up to 10 highest-scored candidates with actionable fields.</p>
          <ol class="candidates">
            ${topPicks.map((item) => {
              try { return renderTopPick(item); }
              catch (_) { return `<li class="candidate-card">render error: ${item.marketSlug}</li>`; }
            }).join("")}
          </ol>
        </details>

        ${movers.length === 0 && thresholds ? renderWhyNoMovers(thresholds, closestToThreshold) : ""}

        <details class="section-toggle">
          <summary>All trade candidates <span class="badge-count">${tradeCandidates.length}</span></summary>
          <p style="color:#6b7280;font-size:0.85rem;margin:0 0 8px;">Top 20 s diverzifikací, novinka, mispricing, pohyb a kvalita orderbooku.</p>
          <ol class="candidates">
            ${tradeCandidates.map((item) => {
              try { return renderCandidate(item); }
              catch (_) { return `<li class="candidate-card">render error: ${item.marketSlug}</li>`; }
            }).join("")}
          </ol>
        </details>

        <details class="section-toggle">
          <summary>Mispricing <span class="badge-count">${mispricing.length}</span></summary>
          <p style="color:#6b7280;font-size:0.85rem;margin:0 0 8px;">Trhy flagnuté z event nekonzistence / peer-relative offside chování.</p>
          <ol class="candidates">
            ${mispricing.map((item) => {
              try { return renderCandidate(item); }
              catch (_) { return `<li class="candidate-card">render error: ${item.marketSlug}</li>`; }
            }).join("")}
          </ol>
        </details>

        <details class="section-toggle">
          <summary>Movers <span class="badge-count">${movers.length}</span></summary>
          <p style="color:#6b7280;font-size:0.85rem;margin:0 0 8px;">Momentum / breakout s viditelným nedávným pohybem.</p>
          <ol class="candidates">
            ${movers.map((item) => {
              try { return renderCandidate(item); }
              catch (_) { return `<li class="candidate-card">render error: ${item.marketSlug}</li>`; }
            }).join("")}
          </ol>
        </details>
      `;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageShell("Dashboard", "/ideas", body));
      return;
    } catch (err) {
      scanStatus.lastError = err.message;
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`ideas error: ${err.message}`);
      return;
    }
  }

  // ── /health-ui ──────────────────────────────────────────────────────────
  if (url.pathname === "/health-ui") {
    const mongoOk = mongoose.connection.readyState === 1;
    const healthData = {
      ok: mongoOk,
      mongoConnected: mongoOk,
      lastScanAt: scanStatus.lastScanAt ? scanStatus.lastScanAt.toISOString() : null,
      scanRunning,
      ts: new Date().toISOString(),
    };
    const body = renderHealthUi(healthData);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageShell("Health", "/health-ui", body));
    return;
  }

  // ── /metrics-ui ─────────────────────────────────────────────────────────
  if (url.pathname === "/metrics-ui") {
    let dbSnapshotCount = null;
    let dbScanCount = null;
    let recentScans = [];
    try {
      [dbSnapshotCount, dbScanCount, recentScans] = await Promise.all([
        MarketSnapshot.estimatedDocumentCount(),
        Scan.estimatedDocumentCount(),
        Scan.find().sort({ startedAt: -1 }).limit(3).lean(),
      ]);
    } catch (_) {}

    const last3Scans = (recentScans || []).map((s) => ({
      scanId: s.scanId,
      durationMs: s.durationMs ?? null,
    }));

    const metrics = {
      lastScanAt: scanStatus.lastScanAt ? scanStatus.lastScanAt.toISOString() : null,
      lastScanId: scanStatus.lastScanId,
      lastTotalFetched: scanStatus.lastTotalFetched,
      savedTarget: scanStatus.lastSavedTarget,
      savedActual: scanStatus.lastSavedCount,
      lastSavedCount: scanStatus.lastSavedCount,
      lastDurationMs: scanStatus.lastDurationMs,
      eventsFetched: scanStatus.lastEventsFetched,
      marketsFlattened: scanStatus.lastMarketsFlattened,
      pagesFetched: scanStatus.lastPagesFetched,
      lastWatchlistCount: scanStatus.lastWatchlistCount,
      lastSignalsCount: scanStatus.lastSignalsCount,
      lastInterestingCount: scanStatus.lastInterestingCount,
      lastMoverCount: scanStatus.lastMoverCount,
      lastMispricingCount: scanStatus.lastMispricingCount,
      filteredOutByGuardrails: scanStatus.lastFilteredOutByGuardrails,
      eligibleForMispricing: scanStatus.lastEligibleForMispricing,
      lastError: scanStatus.lastError,
      scanRunning,
      dbSnapshotCount,
      dbScanCount,
      last3Scans,
      ts: new Date().toISOString(),
    };
    const body = renderMetricsUi(metrics);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageShell("Metrics", "/metrics-ui", body));
    return;
  }

  // ── POST /api/system/settings ──────────────────────────────────────
  if (url.pathname === "/api/system/settings" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const update = {};
        if (typeof data.autoModeEnabled === "boolean") update.autoModeEnabled = data.autoModeEnabled;
        if (typeof data.paperCloseEnabled === "boolean") update.paperCloseEnabled = data.paperCloseEnabled;
        if (typeof data.defaultAutoCloseEnabled === "boolean") update.defaultAutoCloseEnabled = data.defaultAutoCloseEnabled;
        if (typeof data.autoSaveExecuteEnabled === "boolean") update.autoSaveExecuteEnabled = data.autoSaveExecuteEnabled;
        // Risk / sizing settings (synced from Trade page for auto-save)
        if (typeof data.bankrollUsd === "number" && data.bankrollUsd > 0) update.bankrollUsd = data.bankrollUsd;
        else if (data.bankrollUsd === null) update.bankrollUsd = null;
        if (typeof data.riskPct === "number" && data.riskPct > 0) update.riskPct = data.riskPct;
        else if (data.riskPct === null) update.riskPct = null;
        if (typeof data.maxTradeCapUsd === "number" && data.maxTradeCapUsd > 0) update.maxTradeCapUsd = data.maxTradeCapUsd;
        else if (data.maxTradeCapUsd === null) update.maxTradeCapUsd = null;
        if (Object.keys(update).length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Provide at least one field: autoModeEnabled, paperCloseEnabled, defaultAutoCloseEnabled, autoSaveExecuteEnabled, bankrollUsd, riskPct, maxTradeCapUsd" }));
          return;
        }
        const doc = await SystemSetting.findOneAndUpdate(
          { _id: "system" },
          { $set: update },
          { upsert: true, new: true, lean: true }
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(doc));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── GET /api/system/diagnostics/tickets ─────────────────────────────
  if (url.pathname === "/api/system/diagnostics/tickets" && req.method === "GET") {
    try {
      const reason = url.searchParams.get("reason");
      const statusFilter = url.searchParams.get("status"); // OPEN, CLOSING, or omit
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10) || 100, 500);

      if (!reason) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing required query param: reason" }));
        return;
      }

      const VALID_REASONS = [
        "MISSING_TOKEN_ID", "NO_ORDERBOOK",
        "NO_BIDS", "INVALID_TOP_BID",
        "IDENTITY_SKIP",
        "SETTLED", "ENDED",
      ];
      if (!VALID_REASONS.includes(reason)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Invalid reason. Valid: ${VALID_REASONS.join(", ")}` }));
        return;
      }

      const query = {};

      // Reason routing: some reasons live in autoCloseBlockedReason, others in lastMonitorBlockedReason
      if (reason === "MISSING_TOKEN_ID" || reason === "NO_ORDERBOOK") {
        // Match either field — autoCloseBlockedReason is set by the monitor when it blocks,
        // lastMonitorBlockedReason is the runtime diagnostic
        query.$or = [
          { autoCloseBlockedReason: reason },
          { lastMonitorBlockedReason: reason },
        ];
      } else if (reason === "SETTLED") {
        // Settled markets: user-facing reason "SETTLED" maps to stored "MARKET_SETTLED"
        // (closeReason enum and getCurrentCloseablePrice diag use MARKET_SETTLED prefix)
        query.$or = [
          { lastMonitorBlockedReason: "MARKET_SETTLED" },
          { closeReason: "MARKET_SETTLED" },
        ];
      } else if (reason === "ENDED") {
        // Ended markets: user-facing reason "ENDED" maps to stored "MARKET_ENDED"
        query.$or = [
          { lastMonitorBlockedReason: "MARKET_ENDED" },
          { closeReason: "MARKET_ENDED" },
        ];
      } else {
        // Runtime reasons: NO_BIDS, INVALID_TOP_BID, IDENTITY_SKIP
        query.lastMonitorBlockedReason = reason;
      }

      // Status filter — for SETTLED/ENDED, include CLOSED too for operator visibility
      if (statusFilter && ["OPEN", "CLOSING", "CLOSED", "ERROR"].includes(statusFilter)) {
        query.status = statusFilter;
      } else if (reason === "SETTLED" || reason === "ENDED") {
        // Include all statuses for ended/settled so operator can see them
      } else {
        // Default: show OPEN and CLOSING tickets (actively monitored)
        query.status = { $in: ["OPEN", "CLOSING"] };
      }

      const projection = {
        _id: 1, question: 1, marketSlug: 1, conditionId: 1, action: 1,
        autoCloseEnabled: 1, autoCloseBlockedReason: 1,
        lastMonitorBlockedReason: 1, lastMonitorBlockedAt: 1,
        yesTokenId: 1, noTokenId: 1, status: 1, closeReason: 1,
        updatedAt: 1, createdAt: 1,
      };

      const tickets = await TradeTicket.find(query, projection)
        .sort({ updatedAt: -1 })
        .limit(limit)
        .lean();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ reason, count: tickets.length, tickets }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── POST /api/tickets/autoclose ────────────────────────────────────
  if (url.pathname === "/api/tickets/autoclose" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        if (!data.ticketId || typeof data.autoCloseEnabled !== "boolean") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Provide ticketId and autoCloseEnabled (boolean)" }));
          return;
        }
        if (!mongoose.Types.ObjectId.isValid(data.ticketId)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid ticketId format" }));
          return;
        }
        const ticket = await TradeTicket.findByIdAndUpdate(
          String(data.ticketId),
          { $set: { autoCloseEnabled: data.autoCloseEnabled } },
          { new: true, lean: true }
        );
        if (!ticket) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Ticket not found" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(ticket));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── POST /api/tickets/autoclose-all ─────────────────────────────────
  if (url.pathname === "/api/tickets/autoclose-all" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        if (typeof data.autoCloseEnabled !== "boolean") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Provide autoCloseEnabled (boolean)" }));
          return;
        }
        const result = await TradeTicket.updateMany(
          { status: "OPEN", tradeability: "EXECUTE" },
          { $set: { autoCloseEnabled: data.autoCloseEnabled } }
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ updated: result.modifiedCount || 0 }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── POST /api/tickets/edit ───────────────────────────────────────────
  // Edit TP / Exit (risk) on OPEN/CLOSING tickets, or closePrice on CLOSED tickets.
  if (url.pathname === "/api/tickets/edit" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        if (!data.ticketId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing ticketId" }));
          return;
        }
        if (!mongoose.Types.ObjectId.isValid(data.ticketId)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid ticketId format" }));
          return;
        }
        const ticket = await TradeTicket.findById(String(data.ticketId));
        if (!ticket) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Ticket not found" }));
          return;
        }

        let changed = false;

        // TP / Exit (risk) — editable on OPEN or CLOSING tickets
        if (ticket.status === "OPEN" || ticket.status === "CLOSING") {
          if (data.takeProfit !== undefined) {
            let v = Number(data.takeProfit);
            if (isNaN(v) || v < 0) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Invalid takeProfit" })); return; }
            if (v > 1) v = v / 100;
            ticket.takeProfit = v;
            changed = true;
          }
          if (data.riskExitLimit !== undefined) {
            let v = Number(data.riskExitLimit);
            if (isNaN(v) || v < 0) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Invalid riskExitLimit" })); return; }
            if (v > 1) v = v / 100;
            ticket.riskExitLimit = v;
            changed = true;
          }
        }

        // closePrice — editable on CLOSED tickets
        if (ticket.status === "CLOSED" && data.closePrice !== undefined) {
          let cp = Number(data.closePrice);
          if (isNaN(cp) || cp < 0) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Invalid closePrice" })); return; }
          if (cp > 1) cp = cp / 100;
          ticket.closePrice = cp;
          // Recompute PnL
          if (typeof ticket.entryLimit === "number" && ticket.entryLimit > 0 &&
              typeof ticket.maxSizeUsd === "number" && ticket.maxSizeUsd > 0) {
            const shares = ticket.maxSizeUsd / ticket.entryLimit;
            const valueExit = shares * ticket.closePrice;
            ticket.realizedPnlUsd = valueExit - ticket.maxSizeUsd;
            ticket.realizedPnlPct = ticket.realizedPnlUsd / ticket.maxSizeUsd;
          }
          changed = true;
        }

        if (!changed) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "No valid editable fields provided for this ticket status" }));
          return;
        }

        await ticket.save();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(ticket));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── POST /api/tickets ────────────────────────────────────────────────
  if (url.pathname === "/api/tickets" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        // Validate required
        if (!data.marketId || !data.question || !data.tradeability || !data.action) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing required fields: marketId, question, tradeability, action" }));
          return;
        }
        // WATCH snapshot rule
        if (data.tradeability === "WATCH") {
          data.planTbd = true;
          const numericPlanFields = [
            "entryLimit", "takeProfit", "riskExitLimit", "maxSizeUsd",
            "bankrollUsd", "riskPct", "maxTradeCapUsd",
            "pnlTpUsd", "pnlTpPct", "pnlExitUsd", "pnlExitPct",
          ];
          for (const f of numericPlanFields) data[f] = null;
        }
        // Persist canonical identity fields from the payload
        if (data.conditionId) data.conditionId = String(data.conditionId).trim() || null;
        if (data.marketSlug) data.marketSlug = String(data.marketSlug).trim() || null;
        // Persist CLOB token IDs from payload
        if (data.yesTokenId) data.yesTokenId = String(data.yesTokenId).trim() || null;
        if (data.noTokenId) data.noTokenId = String(data.noTokenId).trim() || null;
        // Strict auto-close gate: require valid conditionId for monitoring
        if (data.autoCloseEnabled) {
          const cid = data.conditionId || "";
          if (!cid || !cid.startsWith("0x")) {
            data.autoCloseEnabled = false;
            data.autoCloseBlockedReason = "no_conditionId";
          }
        }
        // --- Server-side CLOB book fetch: verify/override client entry snapshot ---
        // The server MUST NOT trust client-provided bid/ask sizes for admission gating.
        if (data.tradeability === "EXECUTE" && data.action && data.action !== "WATCH") {
          const tokenId = data.action === "BUY_YES" ? ((data.yesTokenId || "").trim() || null)
                        : data.action === "BUY_NO" ? ((data.noTokenId || "").trim() || null)
                        : null;
          if (tokenId) {
            try {
              const book = await fetchClobBook(tokenId);
              if (book) {
                // Override entry snapshot from CLOB only if normalized values are non-null
                if (book.bestBid !== null) data.entryBid = book.bestBid;
                if (book.bestAsk !== null) data.entryAsk = book.bestAsk;
                data.entryBidSize = book.topBidSize;
                data.entryAskSize = book.topAskSize;
                // Recompute derived fields from verified CLOB data
                const vBid = Number.isFinite(data.entryBid) && data.entryBid > 0;
                const vAsk = Number.isFinite(data.entryAsk) && data.entryAsk > 0;
                const mid = (vBid && vAsk) ? (data.entryAsk + data.entryBid) / 2 : null;
                data.entryMid = mid ? Math.round(mid * 10000) / 10000 : null;
                const spreadAbs = (vBid && vAsk) ? (data.entryAsk - data.entryBid) : null;
                data.entrySpreadAbs = spreadAbs !== null
                  ? Math.round(spreadAbs * 10000) / 10000 : null;
                const spreadPct = (mid && mid > 0 && spreadAbs !== null)
                  ? spreadAbs / mid : null;
                data.entrySpreadPct = spreadPct !== null
                  ? Math.round(spreadPct * 10000) / 10000 : null;
              }
            } catch (_) { /* CLOB fetch failed — use client-provided data as fallback */ }
          }
          // HARD INVARIANT: Fail-closed on missing executable bid
          // Requires: entryBid (finite > 0), entryAsk (finite > 0), entryBidSize (finite > 0)
          const vb = Number.isFinite(data.entryBid) && data.entryBid > 0;
          const va = Number.isFinite(data.entryAsk) && data.entryAsk > 0;
          const vs = Number.isFinite(data.entryBidSize) && data.entryBidSize > 0;
          if (data.autoCloseEnabled && !(vb && va && vs)) {
            data.autoCloseEnabled = false;
            data.autoCloseBlockedReason = data.autoCloseBlockedReason || "NO_EXECUTABLE_BID";
          }
          // Also verify TP/SL are valid if present
          if (data.autoCloseEnabled) {
            const vtp = Number.isFinite(data.takeProfit) && data.takeProfit > 0;
            const vsl = Number.isFinite(data.riskExitLimit) && data.riskExitLimit > 0;
            if (!vtp || !vsl) {
              data.autoCloseEnabled = false;
              data.autoCloseBlockedReason = data.autoCloseBlockedReason || "NO_EXECUTABLE_BID";
            }
          }
        }
        // Spread gate: reject wide-spread tickets entirely (same logic as autoSave)
        if (typeof data.entrySpreadPct === "number" && data.entrySpreadPct > config.MAX_ENTRY_SPREAD_PCT) {
          res.writeHead(422, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "SPREAD_TOO_WIDE", spreadPct: data.entrySpreadPct, threshold: config.MAX_ENTRY_SPREAD_PCT }));
          return;
        }
        // Bid-below-SL gate: reject if bid already at or below stop-loss (instant EXIT)
        if (typeof data.entryBid === "number" && data.entryBid > 0 &&
            typeof data.riskExitLimit === "number" && data.riskExitLimit > 0 &&
            data.entryBid <= data.riskExitLimit) {
          res.writeHead(422, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "BID_BELOW_SL", entryBid: data.entryBid, riskExitLimit: data.riskExitLimit }));
          return;
        }
        // Admission gates for auto-close: liquidity
        if (data.autoCloseEnabled && typeof data.entryBid === "number" && typeof data.entryBidSize === "number") {
          const bidNotionalUsd = data.entryBid * data.entryBidSize;
          if (bidNotionalUsd < config.MIN_BID_SIZE_USD) {
            data.autoCloseEnabled = false;
            data.autoCloseBlockedReason = data.autoCloseBlockedReason || "INSUFFICIENT_BID_SIZE";
          }
        }
        // Snapshot-level idempotency via dedupeKey
        const dedupeKey = computeDedupeKey(data);
        data.dedupeKey = dedupeKey;
        const existing = await TradeTicket.findOne({ dedupeKey }).lean();
        if (existing) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(existing));
          return;
        }
        const ticket = await TradeTicket.create(data);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(ticket));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── GET /api/tickets ─────────────────────────────────────────────────
  if (url.pathname === "/api/tickets" && req.method === "GET") {
    try {
      const statusFilter = url.searchParams.get("status");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 1000);
      const query = {};
      if (["OPEN", "CLOSING", "CLOSED", "ERROR"].includes(statusFilter)) query.status = String(statusFilter);
      const tickets = await TradeTicket.find(query).sort({ createdAt: -1 }).limit(limit).lean();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(tickets));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── POST /api/tickets/close ──────────────────────────────────────────
  if (url.pathname === "/api/tickets/close" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        if (!data.ticketId || data.closePrice === undefined || data.closePrice === null) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing ticketId or closePrice" }));
          return;
        }
        // Validate ticketId is a valid Mongo ObjectId
        if (!mongoose.Types.ObjectId.isValid(data.ticketId)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid ticketId format" }));
          return;
        }
        const ticket = await TradeTicket.findById(String(data.ticketId));
        if (!ticket) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Ticket not found" }));
          return;
        }
        if (ticket.status !== "OPEN" && ticket.status !== "CLOSING") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Ticket is not OPEN or CLOSING" }));
          return;
        }
        ticket.status = "CLOSED";
        ticket.closeReason = ticket.closeReason || "MANUAL";
        ticket.closedAt = new Date();
        let cp = Number(data.closePrice);
        if (cp > 1) cp = cp / 100;   // normalize cents → 0-1
        ticket.closePrice = cp;
        // Compute approximate realized PnL if possible
        if (typeof ticket.entryLimit === "number" && ticket.entryLimit > 0 &&
            typeof ticket.maxSizeUsd === "number" && ticket.maxSizeUsd > 0) {
          const shares = ticket.maxSizeUsd / ticket.entryLimit;
          const valueExit = shares * ticket.closePrice;
          ticket.realizedPnlUsd = valueExit - ticket.maxSizeUsd;
          ticket.realizedPnlPct = ticket.realizedPnlUsd / ticket.maxSizeUsd;
        }
        await ticket.save();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(ticket));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── /watchlist ─────────────────────────────────────────────────────────
  if (url.pathname === "/watchlist") {
    try {
      const items = await TradeTicket.find({ tradeability: "WATCH" }).sort({ createdAt: -1 }).limit(500).lean();
      const highlightId = url.searchParams.get("highlight") || null;
      const body = renderWatchlistPage(items, highlightId);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageShell("Watchlist", "/watchlist", body));
      return;
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`watchlist error: ${err.message}`);
      return;
    }
  }

  // ── /history ────────────────────────────────────────────────────────────
  if (url.pathname === "/history") {
    try {
      const rangeParam = url.searchParams.get("range") || "all";
      const customFrom = url.searchParams.get("from") || "";
      const customTo = url.searchParams.get("to") || "";

      const query = { status: "CLOSED", tradeability: { $ne: "WATCH" } };

      // Apply time filter
      if (rangeParam === "24h") {
        query.closedAt = { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) };
      } else if (rangeParam === "7d") {
        query.closedAt = { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
      } else if (rangeParam === "30d") {
        query.closedAt = { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) };
      } else if (rangeParam === "custom" && customFrom) {
        const fromDate = new Date(customFrom);
        const toDateRaw = customTo ? new Date(customTo + "T23:59:59.999Z") : new Date();
        const toDate = isNaN(toDateRaw.getTime()) ? new Date() : toDateRaw;
        if (!isNaN(fromDate.getTime())) {
          query.closedAt = { $gte: fromDate, $lte: toDate };
        }
      }

      const tickets = await TradeTicket.find(query).sort({ closedAt: -1 }).limit(500).lean();
      const body = renderHistoryPage(tickets, rangeParam, customFrom, customTo);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageShell("History", "/history", body));
      return;
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`history error: ${err.message}`);
      return;
    }
  }

  // ── /tickets ───────────────────────────────────────────────────────────
  if (url.pathname === "/tickets") {
    try {
      const query = { tradeability: { $ne: "WATCH" }, status: { $in: ["OPEN", "CLOSING", "ERROR"] } };
      const blockedReason = url.searchParams.get("blockedReason");
      const monitorReason = url.searchParams.get("monitorReason");
      if (blockedReason) query.autoCloseBlockedReason = blockedReason;
      if (monitorReason) {
        // Translate user-facing reason codes to internal stored values
        // (SETTLED → MARKET_SETTLED, ENDED → MARKET_ENDED; all others pass through)
        const REASON_MAP = { SETTLED: "MARKET_SETTLED", ENDED: "MARKET_ENDED" };
        const mapped = REASON_MAP[monitorReason] || monitorReason;
        if (REASON_MAP[monitorReason]) {
          query.$or = [
            { lastMonitorBlockedReason: mapped },
            { closeReason: mapped },
          ];
        } else {
          query.lastMonitorBlockedReason = mapped;
        }
      }
      // Fetch active tickets + closed stats in parallel
      const [tickets, closedStats] = await Promise.all([
        TradeTicket.find(query).sort({ createdAt: -1 }).limit(500).lean(),
        TradeTicket.aggregate([
          { $match: { status: "CLOSED", tradeability: { $ne: "WATCH" } } },
          { $group: {
            _id: null,
            count: { $sum: 1 },
            totalPnl: { $sum: { $ifNull: ["$realizedPnlUsd", 0] } },
            wins: { $sum: { $cond: [{ $gt: ["$realizedPnlUsd", 0] }, 1, 0] } },
            withPnl: { $sum: { $cond: [{ $ne: [{ $type: "$realizedPnlUsd" }, "missing"] }, 1, 0] } },
          }},
        ]),
      ]);
      const cs = closedStats[0] || { count: 0, totalPnl: 0, wins: 0, withPnl: 0 };
      const highlightId = url.searchParams.get("highlight") || null;
      const body = renderTicketsPage(tickets, highlightId, {
        blockedReason, monitorReason,
        closedCount: cs.count,
        realizedPnlSumUsd: cs.totalPnl,
        winRate: cs.withPnl > 0 ? (cs.wins / cs.withPnl * 100) : 0,
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageShell("Tickets", "/tickets", body));
      return;
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`tickets error: ${err.message}`);
      return;
    }
  }

  // ── /tickets/:id — Ticket Detail ──────────────────────────────────────
  const ticketDetailMatch = url.pathname.match(/^\/tickets\/([a-f0-9]{24})$/);
  if (ticketDetailMatch) {
    try {
      const ticketId = ticketDetailMatch[1];
      if (!mongoose.Types.ObjectId.isValid(ticketId)) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Invalid ticket ID");
        return;
      }
      const ticket = await TradeTicket.findById(ticketId).lean();
      if (!ticket) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Ticket not found");
        return;
      }
      // Find prev/next tickets (by createdAt, same sorting as /tickets)
      const [prevTicket, nextTicket] = await Promise.all([
        TradeTicket.findOne({ tradeability: { $ne: "WATCH" }, createdAt: { $gt: ticket.createdAt } }).sort({ createdAt: 1 }).select("_id").lean(),
        TradeTicket.findOne({ tradeability: { $ne: "WATCH" }, createdAt: { $lt: ticket.createdAt } }).sort({ createdAt: -1 }).select("_id").lean(),
      ]);
      const prevId = prevTicket ? prevTicket._id : null;
      const nextId = nextTicket ? nextTicket._id : null;
      const body = renderTicketDetailPage(ticket, prevId, nextId);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageShell("Ticket Detail", "/tickets", body));
      return;
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`ticket detail error: ${err.message}`);
      return;
    }
  }

  // ── POST /api/paper-runner — Execute ONE paper-trading lifecycle ──────
  // Scans real markets, picks one candidate, opens one paper trade, starts monitoring.
  // Uses the SAME code paths as normal autoSave + auto-monitor.
  if (url.pathname === "/api/paper-runner" && req.method === "POST") {
    const runId = `run_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
    const log = (phase, data) => PaperRunnerLog.create({ runId, phase, data }).catch(() => {});

    try {
      // 1) Run a real scan to get fresh market data
      const scanStarted = new Date();
      const result = await fetchPolymarkets();
      const rawMarkets = result.markets;
      const filtered = rawMarkets
        .filter((item) =>
          item.acceptingOrders === true &&
          item.active === true &&
          item.closed === false &&
          item.bestBid !== null &&
          item.bestAsk !== null &&
          item.spread !== null
        )
        .map(normalizeMarket)
        .sort((a, b) => {
          const aScore = Math.log(a.volume24hr + 1) * 100 + Math.log(a.liquidity + 1) * 50 - a.spread * 1000;
          const bScore = Math.log(b.volume24hr + 1) * 100 + Math.log(b.liquidity + 1) * 50 - b.spread * 1000;
          return bScore - aScore;
        });

      const saveLimit = Math.min(filtered.length, config.SAVED_PER_SCAN);
      const toUpsert = filtered.slice(0, saveLimit);
      const tempScanId = scanStarted.toISOString();
      await upsertSnapshots(toUpsert, tempScanId);

      // 2) Build ideas using signal engine (same path as /trade page + autoSave)
      const ideasResult = await buildIdeas({ ...scanStatus, lastScanId: tempScanId }, {});
      const tradeCandidates = ideasResult.tradeCandidates || [];

      // 3) Find the FIRST viable EXECUTE candidate with valid CLOB data
      let picked = null;
      let pickReason = null;
      let pickIndex = -1;

      // Load sizing settings for bankroll-aware sizing
      const paperSettings = await SystemSetting.findOne().lean().catch(() => ({})) || {};
      const paperSizingOpts = {
        bankrollUsd: typeof paperSettings.bankrollUsd === "number" && paperSettings.bankrollUsd > 0 ? paperSettings.bankrollUsd : null,
        riskPct: typeof paperSettings.riskPct === "number" && paperSettings.riskPct > 0 ? paperSettings.riskPct : null,
        maxTradeCapUsd: typeof paperSettings.maxTradeCapUsd === "number" && paperSettings.maxTradeCapUsd > 0 ? paperSettings.maxTradeCapUsd : null,
      };

      const maxCandidatesToEval = config.PAPER_RUNNER_MAX_CANDIDATES;
      // Track skip reasons for operator-grade diagnostics
      const skipReasons = {
        skipped_watch: 0,
        skipped_no_entry: 0,
        skipped_size_too_small: 0,
        skipped_no_token: 0,
        skipped_no_conditionId: 0,
        skipped_no_clob_book: 0,
        skipped_invalid_bid_ask: 0,
        skipped_exits_null: 0,
        skipped_error: 0,
      };
      for (let i = 0; i < Math.min(tradeCandidates.length, maxCandidatesToEval); i++) {
        const item = tradeCandidates[i];
        try {
          const dir = inferDirection(item);
          if (dir.action === "WATCH") { skipReasons.skipped_watch++; continue; }
          const entryNum = inferEntry(item, dir.action);
          if (entryNum === null) { skipReasons.skipped_no_entry++; continue; }
          const sizeNum = inferSize(item, paperSizingOpts);
          if (sizeNum === null || sizeNum < 5) { skipReasons.skipped_size_too_small++; continue; }

          // Require a CLOB token ID
          const tokenId = dir.action === "BUY YES"
            ? ((item.yesTokenId || "").trim() || null)
            : ((item.noTokenId || "").trim() || null);
          if (!tokenId) { skipReasons.skipped_no_token++; continue; }

          // Require valid conditionId for monitoring
          const rawConditionId = (item.conditionId || "").trim() || null;
          if (!rawConditionId || !rawConditionId.startsWith("0x")) { skipReasons.skipped_no_conditionId++; continue; }

          // Fetch real CLOB book
          const book = await fetchClobBook(tokenId);
          if (!book || book.bestBid === null || book.bestAsk === null) { skipReasons.skipped_no_clob_book++; continue; }
          if (book.topBidSize === null) { skipReasons.skipped_no_clob_book++; continue; }

          const entryBidNum = book.bestBid;
          const entryAskNum = book.bestAsk;

          // Safety: valid executable bid/ask must be > 0
          if (!(entryBidNum > 0) || !(entryAskNum > 0)) { skipReasons.skipped_invalid_bid_ask++; continue; }

          // Compute TP/SL from entry price (volatility-adaptive)
          const exits = inferExit(entryAskNum, { volatility: item.volatility });
          if (exits.tp === null || exits.stop === null) { skipReasons.skipped_exits_null++; continue; }

          picked = {
            item, dir, entryNum: entryAskNum, sizeNum,
            tpNum: exits.tp, stopNum: exits.stop,
            entryBidNum, entryAskNum,
            tokenId, rawConditionId, book,
          };
          pickIndex = i;
          pickReason = `Rank #${i + 1} of ${tradeCandidates.length}: ` +
            `${dir.action}, ask=$${entryAskNum.toFixed(4)}, bid=$${entryBidNum.toFixed(4)}, ` +
            `liq=$${Math.round(item.liquidity)}, vol24=$${Math.round(item.volume24hr)}`;
          break;
        } catch (_) { skipReasons.skipped_error++; continue; }
      }

      if (!picked) {
        await log("ERROR", {
          reason: "NO_VIABLE_CANDIDATE",
          candidatesScanned: Math.min(tradeCandidates.length, maxCandidatesToEval),
          totalCandidates: tradeCandidates.length,
          totalFetched: rawMarkets.length,
          skipReasons,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false, runId,
          error: "No viable candidate found",
          candidatesScanned: Math.min(tradeCandidates.length, maxCandidatesToEval),
          totalCandidates: tradeCandidates.length,
          skipReasons,
        }));
        return;
      }

      const { item, dir, entryNum, sizeNum, tpNum, stopNum, entryBidNum, entryAskNum, tokenId, rawConditionId, book } = picked;

      // 4) Log CANDIDATE_SELECTED
      await log("CANDIDATE_SELECTED", {
        pickIndex, pickReason,
        question: safeQuestion(item),
        conditionId: rawConditionId,
        marketSlug: item.marketSlug || null,
        action: dir.action,
        tokenId,
        liquidity: item.liquidity,
        volume24hr: item.volume24hr,
        latestYes: item.latestYes,
        reasonCodes: item.reasonCodes || [],
      });

      // 5) Log ENTRY_SNAPSHOT (raw CLOB book data at entry time)
      await log("ENTRY_SNAPSHOT", {
        tokenId,
        bestBid: book.bestBid,
        bestAsk: book.bestAsk,
        topBidSize: book.topBidSize,
        topAskSize: book.topAskSize,
        entryAsk: entryAskNum,
        entryBid: entryBidNum,
      });

      // 6) Create the paper ticket — using the SAME TradeTicket.create path
      const marketId = rawConditionId || item.marketSlug || safeQuestion(item);
      const actionEnum = dir.action === "BUY YES" ? "BUY_YES" : "BUY_NO";
      const midNum = (entryAskNum + entryBidNum) / 2;
      const spreadAbs = entryAskNum - entryBidNum;
      const spreadPct = midNum > 0 ? spreadAbs / midNum : null;

      const shares = sizeNum / entryAskNum;
      const pnlTpPct = (tpNum - entryAskNum) / entryAskNum * 100;
      const pnlStopPct = (stopNum - entryAskNum) / entryAskNum * 100;
      const pnlTpUsd = sizeNum * (tpNum - entryAskNum) / entryAskNum;
      const pnlStopUsd = sizeNum * (stopNum - entryAskNum) / entryAskNum;

      const ticketData = {
        scanId: tempScanId,
        source: "TRADE_PAGE",
        marketId,
        conditionId: rawConditionId,
        marketSlug: (item.marketSlug || "").trim() || null,
        yesTokenId: (item.yesTokenId || "").trim() || null,
        noTokenId: (item.noTokenId || "").trim() || null,
        eventSlug: item.eventSlug || null,
        eventTitle: item.eventTitle || null,
        groupItemTitle: item.groupItemTitle || null,
        marketUrl: polymarketUrl(item) || null,
        question: safeQuestion(item),
        tradeability: "EXECUTE",
        action: actionEnum,
        reasonCodes: item.reasonCodes || [],
        whyNow: whyNowSummary(item),
        planTbd: false,
        entryLimit: entryAskNum,
        takeProfit: tpNum,
        riskExitLimit: stopNum,
        maxSizeUsd: sizeNum,
        pnlTpUsd: Math.round(pnlTpUsd * 100) / 100,
        pnlTpPct: Math.round(pnlTpPct * 10) / 1000,
        pnlExitUsd: Math.round(pnlStopUsd * 100) / 100,
        pnlExitPct: Math.round(pnlStopPct * 10) / 1000,
        endDate: item.endDate || null,
        entryBid: entryBidNum,
        entryAsk: entryAskNum,
        entryMid: Math.round(midNum * 10000) / 10000,
        entrySpreadAbs: Math.round(spreadAbs * 10000) / 10000,
        entrySpreadPct: spreadPct !== null ? Math.round(spreadPct * 10000) / 10000 : null,
        entryBidSize: book.topBidSize,
        entryAskSize: book.topAskSize,
        entryExecutionBasis: "ASK",
        triggerReferenceBasis: "BID",
        autoCloseEnabled: true,
        autoCloseBlockedReason: null,
        status: "OPEN",
        isSimulated: true,
      };

      // Use a unique dedupeKey for the runner (includes runId to avoid collisions)
      ticketData.dedupeKey = crypto.createHash("sha1")
        .update(`paper-runner|${runId}|${marketId}|${actionEnum}|${entryAskNum}`)
        .digest("hex");

      const ticket = await TradeTicket.create(ticketData);

      // 7) Log PAPER_FILL
      await log("PAPER_FILL", {
        ticketId: ticket._id,
        entryFillPrice: entryAskNum,
        shares: Math.round(shares * 100) / 100,
        maxSizeUsd: sizeNum,
        takeProfit: tpNum,
        riskExitLimit: stopNum,
        triggerBasis: "BID",
        entryBasis: "ASK",
      });

      // Update the log docs with the ticketId
      await PaperRunnerLog.updateMany(
        { runId, ticketId: null },
        { $set: { ticketId: ticket._id } }
      ).catch(() => {});

      console.log(JSON.stringify({
        msg: "paper-runner-opened",
        runId,
        ticketId: String(ticket._id),
        question: safeQuestion(item),
        entryAsk: entryAskNum,
        entryBid: entryBidNum,
        tp: tpNum,
        sl: stopNum,
        shares: Math.round(shares * 100) / 100,
        maxSizeUsd: sizeNum,
        ts: new Date().toISOString(),
      }));

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        runId,
        ticketId: String(ticket._id),
        question: safeQuestion(item),
        pickReason,
        entry: {
          fillPrice: entryAskNum,
          bid: entryBidNum,
          ask: entryAskNum,
          shares: Math.round(shares * 100) / 100,
          maxSizeUsd: sizeNum,
        },
        exits: { takeProfit: tpNum, riskExitLimit: stopNum },
        monitor: "Ticket is OPEN with autoCloseEnabled=true. The existing auto-monitor will monitor and close at TP/SL using CLOB bid.",
      }));
    } catch (err) {
      await log("ERROR", { error: err.message, stack: err.stack });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, runId, error: err.message }));
    }
    return;
  }

  // ── GET /api/paper-runner/status/:runId — Audit trail for a runner ────
  const runStatusMatch = url.pathname.match(/^\/api\/paper-runner\/status\/(.+)$/);
  if (runStatusMatch && req.method === "GET") {
    try {
      const runId = decodeURIComponent(runStatusMatch[1]);
      const logs = await PaperRunnerLog.find({ runId }).sort({ ts: 1 }).lean();
      if (logs.length === 0) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Run not found" }));
        return;
      }
      // Find the ticket if it exists
      const fillLog = logs.find(l => l.phase === "PAPER_FILL");
      let ticket = null;
      if (fillLog && fillLog.ticketId) {
        ticket = await TradeTicket.findById(fillLog.ticketId).lean();
      }
      // Gather close attempts if ticket exists
      let closeAttempts = [];
      if (ticket) {
        closeAttempts = await CloseAttempt.find({ ticketId: ticket._id }).sort({ createdAt: -1 }).lean();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ runId, logs, ticket, closeAttempts }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/paper-runner/runs — List recent paper-runner runs ────────
  if (url.pathname === "/api/paper-runner/runs" && req.method === "GET") {
    try {
      // Get distinct runIds, most recent first
      const runs = await PaperRunnerLog.aggregate([
        { $group: {
          _id: "$runId",
          firstTs: { $min: "$ts" },
          lastTs: { $max: "$ts" },
          phases: { $push: "$phase" },
          ticketId: { $first: "$ticketId" },
          count: { $sum: 1 },
        }},
        { $sort: { firstTs: -1 } },
        { $limit: 50 },
      ]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ runs }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /paper-runner — Operator page ─────────────────────────────────
  if (url.pathname === "/paper-runner") {
    try {
      // Get recent runs
      const runs = await PaperRunnerLog.aggregate([
        { $group: {
          _id: "$runId",
          firstTs: { $min: "$ts" },
          lastTs: { $max: "$ts" },
          phases: { $push: "$phase" },
          ticketId: { $first: "$ticketId" },
          count: { $sum: 1 },
        }},
        { $sort: { firstTs: -1 } },
        { $limit: 20 },
      ]);

      // For each run with a ticket, get the ticket status
      const ticketIds = runs.filter(r => r.ticketId).map(r => r.ticketId);
      const tickets = ticketIds.length > 0
        ? await TradeTicket.find({ _id: { $in: ticketIds } }).lean()
        : [];
      const ticketMap = {};
      for (const t of tickets) ticketMap[String(t._id)] = t;

      // Build operator page HTML
      let runsHtml = "";
      if (runs.length === 0) {
        runsHtml = `<p style="color:#888;margin:24px 0">No paper-runner executions yet. Use the button above to start one.</p>`;
      } else {
        for (const run of runs) {
          const tid = run.ticketId ? String(run.ticketId) : null;
          const t = tid ? ticketMap[tid] : null;
          const statusCls = t ? (t.status === "CLOSED" ? "pill-closed" : t.status === "OPEN" ? "pill-open" : "pill-watch") : "pill-watch";
          const statusLabel = t ? t.status : "NO_TICKET";
          const pnl = t && t.realizedPnlUsd !== null && t.realizedPnlUsd !== undefined
            ? `$${t.realizedPnlUsd >= 0 ? "+" : ""}${t.realizedPnlUsd.toFixed(2)} (${((t.realizedPnlPct || 0) * 100).toFixed(1)}%)`
            : "—";
          const question = t ? (t.question || "—").slice(0, 80) : "—";
          const phases = run.phases.join(" → ");
          const ts = new Date(run.firstTs).toLocaleString();

          runsHtml += `
          <div style="border:1px solid #333;border-radius:8px;padding:16px;margin-bottom:12px;background:#1a1a2e">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <span style="font-weight:600;color:#e0e0e0">${question}</span>
              <span class="${statusCls}" style="padding:2px 10px;border-radius:12px;font-size:13px">${statusLabel}</span>
            </div>
            <div style="font-size:13px;color:#aaa;margin-bottom:4px">
              <b>Run:</b> ${run._id}<br>
              <b>Started:</b> ${ts}<br>
              <b>Phases:</b> ${phases}<br>
              ${t ? `<b>Entry:</b> $${(t.entryAsk || t.entryLimit || 0).toFixed(4)} (ask) | <b>Bid at entry:</b> $${(t.entryBid || 0).toFixed(4)}<br>` : ""}
              ${t ? `<b>TP:</b> $${(t.takeProfit || 0).toFixed(4)} | <b>SL:</b> $${(t.riskExitLimit || 0).toFixed(4)}<br>` : ""}
              ${t ? `<b>Shares:</b> ${t.maxSizeUsd && t.entryLimit ? (t.maxSizeUsd / t.entryLimit).toFixed(2) : "—"} | <b>Size:</b> $${(t.maxSizeUsd || 0).toFixed(2)}<br>` : ""}
              ${t && t.lastObservedPrice ? `<b>Last observed bid:</b> $${t.lastObservedPrice.toFixed(4)}<br>` : ""}
              ${t && t.closePrice !== null && t.closePrice !== undefined ? `<b>Close price:</b> $${t.closePrice.toFixed(4)} | <b>Reason:</b> ${t.closeReason || "—"}<br>` : ""}
              <b>PnL:</b> ${pnl}
            </div>
            ${tid ? `<a href="/tickets/${tid}" style="color:#4ea8de;font-size:13px">View ticket →</a> | ` : ""}
            <a href="/api/paper-runner/status/${encodeURIComponent(run._id)}" style="color:#4ea8de;font-size:13px" target="_blank">Full audit trail (JSON) →</a>
          </div>`;
        }
      }

      const body = `
      <div style="max-width:800px;margin:0 auto;padding:24px">
        <h1 style="color:#e0e0e0;margin-bottom:8px">🧪 Paper Trading Runner</h1>
        <p style="color:#aaa;margin-bottom:20px">
          Execute one complete paper-trading lifecycle using real Polymarket data.<br>
          Scans real markets → picks one candidate → opens one paper trade → auto-monitor closes at TP/SL.
        </p>
        <div style="margin-bottom:24px">
          <button id="runBtn" onclick="runPaperTrader()" style="padding:12px 24px;background:#4ea8de;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;font-weight:600">
            ▶ Run Paper Trader (1 trade)
          </button>
          <span id="runStatus" style="margin-left:12px;color:#aaa;font-size:14px"></span>
        </div>
        <div id="runResult" style="margin-bottom:24px"></div>
        <h2 style="color:#e0e0e0;margin-bottom:12px">Recent Runs</h2>
        ${runsHtml}
      </div>
      <script>
      async function runPaperTrader() {
        const btn = document.getElementById("runBtn");
        const status = document.getElementById("runStatus");
        const result = document.getElementById("runResult");
        btn.disabled = true;
        status.textContent = "Running scan + opening trade...";
        result.innerHTML = "";
        try {
          const res = await fetch("/api/paper-runner", { method: "POST" });
          const data = await res.json();
          if (data.ok) {
            status.textContent = "✅ Trade opened!";
            result.innerHTML = '<div style="border:1px solid #2a9d2a;border-radius:8px;padding:16px;background:#1a2e1a;margin-top:12px">' +
              '<b style="color:#4ade80">Trade Opened Successfully</b><br>' +
              '<b>Ticket:</b> <a href="/tickets/' + data.ticketId + '" style="color:#4ea8de">' + data.ticketId + '</a><br>' +
              '<b>Market:</b> ' + (data.question || '—') + '<br>' +
              '<b>Reason:</b> ' + (data.pickReason || '—') + '<br>' +
              '<b>Entry (ask):</b> $' + (data.entry.fillPrice || 0).toFixed(4) + '<br>' +
              '<b>Bid at entry:</b> $' + (data.entry.bid || 0).toFixed(4) + '<br>' +
              '<b>Shares:</b> ' + (data.entry.shares || 0) + '<br>' +
              '<b>TP:</b> $' + (data.exits.takeProfit || 0).toFixed(4) + ' | <b>SL:</b> $' + (data.exits.riskExitLimit || 0).toFixed(4) + '<br>' +
              '<b>Run ID:</b> ' + data.runId + '<br>' +
              '<p style="color:#aaa;margin-top:8px">' + data.monitor + '</p>' +
              '</div>';
          } else {
            status.textContent = "⚠️ No trade opened";
            let skipHtml = '';
            if (data.skipReasons) {
              const sr = data.skipReasons;
              const entries = Object.entries(sr).filter(([, v]) => v > 0);
              if (entries.length > 0) {
                skipHtml = '<div style="margin-top:8px;padding:8px;background:#2a1a1a;border-radius:4px;font-size:13px">' +
                  '<b style="color:#f87171">Skip Reasons:</b><br>' +
                  entries.map(([k, v]) => '<span style="color:#aaa">' + k + ':</span> <b style="color:#fbbf24">' + v + '</b>').join('<br>') +
                  '</div>';
              }
            }
            result.innerHTML = '<div style="border:1px solid #a00;border-radius:8px;padding:16px;background:#2e1a1a;margin-top:12px">' +
              '<b style="color:#f87171">NO_VIABLE_CANDIDATE</b><br>' +
              '<span style="color:#aaa">' + (data.error || 'Unknown error') + '</span><br>' +
              '<b>Candidates scanned:</b> ' + (data.candidatesScanned || 0) + ' of ' + (data.totalCandidates || 0) +
              skipHtml +
              '</div>';
          }
        } catch (err) {
          status.textContent = "❌ Error: " + err.message;
        }
        btn.disabled = false;
      }
      </script>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageShell("Paper Runner", "/paper-runner", body));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`paper-runner error: ${err.message}`);
    }
    return;
  }

  // ── GET /api/system/danger-zone/counts ──────────────────────────────
  if (url.pathname === "/api/system/danger-zone/counts" && req.method === "GET") {
    try {
      const [allTickets, closedTickets, openClosingTickets, closeAttempts, autoSaveLogs, snapshots, scans, shownCandidates, tagCaches, monitorLeases] = await Promise.all([
        TradeTicket.countDocuments({}),
        TradeTicket.countDocuments({ status: "CLOSED" }),
        TradeTicket.countDocuments({ status: { $in: ["OPEN", "CLOSING"] } }),
        CloseAttempt.countDocuments({}),
        AutoSaveLog.countDocuments({}),
        MarketSnapshot.estimatedDocumentCount(),
        Scan.estimatedDocumentCount(),
        ShownCandidate.estimatedDocumentCount(),
        TagCache.estimatedDocumentCount(),
        MonitorLease.estimatedDocumentCount(),
      ]);
      const closedTicketIds = await TradeTicket.find({ status: "CLOSED" }).select("_id").lean();
      const closedCloseAttempts = closedTicketIds.length > 0
        ? await CloseAttempt.countDocuments({ ticketId: { $in: closedTicketIds.map(t => t._id) } })
        : 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        RESET_ALL: { tickets: allTickets, closeAttempts, autoSaveLogs },
        DELETE_CLOSED: { tickets: closedTickets, closeAttempts: closedCloseAttempts },
        DELETE_OPEN: { tickets: openClosingTickets },
        RESET_TRADES: { tickets: allTickets, closeAttempts },
        FACTORY_RESET: { tickets: allTickets, closeAttempts, autoSaveLogs, snapshots, scans, shownCandidates, tagCaches, monitorLeases },
      }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── POST /api/system/danger-zone ──────────────────────────────────────
  if (url.pathname === "/api/system/danger-zone" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const { action, confirmation } = data;

        if (!DANGER_ZONE_VALID_ACTIONS.includes(action)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Invalid action. Must be one of: ${DANGER_ZONE_VALID_ACTIONS.join(", ")}` }));
          return;
        }

        if (confirmation !== "RESET") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: 'confirmation must be exactly "RESET"' }));
          return;
        }

        const deleted = {};

        if (action === "RESET_ALL") {
          const [ticketResult, closeAttemptResult, autoSaveResult] = await Promise.all([
            TradeTicket.deleteMany({}),
            CloseAttempt.deleteMany({}),
            AutoSaveLog.deleteMany({}),
          ]);
          deleted.tickets = ticketResult.deletedCount;
          deleted.closeAttempts = closeAttemptResult.deletedCount;
          deleted.autoSaveLogs = autoSaveResult.deletedCount;
        } else if (action === "DELETE_CLOSED") {
          const closedTickets = await TradeTicket.find({ status: "CLOSED" }).select("_id").lean();
          const closedIds = closedTickets.map(t => t._id);
          const [ticketResult, closeAttemptResult] = await Promise.all([
            TradeTicket.deleteMany({ status: "CLOSED" }),
            closedIds.length > 0
              ? CloseAttempt.deleteMany({ ticketId: { $in: closedIds } })
              : Promise.resolve({ deletedCount: 0 }),
          ]);
          deleted.tickets = ticketResult.deletedCount;
          deleted.closeAttempts = closeAttemptResult.deletedCount;
        } else if (action === "DELETE_OPEN") {
          const ticketResult = await TradeTicket.deleteMany({ status: { $in: ["OPEN", "CLOSING"] } });
          deleted.tickets = ticketResult.deletedCount;
        } else if (action === "RESET_TRADES") {
          const [ticketResult, closeAttemptResult] = await Promise.all([
            TradeTicket.deleteMany({}),
            CloseAttempt.deleteMany({}),
          ]);
          deleted.tickets = ticketResult.deletedCount;
          deleted.closeAttempts = closeAttemptResult.deletedCount;
        } else if (action === "FACTORY_RESET") {
          const [ticketResult, closeAttemptResult, autoSaveResult, snapshotResult, scanResult, shownResult, tagResult, leaseResult] = await Promise.all([
            TradeTicket.deleteMany({}),
            CloseAttempt.deleteMany({}),
            AutoSaveLog.deleteMany({}),
            MarketSnapshot.deleteMany({}),
            Scan.deleteMany({}),
            ShownCandidate.deleteMany({}),
            TagCache.deleteMany({}),
            MonitorLease.deleteMany({}),
          ]);
          // Reset the lastAutoSaveScanId so next scan can auto-save
          await SystemSetting.updateOne({ _id: "system" }, { $set: { lastAutoSaveScanId: null } });
          deleted.tickets = ticketResult.deletedCount;
          deleted.closeAttempts = closeAttemptResult.deletedCount;
          deleted.autoSaveLogs = autoSaveResult.deletedCount;
          deleted.snapshots = snapshotResult.deletedCount;
          deleted.scans = scanResult.deletedCount;
          deleted.shownCandidates = shownResult.deletedCount;
          deleted.tagCaches = tagResult.deletedCount;
          deleted.monitorLeases = leaseResult.deletedCount;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, action, deleted }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const port = config.PORT;
server.listen(port, () => {
  console.log(JSON.stringify({ msg: "server started", port, ts: new Date().toISOString() }));
  scanLoop();
  startMonitorLoop();
});
