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

{
  // conditionId preserved from raw market
  const m = normalizeMarket({
    question: "Will Team A win?",
    slug: "will-team-a-win",
    eventSlug: "match-2026",
    conditionId: "0xabc123def456",
  });
  assert(m.conditionId === "0xabc123def456", "conditionId preserved from raw market");
  assert(m.marketSlug === "will-team-a-win", "marketSlug from slug field (not conditionId)");
}

{
  // missing conditionId defaults to empty string
  const m = normalizeMarket({ question: "Q", slug: "q-slug" });
  assert(m.conditionId === "", "missing conditionId defaults to empty string");
}

{
  // groupItemTitle preserved from raw market
  const m = normalizeMarket({
    question: "Will Elon Musk post 240-259 tweets from April 3 to April 10, 2026?",
    slug: "elon-musk-of-tweets-april-3-april-10-240-259",
    eventSlug: "elon-musk-tweets-april",
    groupItemTitle: "240-259",
  });
  assert(m.groupItemTitle === "240-259", "groupItemTitle preserved from raw market");
}

{
  // missing groupItemTitle defaults to empty string
  const m = normalizeMarket({ question: "Q", slug: "q-slug" });
  assert(m.groupItemTitle === "", "missing groupItemTitle defaults to empty string");
}

// ---------------------------------------------------------------------------
// polymarketUrl
// ---------------------------------------------------------------------------
console.log("\npolymarketUrl");

{
  // Now exported — use the real function
  const { polymarketUrl, safeQuestion, isInvalidDisplayLabel, slugToLabel, marketDisplayLabel, cardHeadline } = require("../src/html_renderer");

  assert(
    polymarketUrl({ eventSlug: "us-election-2024" }) === "https://polymarket.com/event/us-election-2024",
    "polymarketUrl uses eventSlug when no distinct marketSlug"
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

  // --- Market-specific deep link tests ---
  assert(
    polymarketUrl({ eventSlug: "sud-cbc-vas-2026", marketSlug: "will-team-a-win", question: "Will Team A win?" })
      === "https://polymarket.com/event/sud-cbc-vas-2026/will-team-a-win",
    "polymarketUrl deep-links to market when eventSlug and marketSlug differ"
  );
  assert(
    polymarketUrl({ eventSlug: "match-event", marketSlug: "will-draw", question: "Will it be a Draw?" })
      === "https://polymarket.com/event/match-event/will-draw",
    "polymarketUrl deep-links correctly for draw outcome market"
  );
  // When marketSlug equals eventSlug, fall back to event-level URL
  assert(
    polymarketUrl({ eventSlug: "some-event", marketSlug: "some-event", question: "Q?" })
      === "https://polymarket.com/event/some-event",
    "polymarketUrl does not double-append when marketSlug === eventSlug"
  );
  // When marketSlug is a question fallback, do not use it in URL path
  assert(
    polymarketUrl({ eventSlug: "evt", marketSlug: "Will X happen?", question: "Will X happen?" })
      === "https://polymarket.com/event/evt",
    "polymarketUrl does not use question-as-slug in URL path"
  );

  // --- Multi-outcome correctness: question and URL from same market ---
  {
    const homeMarket = {
      eventSlug: "match-home-away-draw-2026",
      marketSlug: "will-home-team-win",
      question: "Will Home Team win?",
      conditionId: "0xabc123",
    };
    const drawMarket = {
      eventSlug: "match-home-away-draw-2026",
      marketSlug: "will-it-be-a-draw",
      question: "Will it be a Draw?",
      conditionId: "0xdef456",
    };
    const awayMarket = {
      eventSlug: "match-home-away-draw-2026",
      marketSlug: "will-away-team-win",
      question: "Will Away Team win?",
      conditionId: "0x789ghi",
    };
    const homeUrl = polymarketUrl(homeMarket);
    const drawUrl = polymarketUrl(drawMarket);
    const awayUrl = polymarketUrl(awayMarket);
    // Each URL must differ (market-specific)
    assert(homeUrl !== drawUrl, "home and draw URLs are distinct");
    assert(homeUrl !== awayUrl, "home and away URLs are distinct");
    assert(drawUrl !== awayUrl, "draw and away URLs are distinct");
    // Each URL must contain its own marketSlug
    assert(homeUrl.includes("will-home-team-win"), "home URL contains home market slug");
    assert(drawUrl.includes("will-it-be-a-draw"), "draw URL contains draw market slug");
    assert(awayUrl.includes("will-away-team-win"), "away URL contains away market slug");
    // All share the same event slug
    assert(homeUrl.includes("match-home-away-draw-2026"), "home URL contains event slug");
    assert(drawUrl.includes("match-home-away-draw-2026"), "draw URL contains event slug");
    assert(awayUrl.includes("match-home-away-draw-2026"), "away URL contains event slug");
  }

  // --- safeQuestion tests ---
  assert(
    safeQuestion({ question: "Will X happen?" }) === "Will X happen?",
    "safeQuestion returns question when present"
  );
  assert(
    safeQuestion({ question: "" }) === "Market detail unavailable",
    "safeQuestion returns fallback for empty question"
  );
  assert(
    safeQuestion({}) === "Market detail unavailable",
    "safeQuestion returns fallback for missing question"
  );
  assert(
    safeQuestion({ question: "   " }) === "Market detail unavailable",
    "safeQuestion returns fallback for whitespace-only question"
  );
}

// ---------------------------------------------------------------------------
// isInvalidDisplayLabel
// ---------------------------------------------------------------------------
console.log("\nisInvalidDisplayLabel");

{
  const { isInvalidDisplayLabel } = require("../src/html_renderer");

  assert(isInvalidDisplayLabel("YES") === true, "YES is invalid label");
  assert(isInvalidDisplayLabel("No") === true, "No is invalid label");
  assert(isInvalidDisplayLabel("yes") === true, "yes (lowercase) is invalid");
  assert(isInvalidDisplayLabel("") === true, "empty string is invalid");
  assert(isInvalidDisplayLabel(null) === true, "null is invalid");
  assert(isInvalidDisplayLabel(undefined) === true, "undefined is invalid");
  assert(isInvalidDisplayLabel("   ") === true, "whitespace-only is invalid");
  assert(isInvalidDisplayLabel("ab") === true, "2-char string is invalid (too short)");
  assert(isInvalidDisplayLabel("abc") === true, "3-char string is invalid (too short)");
  assert(isInvalidDisplayLabel("Market") === true, "Market is invalid placeholder");
  assert(isInvalidDisplayLabel("Unknown") === true, "Unknown is invalid placeholder");
  assert(isInvalidDisplayLabel("Option") === true, "Option is invalid placeholder");
  assert(isInvalidDisplayLabel("Outcome") === true, "Outcome is invalid placeholder");
  assert(isInvalidDisplayLabel("Will X happen?") === false, "normal question is valid");
  assert(isInvalidDisplayLabel("Curtis Blaydes vs Josh Hokit") === false, "event title is valid");
  assert(isInvalidDisplayLabel("abcd") === false, "4-char string is valid");
}

// ---------------------------------------------------------------------------
// slugToLabel
// ---------------------------------------------------------------------------
console.log("\nslugToLabel");

{
  const { slugToLabel } = require("../src/html_renderer");

  assert(slugToLabel("will-fight-go-the-distance") === "Will fight go the distance?", "slug → question with ?");
  assert(slugToLabel("is-it-a-draw") === "Is it a draw?", "is-slug gets ?");
  assert(slugToLabel("ko-tko-finish") === "Ko tko finish", "non-question slug, no ?");
  assert(slugToLabel("") === "", "empty slug returns empty");
  assert(slugToLabel(null) === "", "null slug returns empty");
  assert(slugToLabel("single") === "Single", "single word slug capitalized");
}

// ---------------------------------------------------------------------------
// marketDisplayLabel
// ---------------------------------------------------------------------------
console.log("\nmarketDisplayLabel");

{
  const { marketDisplayLabel } = require("../src/html_renderer");

  // 1. Valid question — use it directly
  assert(
    marketDisplayLabel({ question: "Will the fight go the distance?" }) === "Will the fight go the distance?",
    "marketDisplayLabel uses question when valid"
  );

  // 2. Question is YES → fall through to slug
  assert(
    marketDisplayLabel({ question: "YES", marketSlug: "will-fight-go-the-distance" }) === "Will fight go the distance?",
    "marketDisplayLabel falls through YES to slug"
  );

  // 3. Question is NO → fall through to slug
  assert(
    marketDisplayLabel({ question: "NO", marketSlug: "ko-tko-finish" }) === "Ko tko finish",
    "marketDisplayLabel falls through NO to slug"
  );

  // 4. Question empty, no slug → fallback
  assert(
    marketDisplayLabel({ question: "" }) === "Market detail unavailable",
    "marketDisplayLabel fallback for empty question and no slug"
  );

  // 5. Outcomes-based label (moneyline/winner)
  assert(
    marketDisplayLabel({ question: "YES", marketSlug: "moneyline-winner", outcomes: ["Curtis Blaydes", "Josh Hokit"] })
      === "Moneyline (Winner): Curtis Blaydes",
    "marketDisplayLabel builds moneyline winner label from outcomes"
  );

  // 6. Outcomes-based label (non-winner)
  assert(
    marketDisplayLabel({ question: "YES", marketSlug: "some-short", outcomes: ["Fighter A", "Fighter B"] })
      === "Fighter A vs Fighter B",
    "marketDisplayLabel builds vs label from outcomes"
  );

  // 7. Null mkt
  assert(
    marketDisplayLabel(null) === "Market detail unavailable",
    "marketDisplayLabel handles null"
  );

  // 8. slugToLabel fallback when question is short
  assert(
    marketDisplayLabel({ question: "ab", slug: "will-team-a-win" }) === "Will team a win?",
    "marketDisplayLabel uses slug when question too short"
  );
}

// ---------------------------------------------------------------------------
// cardHeadline (updated for event-first structure)
// ---------------------------------------------------------------------------
console.log("\ncardHeadline (event-first)");

{
  const { cardHeadline } = require("../src/html_renderer");

  // UFC-style: eventTitle + YES question → eventTitle as headline, market label as subtext
  {
    const result = cardHeadline({
      question: "YES",
      eventTitle: "Curtis Blaydes vs Josh Hokit",
      marketSlug: "will-fight-go-the-distance",
    });
    assert(result.headline === "Curtis Blaydes vs Josh Hokit", "UFC card headline is eventTitle");
    assert(result.subtext === "Will fight go the distance?", "UFC card subtext is market label from slug");
  }

  // Normal case: valid question + eventTitle
  {
    const result = cardHeadline({
      question: "Will Team A win the championship?",
      eventTitle: "Team A vs Team B",
    });
    assert(result.headline === "Team A vs Team B", "headline is eventTitle when both valid and different");
    assert(result.subtext === "Will Team A win the championship?", "subtext is market question");
  }

  // Only valid question, no eventTitle
  {
    const result = cardHeadline({
      question: "Will X happen?",
    });
    assert(result.headline === "Will X happen?", "headline is question when no eventTitle");
    assert(result.subtext === "", "subtext empty when no eventTitle");
  }

  // Both invalid
  {
    const result = cardHeadline({ question: "", eventTitle: "" });
    assert(result.headline === "Market detail unavailable", "fallback headline when both invalid");
  }

  // eventTitle valid, question YES → eventTitle headline, slug-derived subtext
  {
    const result = cardHeadline({
      question: "YES",
      eventTitle: "Big Event",
      marketSlug: "moneyline-winner",
      outcomes: ["Player A", "Player B"],
    });
    assert(result.headline === "Big Event", "eventTitle headline when question is YES");
    assert(result.subtext === "Moneyline (Winner): Player A", "subtext from outcomes");
  }

  // Same eventTitle and question — no duplication
  {
    const result = cardHeadline({
      question: "Will rain tomorrow?",
      eventTitle: "Will rain tomorrow?",
    });
    assert(result.headline === "Will rain tomorrow?", "no duplication when same");
    assert(result.subtext === "", "subtext empty when same as headline");
  }

  // groupItemTitle preferred as subtext over verbose per-token question (multi-outcome market)
  {
    const result = cardHeadline({
      question: "Will Elon Musk post 240-259 tweets from April 3 to April 10, 2026?",
      eventTitle: "Elon Musk # tweets April 3 - April 10, 2026?",
      groupItemTitle: "240-259",
    });
    assert(result.headline === "Elon Musk # tweets April 3 - April 10, 2026?", "headline is eventTitle for grouped market");
    assert(result.subtext === "240-259", "subtext is groupItemTitle, not verbose per-token question");
  }

  // groupItemTitle absent → falls back to mktLabel (legacy behaviour)
  {
    const result = cardHeadline({
      question: "Will Elon Musk post 240-259 tweets from April 3 to April 10, 2026?",
      eventTitle: "Elon Musk # tweets April 3 - April 10, 2026?",
    });
    assert(result.headline === "Elon Musk # tweets April 3 - April 10, 2026?", "headline is eventTitle without groupItemTitle");
    assert(result.subtext === "Will Elon Musk post 240-259 tweets from April 3 to April 10, 2026?", "subtext falls back to question when no groupItemTitle");
  }

  // groupItemTitle with invalid market label — still shown as subtext
  {
    const result = cardHeadline({
      question: "YES",
      eventTitle: "Some Multi-Outcome Event",
      groupItemTitle: "Option A",
    });
    assert(result.headline === "Some Multi-Outcome Event", "headline eventTitle when question invalid + groupItemTitle");
    assert(result.subtext === "Option A", "subtext is groupItemTitle when question invalid");
  }
}

// ---------------------------------------------------------------------------
// safeQuestion — additional invalid label tests
// ---------------------------------------------------------------------------
console.log("\nsafeQuestion (invalid label rejection)");

{
  const { safeQuestion } = require("../src/html_renderer");

  assert(safeQuestion({ question: "YES" }) === "Market detail unavailable", "safeQuestion rejects YES");
  assert(safeQuestion({ question: "NO" }) === "Market detail unavailable", "safeQuestion rejects NO");
  assert(safeQuestion({ question: "Yes" }) === "Market detail unavailable", "safeQuestion rejects Yes (case)");
  assert(safeQuestion({ question: "no" }) === "Market detail unavailable", "safeQuestion rejects no (case)");
  assert(safeQuestion({ question: "ab" }) === "Market detail unavailable", "safeQuestion rejects 2-char");
  assert(safeQuestion({ question: "Market" }) === "Market detail unavailable", "safeQuestion rejects placeholder Market");
  assert(
    safeQuestion({ question: "YES", marketSlug: "will-it-rain" }) === "Will it rain?",
    "safeQuestion falls through YES to slug label"
  );
  assert(
    safeQuestion({ question: "YES", marketSlug: "moneyline-winner", outcomes: ["Alice", "Bob"] }) === "Moneyline (Winner): Alice",
    "safeQuestion falls through YES to winner label from outcomes"
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
// finalizeItem: mispricing eligibility gate (movement / volatility)
// ---------------------------------------------------------------------------
console.log("\nfinalizeItem: mispricing eligibility gate");

{
  const { finalizeItem } = require("../src/signal_engine");

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

  // Case 1: absMove=0, volatility=0, timeLeftHours<=168 → gate fails
  {
    const item = makeItem({ absMove: 0, volatility: 0, hoursLeft: 48, timeBonus: 60 });
    const result = finalizeItem(item, 5, 2);
    assert(result.mispricingTerm === 0,
      "gate: absMove=0/vol=0 → mispricingTerm must be 0");
    assert(!result.reasonCodes.includes("mispricing"),
      "gate: absMove=0/vol=0 → no mispricing tag");
    assert(result.mispricing === false,
      "gate: absMove=0/vol=0 → mispricing flag must be false");
    assert(result.signalType !== "mispricing",
      "gate: absMove=0/vol=0 → signalType must not be mispricing");
  }

  // Case 2: absMove=0.01, high inconsistency, timeLeftHours<=168 → gate passes
  {
    const item = makeItem({ absMove: 0.01, volatility: 0.005, hoursLeft: 48, timeBonus: 60 });
    const result = finalizeItem(item, 5, 2);
    assert(result.mispricingTerm > 0,
      "gate: absMove=0.01 → mispricingTerm > 0");
    assert(result.mispricingTerm <= 500,
      "gate: absMove=0.01 → mispricingTerm <= 500 (clamped)");
    assert(result.reasonCodes.includes("mispricing"),
      "gate: absMove=0.01 → has mispricing tag");
    assert(result.mispricing === true,
      "gate: absMove=0.01 → mispricing flag true");
  }

  // Case 3: volatility passes gate but absMove does not
  {
    const item = makeItem({ absMove: 0.001, volatility: 0.003, hoursLeft: 48, timeBonus: 60 });
    const result = finalizeItem(item, 5, 2);
    assert(result.mispricingTerm > 0,
      "gate: vol=0.003 (>=0.002) → mispricingTerm > 0");
    assert(result.mispricing === true,
      "gate: vol=0.003 → mispricing eligible via volatility");
  }

  // Case 4: both below thresholds but non-zero
  {
    const item = makeItem({ absMove: 0.004, volatility: 0.001, hoursLeft: 48, timeBonus: 60 });
    const result = finalizeItem(item, 5, 2);
    assert(result.mispricingTerm === 0,
      "gate: absMove=0.004/vol=0.001 → both below → mispricingTerm 0");
    assert(result.mispricing === false,
      "gate: absMove=0.004/vol=0.001 → mispricing false");
  }
}

// ---------------------------------------------------------------------------
// Final selection: mispricing quota enforcement
// ---------------------------------------------------------------------------
console.log("\nfinal selection: mispricing quota");

{
  // Simulate the quota logic from buildCandidatesFromEnriched
  // Given 25 candidates where 15 are mispricing-typed, verify cap enforced at 30%
  const finalLimit = 20;
  const mispricingCeil = Math.ceil(finalLimit * 0.30); // = 6

  // Build 30 synthetic candidates: 15 mispricing (higher score), 15 non-mispricing
  const candidates = [];
  for (let i = 0; i < 15; i++) {
    candidates.push({
      marketSlug: `mispricing-${i}`,
      signalType: "mispricing",
      signalScore2: 1000 - i,
      categoryGroup: `cat-${i % 5}`,
      eventGroup: `event-${i}`,
      mispricingTerm: 100,
    });
  }
  for (let i = 0; i < 15; i++) {
    candidates.push({
      marketSlug: `momentum-${i}`,
      signalType: "momentum",
      signalScore2: 800 - i,
      categoryGroup: `cat-${i % 5}`,
      eventGroup: `event-m-${i}`,
      mispricingTerm: 0,
    });
  }

  // Sort by score descending (simulates signals list)
  candidates.sort((a, b) => b.signalScore2 - a.signalScore2);

  // Take top 20 naively
  let selected = candidates.slice(0, finalLimit);

  // Apply mispricing ceiling (same logic as signal_engine.js)
  const mispricingInSelected = selected.filter(
    (x) => x.signalType === "mispricing" || x.mispricingTerm > 0
  );

  if (mispricingInSelected.length > mispricingCeil) {
    const excess = mispricingInSelected.length - mispricingCeil;
    let removed = 0;
    for (let i = selected.length - 1; i >= 0 && removed < excess; i--) {
      if (selected[i].signalType === "mispricing") {
        selected.splice(i, 1);
        removed++;
      }
    }
    // Backfill with non-mispricing from remaining candidates
    for (const item of candidates) {
      if (selected.length >= finalLimit) break;
      if (item.signalType === "mispricing") continue;
      if (selected.find((s) => s.marketSlug === item.marketSlug)) continue;
      selected.push(item);
    }
  }

  const finalMispricingCount = selected.filter(
    (x) => x.signalType === "mispricing" || x.mispricingTerm > 0
  ).length;

  assert(finalMispricingCount <= mispricingCeil,
    `quota: mispricing in final <= ${mispricingCeil} (got ${finalMispricingCount})`);
  assert(selected.length === finalLimit,
    `quota: final list has exactly ${finalLimit} entries (got ${selected.length})`);
  assert(finalMispricingCount <= Math.ceil(finalLimit * 0.35),
    `quota: mispricing share <= 35% of ${finalLimit}`);
}

// ---------------------------------------------------------------------------
// renderTradeCard: outcomeLabel (groupItemTitle) shown in action pill
// ---------------------------------------------------------------------------
{
  console.log("\nrenderTradeCard: outcomeLabel in action pill");
  const { renderTradeCard } = require("../src/html_renderer");

  // Helper: build a minimal EXECUTE-able item
  function makeTradeItem(overrides) {
    return Object.assign({
      question: "Blue Jackets vs. Sabres",
      eventTitle: "Blue Jackets vs. Sabres",
      marketSlug: "blue-jackets-vs-sabres",
      eventSlug: "blue-jackets-vs-sabres",
      conditionId: "abc123",
      groupItemTitle: "",
      tagIds: [],
      tagSlugs: [],
      hoursLeft: 36,
      latestYes: 0.46,
      priceYesNum: 0.46,
      priceNoNum: 0.54,
      bestBidNum: 0.44,
      bestAskNum: 0.47,
      spreadPct: 0.065,
      liquidity: 5000,
      volume24hr: 10000,
      delta1: -0.02,
      absMove: 0.02,
      volatility: 0.01,
      mispricing: true,
      mispricingTerm: 100,
      momentum: false,
      breakout: false,
      reversal: false,
      moveTerm: 10,
      volTerm: 10,
      activityTerm: 10,
      orderbookTerm: 10,
      costPenalty: 0,
      extremePenalty: 0,
      timePenalty: 0,
      timeBonus: 50,
      noveltyBonus: 0,
      signalScore2: 100,
      signalType: "mispricing",
      reasonCodes: ["mispricing"],
      endDate: null,
    }, overrides);
  }

  // 1) Multi-outcome: groupItemTitle present → pill must contain it
  const sportsCard = renderTradeCard(makeTradeItem({ groupItemTitle: "Blue Jackets" }));
  assert(sportsCard.includes("Blue Jackets BUY YES"),
    "multi-outcome sports: pill contains 'Blue Jackets BUY YES'");

  // 2) Multi-outcome date: groupItemTitle = "April 15"
  const dateCard = renderTradeCard(makeTradeItem({
    question: "Trump announces end of military operations against Iran by ...?",
    eventTitle: "Trump announces end of military operations against Iran by ...?",
    groupItemTitle: "April 15",
  }));
  assert(dateCard.includes("April 15 BUY YES"),
    "multi-outcome date: pill contains 'April 15 BUY YES'");

  // 3) Multi-outcome range: groupItemTitle = "130+"
  const rangeCard = renderTradeCard(makeTradeItem({
    question: "# of seats won by TISZA in Hungary parliamentary election?",
    eventTitle: "# of seats won by TISZA in Hungary parliamentary election?",
    groupItemTitle: "130+",
  }));
  assert(rangeCard.includes("130+ BUY YES"),
    "multi-outcome range: pill contains '130+ BUY YES'");

  // 4) Single-outcome: no groupItemTitle → pill must NOT have double space before BUY
  const singleCard = renderTradeCard(makeTradeItem({ groupItemTitle: "" }));
  assert(!singleCard.includes("  BUY YES"),
    "single-outcome: pill does NOT have extra space before BUY YES");
  assert(singleCard.includes("BUY YES"),
    "single-outcome: pill still contains 'BUY YES'");

  // 5) Whitespace-only groupItemTitle treated as empty
  const wsCard = renderTradeCard(makeTradeItem({ groupItemTitle: "   " }));
  assert(!wsCard.includes("   BUY YES"),
    "whitespace-only groupItemTitle: no leading whitespace in pill");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
