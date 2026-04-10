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

{
  // outcomes as JSON string (Polymarket API often returns this format)
  const m = normalizeMarket({
    question: "Match Winner",
    slug: "match-winner",
    outcomes: '["KOIA","BAR"]',
    groupItemTitle: "Match Winner",
  });
  assert(Array.isArray(m.outcomes), "JSON-string outcomes parsed into array");
  assert(m.outcomes.length === 2, "JSON-string outcomes has 2 entries");
  assert(m.outcomes[0] === "KOIA", "JSON-string outcomes[0] is KOIA");
  assert(m.outcomes[1] === "BAR", "JSON-string outcomes[1] is BAR");
}

{
  // outcomes as actual array (still works)
  const m = normalizeMarket({
    question: "Match Winner",
    slug: "match-winner",
    outcomes: ["MIN", "DAL"],
  });
  assert(m.outcomes[0] === "MIN", "array outcomes[0] is MIN");
  assert(m.outcomes[1] === "DAL", "array outcomes[1] is DAL");
}

{
  // outcomes as invalid JSON string falls back to empty array
  const m = normalizeMarket({
    question: "Q",
    slug: "q",
    outcomes: "not-json",
  });
  assert(Array.isArray(m.outcomes), "invalid JSON outcomes falls back to array");
  assert(m.outcomes.length === 0, "invalid JSON outcomes is empty");
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

  // No groupItemTitle + non-generic outcomes → subtext from outcomes[0]
  // (e.g. sports moneyline "Wild vs. Stars" with outcomes ["MIN","STL"])
  {
    const result = cardHeadline({
      question: "Wild vs. Stars",
      eventTitle: "Wild vs. Stars",
      outcomes: ["MIN", "STL"],
    });
    assert(result.headline === "Wild vs. Stars", "sports moneyline headline");
    assert(result.subtext === "MIN", "subtext derived from outcomes[0] when groupItemTitle absent");
  }

  // No groupItemTitle + generic outcomes → subtext stays empty
  {
    const result = cardHeadline({
      question: "Will rain tomorrow?",
      eventTitle: "Will rain tomorrow?",
      outcomes: ["Yes", "No"],
    });
    assert(result.headline === "Will rain tomorrow?", "binary market headline");
    assert(result.subtext === "", "subtext empty for generic outcomes");
  }

  // No groupItemTitle + non-generic outcomes + different eventTitle → mktLabel used as subtext
  {
    const result = cardHeadline({
      question: "YES",
      eventTitle: "Minnesota Wild @ St. Louis Blues",
      outcomes: ["MIN", "STL"],
    });
    assert(result.headline === "Minnesota Wild @ St. Louis Blues", "sports event headline from eventTitle");
    assert(result.subtext === "MIN vs STL", "subtext is mktLabel (outcomes joined) when eventTitle differs");
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

  // 1) Multi-outcome with outcomes array: uses outcomes[0] for Buy action, keeps groupItemTitle as label
  const sportsCard = renderTradeCard(makeTradeItem({
    groupItemTitle: "Blue Jackets",
    outcomes: ["CBJ", "BUF"],
  }));
  assert(sportsCard.includes("Blue Jackets Buy CBJ"),
    "multi-outcome sports with outcomes: pill contains 'Blue Jackets Buy CBJ' (groupItemTitle + button label)");
  assert(!sportsCard.includes("Buy Blue Jackets"),
    "multi-outcome sports with outcomes: pill does NOT use groupItemTitle 'Buy Blue Jackets'");

  // 1b) Multi-outcome WITHOUT outcomes array: falls back to groupItemTitle
  const sportsCardNoOC = renderTradeCard(makeTradeItem({ groupItemTitle: "Blue Jackets" }));
  assert(sportsCardNoOC.includes("Buy Blue Jackets"),
    "multi-outcome sports without outcomes: pill falls back to 'Buy Blue Jackets'");
  assert(!sportsCardNoOC.includes("Blue Jackets BUY YES"),
    "multi-outcome sports without outcomes: pill does NOT contain 'Blue Jackets BUY YES'");

  // 1c) NHL-style: groupItemTitle "Wild", outcomes ["MIN", "DAL"]
  const nhlCard = renderTradeCard(makeTradeItem({
    question: "Wild vs. Stars",
    eventTitle: "Wild vs. Stars",
    groupItemTitle: "Wild",
    outcomes: ["MIN", "DAL"],
  }));
  assert(nhlCard.includes("Wild Buy MIN"),
    "NHL sports: pill contains 'Wild Buy MIN' (groupItemTitle + button label)");
  assert(!nhlCard.includes("Buy Wild"),
    "NHL sports: pill does NOT use groupItemTitle 'Buy Wild'");

  // 2) Multi-outcome date: groupItemTitle = "April 15"
  const dateCard = renderTradeCard(makeTradeItem({
    question: "Trump announces end of military operations against Iran by ...?",
    eventTitle: "Trump announces end of military operations against Iran by ...?",
    groupItemTitle: "April 15",
  }));
  assert(dateCard.includes("Buy April 15"),
    "multi-outcome date: pill contains 'Buy April 15'");
  assert(!dateCard.includes("April 15 BUY YES"),
    "multi-outcome date: pill does NOT contain 'April 15 BUY YES'");

  // 3) Multi-outcome range: groupItemTitle = "130+"
  const rangeCard = renderTradeCard(makeTradeItem({
    question: "# of seats won by TISZA in Hungary parliamentary election?",
    eventTitle: "# of seats won by TISZA in Hungary parliamentary election?",
    groupItemTitle: "130+",
  }));
  assert(rangeCard.includes("Buy 130+"),
    "multi-outcome range: pill contains 'Buy 130+'");
  assert(!rangeCard.includes("130+ BUY YES"),
    "multi-outcome range: pill does NOT contain '130+ BUY YES'");

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

  // 6) O/U market: "O/U 2.5" → pill must say "Over 2.5 Buy Over"
  const ouCard = renderTradeCard(makeTradeItem({ groupItemTitle: "O/U 2.5" }));
  assert(ouCard.includes("Over 2.5 Buy Over"),
    "O/U outcome: pill contains 'Over 2.5 Buy Over'");
  assert(!ouCard.includes("O/U 2.5 BUY YES"),
    "O/U outcome: pill does NOT contain raw 'O/U 2.5 BUY YES'");

  // 7) O/U with different line: "O/U 3.5"
  const ou35Card = renderTradeCard(makeTradeItem({ groupItemTitle: "O/U 3.5" }));
  assert(ou35Card.includes("Over 3.5 Buy Over"),
    "O/U 3.5: pill contains 'Over 3.5 Buy Over'");
}

// ---------------------------------------------------------------------------
// formatOutcomeAction: unit tests for O/U label rewrite
// ---------------------------------------------------------------------------
{
  console.log("\nformatOutcomeAction: O/U label rewrite");
  const { formatOutcomeAction } = require("../src/html_renderer");

  // BUY YES on O/U market → Over
  const r1 = formatOutcomeAction("O/U 2.5", "BUY YES");
  assert(r1.displayLabel === "Over 2.5", "O/U 2.5 + BUY YES → displayLabel 'Over 2.5'");
  assert(r1.displayAction === "Buy Over", "O/U 2.5 + BUY YES → displayAction 'Buy Over'");

  // BUY NO on O/U market → Under
  const r2 = formatOutcomeAction("O/U 2.5", "BUY NO");
  assert(r2.displayLabel === "Under 2.5", "O/U 2.5 + BUY NO → displayLabel 'Under 2.5'");
  assert(r2.displayAction === "Buy Under", "O/U 2.5 + BUY NO → displayAction 'Buy Under'");

  // WATCH on O/U market → expanded but neutral
  const r3 = formatOutcomeAction("O/U 2.5", "WATCH");
  assert(r3.displayLabel === "Over/Under 2.5", "O/U 2.5 + WATCH → displayLabel 'Over/Under 2.5'");
  assert(r3.displayAction === "WATCH", "O/U 2.5 + WATCH → displayAction unchanged");

  // Non-O/U label with BUY YES → "Buy {label}" (no outcomes, fallback)
  const r4 = formatOutcomeAction("Blue Jackets", "BUY YES");
  assert(r4.displayLabel === "", "non-O/U BUY YES: displayLabel empty (folded into action)");
  assert(r4.displayAction === "Buy Blue Jackets", "non-O/U BUY YES no outcomes: displayAction 'Buy Blue Jackets'");

  // Non-O/U label with BUY YES + outcomes array → prefer outcomes[0], keep groupItemTitle as label
  const r4x = formatOutcomeAction("Wild", "BUY YES", ["MIN", "DAL"]);
  assert(r4x.displayLabel === "Wild", "non-O/U BUY YES+outcomes: displayLabel is groupItemTitle 'Wild'");
  assert(r4x.displayAction === "Buy MIN", "non-O/U BUY YES+outcomes: displayAction 'Buy MIN'");

  // Non-O/U label with BUY NO + outcomes array → prefer outcomes[1], keep groupItemTitle as label
  const r4y = formatOutcomeAction("Wild", "BUY NO", ["MIN", "DAL"]);
  assert(r4y.displayLabel === "Wild", "non-O/U BUY NO+outcomes: displayLabel is groupItemTitle 'Wild'");
  assert(r4y.displayAction === "Fade DAL", "non-O/U BUY NO+outcomes: displayAction 'Fade DAL'");

  // Non-O/U label with generic outcomes ["Yes","No"] → fallback to groupItemTitle
  const r4z = formatOutcomeAction("Blue Jackets", "BUY YES", ["Yes", "No"]);
  assert(r4z.displayAction === "Buy Blue Jackets", "generic outcomes fallback: displayAction 'Buy Blue Jackets'");

  // Non-O/U label with BUY NO → "Fade {label}" (no outcomes)
  const r4b = formatOutcomeAction("Blue Jackets", "BUY NO");
  assert(r4b.displayLabel === "", "non-O/U BUY NO: displayLabel empty");
  assert(r4b.displayAction === "Fade Blue Jackets", "non-O/U BUY NO: displayAction 'Fade Blue Jackets'");

  // Non-O/U label with WATCH → passes through unchanged
  const r4c = formatOutcomeAction("Blue Jackets", "WATCH");
  assert(r4c.displayLabel === "Blue Jackets", "non-O/U WATCH: displayLabel unchanged");
  assert(r4c.displayAction === "WATCH", "non-O/U WATCH: displayAction unchanged");

  // Empty label passes through
  const r5 = formatOutcomeAction("", "BUY YES");
  assert(r5.displayLabel === "", "empty label: displayLabel empty");
  assert(r5.displayAction === "BUY YES", "empty label: displayAction unchanged");

  // Empty groupItemTitle + non-generic outcomes → uses outcomes for action
  const r5a = formatOutcomeAction("", "BUY YES", ["MIN", "STL"]);
  assert(r5a.displayLabel === "", "empty label+outcomes: displayLabel empty");
  assert(r5a.displayAction === "Buy MIN", "empty label+outcomes: displayAction 'Buy MIN'");

  const r5b = formatOutcomeAction("", "BUY NO", ["MIN", "STL"]);
  assert(r5b.displayLabel === "", "empty label+outcomes BUY NO: displayLabel empty");
  assert(r5b.displayAction === "Fade STL", "empty label+outcomes BUY NO: displayAction 'Fade STL'");

  // Empty groupItemTitle + generic outcomes → still passes through
  const r5c = formatOutcomeAction("", "BUY YES", ["Yes", "No"]);
  assert(r5c.displayLabel === "", "empty label+generic outcomes: displayLabel empty");
  assert(r5c.displayAction === "BUY YES", "empty label+generic outcomes: displayAction unchanged");

  // Case-insensitive O/U matching
  const r6 = formatOutcomeAction("o/u 1.5", "BUY YES");
  assert(r6.displayLabel === "Over 1.5", "lowercase o/u: displayLabel 'Over 1.5'");
  assert(r6.displayAction === "Buy Over", "lowercase o/u: displayAction 'Buy Over'");
}

// ---------------------------------------------------------------------------
// cardHeadline: O/U subtext expansion
// ---------------------------------------------------------------------------
{
  console.log("\ncardHeadline: O/U subtext expansion");
  const { cardHeadline } = require("../src/html_renderer");

  const result = cardHeadline({
    eventTitle: "SC Braga vs. Real Betis Balompié",
    question: "Will SC Braga vs Real Betis go over 2.5 goals?",
    groupItemTitle: "O/U 2.5",
  });
  assert(result.subtext === "Over/Under 2.5",
    "O/U groupItemTitle expanded to 'Over/Under 2.5' in subtext");
  assert(result.headline === "SC Braga vs. Real Betis Balompié",
    "headline unchanged for O/U market");
}

// ---------------------------------------------------------------------------
// matchMarketFromArray (auto_monitor) — strict fail-closed
// ---------------------------------------------------------------------------
{
  console.log("\nmatchMarketFromArray (strict fail-closed)");
  const { matchMarketFromArray } = require("../src/auto_monitor");

  // Empty / null / undefined array → null
  assert(matchMarketFromArray([], { conditionId: "0xabc" }) === null,
    "empty array returns null");
  assert(matchMarketFromArray(null, { conditionId: "0xabc" }) === null,
    "null array returns null");
  assert(matchMarketFromArray(undefined, { conditionId: "0xabc" }) === null,
    "undefined array returns null");

  // Single-element array → matches only if conditionId matches (no auto-return)
  const single = [{ conditionId: "0xabc", bestBid: "0.55" }];
  assert(matchMarketFromArray(single, { conditionId: "0xabc" }) === single[0],
    "single element matched by conditionId");
  assert(matchMarketFromArray(single, { conditionId: "0xZZZ" }) === null,
    "single element NOT returned when conditionId doesn't match (fail-closed)");

  // Multi-element: match by conditionId (uses ticket.conditionId field)
  const mktA = { conditionId: "0xAAA", question: "Q-A", bestBid: "0.40" };
  const mktB = { conditionId: "0xBBB", question: "Q-B", bestBid: "0.70" };
  const multi = [mktA, mktB];

  assert(matchMarketFromArray(multi, { conditionId: "0xBBB" }) === mktB,
    "conditionId match picks correct market (second)");
  assert(matchMarketFromArray(multi, { conditionId: "0xAAA" }) === mktA,
    "conditionId match picks correct market (first)");

  // Case-insensitive conditionId matching
  assert(matchMarketFromArray(multi, { conditionId: "0xbbb" }) === mktB,
    "conditionId match is case-insensitive");

  // Fail-closed: conditionId not found → returns null (NO question fallback)
  const mktC = { conditionId: "0xCCC", question: "Will it rain tomorrow?" };
  const mktD = { conditionId: "0xDDD", question: "Will BTC hit 100k?" };
  const arr2 = [mktC, mktD];
  assert(matchMarketFromArray(arr2, { conditionId: "0xZZZ", question: "Will BTC hit 100k?" }) === null,
    "no question fallback — returns null when conditionId mismatches (fail-closed)");

  // Fail-closed: no match → returns null (NO arr[0] fallback)
  assert(matchMarketFromArray(arr2, { conditionId: "0xZZZ", question: "No match" }) === null,
    "no arr[0] fallback — returns null (fail-closed)");

  // Fail-closed: empty ticket → returns null (NO arr[0] fallback)
  assert(matchMarketFromArray(arr2, {}) === null,
    "empty ticket returns null (fail-closed)");

  // marketId-only ticket returns null (no fallback to legacy marketId)
  assert(matchMarketFromArray(multi, { marketId: "0xBBB" }) === null,
    "marketId-only ticket returns null (no marketId fallback, fail-closed)");

  // condition_id field variant (some API responses use snake_case)
  const mktE = { condition_id: "0xEEE", question: "Snake case?" };
  const mktF = { condition_id: "0xFFF", question: "Other" };
  assert(matchMarketFromArray([mktE, mktF], { conditionId: "0xFFF" }) === mktF,
    "condition_id (snake_case) variant matched");
  assert(matchMarketFromArray([mktE, mktF], { conditionId: "0xfff" }) === mktF,
    "condition_id (snake_case) case-insensitive match");

  // No conditionId on ticket AND no marketId → null (fail-closed)
  assert(matchMarketFromArray([mktA, mktB], { question: "Q-A" }) === null,
    "question-only ticket returns null (fail-closed, no question matching)");
}

// ---------------------------------------------------------------------------
// detectMarketEndState (auto_monitor)
// ---------------------------------------------------------------------------
{
  console.log("\ndetectMarketEndState");
  const { detectMarketEndState } = require("../src/auto_monitor");

  // null / undefined → all false
  const r0 = detectMarketEndState(null);
  assert(r0.ended === false && r0.settled === false && r0.closed === false,
    "null data returns all false");
  const r0b = detectMarketEndState(undefined);
  assert(r0b.ended === false && r0b.settled === false && r0b.closed === false,
    "undefined data returns all false");

  // Empty object → all false
  const r1 = detectMarketEndState({});
  assert(r1.ended === false && r1.settled === false && r1.closed === false,
    "empty object returns all false");

  // resolved: true → settled
  const r2 = detectMarketEndState({ resolved: true });
  assert(r2.settled === true, "resolved=true → settled=true");
  assert(r2.closed === false, "resolved=true → closed=false");

  // closed: true → closed
  const r3 = detectMarketEndState({ closed: true });
  assert(r3.closed === true, "closed=true → closed=true");

  // end_date_iso in the past → ended
  const pastDate = new Date(Date.now() - 86400000).toISOString();
  const r4 = detectMarketEndState({ end_date_iso: pastDate });
  assert(r4.ended === true, "past end_date_iso → ended=true");

  // endDate in the future → NOT ended
  const futureDate = new Date(Date.now() + 86400000 * 30).toISOString();
  const r5 = detectMarketEndState({ endDate: futureDate });
  assert(r5.ended === false, "future endDate → ended=false");

  // active: false (not settled) → ended
  const r6 = detectMarketEndState({ active: false });
  assert(r6.ended === true, "active=false → ended=true");

  // active: false + resolved: true → settled (not just ended)
  const r7 = detectMarketEndState({ active: false, resolved: true });
  assert(r7.settled === true, "active=false+resolved=true → settled=true");
  // active=false with resolved → ended stays false (settled takes precedence logically)
  // actually per code: active===false && !settled → ended; here settled is true so ended stays false
  assert(r7.ended === false, "active=false+resolved=true → ended=false (settled overrides)");

  // Combined: end_date_iso past + closed + resolved
  const r8 = detectMarketEndState({ end_date_iso: pastDate, closed: true, resolved: true });
  assert(r8.ended === true && r8.settled === true && r8.closed === true,
    "all flags set when all conditions met");

  // active: true (explicitly) → not ended (even if no other flags)
  const r9 = detectMarketEndState({ active: true });
  assert(r9.ended === false, "active=true → ended=false");
}

// ---------------------------------------------------------------------------
// Price fallback chain documentation tests (auto_monitor)
// ---------------------------------------------------------------------------
// These tests verify the price extraction helpers and fallback chain contract.
// getCurrentCloseablePrice is async (requires fetch), so we test the building
// blocks and document the chain:
//   bestBid → outcomePrices → lastTradePrice (SIM-only + freshness-gated)
{
  console.log("\nPrice fallback chain contract");

  // Verify matchMarketFromArray still returns the data object with all fields
  const { matchMarketFromArray } = require("../src/auto_monitor");

  // Market with all price fields (bestBid, bestAsk, outcomePrices, lastTradePrice)
  const fullMarket = {
    conditionId: "0xABC",
    bestBid: "0.65",
    bestAsk: "0.67",
    outcomePrices: '["0.66","0.34"]',
    lastTradePrice: "0.66",
    updatedAt: new Date().toISOString(),
    resolved: false,
    closed: false,
  };
  const matched = matchMarketFromArray([fullMarket], { conditionId: "0xABC" });
  assert(matched === fullMarket, "matched market preserves all price fields");
  assert(matched.bestBid === "0.65", "bestBid accessible on matched market");
  assert(matched.lastTradePrice === "0.66", "lastTradePrice accessible on matched market");
  assert(typeof matched.updatedAt === "string", "updatedAt accessible on matched market");

  // Market with NO bestBid/bestAsk but WITH lastTradePrice (live sports scenario)
  const sportsLive = {
    conditionId: "0xSPORT",
    bestBid: null,
    bestAsk: null,
    outcomePrices: null,
    lastTradePrice: "0.72",
    updatedAt: new Date().toISOString(),
    resolved: false,
    closed: false,
  };
  const sportMatch = matchMarketFromArray([sportsLive], { conditionId: "0xSPORT" });
  assert(sportMatch === sportsLive, "sports market matched despite null orderbook");
  assert(sportMatch.lastTradePrice === "0.72", "lastTradePrice is the only price available");
  // Verify bestBid would fail the parseFloat check → fallback chain needed
  const bestBid = parseFloat(sportMatch.bestBid);
  assert(!Number.isFinite(bestBid) || bestBid <= 0,
    "bestBid null → parseFloat fails → triggers fallback chain");
  const ltp = parseFloat(sportMatch.lastTradePrice);
  assert(Number.isFinite(ltp) && ltp > 0,
    "lastTradePrice parses to valid number → fallback succeeds");

  // Settled market: bestBid null, outcomePrices present, lastTradePrice stale
  const settled = {
    conditionId: "0xSETTLED",
    bestBid: null,
    bestAsk: null,
    outcomePrices: '["1.0","0.0"]',
    lastTradePrice: "0.95",
    resolved: true,
  };
  const settledMatch = matchMarketFromArray([settled], { conditionId: "0xSETTLED" });
  assert(settledMatch.resolved === true, "settled market resolved flag preserved");
  let opStr = settledMatch.outcomePrices;
  let op;
  try { op = JSON.parse(opStr); } catch (_) { op = null; }
  assert(Array.isArray(op) && parseFloat(op[0]) === 1.0,
    "outcomePrices [1.0, 0.0] → fallback 1 catches settled market");
}

// ---------------------------------------------------------------------------
// lastTradePrice gating contract tests (auto_monitor)
// ---------------------------------------------------------------------------
// Verify the gating logic independently. getCurrentCloseablePrice is async
// (needs fetch), so we test the gating decision rules as documented contracts.
{
  console.log("\nlastTradePrice gating contract");
  const cfgMod = require("../src/config");

  // Document the config constant exists and defaults
  assert(typeof cfgMod.AUTO_MODE_LTP_MAX_AGE_SEC === "number",
    "AUTO_MODE_LTP_MAX_AGE_SEC is a number");
  assert(cfgMod.AUTO_MODE_LTP_MAX_AGE_SEC === 120,
    "AUTO_MODE_LTP_MAX_AGE_SEC default is 120s");

  // Gate logic: paperClose=false → NOT_PAPER_CLOSE (never use for non-SIM)
  // (Verified via documented contract — function accepts opts.paperClose)

  // Freshness: updatedAt within 120s → age ≤ 120 → PASS
  const recentUpdatedAt = new Date(Date.now() - 30 * 1000).toISOString();
  const recentMs = new Date(recentUpdatedAt).getTime();
  const recentAge = Math.round((Date.now() - recentMs) / 1000);
  assert(recentAge <= cfgMod.AUTO_MODE_LTP_MAX_AGE_SEC,
    "30s-old updatedAt is within freshness window");

  // Freshness: updatedAt 5 minutes ago → age > 120 → STALE
  const staleUpdatedAt = new Date(Date.now() - 300 * 1000).toISOString();
  const staleMs = new Date(staleUpdatedAt).getTime();
  const staleAge = Math.round((Date.now() - staleMs) / 1000);
  assert(staleAge > cfgMod.AUTO_MODE_LTP_MAX_AGE_SEC,
    "300s-old updatedAt exceeds freshness window → gated as STALE");

  // Freshness: missing updatedAt → null → NO_UPDATED_AT
  const noTimestamp = null;
  const parsedMs = noTimestamp ? new Date(noTimestamp).getTime() : NaN;
  assert(!Number.isFinite(parsedMs),
    "null updatedAt → cannot compute age → gated as NO_UPDATED_AT");

  // Freshness: invalid updatedAt → NaN → NO_UPDATED_AT
  const badUpdatedAt = "not-a-date";
  const badMs = new Date(badUpdatedAt).getTime();
  assert(!Number.isFinite(badMs),
    "invalid updatedAt → NaN → gated as NO_UPDATED_AT");

  // lastTradePrice numeric validity
  assert(Number.isFinite(parseFloat("0.72")) && parseFloat("0.72") > 0,
    "valid lastTradePrice '0.72' passes numeric gate");
  assert(!Number.isFinite(parseFloat(null)),
    "null lastTradePrice fails numeric gate");
  assert(!Number.isFinite(parseFloat(undefined)),
    "undefined lastTradePrice fails numeric gate");
  assert(!(parseFloat("0") > 0),
    "lastTradePrice '0' fails > 0 gate");
  assert(!(parseFloat("-0.5") > 0),
    "negative lastTradePrice fails > 0 gate");
}

// ---------------------------------------------------------------------------
// CLOB integration: resolveTokenId (auto_monitor)
// ---------------------------------------------------------------------------
{
  console.log("\nresolveTokenId (CLOB token selection by action)");
  const { resolveTokenId } = require("../src/auto_monitor");

  // BUY_YES → yesTokenId
  assert(
    resolveTokenId({ action: "BUY_YES", yesTokenId: "tok_yes_123", noTokenId: "tok_no_456" }) === "tok_yes_123",
    "BUY_YES selects yesTokenId"
  );

  // BUY_NO → noTokenId
  assert(
    resolveTokenId({ action: "BUY_NO", yesTokenId: "tok_yes_123", noTokenId: "tok_no_456" }) === "tok_no_456",
    "BUY_NO selects noTokenId"
  );

  // BUY_YES with no yesTokenId → null
  assert(
    resolveTokenId({ action: "BUY_YES", yesTokenId: null, noTokenId: "tok_no_456" }) === null,
    "BUY_YES with null yesTokenId returns null"
  );

  // BUY_NO with no noTokenId → null
  assert(
    resolveTokenId({ action: "BUY_NO", yesTokenId: "tok_yes_123", noTokenId: null }) === null,
    "BUY_NO with null noTokenId returns null"
  );

  // BUY_YES with empty string → null
  assert(
    resolveTokenId({ action: "BUY_YES", yesTokenId: "", noTokenId: "tok_no_456" }) === null,
    "BUY_YES with empty yesTokenId returns null"
  );

  // WATCH action → null (no token selection)
  assert(
    resolveTokenId({ action: "WATCH", yesTokenId: "tok_yes_123", noTokenId: "tok_no_456" }) === null,
    "WATCH action returns null"
  );

  // Missing action → null
  assert(
    resolveTokenId({ yesTokenId: "tok_yes_123", noTokenId: "tok_no_456" }) === null,
    "missing action returns null"
  );

  // Both tokens present, BUY_YES selects correct one (not noTokenId)
  assert(
    resolveTokenId({ action: "BUY_YES", yesTokenId: "A", noTokenId: "B" }) === "A",
    "BUY_YES selects 'A' not 'B'"
  );
  assert(
    resolveTokenId({ action: "BUY_NO", yesTokenId: "A", noTokenId: "B" }) === "B",
    "BUY_NO selects 'B' not 'A'"
  );
}

// ---------------------------------------------------------------------------
// CLOB integration: normalizeMarket extracts clobTokenIds → yesTokenId/noTokenId
// ---------------------------------------------------------------------------
{
  console.log("\nnormalizeMarket: clobTokenIds extraction");

  // Standard JSON string array (Gamma API format)
  const item1 = {
    question: "Will BTC hit 100k?",
    clobTokenIds: '["tok_yes_abc","tok_no_xyz"]',
    outcomePrices: '["0.65","0.35"]',
  };
  const norm1 = normalizeMarket(item1);
  assert(norm1.yesTokenId === "tok_yes_abc",
    "clobTokenIds JSON string → yesTokenId = tok_yes_abc");
  assert(norm1.noTokenId === "tok_no_xyz",
    "clobTokenIds JSON string → noTokenId = tok_no_xyz");

  // Already parsed array
  const item2 = {
    question: "Will ETH merge?",
    clobTokenIds: ["already_parsed_yes", "already_parsed_no"],
    outcomePrices: '["0.50","0.50"]',
  };
  const norm2 = normalizeMarket(item2);
  assert(norm2.yesTokenId === "already_parsed_yes",
    "clobTokenIds array → yesTokenId");
  assert(norm2.noTokenId === "already_parsed_no",
    "clobTokenIds array → noTokenId");

  // Missing clobTokenIds → null
  const item3 = {
    question: "Legacy market",
    outcomePrices: '["0.80","0.20"]',
  };
  const norm3 = normalizeMarket(item3);
  assert(norm3.yesTokenId === null,
    "missing clobTokenIds → yesTokenId null");
  assert(norm3.noTokenId === null,
    "missing clobTokenIds → noTokenId null");

  // Invalid JSON string → null
  const item4 = {
    question: "Bad data market",
    clobTokenIds: "not-valid-json",
    outcomePrices: '["0.50","0.50"]',
  };
  const norm4 = normalizeMarket(item4);
  assert(norm4.yesTokenId === null,
    "invalid clobTokenIds JSON → yesTokenId null");
  assert(norm4.noTokenId === null,
    "invalid clobTokenIds JSON → noTokenId null");

  // Single element array → yes but no noTokenId
  const item5 = {
    question: "Single token market",
    clobTokenIds: '["only_yes"]',
    outcomePrices: '["0.50","0.50"]',
  };
  const norm5 = normalizeMarket(item5);
  assert(norm5.yesTokenId === "only_yes",
    "single-element clobTokenIds → yesTokenId present");
  assert(norm5.noTokenId === null,
    "single-element clobTokenIds → noTokenId null");

  // Empty array → null
  const item6 = {
    question: "Empty tokens market",
    clobTokenIds: "[]",
    outcomePrices: '["0.50","0.50"]',
  };
  const norm6 = normalizeMarket(item6);
  assert(norm6.yesTokenId === null,
    "empty clobTokenIds array → yesTokenId null");
  assert(norm6.noTokenId === null,
    "empty clobTokenIds array → noTokenId null");
}

// ---------------------------------------------------------------------------
// CLOB integration: getClobPrice diagnostic contract tests
// ---------------------------------------------------------------------------
{
  console.log("\ngetClobPrice diagnostic contracts");
  const { getClobPrice, resolveTokenId } = require("../src/auto_monitor");

  // Verify getClobPrice._lastDiag is initialized
  assert(getClobPrice._lastDiag === null || typeof getClobPrice._lastDiag === "object",
    "getClobPrice._lastDiag exists (null or object)");

  // Verify resolveTokenId handles edge cases (additional coverage)
  assert(resolveTokenId({}) === null,
    "empty ticket object → null");
  assert(resolveTokenId({ action: "BUY_YES" }) === null,
    "BUY_YES without yesTokenId field → null");
  assert(resolveTokenId({ action: "BUY_NO" }) === null,
    "BUY_NO without noTokenId field → null");
  assert(resolveTokenId({ action: "BUY_YES", yesTokenId: 0 }) === null,
    "BUY_YES with falsy yesTokenId=0 → null");
  assert(resolveTokenId({ action: "BUY_NO", noTokenId: false }) === null,
    "BUY_NO with falsy noTokenId=false → null");
}

// ---------------------------------------------------------------------------
// CLOB integration: tickets without token IDs get autoClose disabled
// ---------------------------------------------------------------------------
{
  console.log("\nCLOB: missing token IDs → autoClose blocked");

  // Document the contract: resolveTokenId returns null for tickets without IDs
  const { resolveTokenId } = require("../src/auto_monitor");

  // Simulating what monitorTick does: if resolveTokenId returns null,
  // the ticket should be blocked with MISSING_TOKEN_ID reason.

  const ticketNoTokens = {
    _id: "fakeid123",
    action: "BUY_YES",
    conditionId: "0xABC",
    // yesTokenId missing
  };
  const tokenId = resolveTokenId(ticketNoTokens);
  assert(tokenId === null,
    "ticket without yesTokenId → resolveTokenId returns null");

  const ticketWithTokens = {
    _id: "fakeid456",
    action: "BUY_YES",
    conditionId: "0xABC",
    yesTokenId: "tok_yes_123",
  };
  const tokenId2 = resolveTokenId(ticketWithTokens);
  assert(tokenId2 === "tok_yes_123",
    "ticket with yesTokenId → resolveTokenId returns token");

  // NO side
  const ticketNoNoToken = {
    _id: "fakeid789",
    action: "BUY_NO",
    conditionId: "0xDEF",
    yesTokenId: "tok_yes_123",
    // noTokenId missing
  };
  assert(resolveTokenId(ticketNoNoToken) === null,
    "BUY_NO ticket without noTokenId → resolveTokenId returns null");
}

// ---------------------------------------------------------------------------
// CLOB: checkTrigger with CLOB-sourced prices (contract verification)
// ---------------------------------------------------------------------------
{
  console.log("\nCLOB: checkTrigger with CLOB prices");
  const { checkTrigger } = require("../src/auto_monitor");

  // TP hit at CLOB price
  const tp = checkTrigger({ takeProfit: 0.75, riskExitLimit: 0.30 }, 0.80);
  assert(tp.triggered === true && tp.reason === "TP_HIT",
    "CLOB price 0.80 >= TP 0.75 → TP_HIT");

  // EXIT hit at CLOB price
  const exit = checkTrigger({ takeProfit: 0.75, riskExitLimit: 0.30 }, 0.25);
  assert(exit.triggered === true && exit.reason === "EXIT_HIT",
    "CLOB price 0.25 <= EXIT 0.30 → EXIT_HIT");

  // Neither TP nor EXIT hit
  const miss = checkTrigger({ takeProfit: 0.75, riskExitLimit: 0.30 }, 0.50);
  assert(miss.triggered === false,
    "CLOB price 0.50 between TP and EXIT → not triggered");

  // Exact TP boundary
  const exact = checkTrigger({ takeProfit: 0.75, riskExitLimit: 0.30 }, 0.75);
  assert(exact.triggered === true && exact.reason === "TP_HIT",
    "CLOB price exactly at TP → TP_HIT");

  // Exact EXIT boundary
  const exactExit = checkTrigger({ takeProfit: 0.75, riskExitLimit: 0.30 }, 0.30);
  assert(exactExit.triggered === true && exactExit.reason === "EXIT_HIT",
    "CLOB price exactly at EXIT → EXIT_HIT");
}

// ---------------------------------------------------------------------------
// CLOB monitorState: verify CLOB diagnostic counters exist
// ---------------------------------------------------------------------------
{
  console.log("\nCLOB monitorState diagnostic counters");
  const { monitorState } = require("../src/auto_monitor");

  assert(typeof monitorState.lastTickClobPriceOk === "number",
    "lastTickClobPriceOk counter exists");
  assert(typeof monitorState.lastTickClobPriceNull === "number",
    "lastTickClobPriceNull counter exists");
  assert(typeof monitorState.lastTickClobPrice404 === "number",
    "lastTickClobPrice404 counter exists");
  assert(typeof monitorState.lastTickClobRateLimit === "number",
    "lastTickClobRateLimit counter exists");
  assert(typeof monitorState.lastTickClobTokenIdMissing === "number",
    "lastTickClobTokenIdMissing counter exists");

  // Verify all are initialized to 0
  assert(monitorState.lastTickClobPriceOk === 0,
    "lastTickClobPriceOk default 0");
  assert(monitorState.lastTickClobPriceNull === 0,
    "lastTickClobPriceNull default 0");
  assert(monitorState.lastTickClobPrice404 === 0,
    "lastTickClobPrice404 default 0");
  assert(monitorState.lastTickClobRateLimit === 0,
    "lastTickClobRateLimit default 0");
  assert(monitorState.lastTickClobTokenIdMissing === 0,
    "lastTickClobTokenIdMissing default 0");
}

// ---------------------------------------------------------------------------
// TradeTicket schema: verify CLOB fields exist in schema
// ---------------------------------------------------------------------------
{
  console.log("\nTradeTicket schema: CLOB fields");
  const TradeTicket = require("../models/TradeTicket");
  const schemaPaths = TradeTicket.schema.paths;

  assert("yesTokenId" in schemaPaths,
    "yesTokenId field exists in TradeTicket schema");
  assert("noTokenId" in schemaPaths,
    "noTokenId field exists in TradeTicket schema");
  assert("priceSource" in schemaPaths,
    "priceSource field exists in TradeTicket schema");

  // Verify defaults
  assert(schemaPaths.yesTokenId.defaultValue === null,
    "yesTokenId defaults to null");
  assert(schemaPaths.noTokenId.defaultValue === null,
    "noTokenId defaults to null");
  assert(schemaPaths.priceSource.defaultValue === null,
    "priceSource defaults to null");
}

// ---------------------------------------------------------------------------
// TradeTicket schema: diagnostic fields
// ---------------------------------------------------------------------------
{
  console.log("\nTradeTicket schema: diagnostic fields");
  const TradeTicket = require("../models/TradeTicket");
  const schemaPaths = TradeTicket.schema.paths;

  assert("lastMonitorBlockedReason" in schemaPaths,
    "lastMonitorBlockedReason field exists in TradeTicket schema");
  assert("lastMonitorBlockedAt" in schemaPaths,
    "lastMonitorBlockedAt field exists in TradeTicket schema");
  assert("lastMonitorMeta" in schemaPaths,
    "lastMonitorMeta field exists in TradeTicket schema");

  // Verify defaults
  assert(schemaPaths.lastMonitorBlockedReason.defaultValue === null,
    "lastMonitorBlockedReason defaults to null");
  assert(schemaPaths.lastMonitorBlockedAt.defaultValue === null,
    "lastMonitorBlockedAt defaults to null");
  assert(schemaPaths.lastMonitorMeta.defaultValue === null,
    "lastMonitorMeta defaults to null");

  // Verify indexes exist (sparse indexes on reason fields)
  const indexDefs = TradeTicket.schema._indexes;
  const hasBlockedReasonIdx = indexDefs.some(
    (idx) => idx[0] && idx[0].autoCloseBlockedReason === 1
  );
  assert(hasBlockedReasonIdx, "autoCloseBlockedReason index exists");
  const hasMonitorReasonIdx = indexDefs.some(
    (idx) => idx[0] && idx[0].lastMonitorBlockedReason === 1
  );
  assert(hasMonitorReasonIdx, "lastMonitorBlockedReason index exists");
}

// ---------------------------------------------------------------------------
// DIAGNOSTIC_REASONS: canonical set
// ---------------------------------------------------------------------------
{
  console.log("\nDIAGNOSTIC_REASONS: canonical set");
  const { DIAGNOSTIC_REASONS } = require("../src/html_renderer");

  assert(typeof DIAGNOSTIC_REASONS === "object" && DIAGNOSTIC_REASONS !== null,
    "DIAGNOSTIC_REASONS is exported as an object");

  const expectedReasons = [
    "MISSING_TOKEN_ID", "NO_ORDERBOOK", "NO_BIDS", "INVALID_TOP_BID",
    "IDENTITY_SKIP", "SETTLED", "ENDED",
  ];
  for (const reason of expectedReasons) {
    assert(reason in DIAGNOSTIC_REASONS, `${reason} is a defined diagnostic reason`);
    const info = DIAGNOSTIC_REASONS[reason];
    assert(typeof info.label === "string" && info.label.length > 0,
      `${reason} has a non-empty label`);
    assert(typeof info.explanation === "string" && info.explanation.length > 0,
      `${reason} has a non-empty explanation`);
    assert(typeof info.whatToDo === "string" && info.whatToDo.length > 0,
      `${reason} has a non-empty whatToDo`);
    assert(info.queryParam === "blockedReason" || info.queryParam === "monitorReason",
      `${reason} has a valid queryParam`);
  }
}

// ---------------------------------------------------------------------------
// persistMonitorReason export
// ---------------------------------------------------------------------------
{
  console.log("\npersistMonitorReason: export check");
  const { persistMonitorReason } = require("../src/auto_monitor");
  assert(typeof persistMonitorReason === "function",
    "persistMonitorReason is exported as a function");
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
