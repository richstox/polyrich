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

function signalBadge(type) {
  const colors = {
    momentum: "#2563eb",
    breakout: "#7c3aed",
    mispricing: "#dc2626",
    reversal: "#d97706",
  };
  const bg = colors[type] || "#6b7280";
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${bg};color:#fff;font-size:0.75rem;font-weight:600;letter-spacing:0.03em;">${type}</span>`;
}

function renderCandidate(item) {
  const movePrefix = item.delta1 > 0 ? "+" : "";
  const reasonTags = (item.reasonCodes || []).map((r) => {
    const c = r === "novel" ? "#059669" : r === "near-expiry" ? "#d97706" : r === "filtered" ? "#ef4444" : "#6b7280";
    return `<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:${c}22;color:${c};font-size:0.7rem;border:1px solid ${c}44;margin-right:3px;">${r}</span>`;
  }).join("");

  return `
    <li class="candidate-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
        <strong style="flex:1;font-size:0.95rem;line-height:1.3;">${item.question}</strong>
        <span style="margin-left:12px;font-size:1.1rem;font-weight:700;color:#111;white-space:nowrap;">${item.signalScore2.toFixed(1)}</span>
      </div>
      <div style="margin-bottom:6px;">${signalBadge(item.signalType)} ${reasonTags}</div>
      <div class="candidate-grid">
        <div><span class="label">YES now</span><span class="val">${item.latestYes.toFixed(3)}</span></div>
        <div><span class="label">YES prev</span><span class="val">${item.previousYes.toFixed(3)}</span></div>
        <div><span class="label">absMove</span><span class="val">${item.absMove.toFixed(4)}</span></div>
        <div><span class="label">delta1</span><span class="val">${movePrefix}${item.delta1.toFixed(4)}</span></div>
        <div><span class="label">volatility</span><span class="val">${item.volatility.toFixed(4)}</span></div>
        <div><span class="label">spread</span><span class="val">${item.spread.toFixed(4)}</span></div>
        <div><span class="label">spreadPct</span><span class="val">${item.spreadPct.toFixed(4)}</span></div>
        <div><span class="label">24h Vol</span><span class="val bold">${formatVolume(item.volume24hr)}</span></div>
        <div><span class="label">liquidity</span><span class="val">${Math.round(item.liquidity).toLocaleString("en-US")}</span></div>
        <div><span class="label">hoursLeft</span><span class="val">${formatHoursLeft(item.hoursLeft)}</span></div>
        <div><span class="label">bestBid</span><span class="val">${item.bestBidNum.toFixed(3)}</span></div>
        <div><span class="label">bestAsk</span><span class="val">${item.bestAskNum.toFixed(3)}</span></div>
      </div>
      <details style="margin-top:6px;">
        <summary style="cursor:pointer;font-size:0.75rem;color:#6b7280;">Zobrazit breakdown</summary>
        <pre class="breakdown">${renderBreakdown(item)}</pre>
        <div class="candidate-grid" style="margin-top:4px;font-size:0.72rem;">
          <div><span class="label">category</span><span class="val">${item.category || "-"}</span></div>
          <div><span class="label">eventGroup</span><span class="val">${item.eventGroup || "-"}</span></div>
          <div><span class="label">groupSize</span><span class="val">${item.groupSize || 0}</span></div>
          <div><span class="label">sumYes</span><span class="val">${typeof item.sumYesInGroup === "number" ? item.sumYesInGroup.toFixed(3) : "-"}</span></div>
          <div><span class="label">inconsistency</span><span class="val">${typeof item.inconsistency === "number" ? item.inconsistency.toFixed(3) : "-"}</span></div>
          <div><span class="label">peerZ</span><span class="val">${typeof item.peerZ === "number" ? item.peerZ.toFixed(2) : "-"}</span></div>
          <div><span class="label">mid</span><span class="val">${item.mid.toFixed(3)}</span></div>
        </div>
      </details>
    </li>
  `;
}

/** Shared CSS styles for all pages (inline <style> block). */
function sharedStyles() {
  return `<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: #f5f5f7; color: #1d1d1f; line-height: 1.5;
  }
  .top-bar {
    background: #1d1d1f; color: #f5f5f7; padding: 10px 0;
    position: sticky; top: 0; z-index: 100;
  }
  .top-bar .inner {
    max-width: 900px; margin: 0 auto; padding: 0 20px;
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  }
  .top-bar .brand { font-weight: 700; font-size: 1.05rem; margin-right: auto; letter-spacing: 0.02em; }
  .top-bar a { color: #a1a1a6; text-decoration: none; font-size: 0.85rem; transition: color .15s; }
  .top-bar a:hover { color: #fff; }
  .container { max-width: 900px; margin: 0 auto; padding: 24px 20px; }
  h1 { font-size: 1.5rem; font-weight: 700; margin: 0 0 16px; }
  h2 { font-size: 1.15rem; font-weight: 600; margin: 24px 0 10px; color: #1d1d1f; }
  .card {
    background: #fff; border-radius: 12px; padding: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08); margin-bottom: 16px;
  }
  .card p { margin: 4px 0; font-size: 0.88rem; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; }
  .nav-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px;
  }
  .nav-card {
    display: flex; align-items: center; justify-content: center;
    background: #fff; border-radius: 12px; padding: 20px 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08); text-decoration: none;
    color: #1d1d1f; font-weight: 600; font-size: 0.95rem;
    transition: box-shadow .15s, transform .15s;
  }
  .nav-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,.12); transform: translateY(-2px); }
  .nav-card .icon { font-size: 1.4rem; margin-right: 10px; }
  ol.candidates { list-style: none; padding: 0; counter-reset: cand; }
  ol.candidates li::before {
    counter-increment: cand; content: counter(cand);
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; border-radius: 50%; background: #e5e7eb;
    font-size: 0.7rem; font-weight: 600; margin-right: 8px; color: #374151;
    float: left; margin-top: 2px;
  }
  .candidate-card {
    background: #fff; border-radius: 10px; padding: 14px 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,.06); margin-bottom: 10px;
    overflow: hidden;
  }
  .candidate-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 2px 12px; font-size: 0.78rem;
  }
  .candidate-grid .label { color: #6b7280; margin-right: 4px; }
  .candidate-grid .val { font-weight: 500; color: #111; }
  .candidate-grid .val.bold { font-weight: 700; }
  .breakdown {
    font-family: "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.72rem; background: #f9fafb; padding: 8px 10px;
    border-radius: 6px; margin: 6px 0 0; white-space: pre-wrap;
    line-height: 1.6; color: #374151;
  }
  .section-toggle { width: 100%; }
  .section-toggle summary {
    cursor: pointer; list-style: none; padding: 12px 16px;
    background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08);
    font-weight: 600; font-size: 1rem; margin-bottom: 8px;
    display: flex; align-items: center; gap: 8px;
  }
  .section-toggle summary::before { content: "▸"; transition: transform .15s; }
  .section-toggle[open] summary::before { transform: rotate(90deg); }
  .section-toggle summary::-webkit-details-marker { display: none; }
  .badge-count {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 22px; height: 22px; border-radius: 11px;
    background: #e5e7eb; font-size: 0.75rem; font-weight: 600; padding: 0 6px;
  }
  .snapshot-item {
    background: #fff; border-radius: 10px; padding: 14px 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,.06); margin-bottom: 10px;
  }
  .snapshot-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 2px 12px; font-size: 0.82rem; margin-top: 6px;
  }
  .snapshot-grid .label { color: #6b7280; margin-right: 4px; }
  .snapshot-grid .val { font-weight: 500; }
  .error-banner {
    background: #fef2f2; border: 1px solid #fca5a5; border-radius: 10px;
    padding: 12px 16px; color: #b91c1c; font-weight: 600; margin-bottom: 16px;
  }
  .info-banner {
    background: #fffbeb; border: 1px solid #fcd34d; border-radius: 10px;
    padding: 10px 16px; color: #92400e; font-size: 0.88rem; margin-bottom: 16px;
  }
</style>`;
}

/** Shared top navigation bar. */
function renderNav(active) {
  const links = [
    { href: "/", label: "Domů" },
    { href: "/ideas", label: "Dashboard" },
    { href: "/snapshots", label: "Snapshoty" },
    { href: "/scan", label: "Scan" },
    { href: "/health", label: "Health" },
    { href: "/metrics", label: "Metrics" },
  ];
  const items = links.map((l) => {
    const style = l.href === active ? "color:#fff;font-weight:600;" : "";
    return `<a href="${l.href}" style="${style}">${l.label}</a>`;
  }).join("");
  return `<nav class="top-bar"><div class="inner"><span class="brand">Polyrich</span>${items}</div></nav>`;
}

/** Wrap page content with DOCTYPE, head, nav and container. */
function pageShell(title, activeNav, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Polyrich</title>
  ${sharedStyles()}
</head>
<body>
  ${renderNav(activeNav)}
  <div class="container">
    ${bodyHtml}
  </div>
</body>
</html>`;
}

module.exports = { renderBreakdown, renderCandidate, pageShell };
