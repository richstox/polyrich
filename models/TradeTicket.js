"use strict";

const mongoose = require("mongoose");

const tradeTicketSchema = new mongoose.Schema(
  {
    // Core
    scanId: { type: String },
    source: { type: String, enum: ["TRADE_PAGE"], default: "TRADE_PAGE" },

    // Market identity
    marketId: { type: String, required: true },
    eventSlug: { type: String },
    eventTitle: { type: String },
    groupItemTitle: { type: String },
    marketUrl: { type: String },
    question: { type: String, required: true },

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

    // Outcome evaluation
    status: { type: String, enum: ["OPEN", "CLOSED"], default: "OPEN" },
    closedAt: { type: Date, default: null },
    closePrice: { type: Number, default: null },
    realizedPnlUsd: { type: Number, default: null },
    realizedPnlPct: { type: Number, default: null },
    notes: { type: String },
  },
  { timestamps: true }
);

tradeTicketSchema.index({ createdAt: -1 });
tradeTicketSchema.index({ marketId: 1 });
tradeTicketSchema.index({ status: 1 });
// Snapshot-level deduplication: same card snapshot cannot be saved twice
tradeTicketSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("TradeTicket", tradeTicketSchema);
