"use strict";

const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    setting: { type: String, required: true },
    oldValue: { type: mongoose.Schema.Types.Mixed, default: null },
    newValue: { type: mongoose.Schema.Types.Mixed, default: null },
    actor: { type: String, default: null },
    ts: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

auditLogSchema.index({ ts: -1 });
auditLogSchema.index({ setting: 1, ts: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
