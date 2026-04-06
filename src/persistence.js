"use strict";

const mongoose = require("mongoose");
const config = require("./config");

const SNAPSHOT_TTL_SECONDS = config.SNAPSHOT_TTL_DAYS * 24 * 60 * 60;
const SHOWN_TTL_SECONDS = config.SHOWN_CANDIDATE_TTL_DAYS * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// MarketSnapshot schema
// ---------------------------------------------------------------------------
const marketSnapshotSchema = new mongoose.Schema({
  question: String,
  category: String,
  marketSlug: String,
  eventSlug: String,

  // legacy string fields — kept in schema for backward-compat reads; NOT written by new code
  priceYes: String,
  priceNo: String,
  bestBid: String,
  bestAsk: String,
  spread: String,
  volume24hr: String,
  liquidity: String,

  // primary numeric fields
  priceYesNum: Number,
  priceNoNum: Number,
  bestBidNum: Number,
  bestAskNum: Number,
  spreadNum: Number,
  volume24hrNum: Number,
  liquidityNum: Number,

  endDate: String,
  hoursLeft: Number,
  scanId: String,
  createdAt: { type: Date, default: Date.now },
});

// Unique compound index guarantees idempotency per (scan, market)
marketSnapshotSchema.index({ scanId: 1, marketSlug: 1 }, { unique: true });
marketSnapshotSchema.index({ marketSlug: 1, createdAt: -1 });
marketSnapshotSchema.index({ scanId: 1, createdAt: -1 });
// TTL: auto-expire snapshots after SNAPSHOT_TTL_DAYS
marketSnapshotSchema.index({ createdAt: 1 }, { expireAfterSeconds: SNAPSHOT_TTL_SECONDS });

// ---------------------------------------------------------------------------
// ShownCandidate schema
// ---------------------------------------------------------------------------
const shownCandidateSchema = new mongoose.Schema({
  marketSlug: String,
  scanId: String,
  shownAt: { type: Date, default: Date.now },
});

shownCandidateSchema.index({ marketSlug: 1, shownAt: -1 });
// TTL: auto-expire shown-candidate records after SHOWN_CANDIDATE_TTL_DAYS
shownCandidateSchema.index({ shownAt: 1 }, { expireAfterSeconds: SHOWN_TTL_SECONDS });

// ---------------------------------------------------------------------------
// Scan schema — stores scan run metadata
// ---------------------------------------------------------------------------
const scanSchema = new mongoose.Schema({
  scanId: { type: String, unique: true },
  startedAt: Date,
  finishedAt: Date,
  fetchedCount: Number,
  savedCount: Number,
  durationMs: Number,
  error: String,
});

scanSchema.index({ startedAt: -1 });

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
const MarketSnapshot = mongoose.model("MarketSnapshot", marketSnapshotSchema);
const ShownCandidate = mongoose.model("ShownCandidate", shownCandidateSchema);
const Scan = mongoose.model("Scan", scanSchema);

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

/**
 * Idempotent bulk upsert of market snapshots.
 * Uses $setOnInsert so re-running the same scanId never creates duplicates.
 * Returns the number of newly inserted documents (0 is expected for a duplicate scan run —
 * it means all markets already existed and no write was needed, which is correct behaviour).
 */
async function upsertSnapshots(candidates, scanId) {
  if (!candidates.length) return 0;

  const ops = candidates.map((item) => ({
    updateOne: {
      filter: { scanId, marketSlug: item.marketSlug },
      update: {
        $setOnInsert: {
          question: item.question,
          category: item.category,
          marketSlug: item.marketSlug,
          eventSlug: item.eventSlug,
          priceYesNum: item.priceYes,
          priceNoNum: item.priceNo,
          bestBidNum: item.bestBid,
          bestAskNum: item.bestAsk,
          spreadNum: item.spread,
          volume24hrNum: item.volume24hr,
          liquidityNum: item.liquidity,
          endDate: item.endDate,
          hoursLeft: item.hoursLeft,
          scanId,
        },
      },
      upsert: true,
    },
  }));

  const result = await MarketSnapshot.bulkWrite(ops, { ordered: false });
  return result.upsertedCount;
}

async function insertScanRecord(scanId, startedAt) {
  await Scan.updateOne(
    { scanId },
    { $setOnInsert: { scanId, startedAt } },
    { upsert: true }
  );
}

async function updateScanRecord(scanId, fields) {
  await Scan.updateOne({ scanId }, { $set: fields });
}

async function getLastScan() {
  return Scan.findOne().sort({ startedAt: -1 }).lean();
}

/**
 * Idempotent upsert of shown-candidate records (prevents duplicates in the novelty set).
 */
async function persistShownCandidates(scanId, candidates) {
  if (!scanId || !candidates.length) return;

  const ops = candidates.map((item) => ({
    updateOne: {
      filter: { marketSlug: item.marketSlug, scanId },
      update: { $setOnInsert: { marketSlug: item.marketSlug, scanId } },
      upsert: true,
    },
  }));

  await ShownCandidate.bulkWrite(ops, { ordered: false });
}

module.exports = {
  MarketSnapshot,
  ShownCandidate,
  Scan,
  upsertSnapshots,
  insertScanRecord,
  updateScanRecord,
  getLastScan,
  persistShownCandidates,
};
