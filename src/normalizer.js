"use strict";

const { TIME_PENALTY_EXPIRED } = require("./config");

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getHoursLeft(endDate) {
  if (!endDate) return null;
  const end = new Date(endDate).getTime();
  if (Number.isNaN(end)) return null;
  return (end - Date.now()) / (1000 * 60 * 60);
}

function formatHoursLeft(hoursLeft) {
  if (!Number.isFinite(hoursLeft)) return "-";
  if (hoursLeft <= 0) return "ended";
  if (hoursLeft < 1) return `${Math.round(hoursLeft * 60)} min`;
  if (hoursLeft < 24) return `${hoursLeft.toFixed(1)} h`;
  const days = Math.floor(hoursLeft / 24);
  const remHours = hoursLeft % 24;
  return `${days} d ${remHours.toFixed(1)} h`;
}

function formatVolume(volume) {
  const n = asNumber(volume, 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(2);
}

function stddev(values) {
  if (!values || values.length < 2) return 0;
  const m = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function mean(values) {
  if (!values || values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values) {
  if (!values || values.length === 0) return 0;
  const arr = [...values].sort((a, b) => a - b);
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
}

/**
 * Proper quantile interpolation (linear). p is 0–100.
 */
function quantile(values, p) {
  if (!values || values.length === 0) return 0;
  const arr = [...values].sort((a, b) => a - b);
  if (arr.length === 1) return arr[0];
  const idx = (p / 100) * (arr.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return arr[lo] * (1 - frac) + arr[hi] * frac;
}

/**
 * Normalize a raw Polymarket API market object into a clean numeric representation.
 * Legacy string fields are NOT written; all numeric values are stored as numbers.
 */
function normalizeMarket(item) {
  let prices = ["0", "0"];
  try {
    prices = JSON.parse(item.outcomePrices || '["0","0"]');
  } catch (_) {}

  const priceYes = asNumber(prices[0], 0);
  const priceNo = asNumber(prices[1], 0);
  const bestBid = asNumber(item.bestBid, 0);
  const bestAsk = asNumber(item.bestAsk, 0);
  const spread = asNumber(item.spread, 999);
  const volume24hr = asNumber(item.volume24hr || item.volume, 0);
  const liquidity = asNumber(item.liquidityNum ?? item.liquidity, 0);
  const endDate = item.endDate || "";
  const hoursLeft = getHoursLeft(endDate);

  // Event-level context (attached by fetcher when flattening events → markets)
  const eventTags = Array.isArray(item.eventTags) ? item.eventTags : [];
  const tagIds = eventTags.map((t) => t.id || t).filter(Boolean);
  const tagSlugs = eventTags.map((t) => t.slug || t.label || String(t)).filter(Boolean);

  return {
    question: item.question || "",
    category: item.category || "",
    subcategory: item.subcategory || "",
    marketSlug: item.slug || item.marketSlug || item.question || "",
    eventSlug: item.eventSlug || "",
    tagIds,
    tagSlugs,
    priceYes,
    priceNo,
    bestBid,
    bestAsk,
    spread,
    volume24hr,
    liquidity,
    endDate,
    hoursLeft,
  };
}

/**
 * Group key for event-level analysis.
 * Prefers eventSlug; falls back to first 4 slug segments to avoid collisions.
 */
function safeGroupEvent(item) {
  if (item.eventSlug && item.eventSlug.trim()) return item.eventSlug.trim().toLowerCase();
  if (item.marketSlug) {
    const slug = item.marketSlug.toLowerCase();
    const parts = slug.split("-");
    return parts.slice(0, 4).join("-") || slug;
  }
  return item.question || "unknown-event";
}

function safeGroupCategory(item) {
  if (item.category && item.category.trim()) return item.category.trim().toLowerCase();
  if (item.marketSlug) {
    const firstSegment = item.marketSlug.split("/")[0];
    if (firstSegment) return firstSegment.toLowerCase();
  }
  return "uncategorized";
}

function computeSoftTimeBonus(hoursLeft) {
  if (!Number.isFinite(hoursLeft) || hoursLeft <= 0) return -TIME_PENALTY_EXPIRED;
  if (hoursLeft <= 24 * 30) return 60;
  if (hoursLeft <= 24 * 90) return 25;
  return 0;
}

module.exports = {
  asNumber,
  getHoursLeft,
  formatHoursLeft,
  formatVolume,
  stddev,
  mean,
  median,
  quantile,
  normalizeMarket,
  safeGroupEvent,
  safeGroupCategory,
  computeSoftTimeBonus,
};
