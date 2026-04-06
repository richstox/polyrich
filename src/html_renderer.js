"use strict";

const { formatHoursLeft, formatVolume } = require("./normalizer");

function renderBreakdown(item) {
  return [
    `moveTerm=${item.moveTerm.toFixed(1)}`,
    `volTerm=${item.volTerm.toFixed(1)}`,
    `activityTerm=${item.activityTerm.toFixed(1)}`,
    `mispricingTerm=${item.mispricingTerm.toFixed(1)}`,
    `orderbookTerm=${item.orderbookTerm.toFixed(1)}`,
    `costPenalty=${item.costPenalty.toFixed(1)}`,
    `extremePenalty=${item.extremePenalty.toFixed(1)}`,
    `timePenalty=${item.timePenalty.toFixed(1)}`,
    `timeBonus=${item.timeBonus.toFixed(1)}`,
    `noveltyBonus=${item.noveltyBonus.toFixed(1)}`,
    `signalScore2=${item.signalScore2.toFixed(1)}`,
  ].join("\n");
}

function renderCandidate(item) {
  const movePrefix = item.delta1 > 0 ? "+" : "";
  return `
    <li style="margin-bottom:18px;padding:12px;border:1px solid #ddd;border-radius:8px;">
      <strong>${item.question}</strong><br>
      signalType: <strong>${item.signalType}</strong><br>
      reasons: ${(item.reasonCodes || []).join(", ") || "-"}<br>
      category: ${item.category || "-"}<br>
      eventGroup: ${item.eventGroup || "-"}<br>
      groupSize: ${item.groupSize || 0}<br>
      YES now: ${item.latestYes.toFixed(3)}<br>
      YES prev: ${item.previousYes.toFixed(3)}<br>
      absMove: ${item.absMove.toFixed(4)}<br>
      delta1: ${movePrefix}${item.delta1.toFixed(4)}<br>
      volatility: ${item.volatility.toFixed(4)}<br>
      spread: ${item.spread.toFixed(4)}<br>
      spreadPct: ${item.spreadPct.toFixed(4)}<br>
      24h Volume: <strong>${formatVolume(item.volume24hr)}</strong><br>
      liquidity: ${Math.round(item.liquidity).toLocaleString("en-US")}<br>
      hoursLeft: ${formatHoursLeft(item.hoursLeft)}<br>
      sumYesInGroup: ${typeof item.sumYesInGroup === "number" ? item.sumYesInGroup.toFixed(3) : "-"}<br>
      inconsistency: ${typeof item.inconsistency === "number" ? item.inconsistency.toFixed(3) : "-"}<br>
      peerZ: ${typeof item.peerZ === "number" ? item.peerZ.toFixed(2) : "-"}<br>
      bestBid: ${item.bestBidNum.toFixed(3)}<br>
      bestAsk: ${item.bestAskNum.toFixed(3)}<br>
      mid: ${item.mid.toFixed(3)}<br>
      score: <strong>${item.signalScore2.toFixed(2)}</strong><br>
      breakdown: <code>${renderBreakdown(item)}</code>
    </li>
  `;
}

module.exports = { renderBreakdown, renderCandidate };
