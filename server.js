const http = require("http");
const mongoose = require("mongoose");

mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log("mongo connected"))
  .catch((err) => console.error("mongo error", err));

const marketSnapshotSchema = new mongoose.Schema({
  question: String,
  category: String,
  marketSlug: String,
  eventSlug: String,

  // legacy compatibility
  priceYes: String,
  priceNo: String,
  bestBid: String,
  bestAsk: String,
  spread: String,
  volume24hr: String,
  liquidity: String,

  // numeric fields
  priceYesNum: Number,
  priceNoNum: Number,
  bestBidNum: Number,
  bestAskNum: Number,
  spreadNum: Number,
  volume24hrNum: Number,
  liquidityNum: Number,

  endDate: String,
  hoursLeft: Number,
  scanId: String,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const shownCandidateSchema = new mongoose.Schema({
  marketSlug: String,
  scanId: String,
  shownAt: {
    type: Date,
    default: Date.now
  }
});

marketSnapshotSchema.index({ marketSlug: 1, createdAt: -1 });
marketSnapshotSchema.index({ marketSlug: 1, scanId: 1 });
marketSnapshotSchema.index({ scanId: 1, createdAt: -1 });
shownCandidateSchema.index({ marketSlug: 1, shownAt: -1 });

const MarketSnapshot = mongoose.model("MarketSnapshot", marketSnapshotSchema);
const ShownCandidate = mongoose.model("ShownCandidate", shownCandidateSchema);

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
  lastError: null
};

const HISTORY_K = 6;
const WATCHLIST_SIZE = 200;
const SIGNALS_SIZE = 80;
const FINAL_CANDIDATES_SIZE = 20;
const MOVERS_SIZE = 15;
const SAVED_PER_SCAN = 200;
const NOVELTY_LOOKBACK_SCANS = 5;

async function fetchPolymarkets() {
  const urls = [
    "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&offset=0",
    "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&offset=500"
  ];

  const results = await Promise.all(
    urls.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
      }
      return response.json();
    })
  );

  return results.flat();
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getHoursLeft(endDate) {
  if (!endDate) return null;
  const end = new Date(endDate).getTime();
  if (Number.isNaN(end)) return null;
  return (end - Date.now()) / (1000 * 60 * 60);
}

function formatHoursLeft(hoursLeft) {
  if (hoursLeft === null || Number.isNaN(hoursLeft)) return "-";
  if (hoursLeft <= 0) return "ended";
  if (hoursLeft < 1) return `${Math.round(hoursLeft * 60)} min`;
  if (hoursLeft < 24) return `${hoursLeft.toFixed(1)} h`;
  const days = Math.floor(hoursLeft / 24);
  const remHours = hoursLeft % 24;
  return `${days} d ${remHours.toFixed(1)} h`;
}

function formatVolume(volume) {
  if (volume >= 1000000) return `${(volume / 1000000).toFixed(2)}M`;
  if (volume >= 1000) return `${(volume / 1000).toFixed(1)}k`;
  return volume.toFixed(2);
}

function stddev(values) {
  if (!values || values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function mean(values) {
  if (!values || values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values) {
  if (!values || values.length === 0) return 0;
  const arr = [...values].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
}

function percentile(values, p) {
  if (!values || values.length === 0) return 0;
  const arr = [...values].sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.max(0, Math.floor((p / 100) * arr.length)));
  return arr[idx];
}

function normalizeMarket(item) {
  let prices = ["0", "0"];
  try {
    prices = JSON.parse(item.outcomePrices || "[\"0\",\"0\"]");
  } catch (e) {}

  const priceYesNum = asNumber(prices[0], 0);
  const priceNoNum = asNumber(prices[1], 0);
  const bestBidNum = asNumber(item.bestBid, 0);
  const bestAskNum = asNumber(item.bestAsk, 0);
  const spreadNum = asNumber(item.spread, 999);
  const volume24hrNum = asNumber(item.volume24hr || item.volume, 0);
  const liquidityNum = asNumber(item.liquidityNum || item.liquidity, 0);
  const endDate = item.endDate || "";
  const hoursLeft = getHoursLeft(endDate);

  return {
    question: item.question || "",
    category: item.category || "",
    marketSlug: item.slug || item.marketSlug || item.question || "",
    eventSlug: item.eventSlug || "",
    priceYes: String(priceYesNum),
    priceNo: String(priceNoNum),
    bestBid: String(bestBidNum),
    bestAsk: String(bestAskNum),
    spread: String(spreadNum),
    volume24hr: String(volume24hrNum),
    liquidity: String(liquidityNum),
    priceYesNum,
    priceNoNum,
    bestBidNum,
    bestAskNum,
    spreadNum,
    volume24hrNum,
    liquidityNum,
    endDate,
    hoursLeft
  };
}

function marketKey(item) {
  return item.marketSlug || item.question;
}

function safeGroupCategory(item) {
  if (item.category && item.category.trim()) return item.category.trim().toLowerCase();
  if (item.marketSlug) {
    const firstSegment = item.marketSlug.split("/")[0];
    if (firstSegment) return firstSegment.toLowerCase();
  }
  return "uncategorized";
}

function safeGroupEvent(item) {
  if (item.eventSlug && item.eventSlug.trim()) return item.eventSlug.trim().toLowerCase();
  if (item.marketSlug) {
    const slug = item.marketSlug.toLowerCase();
    const parts = slug.split("-");
    return parts.slice(0, 4).join("-") || slug;
  }
  return item.question || "unknown-event";
}

function computeSoftTimeBonus(hoursLeft) {
  if (hoursLeft === null || Number.isNaN(hoursLeft) || hoursLeft <= 0) return -1000000;
  if (hoursLeft <= 24 * 30) return 60;
  if (hoursLeft <= 24 * 90) return 25;
  return 0;
}

function uniqueScanIds(rows) {
  return [...new Set(rows.map((r) => r.scanId).filter(Boolean))];
}

async function runScan() {
  console.log("running auto scan...");

  const data = await fetchPolymarkets();
  const scanId = new Date().toISOString();

  const candidates = data
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
      const aScore = Math.log(a.volume24hrNum + 1) * 100 + Math.log(a.liquidityNum + 1) * 50 - a.spreadNum * 1000;
      const bScore = Math.log(b.volume24hrNum + 1) * 100 + Math.log(b.liquidityNum + 1) * 50 - b.spreadNum * 1000;
      return bScore - aScore;
    })
    .slice(0, SAVED_PER_SCAN);

  const previousScanId = scanStatus.lastScanId || null;

  if (candidates.length > 0) {
    await MarketSnapshot.insertMany(
      candidates.map((item) => ({
        question: item.question,
        category: item.category,
        marketSlug: item.marketSlug,
        eventSlug: item.eventSlug,

        priceYes: item.priceYes,
        priceNo: item.priceNo,
        bestBid: item.bestBid,
        bestAsk: item.bestAsk,
        spread: item.spread,
        volume24hr: item.volume24hr,
        liquidity: item.liquidity,

        priceYesNum: item.priceYesNum,
        priceNoNum: item.priceNoNum,
        bestBidNum: item.bestBidNum,
        bestAskNum: item.bestAskNum,
        spreadNum: item.spreadNum,
        volume24hrNum: item.volume24hrNum,
        liquidityNum: item.liquidityNum,

        endDate: item.endDate,
        hoursLeft: item.hoursLeft,
        scanId
      }))
    );
  }

  const now = new Date();
  const next = new Date(now.getTime() + 5 * 60 * 1000);

  scanStatus.previousScanId = previousScanId;
  scanStatus.lastScanId = scanId;
  scanStatus.lastScanAt = now;
  scanStatus.nextScanAt = next;
  scanStatus.lastSavedCount = candidates.length;
  scanStatus.lastTotalFetched = data.length;
  scanStatus.lastError = null;

  console.log(`auto scan done: fetched=${data.length} saved=${candidates.length} scanId=${scanId}`);
  return candidates;
}

async function buildIdeas() {
  if (!scanStatus.lastScanId) {
    return {
      tradeCandidates: [],
      movers: [],
      mispricing: [],
      funnel: {
        fetched: scanStatus.lastTotalFetched,
        saved: scanStatus.lastSavedCount,
        watchlist: 0,
        signals: 0,
        finalCandidates: 0,
        movers: 0
      }
    };
  }

  const latestItems = await MarketSnapshot.find({ scanId: scanStatus.lastScanId }).lean();
  const marketSlugs = [...new Set(latestItems.map((item) => marketKey(item)).filter(Boolean))];

  const historyRows = await MarketSnapshot.find({
    marketSlug: { $in: marketSlugs }
  })
    .sort({ marketSlug: 1, createdAt: -1 })
    .lean();

  const historyMap = new Map();
  for (const row of historyRows) {
    const key = marketKey(row);
    if (!historyMap.has(key)) historyMap.set(key, []);
    const arr = historyMap.get(key);
    if (arr.length < HISTORY_K) {
      arr.push(row);
    }
  }

  const shownRows = await ShownCandidate.find()
    .sort({ shownAt: -1 })
    .limit(FINAL_CANDIDATES_SIZE * NOVELTY_LOOKBACK_SCANS)
    .lean();

  const recentlyShownSet = new Set(shownRows.map((r) => r.marketSlug).filter(Boolean));

  const baseEnriched = latestItems.map((item) => {
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

    const spreadPct = spread / Math.max(latestYes, 1 - latestYes, 0.01);
    const liquidityScore = Math.log(liquidity + 1);
    const volumeScore = Math.log(volume24hr + 1);

    const moveTerm = absMove * 10000;
    const volTerm = volatility * 5000;
    const costPenalty = spreadPct * 2000;
    const activityTerm = volumeScore * 50 + liquidityScore * 20;
    const extremePenalty = (latestYes < 0.02 || latestYes > 0.98) ? 200 : 0;
    const timePenalty = (hoursLeft !== null && hoursLeft <= 0) ? 1000000 : 0;
    const timeBonus = computeSoftTimeBonus(hoursLeft);

    const momentum =
      absMove >= 0.003 &&
      volume24hr >= 50 &&
      liquidity >= 500 &&
      spreadPct <= 0.25;

    const breakout =
      volatility > Math.max(medianRecentMove * 1.8, 0.0025) ||
      absMove > Math.max(medianRecentMove * 2.0, 0.0035);

    const reversal =
      Math.abs(delta1) >= 0.003 &&
      Math.abs(delta2) >= 0.003 &&
      Math.sign(delta1) !== 0 &&
      Math.sign(delta2) !== 0 &&
      Math.sign(delta1) !== Math.sign(delta2) &&
      volatility >= 0.003;

    const mid = (bestBidNum > 0 && bestAskNum > 0) ? (bestBidNum + bestAskNum) / 2 : 0;
    const microEdge = mid > 0 ? Math.abs(latestYes - mid) : 0;
    const orderbookQualityPenalty =
      (bestBidNum <= 0 || bestAskNum <= 0) ? 200 : (spreadPct > 0.25 ? 100 : 0);

    return {
      question: item.question,
      category: item.category || "",
      marketSlug: item.marketSlug || "",
      eventSlug: item.eventSlug || "",
      eventGroup: safeGroupEvent(item),
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
      categoryGroup: safeGroupCategory(item),
      eventGroupFallback: safeGroupEvent(item),
      historyPoints: yesSeries.length,
      recentSeries: yesSeries,
      medianRecentMove,
      noveltyBonus: recentlyShownSet.has(item.marketSlug) ? 0 : 50
    };
  });

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

  const inconsistencyThreshold = percentile(eventInconsistencyScores, 80);
  const peerZThreshold = percentile(peerZScores, 80);

  const enriched = baseEnriched.map((item) => {
    const mispricing =
      item.eventInconsistencyScore >= inconsistencyThreshold ||
      item.peerZScore >= peerZThreshold;

    const mispricingTerm = item.eventInconsistencyScore * 1.0 + item.peerZScore * 20;
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

    return {
      ...item,
      mispricing,
      mispricingTerm,
      orderbookTerm,
      signalScore2,
      signalType,
      isSignal
    };
  });

  const tradableUniverse = enriched.filter((item) => item.hoursLeft === null || item.hoursLeft > 0);

  const watchlist = tradableUniverse
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
    momentumBreakout: signals.filter((x) => x.signalType === "momentum" || x.signalType === "breakout"),
    reversal: signals.filter((x) => x.signalType === "reversal")
  };

  const selected = [];
  const selectedSlugSet = new Set();
  const categoryCounts = new Map();
  const eventCounts = new Map();
  const categoryCap = Math.max(1, Math.floor(FINAL_CANDIDATES_SIZE * 0.25));

  function canAdd(item) {
    const categoryKey = item.categoryGroup;
    const eventKey = item.eventGroup;
    const currentCategoryCount = categoryCounts.get(categoryKey) || 0;
    const currentEventCount = eventCounts.get(eventKey) || 0;
    if (currentCategoryCount >= categoryCap) return false;
    if (currentEventCount >= 2) return false;
    if (selectedSlugSet.has(item.marketSlug)) return false;
    return true;
  }

  function addItem(item) {
    selected.push(item);
    selectedSlugSet.add(item.marketSlug);
    categoryCounts.set(item.categoryGroup, (categoryCounts.get(item.categoryGroup) || 0) + 1);
    eventCounts.set(item.eventGroup, (eventCounts.get(item.eventGroup) || 0) + 1);
  }

  function takeFromList(list, targetCount) {
    for (const item of list) {
      if (selected.length >= FINAL_CANDIDATES_SIZE) break;
      if ((selected.filter((x) => x.signalType === item.signalType)).length >= targetCount && false) {
        // no-op, handled by outer target loop
      }
      if (canAdd(item)) addItem(item);
      if (selected.length >= FINAL_CANDIDATES_SIZE) break;
    }
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

  takeTypeQuota(byType.mispricing, 8);
  takeTypeQuota(byType.momentumBreakout, 8);
  takeTypeQuota(byType.reversal, 4);

  if (selected.length < FINAL_CANDIDATES_SIZE) {
    for (const item of signals) {
      if (selected.length >= FINAL_CANDIDATES_SIZE) break;
      if (!canAdd(item)) continue;
      addItem(item);
    }
  }

  const movers = watchlist
    .filter((item) =>
      (item.signalType === "momentum" || item.signalType === "breakout") &&
      item.latestYes >= 0.10 &&
      item.latestYes <= 0.90
    )
    .sort((a, b) => b.absMove - a.absMove)
    .slice(0, MOVERS_SIZE);

  const mispricingList = watchlist
    .filter((item) => item.signalType === "mispricing")
    .sort((a, b) => b.mispricingTerm - a.mispricingTerm)
    .slice(0, 15);

  scanStatus.lastWatchlistCount = watchlist.length;
  scanStatus.lastSignalsCount = signals.length;
  scanStatus.lastInterestingCount = selected.length;
  scanStatus.lastMoverCount = movers.length;
  scanStatus.lastMispricingCount = mispricingList.length;

  return {
    tradeCandidates: selected,
    movers,
    mispricing: mispricingList,
    funnel: {
      fetched: scanStatus.lastTotalFetched,
      saved: scanStatus.lastSavedCount,
      watchlist: watchlist.length,
      signals: signals.length,
      finalCandidates: selected.length,
      movers: movers.length
    }
  };
}

function renderBreakdown(item) {
  return `
moveTerm=${item.moveTerm.toFixed(1)}
volTerm=${item.volTerm.toFixed(1)}
activityTerm=${item.activityTerm.toFixed(1)}
mispricingTerm=${item.mispricingTerm.toFixed(1)}
orderbookTerm=${item.orderbookTerm.toFixed(1)}
costPenalty=${item.costPenalty.toFixed(1)}
extremePenalty=${item.extremePenalty.toFixed(1)}
timePenalty=${item.timePenalty.toFixed(1)}
timeBonus=${item.timeBonus.toFixed(1)}
noveltyBonus=${item.noveltyBonus.toFixed(1)}
signalScore2=${item.signalScore2.toFixed(1)}
  `.trim();
}

function renderCandidate(item) {
  const movePrefix = item.delta1 > 0 ? "+" : "";
  return `
    <li style="margin-bottom:18px;padding:12px;border:1px solid #ddd;border-radius:8px;">
      <strong>${item.question}</strong><br>
      signalType: <strong>${item.signalType}</strong><br>
      category: ${item.category || "-"}<br>
      eventGroup: ${item.eventGroup || "-"}<br>
      groupSize: ${item.groupSize || 0}<br>
      YES now: ${item.latestYes.toFixed(3)}<br>
      YES prev: ${item.previousYes.toFixed(3)}<br>
      absMove: ${item.absMove.toFixed(4)}<br>
      delta1: ${movePrefix}${item.delta1.toFixed(4)}<br>
      volatility: ${item.volatility.toFixed(4)}<br>
      spread: ${item.spread.toFixed(4)}<br>
      spreadPct: ${item.spreadPct.toFixed(4)}<br>
      24h Volume: <strong>${formatVolume(item.volume24hr)}</strong><br>
      liquidity: ${Math.round(item.liquidity).toLocaleString("en-US")}<br>
      hoursLeft: ${formatHoursLeft(item.hoursLeft)}<br>
      sumYesInGroup: ${typeof item.sumYesInGroup === "number" ? item.sumYesInGroup.toFixed(3) : "-"}<br>
      inconsistency: ${typeof item.inconsistency === "number" ? item.inconsistency.toFixed(3) : "-"}<br>
      peerZ: ${typeof item.peerZ === "number" ? item.peerZ.toFixed(2) : "-"}<br>
      bestBid: ${item.bestBidNum.toFixed(3)}<br>
      bestAsk: ${item.bestAskNum.toFixed(3)}<br>
      mid: ${item.mid.toFixed(3)}<br>
      score: <strong>${item.signalScore2.toFixed(2)}</strong><br>
      breakdown: <code>${renderBreakdown(item)}</code>
    </li>
  `;
}

async function persistShownCandidates(scanId, candidates) {
  if (!scanId || !candidates.length) return;
  await ShownCandidate.insertMany(
    candidates.map((item) => ({
      marketSlug: item.marketSlug,
      scanId
    }))
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/") {
    const html = `
      <h1>Polyrich</h1>
      <p><a href="/scan">Spustit scan teď</a></p>
      <p><a href="/snapshots">Snapshoty</a></p>
      <p><a href="/ideas">Scanner dashboard</a></p>
    `;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

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
      <p>Scan byl právě spuštěn ručně.</p>
      <p><a href="/ideas">Otevřít scanner dashboard</a></p>
      <ol>
        ${candidates.slice(0, 30).map((item) => `
          <li style="margin-bottom:18px;">
            <strong>${item.question}</strong><br>
            YES: ${item.priceYesNum.toFixed(3)} | NO: ${item.priceNoNum.toFixed(3)}<br>
            spread: ${item.spreadNum.toFixed(4)}<br>
            liquidity: ${Math.round(item.liquidityNum).toLocaleString("en-US")}<br>
            24h Volume: <strong>${formatVolume(item.volume24hrNum)}</strong><br>
            endDate: ${item.endDate || "-"}<br>
            time left: ${formatHoursLeft(item.hoursLeft)}
          </li>
        `).join("")}
      </ol>
    `;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname === "/snapshots") {
    const items = await MarketSnapshot.find().sort({ _id: -1 }).limit(100).lean();

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
            24h Volume: <strong>${formatVolume(typeof item.volume24hrNum === "number" ? item.volume24hrNum : asNumber(item.volume24hr, 0))}</strong><br>
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

  if (url.pathname === "/ideas") {
    try {
      const { tradeCandidates, movers, mispricing, funnel } = await buildIdeas();

      if (scanStatus.lastScanId && tradeCandidates.length > 0) {
        await persistShownCandidates(scanStatus.lastScanId, tradeCandidates);
      }

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
          <p>mispricing: ${scanStatus.lastMispricingCount}</p>
        </div>

        <h2>Trade candidates</h2>
        <p>Top 20 with diversification, novelty, mispricing, movement and orderbook quality.</p>
        <ol>
          ${tradeCandidates.map(renderCandidate).join("")}
        </ol>

        <h2>Mispricing</h2>
        <p>Markets flagged from event inconsistency / peer-relative offside behavior.</p>
        <ol>
          ${mispricing.map(renderCandidate).join("")}
        </ol>

        <h2>Movers</h2>
        <p>Momentum / breakout names with visible recent movement.</p>
        <ol>
          ${movers.map(renderCandidate).join("")}
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

const port = process.env.PORT || 3000;
server.listen(port, async () => {
  console.log(`server running on ${port}`);

  try {
    await runScan();
  } catch (err) {
    scanStatus.lastError = err.message;
    console.error("initial auto scan failed", err);
  }

  setInterval(async () => {
    try {
      await runScan();
    } catch (err) {
      scanStatus.lastError = err.message;
      console.error("scheduled auto scan failed", err);
    }
  }, 5 * 60 * 1000);
});
