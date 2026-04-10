"use strict";

const mongoose = require("mongoose");

const closeAttemptSchema = new mongoose.Schema({
  ticketId: { type: mongoose.Schema.Types.ObjectId, ref: "TradeTicket", required: true },
  observedPrice: { type: Number, default: null },
  reason: { type: String, enum: ["TP_HIT", "EXIT_HIT", "ERROR", "MARKET_ENDED", "MARKET_SETTLED"], required: true },
  result: { type: String, enum: ["INTENT_RECORDED", "CLOSE_EXECUTED", "PAPER_CLOSED", "FAILED", "IDEMPOTENT_SKIP"], required: true },
  error: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

closeAttemptSchema.index({ ticketId: 1, createdAt: -1 });
closeAttemptSchema.index({ createdAt: -1 });
// TTL: auto-expire close attempts after 30 days
closeAttemptSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model("CloseAttempt", closeAttemptSchema);
