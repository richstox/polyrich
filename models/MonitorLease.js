"use strict";

const mongoose = require("mongoose");

/**
 * MonitorLease — single-document lease lock for the auto-monitor.
 * Only one server instance may hold the lease at a time.
 * The document key is always "monitor".
 */
const monitorLeaseSchema = new mongoose.Schema({
  key: { type: String, unique: true, default: "monitor" },
  ownerId: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  acquiredAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("MonitorLease", monitorLeaseSchema);
