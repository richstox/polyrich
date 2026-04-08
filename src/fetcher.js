"use strict";

const config = require("./config");

async function fetchWithRetry(url) {
  const maxAttempts = config.FETCH_RETRY_COUNT + 1;
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// Events-based discovery (paginated)
// ---------------------------------------------------------------------------

/**
 * Fetch all active events from the Gamma API, paginating through offset.
 * Returns { events, markets, stats }.
 *   events  – raw event objects from the API
 *   markets – flattened market objects with event context attached
 *   stats   – { eventsFetched, marketsFlattened, pagesFetched }
 */
async function fetchPolymarkets() {
  const limit = config.EVENTS_PAGE_SIZE;
  const maxPages = config.EVENTS_MAX_PAGES;
  const baseUrl = "https://gamma-api.polymarket.com/events";

  const allEvents = [];
  let pagesFetched = 0;

  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;
    const url = `${baseUrl}?active=true&closed=false&limit=${limit}&offset=${offset}`;

    let batch;
    try {
      batch = await fetchWithRetry(url);
    } catch (err) {
      console.error(JSON.stringify({
        stage: "fetch-events",
        page,
        offset,
        err: err.message || String(err),
        ts: new Date().toISOString(),
      }));
      // If the first page fails, nothing to work with
      if (page === 0) throw new Error("first events page failed: " + (err.message || "unknown error"));
      break;
    }

    if (!Array.isArray(batch)) {
      console.error(JSON.stringify({
        stage: "fetch-events",
        msg: "unexpected non-array response",
        page,
        ts: new Date().toISOString(),
      }));
      break;
    }

    pagesFetched++;
    allEvents.push(...batch);

    // Stop paginating when we got fewer than limit (last page)
    if (batch.length < limit) break;
  }

  if (allEvents.length === 0) {
    throw new Error("all events fetch pages failed");
  }

  // Flatten events → markets, attaching event context
  const markets = [];
  for (const event of allEvents) {
    const eventSlug = event.slug || "";
    const category = event.category || "";
    const subcategory = event.subcategory || "";
    const tags = Array.isArray(event.tags) ? event.tags : [];
    const eventMarkets = Array.isArray(event.markets) ? event.markets : [];

    const eventTitle = event.title || "";
    for (const mkt of eventMarkets) {
      // Attach event-level context onto each market object
      mkt.eventSlug = eventSlug;
      mkt.eventTitle = eventTitle;
      if (!mkt.category) mkt.category = category;
      mkt.subcategory = subcategory;
      mkt.eventTags = tags;
    }
    markets.push(...eventMarkets);
  }

  const stats = {
    eventsFetched: allEvents.length,
    marketsFlattened: markets.length,
    pagesFetched,
  };

  console.log(JSON.stringify({
    stage: "fetch-events-done",
    ...stats,
    universe: `Universe scanned this run: ${stats.eventsFetched} events → ${stats.marketsFlattened} markets (${stats.pagesFetched} pages)`,
    ts: new Date().toISOString(),
  }));

  return { events: allEvents, markets, stats };
}

// ---------------------------------------------------------------------------
// Tags & Sports reference data
// ---------------------------------------------------------------------------

async function fetchTags() {
  try {
    return await fetchWithRetry("https://gamma-api.polymarket.com/tags");
  } catch (err) {
    console.error(JSON.stringify({ stage: "fetch-tags", err: err.message, ts: new Date().toISOString() }));
    return [];
  }
}

async function fetchSports() {
  try {
    return await fetchWithRetry("https://gamma-api.polymarket.com/sports");
  } catch (err) {
    console.error(JSON.stringify({ stage: "fetch-sports", err: err.message, ts: new Date().toISOString() }));
    return [];
  }
}

module.exports = { fetchPolymarkets, fetchTags, fetchSports };
