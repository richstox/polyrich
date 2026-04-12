"use strict";

const mongoose = require("mongoose");

const autoSaveLogSchema = new mongoose.Schema(
  {
    scanId: { type: String, required: true },
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: "TradeTicket" },
    marketId: { type: String },
    action: { type: String },
    dedupeKey: { type: String },
    result: { type: String, enum: ["CREATED", "DUPLICATE", "ERROR", "DISABLED", "SKIPPED"], required: true },
    error: { type: String, default: null },
    skipReasons: { type: mongoose.Schema.Types.Mixed, default: null },
    candidateDetails: { type: [mongoose.Schema.Types.Mixed], default: null },
    watchReasonCounts: { type: mongoose.Schema.Types.Mixed, default: null },
    topWatchExamples: { type: [mongoose.Schema.Types.Mixed], default: null },
  },
  { timestamps: true }
);

autoSaveLogSchema.index({ createdAt: -1 });
autoSaveLogSchema.index({ scanId: 1 });

module.exports = mongoose.model("AutoSaveLog", autoSaveLogSchema);
