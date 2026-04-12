"use strict";

/**
 * outcome_engine.js — Thesis-driven market evaluation for OUTCOME strategy mode.
 *
 * Operates on the same enriched/finalized items produced by signal_engine.js,
 * but instead of producing EXECUTE tickets with TP/SL, it:
 *   1. Extracts thesis features from each candidate
 *   2. Scores mispricing / signal quality
 *   3. Renders a verdict: WATCH / ENTER / AVOID
 *   4. Generates operator-auditable rationale
 */

const config = require("./config");
const ThesisSnapshot = require("../models/ThesisSnapshot");

// ---------------------------------------------------------------------------
// Verdict thresholds (tunable via env)
// ---------------------------------------------------------------------------
const ENTER_MIN_SIGNAL_SCORE = parseFloat(process.env.ENTER_MIN_SIGNAL_SCORE || "150");
const AVOID_SPREAD_PCT       = parseFloat(process.env.AVOID_SPREAD_PCT || "0.25");
const AVOID_MAX_EXTREME      = parseFloat(process.env.AVOID_MAX_EXTREME || "0.97");
const AVOID_MIN_EXTREME      = parseFloat(process.env.AVOID_MIN_EXTREME || "0.03");

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

/**
 * Extract thesis-relevant features from a finalized signal_engine item.
 */
function extractFeatures(item) {
  return {
    signalType: item.signalType || null,
    signalScore: item.signalScore2 || null,
    mispricingScore: item.mispricingTerm || 0,
    spreadPct: item.spreadPct || null,
    liquidity: item.liquidity || 0,
    volume24hr: item.volume24hr || 0,
    volatility: item.volatility || 0,
    absMove: item.absMove || 0,
    hoursLeft: typeof item.hoursLeft === "number" ? item.hoursLeft : null,
    latestYes: item.latestYes || null,
    bestBidNum: item.bestBidNum || 0,
    bestAskNum: item.bestAskNum || 0,
    mispricing: !!item.mispricing,
    momentum: !!item.momentum,
    breakout: !!item.breakout,
    reversal: !!item.reversal,
  };
}

// ---------------------------------------------------------------------------
// Verdict logic
// ---------------------------------------------------------------------------

/**
 * Score a candidate and produce a verdict: WATCH / ENTER / AVOID.
 *
 * AVOID gates (fail-fast):
 *   - expired market (hoursLeft ≤ 0)
 *   - extreme price (< AVOID_MIN_EXTREME or > AVOID_MAX_EXTREME)
 *   - wide spread (spreadPct > AVOID_SPREAD_PCT)
 *   - no orderbook (bestBid ≤ 0 or bestAsk ≤ 0)
 *   - filtered by guardrails (_filtered flag from signal_engine)
 *
 * ENTER requires:
 *   - isSignal (momentum/breakout/reversal/mispricing)
 *   - signalScore2 ≥ ENTER_MIN_SIGNAL_SCORE
 *   - reasonable spread (≤ AVOID_SPREAD_PCT)
 *   - reasonable price (not extreme)
 *
 * Everything else → WATCH
 */
function scoreVerdict(item) {
  const features = extractFeatures(item);

  // ── AVOID gates ──
  if (typeof item.hoursLeft === "number" && item.hoursLeft <= 0) {
    return { verdict: "AVOID", features, reason: "Market expired" };
  }
  if (item._filtered) {
    return { verdict: "AVOID", features, reason: "Failed guardrails (low liquidity, volume, or short time)" };
  }
  if (features.latestYes !== null &&
      (features.latestYes > AVOID_MAX_EXTREME || features.latestYes < AVOID_MIN_EXTREME)) {
    return { verdict: "AVOID", features, reason: `Extreme price (${(features.latestYes * 100).toFixed(1)}¢) — near-certain outcome, no edge` };
  }
  if (features.spreadPct !== null && features.spreadPct > AVOID_SPREAD_PCT) {
    return { verdict: "AVOID", features, reason: `Wide spread (${(features.spreadPct * 100).toFixed(1)}%) exceeds ${(AVOID_SPREAD_PCT * 100).toFixed(0)}% threshold` };
  }
  if (features.bestBidNum <= 0 || features.bestAskNum <= 0) {
    return { verdict: "AVOID", features, reason: "No executable orderbook — missing bid or ask" };
  }

  // ── ENTER gates ──
  const isSignal = item.mispricing || item.momentum || item.breakout || item.reversal;
  const score = features.signalScore || 0;

  if (isSignal && score >= ENTER_MIN_SIGNAL_SCORE) {
    return { verdict: "ENTER", features, reason: buildEnterRationale(item, features) };
  }

  // ── WATCH (default) ──
  return { verdict: "WATCH", features, reason: buildWatchRationale(item, features) };
}

// ---------------------------------------------------------------------------
// Rationale builders
// ---------------------------------------------------------------------------

function buildEnterRationale(item, features) {
  const parts = [];
  if (item.mispricing)  parts.push("mispricing detected (peer-Z / inconsistency)");
  if (item.momentum)    parts.push("momentum signal");
  if (item.breakout)    parts.push("breakout signal");
  if (item.reversal)    parts.push("reversal pattern");

  const score = (features.signalScore || 0).toFixed(0);
  parts.push(`signal score ${score}`);

  if (features.spreadPct !== null) {
    parts.push(`spread ${(features.spreadPct * 100).toFixed(1)}%`);
  }
  if (features.volume24hr > 0) {
    parts.push(`24h vol $${features.volume24hr.toFixed(0)}`);
  }
  if (features.hoursLeft !== null && features.hoursLeft > 0) {
    parts.push(`${features.hoursLeft.toFixed(0)}h left`);
  }

  return parts.join(" · ");
}

function buildWatchRationale(item, features) {
  const parts = [];
  const score = (features.signalScore || 0).toFixed(0);

  if (score < ENTER_MIN_SIGNAL_SCORE) {
    parts.push(`signal score ${score} below ${ENTER_MIN_SIGNAL_SCORE.toFixed(0)} threshold`);
  }

  const isSignal = item.mispricing || item.momentum || item.breakout || item.reversal;
  if (!isSignal) {
    parts.push("no active signal (momentum/breakout/reversal/mispricing)");
  }

  if (features.spreadPct !== null && features.spreadPct > 0.10) {
    parts.push(`spread ${(features.spreadPct * 100).toFixed(1)}% is elevated`);
  }

  if (parts.length === 0) parts.push("does not meet ENTER criteria");

  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Batch evaluation + persistence
// ---------------------------------------------------------------------------

/**
 * Evaluate a list of finalized items and return thesis verdicts.
 * Does NOT persist — caller decides whether to store.
 *
 * @param {Array} items - finalized items from signal_engine (enriched + finalized)
 * @returns {Array<{ item, verdict, features, rationale, reasonCodes }>}
 */
function evaluateTheses(items) {
  return items.map((item) => {
    const { verdict, features, reason } = scoreVerdict(item);
    return {
      item,
      verdict,
      features,
      rationale: reason,
      reasonCodes: item.reasonCodes || [],
    };
  });
}

/**
 * Persist thesis snapshots for a scan.
 * Only stores ENTER and WATCH verdicts by default (AVOID is noise).
 * Set includeAvoid=true to store everything.
 *
 * @param {string} scanId
 * @param {Array} theses - output of evaluateTheses()
 * @param {object} opts
 * @param {boolean} opts.includeAvoid - if true, also persist AVOID verdicts
 * @returns {number} count of snapshots persisted
 */
async function persistThesisSnapshots(scanId, theses, opts = {}) {
  const includeAvoid = opts.includeAvoid || false;

  const toStore = theses.filter((t) =>
    t.verdict === "ENTER" || t.verdict === "WATCH" || (includeAvoid && t.verdict === "AVOID")
  );

  if (toStore.length === 0) return 0;

  const docs = toStore.map((t) => ({
    scanId,
    marketId: t.item.marketSlug || t.item.conditionId || t.item.question || "",
    conditionId: t.item.conditionId || null,
    marketSlug: t.item.marketSlug || null,
    eventSlug: t.item.eventSlug || null,
    eventTitle: t.item.eventTitle || null,
    groupItemTitle: t.item.groupItemTitle || null,
    question: t.item.question || "",
    verdict: t.verdict,
    features: t.features,
    rationale: t.rationale,
    reasonCodes: t.reasonCodes,
  }));

  try {
    const result = await ThesisSnapshot.insertMany(docs, { ordered: false });
    return result.length;
  } catch (err) {
    // Partial insert is acceptable (e.g. duplicate key on retry)
    if (err.insertedDocs) return err.insertedDocs.length;
    console.warn(JSON.stringify({ msg: "persistThesisSnapshots error", scanId, err: err.message }));
    return 0;
  }
}

module.exports = {
  extractFeatures,
  scoreVerdict,
  evaluateTheses,
  persistThesisSnapshots,
  // Expose thresholds for testing
  ENTER_MIN_SIGNAL_SCORE,
  AVOID_SPREAD_PCT,
  AVOID_MAX_EXTREME,
  AVOID_MIN_EXTREME,
};
