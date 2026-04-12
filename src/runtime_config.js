"use strict";

/**
 * Runtime configuration resolver.
 *
 * Reads strategy-mode override and app-paused state from the DB-cached
 * SystemSetting document and resolves the effective values.
 *
 * All background loops and HTTP handlers should call these helpers instead
 * of reading `config.STRATEGY_MODE` directly.
 */

const config = require("./config");

// ---------------------------------------------------------------------------
// Cached settings — refreshed by refreshRuntimeConfig() (called from loops)
// ---------------------------------------------------------------------------
let _cachedSettings = null;

/** Replace the cached settings snapshot (called after DB read). */
function setCachedSettings(settings) {
  _cachedSettings = settings || null;
}

/** Return the cached settings snapshot (may be null before first DB read). */
function getCachedSettings() {
  return _cachedSettings;
}

// ---------------------------------------------------------------------------
// Effective strategy mode
// ---------------------------------------------------------------------------
const VALID_MODES = new Set(["OUTCOME", "MICRO_LEGACY"]);

/**
 * Resolve the effective strategy mode from the provided (or cached) settings.
 *
 * Priority:
 *   1. settings.strategyModeOverride (if non-null and valid)
 *   2. process.env.STRATEGY_MODE  (via config.STRATEGY_MODE)
 *   3. "OUTCOME" (hard default)
 *
 * Returns { mode: string, source: "mongo_override" | "env_default" }.
 */
function getEffectiveStrategyMode(settings) {
  const s = settings || _cachedSettings;
  if (s && s.strategyModeOverride && VALID_MODES.has(s.strategyModeOverride)) {
    return { mode: s.strategyModeOverride, source: "mongo_override" };
  }
  return { mode: config.STRATEGY_MODE || "OUTCOME", source: "env_default" };
}

// ---------------------------------------------------------------------------
// App paused
// ---------------------------------------------------------------------------

/**
 * Return true when the app is paused (from provided or cached settings).
 */
function isAppPaused(settings) {
  const s = settings || _cachedSettings;
  return !!(s && s.appPaused);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  setCachedSettings,
  getCachedSettings,
  getEffectiveStrategyMode,
  isAppPaused,
  VALID_MODES,
};
