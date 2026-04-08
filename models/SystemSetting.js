"use strict";

const mongoose = require("mongoose");

const systemSettingSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "system" },
    autoModeEnabled: { type: Boolean, default: false },
    paperCloseEnabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

/**
 * Retrieve the single settings document, creating it with defaults if absent.
 */
systemSettingSchema.statics.getSettings = async function () {
  return this.findOneAndUpdate(
    { _id: "system" },
    { $setOnInsert: { autoModeEnabled: false, paperCloseEnabled: false } },
    { upsert: true, new: true, lean: true }
  );
};

module.exports = mongoose.model("SystemSetting", systemSettingSchema);
