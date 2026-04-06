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

function assertClose(a, b, name, tol = 1e-9) {
  assert(Math.abs(a - b) <= tol, `${name} (expected ${b}, got ${a})`);
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
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
