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
  const executeItems = [];
  for (const item of cards) {
    try {
      const dir = inferDirection(item);
      if (dir.action === "WATCH") continue;
      const entryNum = inferEntry(item, dir.action);
      if (entryNum === null) continue;
      let sizeNum = inferSize(item);
      if (sizeNum === null) continue;

      // Clamp to user's settings (mirrors client-side updateCards logic)
      if (userCap !== null || userBankroll !== null) {
        const hMax = sizeNum; // heuristic max from inferSize
        let maxSizeRaw;
        if (userBankroll !== null && userRiskPct !== null) {
          const riskBudget = userBankroll * userRiskPct;
          maxSizeRaw = Math.min(userCap || Infinity, riskBudget, hMax);
        } else if (userCap !== null) {
          maxSizeRaw = Math.min(userCap, hMax);
        } else {
          maxSizeRaw = hMax;
        }
        sizeNum = Math.round(maxSizeRaw * 100) / 100;
      }

      // Skip if below min limit order ($5)
      if (sizeNum < 5) continue;

      // Bid-based TP/SL: use bestBidNum as close-price basis
      const entryBidNum = (item.bestBidNum > 0) ? item.bestBidNum : null;
      const exits = inferExit(entryNum, entryBidNum);
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
          // Override bid from CLOB if available (more accurate than Gamma snapshot)
          if (book.bestBid !== null) entryBidNum = book.bestBid;
          bidSizeRaw = book.topBidSize;
          askSizeRaw = book.topAskSize;
        }
      } catch (_) { /* CLOB fetch failed — use Gamma data */ }
      await new Promise((r) => setTimeout(r, 50)); // rate-limit CLOB calls
    }

    // Recompute TP/SL with CLOB-verified bid (may differ from Gamma screening pass)
    if (entryBidNum) {
      const clobExits = inferExit(entryNum, entryBidNum);
      if (clobExits.tp !== null && clobExits.stop !== null) {
        tpNum = clobExits.tp;
        stopNum = clobExits.stop;
      }
    }

    // Fail-closed: if entryBid is missing after CLOB fetch, block auto-close
    if (effectiveAutoClose && (typeof entryBidNum !== "number" || entryBidNum <= 0)) {
      effectiveAutoClose = false;
      autoCloseBlockedReason = autoCloseBlockedReason || "MISSING_ENTRY_EXEC_PRICES";
    }

    // --- Entry microstructure snapshot ---
    const entryAskNum = entryNum; // inferEntry returns bestAsk
    const midNum = (entryBidNum && entryAskNum) ? (entryAskNum + entryBidNum) / 2 : null;
    const spreadAbs = (entryBidNum && entryAskNum) ? (entryAskNum - entryBidNum) : null;
    const spreadPct = (midNum && midNum > 0 && spreadAbs !== null) ? spreadAbs / midNum : null;

    // --- Admission gates: liquidity ---
    // Liquidity gate: close-side = bid (selling shares). Check notional at top bid.
    if (effectiveAutoClose && entryBidNum && bidSizeRaw !== null) {
      const bidNotionalUsd = entryBidNum * bidSizeRaw;
      if (bidNotionalUsd < config.MIN_BID_SIZE_USD) {
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
          const exits = inferExit(entryNum);
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
                // Override entry snapshot from CLOB (authoritative)
                if (book.bestBid !== null) data.entryBid = book.bestBid;
                if (book.bestAsk !== null) data.entryAsk = book.bestAsk;
                data.entryBidSize = book.topBidSize;
                data.entryAskSize = book.topAskSize;
                // Recompute derived fields from verified CLOB data
                const mid = (data.entryBid && data.entryAsk)
                  ? (data.entryAsk + data.entryBid) / 2 : null;
                data.entryMid = mid ? Math.round(mid * 10000) / 10000 : null;
                const spreadAbs = (data.entryBid && data.entryAsk)
                  ? (data.entryAsk - data.entryBid) : null;
                data.entrySpreadAbs = spreadAbs !== null
                  ? Math.round(spreadAbs * 10000) / 10000 : null;
                const spreadPct = (mid && mid > 0 && spreadAbs !== null)
                  ? spreadAbs / mid : null;
                data.entrySpreadPct = spreadPct !== null
                  ? Math.round(spreadPct * 10000) / 10000 : null;
              }
            } catch (_) { /* CLOB fetch failed — use client-provided data as fallback */ }
          }
          // Fail-closed: if entryBid is missing after CLOB fetch, block auto-close
          if (data.autoCloseEnabled && (typeof data.entryBid !== "number" || data.entryBid <= 0)) {
            data.autoCloseEnabled = false;
            data.autoCloseBlockedReason = data.autoCloseBlockedReason || "MISSING_ENTRY_EXEC_PRICES";
          }
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
