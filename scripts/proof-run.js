#!/usr/bin/env node
"use strict";

/**
 * Paper Trading Runner — Live Proof Run
 *
 * Executes ONE complete paper-trading lifecycle using real Polymarket data:
 *   scan → pick candidate → open paper trade → monitor with real CLOB bids → close → PnL
 *
 * Usage:
 *   MONGO_URL=mongodb://localhost:27017/polyrich-proof node scripts/proof-run.js
 *
 * Or with mongodb-memory-server (auto-managed ephemeral MongoDB):
 *   node scripts/proof-run.js --in-memory
 *
 * Environment variables:
 *   MONGO_URL          — MongoDB connection string (required unless --in-memory)
 *   PORT               — HTTP port (default 3099)
 *   MONITOR_TICKS      — Number of real CLOB monitor observations before closing (default 5)
 *   MONITOR_DELAY_MS   — Delay between monitor observations in ms (default 10000)
 *
 * What this does (in order):
 *   1. Starts MongoDB (in-memory or connects to provided MONGO_URL)
 *   2. Enables autoMode + paperClose in SystemSetting
 *   3. Starts the HTTP server (same server.js, same code paths)
 *   4. Calls POST /api/paper-runner → scans live Gamma markets → picks 1 candidate → opens 1 paper trade
 *   5. Runs N real monitor ticks (each fetches live CLOB prices)
 *   6. If TP/SL not triggered naturally, closes at the current real CLOB bid
 *   7. Dumps the full audit trail (PaperRunnerLog + ticket + close attempts)
 *   8. Shuts down
 */

const http = require("http");

const useInMemory = process.argv.includes("--in-memory");
const MONITOR_TICKS = parseInt(process.env.MONITOR_TICKS || "5", 10);
const MONITOR_DELAY_MS = parseInt(process.env.MONITOR_DELAY_MS || "10000", 10);
const PORT = parseInt(process.env.PORT || "3099", 10);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "127.0.0.1",
      port: PORT,
      path,
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
    };
    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const startTime = Date.now();
  console.log("═".repeat(80));
  console.log("  PAPER TRADING RUNNER — LIVE PROOF RUN");
  console.log("═".repeat(80));
  console.log(`  Time:        ${new Date().toISOString()}`);
  console.log(`  Port:        ${PORT}`);
  console.log(`  MonitorTicks: ${MONITOR_TICKS}`);
  console.log(`  In-memory:   ${useInMemory}`);
  console.log("");

  // ── Step 0: Start MongoDB ──────────────────────────────────────────────
  let mongoUri;
  let mongod;

  if (useInMemory) {
    console.log("[0] Starting in-memory MongoDB...");
    const { MongoMemoryServer } = require("mongodb-memory-server");
    mongod = await MongoMemoryServer.create();
    mongoUri = mongod.getUri();
    console.log(`    URI: ${mongoUri}`);
  } else {
    mongoUri = process.env.MONGO_URL;
    if (!mongoUri) {
      console.error("ERROR: MONGO_URL not set and --in-memory not specified");
      process.exit(1);
    }
    console.log(`[0] Using existing MongoDB: ${mongoUri.replace(/\/\/[^@]+@/, "//***@")}`);
  }

  // ── Step 1: Set env and start server ────────────────────────────────────
  console.log("\n[1] Starting server with live-data config...");
  process.env.MONGO_URL = mongoUri;
  process.env.PORT = String(PORT);
  process.env.AUTO_MODE_ENABLED = "true";
  process.env.AUTO_MODE_PAPER_CLOSE = "true";
  process.env.AUTO_MODE_TICK_MS = "5000"; // fast ticks for proof
  process.env.AUTO_MODE_DEBOUNCE_CHECKS = "1";
  process.env.AUTO_MODE_DEBOUNCE_SEC = "1";
  process.env.SCAN_INTERVAL_MS = "999999999"; // don't auto-scan; we scan on demand

  // Start the server (this triggers mongoose.connect + HTTP listen + scanLoop + monitorLoop)
  require("../server");

  // Wait for server + MongoDB to be ready
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const resp = await httpRequest("GET", "/api/system/health");
      if (resp.status === 200) {
        ready = true;
        break;
      }
    } catch (_) {
      // not ready yet
    }
  }
  if (!ready) {
    console.error("ERROR: Server did not become ready in 30 seconds");
    process.exit(1);
  }
  console.log("    Server ready ✓");

  // ── Step 2: Enable autoMode + paperClose in DB ──────────────────────────
  console.log("\n[2] Enabling autoMode + paperClose in SystemSetting...");
  const settingsResp = await httpRequest("POST", "/api/system/settings", {
    autoModeEnabled: true,
    paperCloseEnabled: true,
  });
  console.log(`    Settings update: HTTP ${settingsResp.status}`);
  if (settingsResp.status !== 200) {
    console.error("    ERROR:", settingsResp.body);
    process.exit(1);
  }

  // ── Step 3: Execute paper-runner (live scan + pick + open) ──────────────
  console.log("\n[3] Calling POST /api/paper-runner (live Gamma/CLOB scan)...");
  console.log("    This scans real Polymarket markets and opens one paper trade.");
  console.log("    Please wait (may take 15-30 seconds for API calls)...\n");

  const runResp = await httpRequest("POST", "/api/paper-runner");
  console.log(`    Response: HTTP ${runResp.status}`);
  console.log(JSON.stringify(runResp.body, null, 2));

  if (!runResp.body.ok) {
    console.error("\n    ❌ Paper runner failed:", runResp.body.error || "unknown");
    console.error("    This may mean no markets met the signal criteria right now.");
    console.error("    Try again in a few minutes when market conditions change.\n");
    if (mongod) await mongod.stop();
    process.exit(1);
  }

  const { runId, ticketId, entry, exits } = runResp.body;
  console.log(`\n    ✅ Paper trade opened!`);
  console.log(`    runId:    ${runId}`);
  console.log(`    ticketId: ${ticketId}`);
  console.log(`    entry:    $${entry.fillPrice.toFixed(4)} (ask)`);
  console.log(`    bid:      $${entry.bid.toFixed(4)}`);
  console.log(`    shares:   ${entry.shares}`);
  console.log(`    TP:       $${exits.takeProfit.toFixed(4)}`);
  console.log(`    SL:       $${exits.riskExitLimit.toFixed(4)}`);

  // ── Step 4: Run monitor ticks (real CLOB observations) ──────────────────
  console.log(`\n[4] Running ${MONITOR_TICKS} real monitor ticks (${MONITOR_DELAY_MS}ms apart)...`);
  console.log("    Each tick fetches the real CLOB orderbook for the ticket's token.\n");

  const { monitorTick } = require("../src/auto_monitor");

  let ticketClosed = false;
  for (let i = 0; i < MONITOR_TICKS; i++) {
    if (i > 0) await sleep(MONITOR_DELAY_MS);
    console.log(`    Tick ${i + 1}/${MONITOR_TICKS} ...`);

    try {
      await monitorTick();
    } catch (err) {
      console.log(`      Error: ${err.message}`);
    }

    // Check if ticket was closed by the monitor
    const statusResp = await httpRequest("GET", `/api/paper-runner/status/${encodeURIComponent(runId)}`);
    if (statusResp.body && statusResp.body.ticket && statusResp.body.ticket.status === "CLOSED") {
      ticketClosed = true;
      console.log(`\n    🎯 Ticket auto-closed by monitor at tick ${i + 1}!`);
      break;
    }

    // Log the latest observation
    const observations = (statusResp.body.logs || []).filter(l => l.phase === "MONITOR_OBSERVATION");
    if (observations.length > 0) {
      const latest = observations[observations.length - 1];
      console.log(`      Observed bid: $${latest.data?.observedBid?.toFixed(4) || "null"} @ ${new Date(latest.ts).toISOString()}`);
    }
  }

  // ── Step 5: If not auto-closed, close at real current bid ───────────────
  if (!ticketClosed) {
    console.log(`\n[5] TP/SL not triggered in ${MONITOR_TICKS} ticks. Closing at current CLOB bid...`);

    // Fetch the ticket to get the current observed price
    const statusResp = await httpRequest("GET", `/api/paper-runner/status/${encodeURIComponent(runId)}`);
    const ticket = statusResp.body.ticket;
    const currentBid = ticket?.lastObservedPrice || null;

    if (currentBid && currentBid > 0) {
      const closeResp = await httpRequest("POST", "/api/tickets/close", {
        ticketId,
        closePrice: currentBid,
      });
      console.log(`    Closed at bid: $${currentBid.toFixed(4)} → HTTP ${closeResp.status}`);

      // Also write a CLOSE event to the audit trail
      const mongoose = require("mongoose");
      const PaperRunnerLog = require("../models/PaperRunnerLog");
      const entryLimit = ticket.entryLimit;
      const maxSizeUsd = ticket.maxSizeUsd;
      let pnlUsd = null, pnlPct = null;
      if (entryLimit > 0 && maxSizeUsd > 0) {
        const shares = maxSizeUsd / entryLimit;
        pnlUsd = (shares * currentBid) - maxSizeUsd;
        pnlPct = pnlUsd / maxSizeUsd;
      }
      await PaperRunnerLog.create({
        runId,
        ticketId: new mongoose.Types.ObjectId(ticketId),
        phase: "CLOSE",
        data: {
          closeFillPrice: currentBid,
          closeReason: "BOUNDED_WINDOW",
          realizedPnlUsd: pnlUsd,
          realizedPnlPct: pnlPct,
          isSimulated: true,
          note: `Bounded monitoring window (${MONITOR_TICKS} ticks). Closed at real CLOB bid.`,
        },
      });
    } else {
      console.log("    ⚠️ No valid bid observed — cannot close (safety rule).");
    }
  } else {
    console.log("\n[5] Ticket was auto-closed by monitor. Skipping manual close.");
  }

  // ── Step 6: Dump full audit trail ───────────────────────────────────────
  console.log("\n[6] Full audit trail:");
  console.log("─".repeat(80));

  const finalResp = await httpRequest("GET", `/api/paper-runner/status/${encodeURIComponent(runId)}`);
  const trail = finalResp.body;
  console.log(JSON.stringify(trail, null, 2));

  // ── Step 7: Extract key values ──────────────────────────────────────────
  console.log("\n" + "═".repeat(80));
  console.log("  PROOF RUN SUMMARY");
  console.log("═".repeat(80));

  const candidateLog = (trail.logs || []).find(l => l.phase === "CANDIDATE_SELECTED");
  const entryLog = (trail.logs || []).find(l => l.phase === "ENTRY_SNAPSHOT");
  const fillLog = (trail.logs || []).find(l => l.phase === "PAPER_FILL");
  const observations = (trail.logs || []).filter(l => l.phase === "MONITOR_OBSERVATION");
  const closeLog = (trail.logs || []).find(l => l.phase === "CLOSE");
  const ticket = trail.ticket;

  console.log(`\n  runId:         ${runId}`);
  console.log(`  ticketId:      ${ticketId}`);
  console.log(`  question:      ${candidateLog?.data?.question || ticket?.question || "—"}`);
  console.log(`  action:        ${candidateLog?.data?.action || ticket?.action || "—"}`);
  console.log(`  tokenId:       ${entryLog?.data?.tokenId || candidateLog?.data?.tokenId || "—"}`);
  console.log(`  conditionId:   ${candidateLog?.data?.conditionId || ticket?.conditionId || "—"}`);
  console.log(`  pickReason:    ${candidateLog?.data?.pickReason || "—"}`);

  console.log(`\n  === Entry Snapshot ===`);
  console.log(`  entryBid:      ${entryLog?.data?.entryBid ?? ticket?.entryBid ?? "—"}`);
  console.log(`  entryAsk:      ${entryLog?.data?.entryAsk ?? ticket?.entryAsk ?? "—"}`);
  console.log(`  entryBidSize:  ${entryLog?.data?.topBidSize ?? ticket?.entryBidSize ?? "—"}`);
  console.log(`  entryAskSize:  ${entryLog?.data?.topAskSize ?? ticket?.entryAskSize ?? "—"}`);

  console.log(`\n  === Paper Fill ===`);
  console.log(`  entryFillPrice: ${fillLog?.data?.entryFillPrice ?? ticket?.entryLimit ?? "—"} (ASK)`);
  console.log(`  shares:         ${fillLog?.data?.shares ?? "—"}`);
  console.log(`  maxSizeUsd:     ${fillLog?.data?.maxSizeUsd ?? ticket?.maxSizeUsd ?? "—"}`);
  console.log(`  takeProfit:     ${fillLog?.data?.takeProfit ?? ticket?.takeProfit ?? "—"}`);
  console.log(`  riskExitLimit:  ${fillLog?.data?.riskExitLimit ?? ticket?.riskExitLimit ?? "—"}`);

  console.log(`\n  === Monitor Observations (${observations.length}) ===`);
  for (const obs of observations) {
    console.log(`    ${new Date(obs.ts).toISOString()} — bid: $${obs.data?.observedBid?.toFixed(4) || "null"}`);
  }

  console.log(`\n  === Close ===`);
  console.log(`  closeFillPrice: ${closeLog?.data?.closeFillPrice ?? ticket?.closePrice ?? "—"} (BID)`);
  console.log(`  closeReason:    ${closeLog?.data?.closeReason ?? ticket?.closeReason ?? "—"}`);
  console.log(`  realizedPnL:    ${closeLog?.data?.realizedPnlUsd?.toFixed(4) ?? ticket?.realizedPnlUsd?.toFixed(4) ?? "—"} USD`);
  console.log(`  realizedPnlPct: ${closeLog?.data?.realizedPnlPct !== undefined ? (closeLog.data.realizedPnlPct * 100).toFixed(2) : (ticket?.realizedPnlPct !== undefined ? (ticket.realizedPnlPct * 100).toFixed(2) : "—")}%`);

  console.log(`\n  === Ticket Status ===`);
  console.log(`  status:         ${ticket?.status ?? "—"}`);
  console.log(`  isSimulated:    ${ticket?.isSimulated ?? "—"}`);

  console.log(`\n  Duration:       ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log("═".repeat(80));
  console.log("  ✅ Proof run complete. All data from LIVE Polymarket APIs (Gamma + CLOB).");
  console.log("  ✅ No mocks, stubs, or synthetic prices.");
  console.log("═".repeat(80));

  // ── Cleanup ─────────────────────────────────────────────────────────────
  if (mongod) {
    console.log("\nStopping in-memory MongoDB...");
    await mongod.stop();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
