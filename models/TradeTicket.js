"use strict";

const mongoose = require("mongoose");

const tradeTicketSchema = new mongoose.Schema(
  {
    // Core
    scanId: { type: String },
    source: { type: String, enum: ["TRADE_PAGE"], default: "TRADE_PAGE" },

    // Market identity — canonical fields for strict monitoring
    marketId: { type: String, required: true },
    conditionId: { type: String, default: null },   // 0x… hex — canonical for Gamma lookup
    marketSlug: { type: String, default: null },     // URL/display slug
    eventSlug: { type: String },
    eventTitle: { type: String },
    groupItemTitle: { type: String },
    marketUrl: { type: String },
    question: { type: String, required: true },      // display text only — NEVER used as identifier

    // CLOB token IDs — required for CLOB orderbook price monitoring
    // Extracted from Gamma API `clobTokenIds` field (JSON-encoded string array: [yesTokenId, noTokenId])
    yesTokenId: { type: String, default: null },     // CLOB token ID for YES outcome
    noTokenId: { type: String, default: null },      // CLOB token ID for NO outcome
    priceSource: { type: String, default: null },    // "CLOB" when CLOB monitoring is active; audit/debug

    // Classification
    tradeability: { type: String, enum: ["EXECUTE", "WATCH"], required: true },
    action: { type: String, enum: ["BUY_YES", "BUY_NO", "WATCH"], required: true },
    reasonCodes: { type: [String], default: [] },
    whyNow: { type: String },
    whyWatch: { type: String },
    nextStep: { type: String },

    // Plan snapshot
    planTbd: { type: Boolean, default: false },
    entryLimit: { type: Number, default: null },
    takeProfit: { type: Number, default: null },
    riskExitLimit: { type: Number, default: null },
    maxSizeUsd: { type: Number, default: null },
    bankrollUsd: { type: Number, default: null },
    riskPct: { type: Number, default: null },
    maxTradeCapUsd: { type: Number, default: null },
    minLimitOrderUsd: { type: Number, default: 5 },
    pnlTpUsd: { type: Number, default: null },
    pnlTpPct: { type: Number, default: null },
    pnlExitUsd: { type: Number, default: null },
    pnlExitPct: { type: Number, default: null },

    // Deduplication
    dedupeKey: { type: String },

    // Market end date (for time-remaining display)
    endDate: { type: String, default: null },

    // Outcome evaluation
    status: { type: String, enum: ["OPEN", "CLOSING", "CLOSED", "ERROR"], default: "OPEN" },
    closeReason: { type: String, enum: ["TP_HIT", "EXIT_HIT", "MANUAL", "ERROR", "MARKET_ENDED", "MARKET_SETTLED"], default: null },
    closedAt: { type: Date, default: null },
    closePrice: { type: Number, default: null },
    realizedPnlUsd: { type: Number, default: null },
    realizedPnlPct: { type: Number, default: null },
    notes: { type: String },

    // Simulation flag — true when ticket was paper-closed (no on-chain execution)
    isSimulated: { type: Boolean, default: false },

    // Auto-mode monitoring fields
    autoCloseEnabled: { type: Boolean, default: false },
    autoCloseBlockedReason: { type: String, default: null }, // non-null → why auto-close was blocked
    lastPriceCheckAt: { type: Date, default: null },
    lastObservedPrice: { type: Number, default: null },
    autoCloseIntentAt: { type: Date, default: null },
    autoCloseIntentReason: { type: String, default: null },
  },
  { timestamps: true }
);

tradeTicketSchema.index({ createdAt: -1 });
tradeTicketSchema.index({ marketId: 1 });
tradeTicketSchema.index({ conditionId: 1 });
tradeTicketSchema.index({ status: 1 });
// Snapshot-level deduplication: same card snapshot cannot be saved twice
tradeTicketSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("TradeTicket", tradeTicketSchema);
