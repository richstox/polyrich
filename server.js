"use strict";

const http = require("http");
const mongoose = require("mongoose");

const config = require("./src/config");
const { fetchPolymarkets } = require("./src/fetcher");
const { normalizeMarket, formatHoursLeft, formatVolume, asNumber } = require("./src/normalizer");
const {
  MarketSnapshot,
  Scan,
  upsertSnapshots,
  insertScanRecord,
  updateScanRecord,
  getLastScan,
  persistShownCandidates,
} = require("./src/persistence");
const { buildIdeas } = require("./src/signal_engine");
const { renderCandidate } = require("./src/html_renderer");

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
  lastWatchlistCount: 0,
  lastSignalsCount: 0,
  lastInterestingCount: 0,
  lastMoverCount: 0,
  lastMispricingCount: 0,
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

  try {
    data = await fetchPolymarkets();

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
      })
      .slice(0, config.SAVED_PER_SCAN);

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
    scanStatus.lastError = null;
    scanStatus.lastDurationMs = durationMs;

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
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // ── / ──────────────────────────────────────────────────────────────────
  if (url.pathname === "/") {
    const html = `
      <h1>Polyrich</h1>
      <p><a href="/scan">Spustit scan teď</a></p>
      <p><a href="/snapshots">Snapshoty</a></p>
      <p><a href="/ideas">Scanner dashboard</a></p>
      <p><a href="/health">Health</a></p>
      <p><a href="/metrics">Metrics</a></p>
    `;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
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
    try {
      [dbSnapshotCount, dbScanCount] = await Promise.all([
        MarketSnapshot.estimatedDocumentCount(),
        Scan.estimatedDocumentCount(),
      ]);
    } catch (_) {}

    const metrics = {
      lastScanAt: scanStatus.lastScanAt ? scanStatus.lastScanAt.toISOString() : null,
      lastScanId: scanStatus.lastScanId,
      lastTotalFetched: scanStatus.lastTotalFetched,
      lastSavedCount: scanStatus.lastSavedCount,
      lastDurationMs: scanStatus.lastDurationMs,
      lastWatchlistCount: scanStatus.lastWatchlistCount,
      lastSignalsCount: scanStatus.lastSignalsCount,
      lastInterestingCount: scanStatus.lastInterestingCount,
      lastMoverCount: scanStatus.lastMoverCount,
      lastMispricingCount: scanStatus.lastMispricingCount,
      lastError: scanStatus.lastError,
      scanRunning,
      dbSnapshotCount,
      dbScanCount,
      ts: new Date().toISOString(),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(metrics, null, 2));
    return;
  }

  // ── /scan ──────────────────────────────────────────────────────────────
  if (url.pathname === "/scan") {
    let candidates = [];
    try {
      candidates = await runScan();
    } catch (err) {
      scanStatus.lastError = err.message;
    }

    const html = `
      <h1>Scan trhu</h1>
      <p><a href="/">← Zpět</a></p>
      ${scanRunning ? '<p style="color:orange;">⚠️ Scan právě probíhá na pozadí.</p>' : ""}
      <p>Scan byl právě spuštěn ručně.</p>
      <p><a href="/ideas">Otevřít scanner dashboard</a></p>
      <ol>
        ${candidates.slice(0, 30).map((item) => `
          <li style="margin-bottom:18px;">
            <strong>${item.question}</strong><br>
            YES: ${item.priceYes.toFixed(3)} | NO: ${item.priceNo.toFixed(3)}<br>
            spread: ${item.spread.toFixed(4)}<br>
            liquidity: ${Math.round(item.liquidity).toLocaleString("en-US")}<br>
            24h Volume: <strong>${formatVolume(item.volume24hr)}</strong><br>
            endDate: ${item.endDate || "-"}<br>
            time left: ${formatHoursLeft(item.hoursLeft)}
          </li>
        `).join("")}
        <!--
          Note: these items come directly from normalizeMarket() (pre-DB) and already
          carry numeric fields as priceYes/spread/liquidity — not the *Num DB aliases.
        -->
      </ol>
    `;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
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

    const html = `
      <h1>Snapshoty</h1>
      <p><a href="/">← Zpět</a></p>
      <ul>
        ${items.map((item) => `
          <li style="margin-bottom:16px;">
            <strong>${item.question}</strong><br>
            scanId: ${item.scanId || "-"}<br>
            slug: ${item.marketSlug || "-"}<br>
            YES: ${typeof item.priceYesNum === "number" ? item.priceYesNum : item.priceYes}<br>
            spread: ${typeof item.spreadNum === "number" ? item.spreadNum : item.spread}<br>
            liquidity: ${Math.round(typeof item.liquidityNum === "number" ? item.liquidityNum : asNumber(item.liquidity, 0)).toLocaleString("en-US")}<br>
            <strong>24h Volume: ${formatVolume(typeof item.volume24hrNum === "number" ? item.volume24hrNum : asNumber(item.volume24hr, 0))}</strong><br>
            endDate: ${item.endDate || "-"}<br>
            time left: ${formatHoursLeft(item.hoursLeft)}<br>
            createdAt: ${new Date(item.createdAt).toLocaleString("cs-CZ")}
          </li>
        `).join("")}
      </ul>
    `;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  // ── /ideas ─────────────────────────────────────────────────────────────
  if (url.pathname === "/ideas") {
    try {
      const {
        tradeCandidates, movers, mispricing, funnel,
        watchlistCount, signalsCount, mispricingCount,
      } = await buildIdeas(scanStatus);

      if (scanStatus.lastScanId && tradeCandidates.length > 0) {
        await persistShownCandidates(scanStatus.lastScanId, tradeCandidates).catch(() => {});
      }

      scanStatus.lastWatchlistCount = watchlistCount || 0;
      scanStatus.lastSignalsCount = signalsCount || 0;
      scanStatus.lastInterestingCount = tradeCandidates.length;
      scanStatus.lastMoverCount = movers.length;
      scanStatus.lastMispricingCount = mispricingCount || 0;

      const html = `
        <h1>Scanner dashboard</h1>
        <p><a href="/">← Zpět</a></p>

        <div style="padding:12px;border:1px solid #ccc;border-radius:8px;margin-bottom:20px;">
          <p><strong>Poslední scan:</strong> ${scanStatus.lastScanAt ? scanStatus.lastScanAt.toLocaleString("cs-CZ") : "zatím neproběhl"}</p>
          <p><strong>Další scan:</strong> ${scanStatus.nextScanAt ? scanStatus.nextScanAt.toLocaleString("cs-CZ") : "nenaplánován"}</p>
          <p><strong>Aktuální scanId:</strong> ${scanStatus.lastScanId || "-"}</p>
          <p><strong>Předchozí scanId:</strong> ${scanStatus.previousScanId || "-"}</p>
          <p><strong>Chyba:</strong> ${scanStatus.lastError || "žádná"}</p>
        </div>

        <div style="padding:12px;border:1px solid #ccc;border-radius:8px;margin-bottom:20px;">
          <h2>Funnel</h2>
          <p>fetched: ${funnel.fetched}</p>
          <p>saved: ${funnel.saved}</p>
          <p>watchlist: ${funnel.watchlist}</p>
          <p>signals: ${funnel.signals}</p>
          <p>final candidates: ${funnel.finalCandidates}</p>
          <p>movers: ${funnel.movers}</p>
          <p>mispricing: ${mispricingCount || 0}</p>
        </div>

        <h2>Trade candidates</h2>
        <p>Top 20 with diversification, novelty, mispricing, movement and orderbook quality.</p>
        <ol>
          ${tradeCandidates.map((item) => {
            try { return renderCandidate(item); }
            catch (_) { return `<li>render error: ${item.marketSlug}</li>`; }
          }).join("")}
        </ol>

        <h2>Mispricing</h2>
        <p>Markets flagged from event inconsistency / peer-relative offside behavior.</p>
        <ol>
          ${mispricing.map((item) => {
            try { return renderCandidate(item); }
            catch (_) { return `<li>render error: ${item.marketSlug}</li>`; }
          }).join("")}
        </ol>

        <h2>Movers</h2>
        <p>Momentum / breakout names with visible recent movement.</p>
        <ol>
          ${movers.map((item) => {
            try { return renderCandidate(item); }
            catch (_) { return `<li>render error: ${item.marketSlug}</li>`; }
          }).join("")}
        </ol>
      `;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    } catch (err) {
      scanStatus.lastError = err.message;
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`ideas error: ${err.message}`);
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
});
