"use strict";

const mongoose = require("mongoose");

/**
 * ThesisSnapshot — stores operator-auditable thesis evaluations
 * produced by the OUTCOME strategy mode.
 *
 * Each snapshot captures a point-in-time assessment of a market:
 *   - thesis features (signal type, mispricing score, liquidity, etc.)
 *   - verdict: WATCH / ENTER / AVOID
 *   - human-readable rationale for audit
 */
const thesisSnapshotSchema = new mongoose.Schema(
  {
    scanId: { type: String, required: true },

    // Market identity (same canonical fields as TradeTicket / MarketSnapshot)
    marketId: { type: String, required: true },
    conditionId: { type: String, default: null },
    marketSlug: { type: String, default: null },
    eventSlug: { type: String, default: null },
    eventTitle: { type: String, default: null },
    groupItemTitle: { type: String, default: null },
    question: { type: String, required: true },

    // Verdict — the operator-facing recommendation
    verdict: { type: String, enum: ["WATCH", "ENTER", "AVOID"], required: true },

    // Thesis features — the signals/metrics that informed the verdict
    features: {
      signalType: { type: String, default: null },       // momentum / breakout / reversal / mispricing
      signalScore: { type: Number, default: null },       // signalScore2 from finalizeItem
      mispricingScore: { type: Number, default: null },   // mispricingTerm
      spreadPct: { type: Number, default: null },
      liquidity: { type: Number, default: null },
      volume24hr: { type: Number, default: null },
      volatility: { type: Number, default: null },
      absMove: { type: Number, default: null },
      hoursLeft: { type: Number, default: null },
      latestYes: { type: Number, default: null },
      bestBidNum: { type: Number, default: null },
      bestAskNum: { type: Number, default: null },
      mispricing: { type: Boolean, default: false },
      momentum: { type: Boolean, default: false },
      breakout: { type: Boolean, default: false },
      reversal: { type: Boolean, default: false },
    },

    // Human-readable rationale — operator-auditable explanation
    rationale: { type: String, required: true },

    // Reason codes (e.g. ["mispricing", "near-expiry"])
    reasonCodes: { type: [String], default: [] },
  },
  { timestamps: true }
);

thesisSnapshotSchema.index({ scanId: 1 });
thesisSnapshotSchema.index({ marketSlug: 1 });
thesisSnapshotSchema.index({ verdict: 1 });
thesisSnapshotSchema.index({ createdAt: -1 });
// TTL: auto-delete thesis snapshots after 30 days
thesisSnapshotSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model("ThesisSnapshot", thesisSnapshotSchema);
