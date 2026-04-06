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

async function fetchPolymarkets() {
  const baseUrl = "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500";
  const urls = [
    `${baseUrl}&offset=0`,
    `${baseUrl}&offset=500`,
  ];

  const results = await Promise.allSettled(urls.map((url) => fetchWithRetry(url)));

  const data = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      data.push(...result.value);
    } else {
      console.error(JSON.stringify({
        stage: "fetch",
        err: result.reason?.message || String(result.reason),
        ts: new Date().toISOString(),
      }));
    }
  }

  if (data.length === 0) {
    throw new Error("all fetch pages failed");
  }

  return data;
}

module.exports = { fetchPolymarkets };
