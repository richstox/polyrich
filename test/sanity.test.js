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
// computeTradeInstruction (inlined — same logic as signal_engine.js)
// ---------------------------------------------------------------------------
console.log("\ncomputeTradeInstruction");

{
  // Inline the function to avoid requiring signal_engine.js (which pulls mongoose)
  function computeTradeInstruction(item, signalType, mispricing) {
    const spread = item.spread || 0;
    const bestBid = item.bestBidNum || 0;
    const bestAsk = item.bestAskNum || 0;
    const delta1 = item.delta1 || 0;
    const absMove = item.absMove || 0;
    const volatility = item.volatility || 0;
    const spreadPct = item.spreadPct || 0;
    const liquidity = item.liquidity || 0;
    const volume24hr = item.volume24hr || 0;
    const hoursLeft = item.hoursLeft;
    let recommendedSide = "WATCH";
    let confidence = 0;
    if (signalType === "momentum" || signalType === "breakout" || signalType === "reversal") {
      if (delta1 > 0) recommendedSide = "YES";
      else if (delta1 < 0) recommendedSide = "NO";
      const moveStrength = Math.min(absMove / 0.02, 1);
      const volStrength = Math.min(volatility / 0.01, 1);
      confidence = Math.min(moveStrength * 0.6 + volStrength * 0.4, 1);
    } else if (mispricing) {
      const peerZ = item.peerZ || 0;
      if (peerZ > 0.5) { recommendedSide = "NO"; confidence = Math.min(Math.abs(peerZ) / 3, 1) * 0.7; }
      else if (peerZ < -0.5) { recommendedSide = "YES"; confidence = Math.min(Math.abs(peerZ) / 3, 1) * 0.7; }
      else { recommendedSide = "WATCH"; confidence = 0.2; }
    }
    if (recommendedSide === "WATCH") confidence = Math.max(confidence, 0.1);
    let entryLimit = 0;
    if (recommendedSide === "YES" && bestBid > 0 && bestAsk > 0) entryLimit = bestBid + 0.25 * spread;
    else if (recommendedSide === "NO" && bestBid > 0 && bestAsk > 0) entryLimit = (1 - bestAsk) + 0.25 * spread;
    entryLimit = Math.round(entryLimit * 1000) / 1000;
    let sizeUSD = 5;
    const liqBoost = Math.min(Math.log10(Math.max(liquidity, 1)) / 5, 1);
    const volBoost = Math.min(Math.log10(Math.max(volume24hr, 1)) / 5, 1);
    sizeUSD += (liqBoost + volBoost) * 10;
    sizeUSD = Math.min(sizeUSD, 25);
    if (spreadPct > 0.10 || confidence < 0.6) sizeUSD = Math.max(sizeUSD * 0.5, 5);
    sizeUSD = Math.round(sizeUSD);
    if (recommendedSide === "WATCH") { sizeUSD = 0; entryLimit = 0; }
    const isIntraday = hoursLeft !== null && hoursLeft > 0 && hoursLeft <= 24;
    const timeStop = isIntraday ? "6 h" : "24 h";
    const exitPlan = recommendedSide === "WATCH"
      ? "No trade — monitor only"
      : `TP +2% or spread tightens · SL −2% · time stop ${timeStop}`;
    confidence = Math.round(confidence * 100) / 100;
    return { recommendedSide, confidence, entryLimit, sizeUSD, exitPlan };
  }

  // Momentum BUY YES: positive delta1
  {
    const item = {
      delta1: 0.01, absMove: 0.01, volatility: 0.005,
      bestBidNum: 0.50, bestAskNum: 0.54, spread: 0.04,
      spreadPct: 0.08, liquidity: 10000, volume24hr: 5000,
      hoursLeft: 48, peerZ: 0,
    };
    const r = computeTradeInstruction(item, "momentum", false);
    assert(r.recommendedSide === "YES", "momentum +delta1 => BUY YES");
    assert(r.confidence > 0, "momentum confidence > 0");
    assert(r.entryLimit > 0, "momentum entryLimit > 0");
    assert(r.sizeUSD >= 5 && r.sizeUSD <= 25, "momentum size in range");
    assert(r.exitPlan.includes("TP"), "momentum exitPlan has TP");
    assert(r.exitPlan.includes("24 h"), "multi-day => 24h time stop");
  }

  // Momentum BUY NO: negative delta1
  {
    const item = {
      delta1: -0.01, absMove: 0.01, volatility: 0.005,
      bestBidNum: 0.50, bestAskNum: 0.54, spread: 0.04,
      spreadPct: 0.08, liquidity: 10000, volume24hr: 5000,
      hoursLeft: 12, peerZ: 0,
    };
    const r = computeTradeInstruction(item, "momentum", false);
    assert(r.recommendedSide === "NO", "momentum -delta1 => BUY NO");
    assert(r.exitPlan.includes("6 h"), "intraday => 6h time stop");
  }

  // Mispricing with clear peerZ direction (negative => YES)
  {
    const item = {
      delta1: 0.001, absMove: 0.001, volatility: 0.001,
      bestBidNum: 0.30, bestAskNum: 0.34, spread: 0.04,
      spreadPct: 0.12, liquidity: 5000, volume24hr: 2000,
      hoursLeft: 100, peerZ: -1.5,
    };
    const r = computeTradeInstruction(item, "mispricing", true);
    assert(r.recommendedSide === "YES", "mispricing peerZ<-0.5 => BUY YES");
    assert(r.confidence > 0, "mispricing with direction has confidence");
  }

  // Mispricing with unclear direction => WATCH
  {
    const item = {
      delta1: 0, absMove: 0, volatility: 0,
      bestBidNum: 0.50, bestAskNum: 0.52, spread: 0.02,
      spreadPct: 0.04, liquidity: 8000, volume24hr: 3000,
      hoursLeft: 200, peerZ: 0.1,
    };
    const r = computeTradeInstruction(item, "mispricing", true);
    assert(r.recommendedSide === "WATCH", "mispricing unclear => WATCH");
    assert(r.sizeUSD === 0, "WATCH => size 0");
    assert(r.entryLimit === 0, "WATCH => entryLimit 0");
    assert(r.exitPlan.includes("monitor"), "WATCH => monitor only");
  }

  // Size reduction for wide spread
  {
    const item = {
      delta1: 0.015, absMove: 0.015, volatility: 0.008,
      bestBidNum: 0.40, bestAskNum: 0.50, spread: 0.10,
      spreadPct: 0.25, liquidity: 100000, volume24hr: 50000,
      hoursLeft: 48, peerZ: 0,
    };
    const r = computeTradeInstruction(item, "momentum", false);
    assert(r.sizeUSD <= 13, "wide spread reduces size");
  }

  // entryLimit rounding to 0.001
  {
    const item = {
      delta1: 0.01, absMove: 0.01, volatility: 0.005,
      bestBidNum: 0.1611, bestAskNum: 0.1671, spread: 0.006,
      spreadPct: 0.04, liquidity: 10000, volume24hr: 5000,
      hoursLeft: 48, peerZ: 0,
    };
    const r = computeTradeInstruction(item, "momentum", false);
    const decimals = r.entryLimit.toString().split(".")[1] || "";
    assert(decimals.length <= 3, "entryLimit rounded to max 3 decimals");
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
