"use strict";

const mongoose = require("mongoose");

/**
 * PaperRunnerLog — append-only audit trail for a single paper-trading lifecycle.
 *
 * Each document represents one event in the lifecycle:
 *   CANDIDATE_SELECTED → ENTRY_SNAPSHOT → PAPER_FILL → MONITOR_OBSERVATION → CLOSE
 *
 * Grouped by `runId` (one runner invocation = one lifecycle).
 */
const paperRunnerLogSchema = new mongoose.Schema(
  {
    runId: { type: String, required: true, index: true },
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: "TradeTicket", default: null },
    phase: {
      type: String,
      enum: [
        "CANDIDATE_SELECTED",
        "ENTRY_SNAPSHOT",
        "PAPER_FILL",
        "MONITOR_OBSERVATION",
        "CLOSE",
        "ERROR",
      ],
      required: true,
    },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    ts: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

paperRunnerLogSchema.index({ runId: 1, ts: 1 });
paperRunnerLogSchema.index({ ticketId: 1, ts: 1 });
// TTL: auto-expire after 90 days
paperRunnerLogSchema.index({ ts: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

module.exports = mongoose.model("PaperRunnerLog", paperRunnerLogSchema);
