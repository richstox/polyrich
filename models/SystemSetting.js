"use strict";

const mongoose = require("mongoose");

const systemSettingSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "system" },
    autoModeEnabled: { type: Boolean, default: false },
    paperCloseEnabled: { type: Boolean, default: false },
    defaultAutoCloseEnabled: { type: Boolean, default: false },
    autoSaveExecuteEnabled: { type: Boolean, default: false },
    // Idempotency guard: last scanId that auto-save already processed
    lastAutoSaveScanId: { type: String, default: null },
    // Risk / sizing settings (synced from Trade page — used by auto-save)
    bankrollUsd: { type: Number, default: null },
    riskPct: { type: Number, default: null },        // decimal, e.g. 0.01 = 1%
    maxTradeCapUsd: { type: Number, default: null },  // absolute $ cap per trade
    // Strategy mode override: "OUTCOME" | "MICRO_LEGACY" | null (null = use env/default)
    strategyModeOverride: { type: String, enum: ["OUTCOME", "MICRO_LEGACY", null], default: null },
    // Global pause switch — when true, all background activity stops and manual endpoints reject
    appPaused: { type: Boolean, default: false },
    // Debug: persisted null-price sample from auto-monitor (rate-limited writes)
    debugNullPriceSample: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

/**
 * Retrieve the single settings document, creating it with defaults if absent.
 */
systemSettingSchema.statics.getSettings = async function () {
  return this.findOneAndUpdate(
    { _id: "system" },
    { $setOnInsert: { autoModeEnabled: false, paperCloseEnabled: false, defaultAutoCloseEnabled: false, autoSaveExecuteEnabled: false } },
    { upsert: true, new: true, lean: true }
  );
};

module.exports = mongoose.model("SystemSetting", systemSettingSchema);
