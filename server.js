"use strict";

const http = require("http");
const mongoose = require("mongoose");

const config = require("./src/config");
const { fetchPolymarkets, fetchTags, fetchSports } = require("./src/fetcher");
const { normalizeMarket, formatHoursLeft, formatVolume, asNumber } = require("./src/normalizer");
const {
  MarketSnapshot,
  Scan,
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
  renderTicketsPage,
  renderWatchlistPage,
  pageShell,
  inferDirection,
  inferEntry,
  inferSize,
  inferExit,
} = require("./src/html_renderer");
const { startMonitorLoop, getMonitorStatus } = require("./src/auto_monitor");

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
      const {
        tradeCandidates: rawCandidates, relaxedMode,
      } = await buildIdeas(scanStatus, {});

      if (scanStatus.lastScanId && rawCandidates.length > 0) {
        await persistShownCandidates(scanStatus.lastScanId, rawCandidates).catch(() => {});
      }

      scanStatus.lastInterestingCount = rawCandidates.length;

      const body = renderTradePage(scanStatus, rawCandidates, relaxedMode);
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
    try {
      [dbSnapshotCount, dbScanCount, recentScans, recentCloseAttempts, systemSettings] = await Promise.all([
        MarketSnapshot.estimatedDocumentCount(),
        Scan.estimatedDocumentCount(),
        Scan.find().sort({ startedAt: -1 }).limit(3).lean(),
        CloseAttempt.find().sort({ createdAt: -1 }).limit(10).lean(),
        SystemSetting.getSettings(),
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

    const autoModeStatus = getMonitorStatus();

    const envKillSwitches = {
      autoModeEnv: config.AUTO_MODE_ENABLED,
      paperCloseEnv: config.AUTO_MODE_PAPER_CLOSE,
    };

    const body = renderSystemPage(healthData, metrics, autoModeStatus, recentCloseAttempts, systemSettings, envKillSwitches);
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
        if (Object.keys(update).length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Provide at least one boolean field: autoModeEnabled, paperCloseEnabled" }));
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
        ticket.closePrice = Number(data.closePrice);
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

  // ── /tickets ───────────────────────────────────────────────────────────
  if (url.pathname === "/tickets") {
    try {
      const tickets = await TradeTicket.find({ tradeability: { $ne: "WATCH" } }).sort({ createdAt: -1 }).limit(500).lean();
      const highlightId = url.searchParams.get("highlight") || null;
      const body = renderTicketsPage(tickets, highlightId);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageShell("Tickets", "/tickets", body));
      return;
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`tickets error: ${err.message}`);
      return;
    }
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
