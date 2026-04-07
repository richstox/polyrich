"use strict";

/**
 * Sanity tests — run with: node test/sanity.test.js
 * No external test framework required.
 */

const { normalizeMarket, quantile, safeGroupEvent, safeGroupCategory, asNumber } = require("../src/normalizer");

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  ✓  ${name}`);
    passed++;
  } else {
    console.error(`  ✗  ${name}`);
    failed++;
  }
}

function assertClose(actual, expected, name, tol = 1e-9) {
  assert(Math.abs(actual - expected) <= tol, `${name} (expected ${expected}, got ${actual})`);
}

// ---------------------------------------------------------------------------
// normalizeMarket
// ---------------------------------------------------------------------------
console.log("\nnormalizeMarket");

{
  const item = {
    question: "Will X happen?",
    category: "politics",
    slug: "will-x-happen",
    eventSlug: "event-x",
    outcomePrices: '["0.7","0.3"]',
    bestBid: "0.68",
    bestAsk: "0.72",
    spread: "0.04",
    volume24hr: "5000",
    liquidity: "10000",
    endDate: "2099-01-01T00:00:00Z",
    acceptingOrders: true,
    active: true,
    closed: false,
  };

  const m = normalizeMarket(item);
  assert(m.priceYes === 0.7, "priceYes is numeric 0.7");
  assert(m.priceNo === 0.3, "priceNo is numeric 0.3");
  assert(m.volume24hr === 5000, "volume24hr is numeric 5000");
  assert(m.liquidity === 10000, "liquidity is numeric 10000");
  assert(m.bestBid === 0.68, "bestBid is numeric 0.68");
  assert(m.bestAsk === 0.72, "bestAsk is numeric 0.72");
  assert(m.spread === 0.04, "spread is numeric 0.04");
  assert(m.marketSlug === "will-x-happen", "marketSlug from slug field");
  assert(m.eventSlug === "event-x", "eventSlug preserved");
  assert(typeof m.priceYes === "number", "priceYes is a number type");
  assert(m.hoursLeft !== null && m.hoursLeft > 0, "hoursLeft > 0 for future date");
  // normalizeMarket must not write the old separate string properties like priceYes as a string
  assert(typeof m.priceYes !== "string", "priceYes must not be a string (no legacy string write)");
  // New fields
  assert(m.subcategory === "", "subcategory defaults to empty string");
  assert(Array.isArray(m.tagIds), "tagIds is an array");
  assert(Array.isArray(m.tagSlugs), "tagSlugs is an array");
}

{
  // Minimal / missing fields
  const m = normalizeMarket({ question: "Bad item" });
  assert(m.priceYes === 0, "missing prices default to 0");
  assert(m.priceNo === 0, "missing priceNo defaults to 0");
  assert(m.hoursLeft === null, "missing endDate gives null hoursLeft");
  assert(m.marketSlug === "Bad item", "marketSlug falls back to question");
}

{
  // Malformed outcomePrices
  const m = normalizeMarket({ question: "Q", outcomePrices: "not-json" });
  assert(m.priceYes === 0, "malformed outcomePrices defaults to 0");
}

{
  // volume24hr alias (volume field)
  const m = normalizeMarket({ question: "Q", volume: "1234" });
  assert(m.volume24hr === 1234, "volume alias parsed correctly");
}

{
  // Event context: subcategory and tags from event flattening
  const m = normalizeMarket({
    question: "Will Y win?",
    subcategory: "NBA",
    eventSlug: "nba-finals-2025",
    eventTags: [
      { id: "t1", slug: "basketball", label: "Basketball" },
      { id: "t2", slug: "sports", label: "Sports" },
    ],
  });
  assert(m.subcategory === "NBA", "subcategory preserved from event");
  assert(m.eventSlug === "nba-finals-2025", "eventSlug preserved from event");
  assert(m.tagIds.length === 2, "tagIds contains 2 entries");
  assert(m.tagIds[0] === "t1", "tagIds[0] is t1");
  assert(m.tagSlugs.length === 2, "tagSlugs contains 2 entries");
  assert(m.tagSlugs[0] === "basketball", "tagSlugs[0] is basketball");
}

// ---------------------------------------------------------------------------
// polymarketUrl
// ---------------------------------------------------------------------------
console.log("\npolymarketUrl");

{
  const { polymarketUrl } = (() => {
    // Inline the function for testing since it's not exported
    function polymarketUrl(item) {
      if (typeof item === "string") {
        if (!item) return null;
        return "https://polymarket.com/event/" + encodeURIComponent(item);
      }
      if (item.eventSlug) {
        return "https://polymarket.com/event/" + encodeURIComponent(item.eventSlug);
      }
      if (item.question) {
        return "https://polymarket.com/search?q=" + encodeURIComponent(item.question);
      }
      return null;
    }
    return { polymarketUrl };
  })();

  assert(
    polymarketUrl({ eventSlug: "us-election-2024" }) === "https://polymarket.com/event/us-election-2024",
    "polymarketUrl uses eventSlug"
  );
  assert(
    polymarketUrl({ question: "Will X happen?" }) === "https://polymarket.com/search?q=Will%20X%20happen%3F",
    "polymarketUrl falls back to search when no eventSlug"
  );
  assert(
    polymarketUrl({}) === null,
    "polymarketUrl returns null for empty item"
  );
  assert(
    polymarketUrl("legacy-slug") === "https://polymarket.com/event/legacy-slug",
    "polymarketUrl accepts legacy string arg"
  );
}

// ---------------------------------------------------------------------------
// quantile / percentile
// ---------------------------------------------------------------------------
console.log("\nquantile");

{
  const values = [1, 2, 3, 4, 5];
  assert(quantile(values, 0) === 1, "p=0 gives minimum");
  assert(quantile(values, 100) === 5, "p=100 gives maximum");
  assert(quantile(values, 50) === 3, "p=50 gives median of [1,2,3,4,5]");
  // p=25 → idx = 0.25 * 4 = 1.0 → exactly arr[1] = 2
  assertClose(quantile(values, 25), 2, "p=25 exact index");
  // p=75 → idx = 0.75 * 4 = 3.0 → exactly arr[3] = 4
  assertClose(quantile(values, 75), 4, "p=75 exact index");
  assert(quantile([], 50) === 0, "empty array returns 0");
  assert(quantile([42], 50) === 42, "single-value array returns that value");
  assert(quantile([42], 0) === 42, "single-value p=0");
  assert(quantile([42], 100) === 42, "single-value p=100");
}

{
  // Linear interpolation: [0, 10] at p=50 → idx=0.5 → 0*0.5 + 10*0.5 = 5
  assertClose(quantile([0, 10], 50), 5, "linear interp [0,10] p=50");
  // [0, 10, 20] at p=50 → idx=1.0 → arr[1]=10
  assertClose(quantile([0, 10, 20], 50), 10, "linear interp [0,10,20] p=50");
  // [0, 10, 20] at p=25 → idx=0.5 → 0*0.5 + 10*0.5 = 5
  assertClose(quantile([0, 10, 20], 25), 5, "linear interp [0,10,20] p=25", 1e-6);
}

// ---------------------------------------------------------------------------
// Event grouping
// ---------------------------------------------------------------------------
console.log("\nsafeGroupEvent / safeGroupCategory");

{
  assert(
    safeGroupEvent({ eventSlug: "USA-Election-2024" }) === "usa-election-2024",
    "groupEvent: uses eventSlug (lowercased)"
  );
  assert(
    safeGroupEvent({ marketSlug: "will-trump-win-2024-election" }) === "will-trump-win-2024",
    "groupEvent: uses first 4 slug parts when no eventSlug"
  );
  assert(
    safeGroupEvent({ marketSlug: "abc" }) === "abc",
    "groupEvent: short slug used as-is"
  );
  assert(
    safeGroupEvent({}) === "unknown-event",
    "groupEvent: fallback for empty item"
  );
  assert(
    safeGroupEvent({ eventSlug: "   " }) === "unknown-event",
    "groupEvent: whitespace-only eventSlug falls back"
  );
}

{
  assert(
    safeGroupCategory({ category: "Politics" }) === "politics",
    "groupCategory: uses category (lowercased)"
  );
  assert(
    safeGroupCategory({ marketSlug: "sports/nba/game" }) === "sports",
    "groupCategory: uses first path segment of marketSlug"
  );
  assert(
    safeGroupCategory({}) === "uncategorized",
    "groupCategory: fallback for empty item"
  );
}

// ---------------------------------------------------------------------------
// Idempotent insert simulation
// ---------------------------------------------------------------------------
console.log("\nidempotent insert");

{
  const store = new Map();

  function idempotentInsert(scanId, marketSlug, data) {
    const key = `${scanId}:${marketSlug}`;
    if (!store.has(key)) {
      store.set(key, data);
      return true;
    }
    return false;
  }

  const first = idempotentInsert("scan1", "market-a", { price: 0.5 });
  const second = idempotentInsert("scan1", "market-a", { price: 0.6 });
  const third = idempotentInsert("scan1", "market-b", { price: 0.3 });
  const fourth = idempotentInsert("scan2", "market-a", { price: 0.7 });

  assert(first === true, "first insert returns true");
  assert(second === false, "duplicate (same scanId+slug) returns false");
  assert(third === true, "different slug inserts successfully");
  assert(fourth === true, "same slug but different scanId inserts successfully");
  assert(store.get("scan1:market-a").price === 0.5, "first value preserved on duplicate");
  assert(store.size === 3, "store has 3 entries (scan1:a, scan1:b, scan2:a)");
}

// ---------------------------------------------------------------------------
// asNumber edge cases
// ---------------------------------------------------------------------------
console.log("\nasNumber");

{
  assert(asNumber("0.5") === 0.5, "string float parsed");
  assert(asNumber(0.5) === 0.5, "number passthrough");
  assert(asNumber(null) === 0, "null → fallback 0");
  assert(asNumber(undefined) === 0, "undefined → fallback 0");
  assert(asNumber("") === 0, "empty string → fallback 0");
  assert(asNumber(NaN) === 0, "NaN → fallback 0");
  assert(asNumber(Infinity) === 0, "Infinity → fallback 0");
  assert(asNumber("bad", 99) === 99, "non-numeric string → custom fallback");
}

// ---------------------------------------------------------------------------
// Time bucket helpers (from signal_engine — inlined to avoid mongoose dep)
// ---------------------------------------------------------------------------
console.log("\ntime buckets");

{
  // classifyBucket logic inline
  const BUCKET_INTRADAY_MAX = 48;
  const BUCKET_THIS_WEEK_MAX = 168;
  function classifyBucket(hoursLeft) {
    if (hoursLeft === null || !Number.isFinite(hoursLeft)) return "WATCH";
    if (hoursLeft <= 0) return null;
    if (hoursLeft <= BUCKET_INTRADAY_MAX) return "INTRADAY";
    if (hoursLeft <= BUCKET_THIS_WEEK_MAX) return "THIS_WEEK";
    return "WATCH";
  }
  function bucketTimeBonus(hoursLeft, bucketMaxHours) {
    if (!Number.isFinite(hoursLeft) || hoursLeft <= 0 || bucketMaxHours <= 0) return 0;
    const raw = (bucketMaxHours - hoursLeft) / bucketMaxHours;
    return Math.max(0, Math.min(raw, 1)) * 100;
  }

  assert(classifyBucket(12) === "INTRADAY", "12h → INTRADAY");
  assert(classifyBucket(48) === "INTRADAY", "48h → INTRADAY (boundary)");
  assert(classifyBucket(49) === "THIS_WEEK", "49h → THIS_WEEK");
  assert(classifyBucket(168) === "THIS_WEEK", "168h → THIS_WEEK (boundary)");
  assert(classifyBucket(169) === "WATCH", "169h → WATCH");
  assert(classifyBucket(null) === "WATCH", "null hoursLeft → WATCH");
  assert(classifyBucket(0) === null, "0h → null (expired)");
  assert(classifyBucket(-5) === null, "-5h → null (expired)");

  // bucketTimeBonus: earlier in bucket → higher bonus
  assertClose(bucketTimeBonus(0.001, 48), 100, "near-zero hours gives ~100 bonus", 1);
  assertClose(bucketTimeBonus(48, 48), 0, "at bucket max gives 0 bonus");
  assertClose(bucketTimeBonus(24, 48), 50, "halfway gives 50 bonus");
  assertClose(bucketTimeBonus(null, 48), 0, "null hoursLeft gives 0 bonus");
  assertClose(bucketTimeBonus(-1, 48), 0, "negative hoursLeft gives 0 bonus");
}

// ---------------------------------------------------------------------------
// Dynamic saving config
// ---------------------------------------------------------------------------
console.log("\ndynamic saving config");

{
  const cfg = require("../src/config");
  assert(cfg.SAVED_PER_SCAN_MIN === 2000, "SAVED_PER_SCAN_MIN default is 2000");
  assert(cfg.SAVED_PER_SCAN_CAP === 5000, "SAVED_PER_SCAN_CAP default is 5000");
  assert(cfg.SAVED_PER_SCAN_PCT === 0.05, "SAVED_PER_SCAN_PCT default is 0.05");
  assert(cfg.SAVED_DYNAMIC_THRESHOLD === 5000, "SAVED_DYNAMIC_THRESHOLD default is 5000");

  // Simulate dynamic save calculation — threshold is based on fetchedCount (data.length)
  function computeSaveLimit(fetchedCount) {
    let saveLimit = cfg.SAVED_PER_SCAN;
    if (fetchedCount > cfg.SAVED_DYNAMIC_THRESHOLD) {
      const pctBased = Math.ceil(fetchedCount * cfg.SAVED_PER_SCAN_PCT);
      saveLimit = Math.min(Math.max(cfg.SAVED_PER_SCAN_MIN, pctBased), cfg.SAVED_PER_SCAN_CAP);
    }
    return saveLimit;
  }

  assert(computeSaveLimit(200) === 200, "small count → legacy SAVED_PER_SCAN");
  assert(computeSaveLimit(5000) === 200, "at threshold → legacy SAVED_PER_SCAN");
  assert(computeSaveLimit(43000) >= 2000, "43k fetched → at least 2000 saved");
  assert(computeSaveLimit(43000) <= 5000, "43k fetched → at most 5000 saved");
  assertClose(computeSaveLimit(43000), 2150, "43k fetched → 5% = 2150", 1);
  assert(computeSaveLimit(200000) === 5000, "200k fetched → capped at 5000");
}

// ---------------------------------------------------------------------------
// computeTradeability
// ---------------------------------------------------------------------------
console.log("\ncomputeTradeability");

{
  const { computeTradeability } = require("../src/html_renderer");

  // Long-dated market (944 days = 22656 hours) must be Watch, not Tradeable
  const longDated = { hoursLeft: 22656, spreadPct: 0.05, liquidity: 10000, volume24hr: 5000, _filtered: false };
  assert(computeTradeability(longDated).label === "Watch", "944 days → Watch (not Tradeable)");

  // Market >10 days (e.g. 300 hours) must be Watch
  const tenDayPlus = { hoursLeft: 300, spreadPct: 0.05, liquidity: 10000, volume24hr: 5000, _filtered: false };
  assert(computeTradeability(tenDayPlus).label === "Watch", ">240h (>10 days) → Watch");

  // Market exactly at 240h boundary → Tradeable today
  const atBoundary = { hoursLeft: 240, spreadPct: 0.05, liquidity: 10000, volume24hr: 5000, _filtered: false };
  assert(computeTradeability(atBoundary).label === "Tradeable today", "240h → Tradeable today");

  // Intraday market (<=48h) can still be Tradeable
  const intraday = { hoursLeft: 24, spreadPct: 0.05, liquidity: 10000, volume24hr: 5000, _filtered: false };
  assert(computeTradeability(intraday).label === "Tradeable today", "intraday 24h → Tradeable today");

  // Wide spread (>0.15) must be Watch
  const wideSpread = { hoursLeft: 48, spreadPct: 0.20, liquidity: 10000, volume24hr: 5000, _filtered: false };
  assert(computeTradeability(wideSpread).label === "Watch", "spreadPct 0.20 → Watch");

  // Expired market → Excluded
  const expired = { hoursLeft: -1, spreadPct: 0.05, liquidity: 10000, volume24hr: 5000, _filtered: false };
  assert(computeTradeability(expired).label === "Excluded", "expired → Excluded");

  // Filtered market → Excluded
  const filtered = { hoursLeft: 48, spreadPct: 0.05, liquidity: 10000, volume24hr: 5000, _filtered: true };
  assert(computeTradeability(filtered).label === "Excluded", "filtered → Excluded");
}

// ---------------------------------------------------------------------------
// finalizeItem: near-expiry gate & mispricingTerm clamp
// ---------------------------------------------------------------------------
console.log("\nfinalizeItem: near-expiry gate & mispricingTerm clamp");

{
  const { finalizeItem } = require("../src/signal_engine");

  // Helper: build a minimal enriched item that finalizeItem expects
  function makeItem(overrides) {
    return {
      question: "Test?",
      category: "",
      subcategory: "",
      marketSlug: "test",
      eventSlug: "test-event",
      tagIds: [],
      tagSlugs: [],
      eventGroup: "test-event",
      categoryGroup: "uncategorized",
      latestYes: 0.5,
      previousYes: 0.5,
      delta1: 0,
      delta2: 0,
      absMove: 0.005,
      volatility: 0.005,
      spread: 0.02,
      spreadPct: 0.04,
      liquidity: 10000,
      volume24hr: 5000,
      bestBidNum: 0.48,
      bestAskNum: 0.52,
      mid: 0.5,
      microEdge: 0,
      orderbookQualityPenalty: 0,
      endDate: "",
      hoursLeft: 48,
      liquidityScore: Math.log(10001),
      volumeScore: Math.log(5001),
      moveTerm: 50,
      volTerm: 25,
      costPenalty: 80,
      activityTerm: 600,
      extremePenalty: 0,
      timePenalty: 0,
      timeBonus: 60,
      momentum: true,
      breakout: false,
      reversal: false,
      historyPoints: 5,
      recentSeries: [0.5, 0.5, 0.5, 0.5, 0.5],
      medianRecentMove: 0.001,
      noveltyBonus: 0,
      _filtered: false,
      eventInconsistencyScore: 10,
      peerZScore: 300,
      ...overrides,
    };
  }

  // Case 1: timeLeftHours = 2016 (84 days) → no near-expiry, mispricingTerm = 0
  {
    const item = makeItem({ hoursLeft: 2016, timeBonus: 25 });
    const result = finalizeItem(item, 5, 2);
    assert(!result.reasonCodes.includes("near-expiry"),
      "2016h (84 days): must NOT have near-expiry tag");
    assert(result.mispricingTerm === 0,
      "2016h (84 days): mispricingTerm must be 0 (long-dated disabled)");
  }

  // Case 2: timeLeftHours = 12 → must have near-expiry
  {
    const item = makeItem({ hoursLeft: 12, timeBonus: 60 });
    const result = finalizeItem(item, 5, 2);
    assert(result.reasonCodes.includes("near-expiry"),
      "12h: must have near-expiry tag");
  }

  // Case 3: timeLeftHours = 24 → mispricingTerm > 0 but <= 500
  {
    // peerZScore=300 → raw mispricingTerm = 10*1 + 300*20 = 6010, clamped to 500
    const item = makeItem({ hoursLeft: 24, timeBonus: 60 });
    const result = finalizeItem(item, 5, 2);
    assert(result.mispricingTerm > 0,
      "24h: mispricingTerm must be > 0");
    assert(result.mispricingTerm <= 500,
      "24h: mispricingTerm must be <= 500 after clamp");
  }

  // Edge: timeLeftHours = 72 → at boundary, should have near-expiry
  {
    const item = makeItem({ hoursLeft: 72, timeBonus: 60 });
    const result = finalizeItem(item, 5, 2);
    assert(result.reasonCodes.includes("near-expiry"),
      "72h: must have near-expiry (boundary)");
  }

  // Edge: timeLeftHours = 73 → just over boundary, no near-expiry
  {
    const item = makeItem({ hoursLeft: 73, timeBonus: 60 });
    const result = finalizeItem(item, 5, 2);
    assert(!result.reasonCodes.includes("near-expiry"),
      "73h: must NOT have near-expiry (over boundary)");
  }

  // Edge: timeLeftHours = 168 → at boundary, mispricingTerm should NOT be zeroed
  {
    const item = makeItem({ hoursLeft: 168, timeBonus: 25 });
    const result = finalizeItem(item, 5, 2);
    assert(result.mispricingTerm > 0,
      "168h: mispricingTerm > 0 (at boundary, not long-dated)");
    assert(result.mispricingTerm <= 500,
      "168h: mispricingTerm <= 500 (clamped)");
  }

  // Edge: timeLeftHours = 169 → just over, mispricingTerm = 0
  {
    const item = makeItem({ hoursLeft: 169, timeBonus: 25 });
    const result = finalizeItem(item, 5, 2);
    assert(result.mispricingTerm === 0,
      "169h: mispricingTerm must be 0 (long-dated)");
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
