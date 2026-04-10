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
