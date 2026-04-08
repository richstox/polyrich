"use strict";

const config = require("./config");
const { MarketSnapshot, ShownCandidate } = require("./persistence");
const {
  asNumber,
  stddev,
  mean,
  median,
  quantile,
  safeGroupEvent,
  safeGroupCategory,
  computeSoftTimeBonus,
} = require("./normalizer");

const {
  HISTORY_K,
  WATCHLIST_SIZE,
  SIGNALS_SIZE,
  FINAL_CANDIDATES_SIZE,
  MOVERS_SIZE,
  NOVELTY_LOOKBACK_SCANS,
  FEE_SLIPPAGE_BUFFER,
  MAX_SPREAD_HARD,
  MISPRICING_MAX_SPREAD_PCT_STATIC,
  TIME_PENALTY_EXPIRED,
  REVERSAL_MIN_DELTA,
  REVERSAL_MIN_VOLATILITY,
} = config;

// ---------------------------------------------------------------------------
// Time-bucket constants
// ---------------------------------------------------------------------------
const BUCKET_INTRADAY_MAX = 48;   // hours
const BUCKET_THIS_WEEK_MAX = 168; // hours

function classifyBucket(hoursLeft) {
  if (hoursLeft === null || !Number.isFinite(hoursLeft)) return "WATCH";
  if (hoursLeft <= 0) return null; // expired
  if (hoursLeft <= BUCKET_INTRADAY_MAX) return "INTRADAY";
  if (hoursLeft <= BUCKET_THIS_WEEK_MAX) return "THIS_WEEK";
  return "WATCH";
}

/** Bucket-specific hard gates.  Returns true when the item PASSES the gate. */
function passesBucketGate(item, bucket, adaptiveMoveGate, adaptiveVolGate) {
  if (bucket === "INTRADAY") {
    if (item.spreadPct > 0.10) return false;
    if (item.liquidity < 5000) return false;
    if (item.volume24hr < 1000) return false;
    return (item.absMove >= adaptiveMoveGate || item.volatility >= adaptiveVolGate || item.mispricing === true);
  }
  if (bucket === "THIS_WEEK") {
    if (item.spreadPct > 0.12) return false;
    if (item.liquidity < 25000) return false;
    if (item.volume24hr < 5000) return false;
    return (item.absMove >= adaptiveMoveGate || item.volatility >= adaptiveVolGate || item.mispricing === true);
  }
  // WATCH — no hard gates
  return true;
}

function bucketTimeBonus(hoursLeft, bucketMaxHours) {
  if (!Number.isFinite(hoursLeft) || hoursLeft <= 0 || bucketMaxHours <= 0) return 0;
  const raw = (bucketMaxHours - hoursLeft) / bucketMaxHours;
  return Math.max(0, Math.min(raw, 1)) * 100;
}

// Adaptive threshold floors — used for momentum, breakout and mispricing movement gate
const MOMENTUM_FLOOR = 0.0012;
const BREAKOUT_MOVE_FLOOR = 0.0015;
const BREAKOUT_VOL_FLOOR = 0.0015;

// Mispricing eligibility gate — require real market action before allowing mispricing
const MIN_ABS_MOVE_FOR_MISPRICING = 0.005;
const MIN_VOL_FOR_MISPRICING = 0.002;

function marketKey(item) {
  return item.marketSlug || item.question;
}

// Projection to minimise DB read payload in buildIdeas
const SNAPSHOT_PROJECTION = {
  question: 1,
  eventTitle: 1,
  category: 1,
  subcategory: 1,
  marketSlug: 1,
  eventSlug: 1,
  conditionId: 1,
  groupItemTitle: 1,
  tagIds: 1,
  tagSlugs: 1,
  priceYesNum: 1,
  priceYes: 1,
  bestBidNum: 1,
  bestBid: 1,
  bestAskNum: 1,
  bestAsk: 1,
  spreadNum: 1,
  spread: 1,
  volume24hrNum: 1,
  volume24hr: 1,
  liquidityNum: 1,
  liquidity: 1,
  endDate: 1,
  hoursLeft: 1,
  scanId: 1,
  createdAt: 1,
};

async function buildIdeas(scanStatus, opts = {}) {
  if (!scanStatus.lastScanId) {
    return {
      tradeCandidates: [],
      movers: [],
      mispricing: [],
      watchlistCount: 0,
      signalsCount: 0,
      mispricingCount: 0,
      relaxedMode: false,
      thresholds: {
        globalMedianMove: 0,
        momentumThreshold: MOMENTUM_FLOOR,
        breakoutMoveThreshold: BREAKOUT_MOVE_FLOOR,
        breakoutVolThreshold: BREAKOUT_VOL_FLOOR,
      },
      closestToThreshold: [],
      funnel: {
        fetched: scanStatus.lastTotalFetched || 0,
        saved: scanStatus.lastSavedCount || 0,
        watchlist: 0,
        signals: 0,
        finalCandidates: 0,
        movers: 0,
      },
    };
  }

  const latestItems = await MarketSnapshot.find(
    { scanId: scanStatus.lastScanId },
    SNAPSHOT_PROJECTION
  ).lean();

  const marketSlugs = [...new Set(latestItems.map((item) => marketKey(item)).filter(Boolean))];

  // Efficiently fetch only last HISTORY_K snapshots per market via aggregation
  const historyGroups = await MarketSnapshot.aggregate([
    { $match: { marketSlug: { $in: marketSlugs } } },
    { $sort: { marketSlug: 1, createdAt: -1 } },
    { $group: { _id: "$marketSlug", docs: { $push: "$$ROOT" } } },
    { $project: { docs: { $slice: ["$docs", HISTORY_K] } } },
  ]);

  const historyMap = new Map();
  for (const group of historyGroups) {
    historyMap.set(group._id, group.docs);
  }

  const shownRows = await ShownCandidate.find()
    .sort({ shownAt: -1 })
    .limit(FINAL_CANDIDATES_SIZE * NOVELTY_LOOKBACK_SCANS)
    .lean();

  const recentlyShownSet = new Set(shownRows.map((r) => r.marketSlug).filter(Boolean));

  const baseEnriched = latestItems.map((item) => {
    try {
      return enrichItem(item, historyMap, recentlyShownSet);
    } catch (err) {
      console.error(JSON.stringify({
        stage: "enrich",
        marketSlug: item.marketSlug,
        err: err.message,
        ts: new Date().toISOString(),
      }));
      return null;
    }
  }).filter(Boolean);

  // Compute globalMedianMove across all enriched items for adaptive thresholds
  const allAbsMoves = baseEnriched.map((x) => x.absMove).filter((v) => v > 0);
  const globalMedianMove = median(allAbsMoves);

  // --- Adaptive threshold multipliers (may be relaxed below) ---
  let momentumMult = 2.0;
  let breakoutMoveMult = 2.5;
  let breakoutVolMult = 2.0;
  let relaxedMode = false;

  // First pass: compute signals with normal thresholds
  const applyThresholds = () => {
    for (const item of baseEnriched) {
      item.momentum =
        item.absMove >= Math.max(MOMENTUM_FLOOR, momentumMult * globalMedianMove) &&
        item.volume24hr >= 50 &&
        item.liquidity >= 500 &&
        item.spreadPct <= 0.25;

      item.breakout =
        item.absMove > Math.max(BREAKOUT_MOVE_FLOOR, breakoutMoveMult * globalMedianMove) ||
        item.volatility > Math.max(BREAKOUT_VOL_FLOOR, breakoutVolMult * globalMedianMove);
    }
  };

  applyThresholds();

  const filteredCount = baseEnriched.filter((x) => x._filtered).length;
  if (filteredCount > 0) {
    console.log(JSON.stringify({
      stage: "buildIdeas",
      msg: "guardrail-filtered markets",
      filteredCount,
      totalEnriched: baseEnriched.length,
      ts: new Date().toISOString(),
    }));
  }

  // Event-level peer analysis
  const eventGroups = new Map();
  for (const item of baseEnriched) {
    const key = item.eventGroup;
    if (!eventGroups.has(key)) eventGroups.set(key, []);
    eventGroups.get(key).push(item);
  }

  const eventInconsistencyScores = [];
  const peerZScores = [];

  for (const [, items] of eventGroups.entries()) {
    const groupYes = items.map((x) => x.latestYes);
    const sumYes = groupYes.reduce((sum, v) => sum + v, 0);
    const inconsistency = Math.abs(sumYes - 1);
    const meanYes = mean(groupYes);
    const stdYes = stddev(groupYes);
    const totalWeightBase = items.reduce((sum, x) => sum + Math.max(x.volumeScore, 0.1), 0);

    for (const item of items) {
      const weight = Math.max(item.volumeScore, 0.1) / Math.max(totalWeightBase, 1e-6);
      const eventInconsistencyScore = inconsistency * 1000 * weight;
      const z = (item.latestYes - meanYes) / (stdYes + 1e-6);
      const peerZScore = Math.abs(z) * 100;

      item.groupSize = items.length;
      item.sumYesInGroup = sumYes;
      item.inconsistency = inconsistency;
      item.eventInconsistencyScore = eventInconsistencyScore;
      item.peerZ = z;
      item.peerZScore = peerZScore;

      eventInconsistencyScores.push(eventInconsistencyScore);
      peerZScores.push(peerZScore);
    }
  }

  // Use proper quantile interpolation (replaces the old floor-based percentile)
  const inconsistencyThreshold = quantile(eventInconsistencyScores, 80);
  const peerZThreshold = quantile(peerZScores, 80);

  // --- Helper: finalize + select candidates (called once, or again after relaxation) ---
  function buildCandidatesFromEnriched() {
    const enriched = baseEnriched.map((item) => {
      try {
        return finalizeItem(item, inconsistencyThreshold, peerZThreshold);
      } catch (err) {
        console.error(JSON.stringify({
          stage: "finalize",
          marketSlug: item.marketSlug,
          err: err.message,
          ts: new Date().toISOString(),
        }));
        return null;
      }
    }).filter(Boolean);

    const tradableUniverse = enriched.filter(
      (item) => (item.hoursLeft === null || item.hoursLeft > 0) && !item._filtered
    );

    const filteredOutByGuardrails = enriched.filter((x) => x._filtered).length;
    const eligibleForMispricing = enriched.filter(
      (x) => !x._filtered && x.signalType === "mispricing"
    ).length;

    const watchlist = [...tradableUniverse]
      .sort((a, b) => {
        const aScore = a.activityTerm + a.orderbookTerm - a.costPenalty;
        const bScore = b.activityTerm + b.orderbookTerm - b.costPenalty;
        return bScore - aScore;
      })
      .slice(0, WATCHLIST_SIZE);

    const signals = watchlist
      .filter((item) => item.isSignal)
      .sort((a, b) => b.signalScore2 - a.signalScore2)
      .slice(0, SIGNALS_SIZE);

    const byType = {
      mispricing: signals.filter((x) => x.signalType === "mispricing"),
      momentumBreakout: signals.filter(
        (x) => x.signalType === "momentum" || x.signalType === "breakout"
      ),
      reversal: signals.filter((x) => x.signalType === "reversal"),
    };

    const selected = [];
    const selectedSlugSet = new Set();
    const categoryCounts = new Map();
    const eventCounts = new Map();
    const categoryCap = Math.max(1, Math.floor(FINAL_CANDIDATES_SIZE * 0.25));

    function canAdd(item) {
      if (selectedSlugSet.has(item.marketSlug)) return false;
      if ((categoryCounts.get(item.categoryGroup) || 0) >= categoryCap) return false;
      if ((eventCounts.get(item.eventGroup) || 0) >= 2) return false;
      return true;
    }

    function addItem(item) {
      selected.push(item);
      selectedSlugSet.add(item.marketSlug);
      categoryCounts.set(item.categoryGroup, (categoryCounts.get(item.categoryGroup) || 0) + 1);
      eventCounts.set(item.eventGroup, (eventCounts.get(item.eventGroup) || 0) + 1);
    }

    function takeTypeQuota(list, quota) {
      let added = 0;
      for (const item of list) {
        if (selected.length >= FINAL_CANDIDATES_SIZE) break;
        if (added >= quota) break;
        if (!canAdd(item)) continue;
        addItem(item);
        added++;
      }
    }

    const mispricingCap = Math.ceil(FINAL_CANDIDATES_SIZE * 0.30);
    takeTypeQuota(byType.mispricing, mispricingCap);
    takeTypeQuota(byType.momentumBreakout, 8);
    takeTypeQuota(byType.reversal, 4);

    // Backfill from remaining signals if we haven't hit FINAL_CANDIDATES_SIZE
    if (selected.length < FINAL_CANDIDATES_SIZE) {
      for (const item of signals) {
        if (selected.length >= FINAL_CANDIDATES_SIZE) break;
        if (!canAdd(item)) continue;
        addItem(item);
      }
    }

    // Hard ceiling: mispricing must not exceed 30% of finalCandidates
    // unless total signals < FINAL_CANDIDATES_SIZE (i.e. we can't fill otherwise).
    if (signals.length >= FINAL_CANDIDATES_SIZE) {
      const mispricingCeil = Math.ceil(selected.length * 0.30);
      const mispricingInSelected = selected.filter((x) => x.signalType === "mispricing");
      if (mispricingInSelected.length > mispricingCeil) {
        // Remove excess mispricing from the end (lowest priority) and backfill
        const excess = mispricingInSelected.length - mispricingCeil;
        let removed = 0;
        for (let i = selected.length - 1; i >= 0 && removed < excess; i--) {
          if (selected[i].signalType === "mispricing") {
            selectedSlugSet.delete(selected[i].marketSlug);
            selected.splice(i, 1);
            removed++;
          }
        }
        // Backfill with non-mispricing signals
        for (const item of signals) {
          if (selected.length >= FINAL_CANDIDATES_SIZE) break;
          if (item.signalType === "mispricing") continue;
          if (!canAdd(item)) continue;
          addItem(item);
        }
      }
    }

    const movers = watchlist
      .filter(
        (item) =>
          (item.signalType === "momentum" || item.signalType === "breakout") &&
          item.latestYes >= 0.05 &&
          item.latestYes <= 0.95
      )
      .sort((a, b) => b.absMove - a.absMove)
      .slice(0, MOVERS_SIZE);

    const mispricingList = watchlist
      .filter((item) => item.signalType === "mispricing")
      .sort((a, b) => b.mispricingTerm - a.mispricingTerm)
      .slice(0, 15);

    return { enriched, selected, signals, movers, mispricingList, watchlist, filteredOutByGuardrails, eligibleForMispricing };
  }

  // --- First pass (normal thresholds) ---
  let result = buildCandidatesFromEnriched();

  // --- Auto-adaptive fallback: relax thresholds when too few signals ---
  // Also triggers via opts.forceRelaxed for debugging.
  if ((result.signals.length < 10 || opts.forceRelaxed) && !relaxedMode) {
    const signalsBefore = result.signals.length;
    relaxedMode = true;
    momentumMult = 1.5;
    breakoutMoveMult = 2.0;
    breakoutVolMult = 1.7;
    applyThresholds();
    result = buildCandidatesFromEnriched();
    console.log(JSON.stringify({
      msg: "auto-relaxed thresholds",
      signalsBefore,
      signalsAfter: result.signals.length,
      momentumMult,
      breakoutMoveMult,
      breakoutVolMult,
      forced: !!opts.forceRelaxed,
      ts: new Date().toISOString(),
    }));
  }

  const { selected, signals, movers, mispricingList, watchlist, filteredOutByGuardrails, eligibleForMispricing } = result;

  // --- Compute "closest to threshold" markets for the "Why no movers?" card ---
  const momentumThreshold = Math.max(MOMENTUM_FLOOR, momentumMult * globalMedianMove);
  const breakoutMoveThreshold = Math.max(BREAKOUT_MOVE_FLOOR, breakoutMoveMult * globalMedianMove);
  const breakoutVolThreshold = Math.max(BREAKOUT_VOL_FLOOR, breakoutVolMult * globalMedianMove);

  const closestToThreshold = [...baseEnriched]
    .filter((x) => !x._filtered && (x.hoursLeft === null || x.hoursLeft > 0))
    .sort((a, b) => b.absMove - a.absMove)
    .slice(0, 3)
    .map((x) => ({
      question: x.question,
      marketSlug: x.marketSlug,
      absMove: x.absMove,
      volatility: x.volatility,
      momentumThreshold,
      breakoutMoveThreshold,
    }));

  // --- Time buckets: classify, gate, rank --------------------------------
  const adaptiveMoveGate = momentumThreshold;
  const adaptiveVolGate = breakoutVolThreshold;

  // Work on ALL finalized items from the enriched pool (not just selected)
  const allFinalized = result.enriched || [];

  const bucketMap = { INTRADAY: [], THIS_WEEK: [], WATCH: [] };

  for (const item of allFinalized) {
    if (item._filtered) continue;
    if (item.hoursLeft !== null && item.hoursLeft <= 0) continue;
    const bucket = classifyBucket(item.hoursLeft);
    if (!bucket) continue;

    const passesGate = passesBucketGate(item, bucket, adaptiveMoveGate, adaptiveVolGate);
    if (!passesGate && bucket !== "WATCH") continue;

    // Compute finalRank = signalScore2 + bucket-local time bonus
    const bucketMaxMap = { INTRADAY: BUCKET_INTRADAY_MAX, THIS_WEEK: BUCKET_THIS_WEEK_MAX };
    const bucketMax = bucketMaxMap[bucket] || 0;
    const tBonus = bucketTimeBonus(item.hoursLeft, bucketMax);
    const finalRank = item.signalScore2 + tBonus;

    bucketMap[bucket].push({ ...item, bucketTimeBonus: tBonus, finalRank });
  }

  // Sort each bucket by finalRank descending, cap to 10 for display
  for (const key of Object.keys(bucketMap)) {
    bucketMap[key].sort((a, b) => b.finalRank - a.finalRank);
  }
  const intradayBucket = bucketMap.INTRADAY.slice(0, 10);
  const thisWeekBucket = bucketMap.THIS_WEEK.slice(0, 10);
  const watchBucket = bucketMap.WATCH; // collapsed, show all (but UI will collapse)

  const buckets = {
    INTRADAY: intradayBucket,
    THIS_WEEK: thisWeekBucket,
    WATCH: watchBucket,
    counts: {
      INTRADAY: bucketMap.INTRADAY.length,
      THIS_WEEK: bucketMap.THIS_WEEK.length,
      WATCH: bucketMap.WATCH.length,
    },
    gates: {
      INTRADAY: "spreadPct≤10% · liq≥5k · vol24h≥1k · (move|vol|mispricing)",
      THIS_WEEK: "spreadPct≤12% · liq≥25k · vol24h≥5k · (move|vol|mispricing)",
      WATCH: "no hard gates",
    },
  };

  return {
    tradeCandidates: selected,
    movers,
    mispricing: mispricingList,
    watchlistCount: watchlist.length,
    signalsCount: signals.length,
    mispricingCount: mispricingList.length,
    filteredOutByGuardrails,
    eligibleForMispricing,
    relaxedMode,
    thresholds: {
      globalMedianMove,
      momentumThreshold,
      breakoutMoveThreshold,
      breakoutVolThreshold,
    },
    closestToThreshold,
    buckets,
    funnel: {
      fetched: scanStatus.lastTotalFetched || 0,
      saved: scanStatus.lastSavedCount || 0,
      watchlist: watchlist.length,
      signals: signals.length,
      finalCandidates: selected.length,
      movers: movers.length,
    },
  };
}

function enrichItem(item, historyMap, recentlyShownSet) {
  const key = marketKey(item);
  const historyDesc = historyMap.get(key) || [];
  const historyAsc = [...historyDesc].reverse();

  const yesSeries = historyAsc.map((h) =>
    typeof h.priceYesNum === "number" ? h.priceYesNum : asNumber(h.priceYes, 0)
  );

  const diffs = [];
  for (let i = 1; i < yesSeries.length; i++) {
    diffs.push(yesSeries[i] - yesSeries[i - 1]);
  }

  const latestYes = typeof item.priceYesNum === "number" ? item.priceYesNum : asNumber(item.priceYes, 0);
  const previousYes = yesSeries.length >= 2 ? yesSeries[yesSeries.length - 2] : latestYes;
  const delta1 = yesSeries.length >= 2 ? yesSeries[yesSeries.length - 1] - yesSeries[yesSeries.length - 2] : 0;
  const delta2 = yesSeries.length >= 3 ? yesSeries[yesSeries.length - 2] - yesSeries[yesSeries.length - 3] : 0;

  const absMove = Math.abs(delta1);
  const volatility = stddev(yesSeries);
  const recentAbsDiffs = diffs.map((d) => Math.abs(d));
  const medianRecentMove = median(recentAbsDiffs);

  const spread = typeof item.spreadNum === "number" ? item.spreadNum : asNumber(item.spread, 999);
  const volume24hr = typeof item.volume24hrNum === "number" ? item.volume24hrNum : asNumber(item.volume24hr, 0);
  const liquidity = typeof item.liquidityNum === "number" ? item.liquidityNum : asNumber(item.liquidity, 0);
  const bestBidNum = typeof item.bestBidNum === "number" ? item.bestBidNum : asNumber(item.bestBid, 0);
  const bestAskNum = typeof item.bestAskNum === "number" ? item.bestAskNum : asNumber(item.bestAsk, 0);
  const hoursLeft = typeof item.hoursLeft === "number" ? item.hoursLeft : asNumber(item.hoursLeft, null);

  // Guardrails: filter extreme illiquidity, huge spreads, or very short hoursLeft
  const _filtered =
    liquidity < 100 ||
    volume24hr < 10 ||
    spread > MAX_SPREAD_HARD ||
    (hoursLeft !== null && hoursLeft > 0 && hoursLeft < 0.5);

  // spreadPct includes configurable fee + slippage buffer to avoid misleading mispricing flags.
  // Divides by the cheaper side's price (min) to get the worst-case relative spread.
  const effectiveSpread = spread + FEE_SLIPPAGE_BUFFER;
  const spreadPct = effectiveSpread / Math.max(Math.min(latestYes, 1 - latestYes), 0.01);

  const liquidityScore = Math.log(liquidity + 1);
  const volumeScore = Math.log(volume24hr + 1);

  const moveTerm = absMove * 10000;
  const volTerm = volatility * 5000;
  const costPenalty = spreadPct * 2000;
  const activityTerm = volumeScore * 50 + liquidityScore * 20;
  const extremePenalty = (latestYes < 0.02 || latestYes > 0.98) ? 200 : 0;
  const timePenalty = (hoursLeft !== null && hoursLeft <= 0) ? TIME_PENALTY_EXPIRED : 0;
  const timeBonus = computeSoftTimeBonus(hoursLeft);

  const momentum =
    absMove >= 0.003 &&
    volume24hr >= 50 &&
    liquidity >= 500 &&
    spreadPct <= 0.25;

  const breakout =
    volatility > Math.max(medianRecentMove * 1.8, 0.0025) ||
    absMove > Math.max(medianRecentMove * 2.0, 0.0035);

  // Reversal requires at least 3 history points to be meaningful
  const reversal =
    yesSeries.length >= 3 &&
    Math.abs(delta1) >= REVERSAL_MIN_DELTA &&
    Math.abs(delta2) >= REVERSAL_MIN_DELTA &&
    Math.sign(delta1) !== 0 &&
    Math.sign(delta2) !== 0 &&
    Math.sign(delta1) !== Math.sign(delta2) &&
    volatility >= REVERSAL_MIN_VOLATILITY;

  const mid = (bestBidNum > 0 && bestAskNum > 0) ? (bestBidNum + bestAskNum) / 2 : 0;
  const microEdge = mid > 0 ? Math.abs(latestYes - mid) : 0;
  const orderbookQualityPenalty =
    (bestBidNum <= 0 || bestAskNum <= 0) ? 200 : (spreadPct > 0.25 ? 100 : 0);

  return {
    question: item.question,
    eventTitle: item.eventTitle || "",
    category: item.category || "",
    subcategory: item.subcategory || "",
    marketSlug: item.marketSlug || "",
    eventSlug: item.eventSlug || "",
    conditionId: item.conditionId || "",
    tagIds: item.tagIds || [],
    tagSlugs: item.tagSlugs || [],
    eventGroup: safeGroupEvent(item),
    categoryGroup: safeGroupCategory(item),
    latestYes,
    previousYes,
    delta1,
    delta2,
    absMove,
    volatility,
    spread,
    spreadPct,
    liquidity,
    volume24hr,
    bestBidNum,
    bestAskNum,
    mid,
    microEdge,
    orderbookQualityPenalty,
    endDate: item.endDate || "",
    hoursLeft,
    liquidityScore,
    volumeScore,
    moveTerm,
    volTerm,
    costPenalty,
    activityTerm,
    extremePenalty,
    timePenalty,
    timeBonus,
    momentum,
    breakout,
    reversal,
    historyPoints: yesSeries.length,
    recentSeries: yesSeries,
    medianRecentMove,
    noveltyBonus: recentlyShownSet.has(item.marketSlug) ? 0 : 50,
    _filtered,
  };
}

function finalizeItem(item, inconsistencyThreshold, peerZThreshold) {
  // Mispricing is only flagged for non-filtered items to avoid noise.
  // Also reject when the static spreadPct exceeds the ceiling — wide spreads
  // mechanically inflate peer-Z / inconsistency scores and create false positives.
  // Eligibility gate: mispricing requires real market action (movement OR volatility).
  const mispricingEligible =
    item.absMove >= MIN_ABS_MOVE_FOR_MISPRICING || item.volatility >= MIN_VOL_FOR_MISPRICING;
  const rawMispricing =
    !item._filtered &&
    item.spreadPct <= MISPRICING_MAX_SPREAD_PCT_STATIC &&
    (item.eventInconsistencyScore >= inconsistencyThreshold ||
      item.peerZScore >= peerZThreshold);
  const mispricing = rawMispricing && mispricingEligible;

  // item.hoursLeft is always in hours (number|null) — set by getHoursLeft() in normalizer.js
  const timeLeftHours = typeof item.hoursLeft === "number" ? item.hoursLeft : 0;

  let mispricingTerm = (item.eventInconsistencyScore || 0) * 1.0 + (item.peerZScore || 0) * 20;
  mispricingTerm = Math.min(mispricingTerm, 500);
  if (timeLeftHours > 168) mispricingTerm = 0;
  if (!mispricingEligible) mispricingTerm = 0;
  const orderbookTerm =
    (item.bestBidNum > 0 && item.bestAskNum > 0 ? 50 : -200) -
    item.spreadPct * 500 -
    item.orderbookQualityPenalty +
    Math.min(item.microEdge * 200, 50);

  const signalScore2 =
    item.moveTerm * 0.6 +
    item.volTerm * 0.4 +
    item.activityTerm +
    mispricingTerm +
    orderbookTerm -
    item.costPenalty -
    item.extremePenalty -
    item.timePenalty +
    item.timeBonus +
    item.noveltyBonus;

  let signalType = "momentum";
  if (mispricing) {
    signalType = "mispricing";
  } else if (item.reversal) {
    signalType = "reversal";
  } else if (item.breakout) {
    signalType = "breakout";
  } else if (item.momentum) {
    signalType = "momentum";
  }

  const isSignal = mispricing || item.momentum || item.breakout || item.reversal;

  // Explain why this market was selected
  const reasonCodes = [];
  if (item.momentum) reasonCodes.push("momentum");
  if (item.breakout) reasonCodes.push("breakout");
  if (item.reversal) reasonCodes.push("reversal");
  if (mispricing) reasonCodes.push("mispricing");
  if (item.noveltyBonus > 0) reasonCodes.push("novel");
  if (item.timeBonus > 0 && timeLeftHours <= 72) reasonCodes.push("near-expiry");
  if (item._filtered) reasonCodes.push("filtered");

  return {
    ...item,
    mispricing,
    mispricingTerm,
    orderbookTerm,
    signalScore2,
    signalType,
    isSignal,
    reasonCodes,
  };
}

module.exports = { buildIdeas, marketKey, classifyBucket, passesBucketGate, bucketTimeBonus, finalizeItem };
