"use strict";

const mongoose = require("mongoose");

/**
 * Per-candidate BUY YES decision trace for auto-save diagnostics.
 *
 * Records the first-failing gate for each candidate evaluated during auto-save,
 * enabling root-cause classification of why tickets are not being created.
 *
 * Query by scanId to answer: "For scanId X, here are N BUY YES candidates;
 * 0 saved because firstFailGate distribution is …"
 *
 * Usage:
 *   AutoSaveDecisionLog.find({ scanId: "2026-04-12T..." })
 *   AutoSaveDecisionLog.aggregate([
 *     { $match: { scanId: "..." } },
 *     { $group: { _id: "$firstFailGate", count: { $sum: 1 } } },
 *     { $sort: { count: -1 } }
 *   ])
 */
const autoSaveDecisionLogSchema = new mongoose.Schema(
  {
    scanId: { type: String, required: true, index: true },
    marketSlug: { type: String, default: null },
    conditionId: { type: String, default: null },
    question: { type: String, default: null },
    action: { type: String, default: null },           // BUY_YES, BUY_NO, WATCH, or null
    firstFailGate: { type: String, required: true },   // gate name or "PASS"
    reasonCode: { type: String, default: null },       // specific reason within the gate
    decision: { type: String, enum: ["PASS", "FAIL", "ERROR"], required: true },
    gateCategory: { type: String, enum: ["POLICY", "DATA_INTEGRITY", "SERVER_EXECUTION", "DEDUPE", "PASS", "ERROR"], default: null },
    gateInputs: { type: mongoose.Schema.Types.Mixed, default: null },
    gateThresholds: { type: mongoose.Schema.Types.Mixed, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

autoSaveDecisionLogSchema.index({ scanId: 1, firstFailGate: 1 });
autoSaveDecisionLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AutoSaveDecisionLog", autoSaveDecisionLogSchema);
