"use strict";

/**
 * Per-candidate BUY YES decision trace for auto-save diagnostics.
 *
 * Pure-function core: traceAutoSaveBuyYesDecisions() takes candidates + settings
 * and returns an array of trace records, one per candidate, with the first-failing
 * gate identified.  No I/O — suitable for unit testing.
 *
 * Gate evaluation order (matches autoSaveExecuteTickets in server.js):
 *   POLICY gates (from evaluateCandidateForExecution):
 *     1. TRADEABILITY           — computeTradeability → Excluded/Watch
 *     2. DIRECTION_UNCLEAR      — no rawAction
 *     3. NO_MOVEMENT            — absMove/vol below threshold
 *     4. NO_NO_SIDE_PRICING     — BUY NO (hard block)
 *     5. NO_YES_SIDE_PRICING    — BUY YES but no bestAsk
 *     6. NO_ENTRY_PRICING       — inferEntry returns null
 *     7. SIZE_NULL               — inferSize returns null
 *     8. SIZE_TOO_SMALL          — below $5 min limit order
 *     9. NO_EXIT_LEVELS          — inferExit returns null TP/SL
 *   DATA_INTEGRITY gates (server-side, pre-CLOB):
 *     10. MISSING_CONDITION_ID   — no 0x… conditionId
 *     11. MISSING_TOKEN_ID       — no yesTokenId for BUY_YES
 *   SERVER_EXECUTION gates (require CLOB data — simulated via clobBook param):
 *     12. CLOB_FETCH_NULL        — fetchClobBook returned null
 *     13. NO_EXECUTABLE_BID      — bid/ask/bidSize/TP/SL missing after CLOB
 *     14. CLOB_SPREAD_RECHECK    — CLOB spread > MAX_ENTRY_SPREAD_PCT
 *     15. BID_BELOW_SL           — bid ≤ stop-loss
 *     16. INSUFFICIENT_BID_SIZE  — bid notional below threshold
 *   DEDUPE gate:
 *     17. DEDUPE_HIT             — existing OPEN/CLOSING ticket with same key
 */

const config = require("./config");
const {
  evaluateCandidateForExecution,
  inferDirection,
  safeQuestion,
} = require("./html_renderer");

/**
 * Evaluate all candidates and produce per-candidate trace records.
 *
 * @param {Array} candidates - tradeCandidates from buildIdeas()
 * @param {Object} sizingSettings - { bankrollUsd, riskPct, maxTradeCapUsd }
 * @param {Object} opts
 * @param {Function} [opts.fetchClobBookFn] - async (tokenId) => { bestBid, bestAsk, topBidSize, topAskSize } | null
 * @param {Function} [opts.checkDedupeFn]   - async (dedupeKey) => boolean (true = duplicate exists)
 * @param {number}   [opts.maxCandidates]   - max candidates to evaluate (default 20)
 * @returns {Promise<Array>} trace records
 */
async function traceAutoSaveBuyYesDecisions(candidates, sizingSettings, opts) {
  opts = opts || {};
  const maxCandidates = opts.maxCandidates || 20;
  const fetchClobBookFn = opts.fetchClobBookFn || (async () => null);
  const checkDedupeFn = opts.checkDedupeFn || (async () => false);

  const cards = candidates.slice(0, maxCandidates);
  const traces = [];

  for (const item of cards) {
    // Safe base info extraction — item could be null/undefined
    let baseInfo;
    try {
      baseInfo = {
        marketSlug: (item && item.marketSlug) || null,
        conditionId: (item && item.conditionId) || null,
        question: item ? (safeQuestion(item) || "").slice(0, 200) : null,
      };
    } catch (_) {
      baseInfo = { marketSlug: null, conditionId: null, question: null };
    }

    // --- Step 1: Client-side evaluation (policy gates) ---
    let evalResult;
    try {
      evalResult = evaluateCandidateForExecution(item, sizingSettings);
    } catch (err) {
      traces.push({
        ...baseInfo,
        action: null,
        firstFailGate: "EVAL_ERROR",
        reasonCode: err.message,
        decision: "ERROR",
        gateCategory: "ERROR",
        gateInputs: null,
        gateThresholds: null,
        details: { error: err.message, stack: (err.stack || "").split("\n").slice(0, 3) },
      });
      continue;
    }

    // Determine action from direction
    const actionRaw = evalResult.direction ? evalResult.direction.action : null;
    const actionEnum = actionRaw === "BUY YES" ? "BUY_YES"
                     : actionRaw === "BUY NO" ? "BUY_NO"
                     : "WATCH";

    // Skip non-BUY_YES — we only trace BUY YES in this function
    // But record a summary trace for non-BUY_YES so we see the full picture
    if (actionEnum !== "BUY_YES" && evalResult.status !== "EXECUTE") {
      // For non-EXECUTE non-BUY_YES, record the first reason code
      const firstReason = (evalResult.reasonCodes && evalResult.reasonCodes[0]) || evalResult.skipReason || "UNKNOWN";
      traces.push({
        ...baseInfo,
        action: actionEnum,
        firstFailGate: firstReason,
        reasonCode: firstReason,
        decision: "FAIL",
        gateCategory: "POLICY",
        gateInputs: {
          hoursLeft: item.hoursLeft,
          spreadPct: item.spreadPct,
          liquidity: item.liquidity,
          volume24hr: item.volume24hr,
          absMove: item.absMove,
          volatility: item.volatility,
          delta1: item.delta1,
          mispricing: !!item.mispricing,
          momentum: !!item.momentum,
          breakout: !!item.breakout,
          latestYes: item.latestYes,
          bestAskNum: item.bestAskNum,
          bestBidNum: item.bestBidNum,
        },
        gateThresholds: {
          MAX_ENTRY_SPREAD_PCT: config.MAX_ENTRY_SPREAD_PCT,
          minLiquidity: 500,
          minVolume: 50,
          maxHoursLeft: 240,
          minHoursLeft: 2,
        },
        details: {
          evalStatus: evalResult.status,
          skipReason: evalResult.skipReason,
          reasonCodes: evalResult.reasonCodes,
          reasonDetails: evalResult.reasonDetails,
          whyWatch: evalResult.whyWatch,
        },
      });
      continue;
    }

    // If EXECUTE but not BUY_YES (e.g. BUY_NO that somehow passed), still record
    if (actionEnum !== "BUY_YES" && evalResult.status === "EXECUTE") {
      traces.push({
        ...baseInfo,
        action: actionEnum,
        firstFailGate: "NOT_BUY_YES",
        reasonCode: "NOT_BUY_YES",
        decision: "FAIL",
        gateCategory: "POLICY",
        gateInputs: null,
        gateThresholds: null,
        details: { evalStatus: "EXECUTE", action: actionEnum },
      });
      continue;
    }

    // --- BUY_YES candidate from here ---

    // If evaluateCandidateForExecution returned WATCH for a BUY_YES direction,
    // it means a policy gate failed (sizing, exits, etc.)
    if (evalResult.status !== "EXECUTE") {
      const firstReason = (evalResult.reasonCodes && evalResult.reasonCodes[0]) || evalResult.skipReason || "UNKNOWN";
      traces.push({
        ...baseInfo,
        action: "BUY_YES",
        firstFailGate: firstReason,
        reasonCode: firstReason,
        decision: "FAIL",
        gateCategory: "POLICY",
        gateInputs: {
          hoursLeft: item.hoursLeft,
          spreadPct: item.spreadPct,
          liquidity: item.liquidity,
          volume24hr: item.volume24hr,
          absMove: item.absMove,
          volatility: item.volatility,
          bestAskNum: item.bestAskNum,
          bestBidNum: item.bestBidNum,
          sizeNum: evalResult.sizeNum,
        },
        gateThresholds: {
          MAX_ENTRY_SPREAD_PCT: config.MAX_ENTRY_SPREAD_PCT,
          minLiquidity: 500,
          minVolume: 50,
          MIN_LIMIT_ORDER_USD: 5,
        },
        details: {
          evalStatus: evalResult.status,
          skipReason: evalResult.skipReason,
          reasonCodes: evalResult.reasonCodes,
          reasonDetails: evalResult.reasonDetails,
          sizingBreakdown: evalResult.sizingBreakdown,
          whyWatch: evalResult.whyWatch,
        },
      });
      continue;
    }

    // --- EXECUTE BUY_YES: now run server-side gates ---
    const entryNum = evalResult.entryNum;
    const sizeNum = evalResult.sizeNum;
    const tpNum = evalResult.exits.tp;
    const stopNum = evalResult.exits.stop;
    let entryBidNum = evalResult.entryBidNum;

    const rawConditionId = (item.conditionId || "").trim() || null;
    const rawMarketSlug = (item.marketSlug || "").trim() || null;
    const marketId = rawConditionId || rawMarketSlug || item.question;

    // Gate 10: MISSING_CONDITION_ID
    const hasCanonicalId = rawConditionId && rawConditionId.startsWith("0x");
    if (!hasCanonicalId) {
      traces.push({
        ...baseInfo,
        action: "BUY_YES",
        firstFailGate: "MISSING_CONDITION_ID",
        reasonCode: "MISSING_CONDITION_ID",
        decision: "FAIL",
        gateCategory: "DATA_INTEGRITY",
        gateInputs: { conditionId: rawConditionId },
        gateThresholds: { required: "0x… prefix" },
        details: { note: "autoClose blocked but ticket would still be created (not a hard skip)" },
      });
      // Note: In actual autoSave, missing conditionId only blocks autoClose, doesn't skip.
      // But it's important for diagnostics. Continue to check remaining gates.
    }

    // Gate 11: MISSING_TOKEN_ID
    const tokenId = ((item.yesTokenId || "").trim()) || null;
    if (!tokenId) {
      traces.push({
        ...baseInfo,
        action: "BUY_YES",
        firstFailGate: "MISSING_TOKEN_ID",
        reasonCode: "MISSING_TOKEN_ID",
        decision: "FAIL",
        gateCategory: "DATA_INTEGRITY",
        gateInputs: { yesTokenId: item.yesTokenId, noTokenId: item.noTokenId },
        gateThresholds: { required: "non-empty string" },
        details: { note: "No CLOB token ID — cannot fetch orderbook" },
      });
      continue;  // Cannot proceed to CLOB gates without tokenId
    }

    // Gate 12: CLOB_FETCH_NULL
    let clobBook = null;
    let bidSizeRaw = null;
    let askSizeRaw = null;
    try {
      clobBook = await fetchClobBookFn(tokenId);
    } catch (err) {
      traces.push({
        ...baseInfo,
        action: "BUY_YES",
        firstFailGate: "CLOB_FETCH_ERROR",
        reasonCode: err.message,
        decision: "ERROR",
        gateCategory: "SERVER_EXECUTION",
        gateInputs: { tokenId },
        gateThresholds: null,
        details: { error: err.message },
      });
      continue;
    }

    if (clobBook) {
      if (clobBook.bestBid !== null) entryBidNum = clobBook.bestBid;
      bidSizeRaw = clobBook.topBidSize;
      askSizeRaw = clobBook.topAskSize;
    }

    // Gate 13: NO_EXECUTABLE_BID
    const hasValidBid  = Number.isFinite(entryBidNum) && entryBidNum > 0;
    const hasValidAsk  = Number.isFinite(entryNum) && entryNum > 0;
    const hasValidSize = Number.isFinite(bidSizeRaw) && bidSizeRaw > 0;
    const hasValidTP   = Number.isFinite(tpNum) && tpNum > 0;
    const hasValidSL   = Number.isFinite(stopNum) && stopNum > 0;

    // Note: NO_EXECUTABLE_BID only blocks autoClose, doesn't hard-skip the ticket.
    // But we record it for diagnostics.

    // Gate 14: CLOB_SPREAD_RECHECK (hard skip — no ticket created)
    const entryAskNum = entryNum;
    const midNum = (hasValidBid && entryAskNum) ? (entryAskNum + entryBidNum) / 2 : null;
    const spreadAbs = (hasValidBid && entryAskNum) ? (entryAskNum - entryBidNum) : null;
    const spreadPct = (midNum && midNum > 0 && spreadAbs !== null) ? spreadAbs / midNum : null;

    if (spreadPct !== null && spreadPct > config.MAX_ENTRY_SPREAD_PCT) {
      traces.push({
        ...baseInfo,
        action: "BUY_YES",
        firstFailGate: "CLOB_SPREAD_RECHECK",
        reasonCode: "SPREAD_TOO_WIDE",
        decision: "FAIL",
        gateCategory: "SERVER_EXECUTION",
        gateInputs: {
          entryBid: entryBidNum, entryAsk: entryNum,
          spreadPct: Math.round(spreadPct * 10000) / 10000,
          bidSize: bidSizeRaw, askSize: askSizeRaw,
          tokenId,
        },
        gateThresholds: { MAX_ENTRY_SPREAD_PCT: config.MAX_ENTRY_SPREAD_PCT },
        details: { note: "CLOB book spread exceeds threshold — ticket NOT created" },
      });
      continue;
    }

    // Gate 15: BID_BELOW_SL (hard skip)
    if (hasValidBid && stopNum > 0 && entryBidNum <= stopNum) {
      traces.push({
        ...baseInfo,
        action: "BUY_YES",
        firstFailGate: "BID_BELOW_SL",
        reasonCode: "BID_BELOW_SL",
        decision: "FAIL",
        gateCategory: "SERVER_EXECUTION",
        gateInputs: {
          entryBid: entryBidNum, stopLoss: stopNum,
          entryAsk: entryNum, bidSize: bidSizeRaw,
        },
        gateThresholds: { rule: "entryBid must be > stopLoss" },
        details: { note: "Bid already at or below SL — would trigger EXIT_HIT immediately" },
      });
      continue;
    }

    // Gate 16: INSUFFICIENT_BID_SIZE (blocks autoClose, doesn't skip ticket)
    // Record for diagnostics but don't stop ticket creation
    let insufficientBidSize = false;
    if (hasValidBid && bidSizeRaw !== null) {
      const bidNotionalUsd = entryBidNum * bidSizeRaw;
      const minBidRequired = Math.max(config.MIN_BID_SIZE_USD, sizeNum * config.MIN_BID_NOTIONAL_RATIO);
      if (bidNotionalUsd < minBidRequired) {
        insufficientBidSize = true;
      }
    }

    // Gate 17: DEDUPE_HIT (hard skip)
    const crypto = require("crypto");
    function canon(v) {
      if (v === null || v === undefined) return "null";
      if (typeof v === "number") return Number(v).toString();
      return String(v).trim();
    }
    const actionEnumStr = "BUY_YES";
    const dedupeKeyParts = [
      canon(marketId),
      canon(actionEnumStr),
      canon(entryNum),
      canon(tpNum),
      canon(stopNum),
      canon(sizeNum),
    ].join("|");
    const dedupeKey = crypto.createHash("sha1").update(dedupeKeyParts).digest("hex");

    let isDuplicate = false;
    try {
      isDuplicate = await checkDedupeFn(dedupeKey);
    } catch (err) {
      traces.push({
        ...baseInfo,
        action: "BUY_YES",
        firstFailGate: "DEDUPE_ERROR",
        reasonCode: err.message,
        decision: "ERROR",
        gateCategory: "DEDUPE",
        gateInputs: { dedupeKey },
        gateThresholds: null,
        details: { error: err.message },
      });
      continue;
    }

    if (isDuplicate) {
      traces.push({
        ...baseInfo,
        action: "BUY_YES",
        firstFailGate: "DEDUPE_HIT",
        reasonCode: "DEDUPE_HIT",
        decision: "FAIL",
        gateCategory: "DEDUPE",
        gateInputs: { dedupeKey, marketId },
        gateThresholds: { rule: "No existing OPEN/CLOSING ticket with same dedupeKey" },
        details: null,
      });
      continue;
    }

    // --- ALL GATES PASSED ---
    traces.push({
      ...baseInfo,
      action: "BUY_YES",
      firstFailGate: "PASS",
      reasonCode: null,
      decision: "PASS",
      gateCategory: "PASS",
      gateInputs: {
        entryBid: entryBidNum, entryAsk: entryNum,
        spreadPct: spreadPct !== null ? Math.round(spreadPct * 10000) / 10000 : null,
        bidSize: bidSizeRaw, askSize: askSizeRaw,
        sizeNum, tpNum, stopNum,
        tokenId, conditionId: rawConditionId,
        hasCanonicalId,
        noExecutableBid: !(hasValidBid && hasValidAsk && hasValidSize && hasValidTP && hasValidSL),
        insufficientBidSize,
      },
      gateThresholds: null,
      details: { note: "All gates passed — ticket would be created" },
    });
  }

  return traces;
}

module.exports = { traceAutoSaveBuyYesDecisions };
