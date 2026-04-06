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
const { renderCandidate, pageShell } = require("./src/html_renderer");

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
    const body = `
      <h1>Polyrich</h1>
      <p style="color:#6b7280;margin-bottom:20px;">Scanner prediction markets. Vyberte sekci:</p>
      <div class="nav-grid">
        <a class="nav-card" href="/scan"><span class="icon">🔄</span> Spustit scan</a>
        <a class="nav-card" href="/snapshots"><span class="icon">📸</span> Snapshoty</a>
        <a class="nav-card" href="/ideas"><span class="icon">📊</span> Dashboard</a>
        <a class="nav-card" href="/health"><span class="icon">💚</span> Health</a>
        <a class="nav-card" href="/metrics"><span class="icon">📈</span> Metrics</a>
      </div>
    `;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(pageShell("Domů", "/", body));
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
      lastSavedCount: scanStatus.lastSavedCount,
      lastDurationMs: scanStatus.lastDurationMs,
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
      const {
        tradeCandidates, movers, mispricing, funnel,
        watchlistCount, signalsCount, mispricingCount,
        filteredOutByGuardrails, eligibleForMispricing,
      } = await buildIdeas(scanStatus);

      if (scanStatus.lastScanId && tradeCandidates.length > 0) {
        await persistShownCandidates(scanStatus.lastScanId, tradeCandidates).catch(() => {});
      }

      scanStatus.lastWatchlistCount = watchlistCount || 0;
      scanStatus.lastSignalsCount = signalsCount || 0;
      scanStatus.lastInterestingCount = tradeCandidates.length;
      scanStatus.lastMoverCount = movers.length;
      scanStatus.lastMispricingCount = mispricingCount || 0;
      scanStatus.lastFilteredOutByGuardrails = filteredOutByGuardrails || 0;
      scanStatus.lastEligibleForMispricing = eligibleForMispricing || 0;

      const body = `
        <h1>Scanner dashboard</h1>

        <div class="card">
          <div class="grid-2">
            <p><strong>Poslední scan:</strong> ${scanStatus.lastScanAt ? scanStatus.lastScanAt.toLocaleString("cs-CZ") : "zatím neproběhl"}</p>
            <p><strong>Další scan:</strong> ${scanStatus.nextScanAt ? scanStatus.nextScanAt.toLocaleString("cs-CZ") : "nenaplánován"}</p>
            <p><strong>Aktuální scanId:</strong> ${scanStatus.lastScanId || "-"}</p>
            <p><strong>Předchozí scanId:</strong> ${scanStatus.previousScanId || "-"}</p>
          </div>
          ${scanStatus.lastError ? `<p style="color:#b91c1c;margin-top:8px;"><strong>Chyba:</strong> ${scanStatus.lastError}</p>` : ""}
        </div>

        <div class="card">
          <h2 style="margin-top:0;">Funnel</h2>
          <div class="grid-2">
            <p><span style="color:#6b7280;">fetched:</span> <strong>${funnel.fetched}</strong></p>
            <p><span style="color:#6b7280;">saved:</span> <strong>${funnel.saved}</strong></p>
            <p><span style="color:#6b7280;">watchlist:</span> <strong>${funnel.watchlist}</strong></p>
            <p><span style="color:#6b7280;">signals:</span> <strong>${funnel.signals}</strong></p>
            <p><span style="color:#6b7280;">final candidates:</span> <strong>${funnel.finalCandidates}</strong></p>
            <p><span style="color:#6b7280;">movers:</span> <strong>${funnel.movers}</strong></p>
            <p><span style="color:#6b7280;">mispricing:</span> <strong>${mispricingCount || 0}</strong></p>
          </div>
        </div>

        <details class="section-toggle" open>
          <summary>Trade candidates <span class="badge-count">${tradeCandidates.length}</span></summary>
          <p style="color:#6b7280;font-size:0.85rem;margin:0 0 8px;">Top 20 s diverzifikací, novinka, mispricing, pohyb a kvalita orderbooku.</p>
          <ol class="candidates">
            ${tradeCandidates.map((item) => {
              try { return renderCandidate(item); }
              catch (_) { return `<li class="candidate-card">render error: ${item.marketSlug}</li>`; }
            }).join("")}
          </ol>
        </details>

        <details class="section-toggle" open>
          <summary>Mispricing <span class="badge-count">${mispricing.length}</span></summary>
          <p style="color:#6b7280;font-size:0.85rem;margin:0 0 8px;">Trhy flagnuté z event nekonzistence / peer-relative offside chování.</p>
          <ol class="candidates">
            ${mispricing.map((item) => {
              try { return renderCandidate(item); }
              catch (_) { return `<li class="candidate-card">render error: ${item.marketSlug}</li>`; }
            }).join("")}
          </ol>
        </details>

        <details class="section-toggle" open>
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
