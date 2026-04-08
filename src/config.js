"use strict";

module.exports = {
  MONGO_URL: process.env.MONGO_URL,
  PORT: parseInt(process.env.PORT || "3000", 10),

  // scan settings
  HISTORY_K: parseInt(process.env.HISTORY_K || "6", 10),
  WATCHLIST_SIZE: parseInt(process.env.WATCHLIST_SIZE || "200", 10),
  SIGNALS_SIZE: parseInt(process.env.SIGNALS_SIZE || "80", 10),
  FINAL_CANDIDATES_SIZE: parseInt(process.env.FINAL_CANDIDATES_SIZE || "20", 10),
  MOVERS_SIZE: parseInt(process.env.MOVERS_SIZE || "15", 10),
  SAVED_PER_SCAN: parseInt(process.env.SAVED_PER_SCAN || "200", 10),
  SAVED_PER_SCAN_MIN: parseInt(process.env.SAVED_PER_SCAN_MIN || "2000", 10),
  SAVED_PER_SCAN_PCT: parseFloat(process.env.SAVED_PER_SCAN_PCT || "0.05"),
  SAVED_PER_SCAN_CAP: parseInt(process.env.SAVED_PER_SCAN_CAP || "5000", 10),
  SAVED_DYNAMIC_THRESHOLD: parseInt(process.env.SAVED_DYNAMIC_THRESHOLD || "5000", 10),
  NOVELTY_LOOKBACK_SCANS: parseInt(process.env.NOVELTY_LOOKBACK_SCANS || "5", 10),
  SCAN_INTERVAL_MS: parseInt(process.env.SCAN_INTERVAL_MS || String(5 * 60 * 1000), 10),

  // retention (days)
  SNAPSHOT_TTL_DAYS: parseInt(process.env.SNAPSHOT_TTL_DAYS || "14", 10),
  SHOWN_CANDIDATE_TTL_DAYS: parseInt(process.env.SHOWN_CANDIDATE_TTL_DAYS || "30", 10),

  // signal quality
  FEE_SLIPPAGE_BUFFER: parseFloat(process.env.FEE_SLIPPAGE_BUFFER || "0.02"),
  MAX_SPREAD_HARD: parseFloat(process.env.MAX_SPREAD_HARD || "0.5"),
  // Static spreadPct ceiling: markets above this are never flagged as mispricing
  MISPRICING_MAX_SPREAD_PCT_STATIC: parseFloat(process.env.MISPRICING_MAX_SPREAD_PCT_STATIC || "0.30"),
  // Minimum price delta (abs) per step to qualify as a reversal leg
  REVERSAL_MIN_DELTA: parseFloat(process.env.REVERSAL_MIN_DELTA || "0.003"),
  // Minimum historical volatility to qualify as a reversal
  REVERSAL_MIN_VOLATILITY: parseFloat(process.env.REVERSAL_MIN_VOLATILITY || "0.003"),
  // Large negative score applied to expired markets (no-trade sentinel)
  TIME_PENALTY_EXPIRED: 1_000_000,

  // fetch
  FETCH_TIMEOUT_MS: parseInt(process.env.FETCH_TIMEOUT_MS || "15000", 10),
  FETCH_RETRY_COUNT: parseInt(process.env.FETCH_RETRY_COUNT || "2", 10),

  // events pagination
  EVENTS_PAGE_SIZE: parseInt(process.env.EVENTS_PAGE_SIZE || "100", 10),
  EVENTS_MAX_PAGES: parseInt(process.env.EVENTS_MAX_PAGES || "50", 10),

  // tags/sports cache TTL (seconds) — default 24 h
  TAGS_CACHE_TTL_SECONDS: parseInt(process.env.TAGS_CACHE_TTL_SECONDS || String(24 * 60 * 60), 10),

  // ---------------------------------------------------------------------------
  // Auto-mode monitoring
  // ---------------------------------------------------------------------------
  AUTO_MODE_ENABLED: process.env.AUTO_MODE_ENABLED === "true",
  // Base tick interval in ms (15s default)
  AUTO_MODE_TICK_MS: parseInt(process.env.AUTO_MODE_TICK_MS || "15000", 10),
  // Jitter ±20% applied to tick interval
  AUTO_MODE_JITTER_PCT: parseFloat(process.env.AUTO_MODE_JITTER_PCT || "0.20"),
  // Max tickets per tick
  AUTO_MODE_BATCH_SIZE: parseInt(process.env.AUTO_MODE_BATCH_SIZE || "20", 10),
  // Debounce: consecutive checks or seconds required before triggering
  AUTO_MODE_DEBOUNCE_CHECKS: parseInt(process.env.AUTO_MODE_DEBOUNCE_CHECKS || "2", 10),
  AUTO_MODE_DEBOUNCE_SEC: parseInt(process.env.AUTO_MODE_DEBOUNCE_SEC || "15", 10),
  // Cooldown after failed attempt (ms)
  AUTO_MODE_COOLDOWN_MS: parseInt(process.env.AUTO_MODE_COOLDOWN_MS || "30000", 10),
  // Backoff schedule on 429/5xx (ms)
  AUTO_MODE_BACKOFF_INITIAL_MS: parseInt(process.env.AUTO_MODE_BACKOFF_INITIAL_MS || "30000", 10),
  AUTO_MODE_BACKOFF_MAX_MS: parseInt(process.env.AUTO_MODE_BACKOFF_MAX_MS || "300000", 10),
  // Lease TTL in ms (60s, renew every 30s)
  AUTO_MODE_LEASE_TTL_MS: parseInt(process.env.AUTO_MODE_LEASE_TTL_MS || "60000", 10),
  AUTO_MODE_LEASE_RENEW_MS: parseInt(process.env.AUTO_MODE_LEASE_RENEW_MS || "30000", 10),
  // Paper close: when true, auto-mode closes tickets as simulated (no on-chain execution)
  AUTO_MODE_PAPER_CLOSE: process.env.AUTO_MODE_PAPER_CLOSE === "true",
};
