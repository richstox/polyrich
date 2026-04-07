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

/** Compute human-readable "Why this is a pick" bullets from signal terms. */
function computeWhyPick(item) {
  const bullets = [];
  const ABS_MOVE_THRESHOLD = 0.003;

  if (item.absMove >= ABS_MOVE_THRESHOLD) {
    const dir = item.delta1 > 0 ? "up" : "down";
    bullets.push(`Price moved recently: ${dir} ${(item.absMove * 100).toFixed(2)}%`);
  }

  if (item.volume24hr >= 1000 || item.liquidity >= 5000) {
    bullets.push(`High activity: 24h vol ${formatVolume(item.volume24hr)}, liquidity ${Math.round(item.liquidity).toLocaleString("en-US")}`);
  }

  const spreadLabel = item.spreadPct <= 0.10 ? "good" : item.spreadPct <= 0.25 ? "OK" : "wide";
  bullets.push(`Costs: spread ${(item.spreadPct * 100).toFixed(1)}% (${spreadLabel})`);

  if (item.mispricing) {
    bullets.push("Mispricing signal: yes — event-level inconsistency detected");
  }

  if (item.hoursLeft !== null && item.hoursLeft > 0) {
    if (item.hoursLeft < 48) {
      bullets.push("Time horizon: near-expiry (< 2 days)");
    } else if (item.hoursLeft > 720) {
      bullets.push("Time horizon: long-dated (> 30 days)");
    }
  }

  return bullets.slice(0, 5);
}

/** Compute a simple tradeability label based on key metrics. */
function computeTradeability(item) {
  if (
    item._filtered ||
    (item.hoursLeft !== null && item.hoursLeft <= 0)
  ) {
    return { icon: "❌", label: "Excluded", cls: "tradeability-excluded" };
  }
  if (
    (item.hoursLeft !== null && item.hoursLeft > 240) ||
    item.spreadPct > 0.15 ||
    item.liquidity < 500 ||
    item.volume24hr < 50 ||
    (item.hoursLeft !== null && item.hoursLeft < 2)
  ) {
    return { icon: "⚠️", label: "Watch", cls: "tradeability-watch" };
  }
  return { icon: "✅", label: "Tradeable today", cls: "tradeability-ok" };
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

function escHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function polymarketUrl(item) {
  if (typeof item === "string") {
    // Legacy: called with a slug string
    if (!item) return null;
    return `https://polymarket.com/event/${encodeURIComponent(item)}`;
  }
  // Called with a market item object
  if (item.eventSlug) {
    return `https://polymarket.com/event/${encodeURIComponent(item.eventSlug)}`;
  }
  if (item.question) {
    return `https://polymarket.com/search?q=${encodeURIComponent(item.question)}`;
  }
  return null;
}

/** Compact "Top Pick" card for micro-trade action list */
function renderTopPick(item) {
  const link = polymarketUrl(item);
  const questionHtml = link
    ? `<a href="${escHtml(link)}" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:none;font-weight:600;">${escHtml(item.question)}</a>`
    : `<strong>${escHtml(item.question)}</strong>`;
  const reasonTags = (item.reasonCodes || []).map((r) => {
    const c = r === "novel" ? "#059669" : r === "near-expiry" ? "#d97706" : r === "filtered" ? "#ef4444" : "#6b7280";
    return `<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:${c}22;color:${c};font-size:0.7rem;border:1px solid ${c}44;margin-right:3px;">${escHtml(r)}</span>`;
  }).join("");

  const whyBullets = computeWhyPick(item);
  const trade = computeTradeability(item);
  const safeLink = link ? escHtml(link) : "";

  return `
    <li class="candidate-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
        ${questionHtml}
      </div>
      <div style="margin-bottom:6px;">${signalBadge(item.signalType)} ${reasonTags}</div>
      <div class="candidate-grid">
        <div><span class="label">YES</span><span class="val">${item.latestYes.toFixed(3)}</span></div>
        <div><span class="label">spreadPct</span><span class="val">${(item.spreadPct * 100).toFixed(1)}%</span></div>
        <div><span class="label">24h Vol</span><span class="val bold">${formatVolume(item.volume24hr)}</span></div>
        <div><span class="label">liquidity</span><span class="val">${Math.round(item.liquidity).toLocaleString("en-US")}</span></div>
        <div><span class="label">hoursLeft</span><span class="val">${formatHoursLeft(item.hoursLeft)}</span></div>
      </div>
      <div class="why-pick-card">
        <div class="${trade.cls}" style="margin-bottom:6px;font-weight:600;font-size:0.85rem;">${trade.icon} ${escHtml(trade.label)}</div>
        <p style="margin:0 0 4px;font-weight:600;font-size:0.82rem;color:#1d1d1f;">Why this is a pick</p>
        <ul style="margin:0;padding-left:18px;font-size:0.82rem;color:#374151;">
          ${whyBullets.map((b) => `<li>${escHtml(b)}</li>`).join("")}
        </ul>
      </div>
      ${link ? `<div class="cta-row">
        <a href="${safeLink}" target="_blank" rel="noopener" class="cta-primary">Open on Polymarket</a>
        <button class="cta-secondary" data-copy-url="${safeLink}">Copy link</button>
      </div>` : ""}
      <details style="margin-top:6px;">
        <summary style="cursor:pointer;font-size:0.75rem;color:#6b7280;">Debug</summary>
        <div class="candidate-grid" style="margin-top:4px;font-size:0.78rem;">
          <div><span class="label">YES prev</span><span class="val">${item.previousYes.toFixed(3)}</span></div>
          <div><span class="label">absMove</span><span class="val">${item.absMove.toFixed(4)}</span></div>
          <div><span class="label">delta1</span><span class="val">${item.delta1 > 0 ? "+" : ""}${item.delta1.toFixed(4)}</span></div>
          <div><span class="label">volatility</span><span class="val">${item.volatility.toFixed(4)}</span></div>
          <div><span class="label">spread</span><span class="val">${item.spread.toFixed(4)}</span></div>
          <div><span class="label">bestBid</span><span class="val">${item.bestBidNum.toFixed(3)}</span></div>
          <div><span class="label">bestAsk</span><span class="val">${item.bestAskNum.toFixed(3)}</span></div>
        </div>
        <pre class="breakdown">${renderBreakdown(item)}</pre>
      </details>
    </li>
  `;
}

/** Today's Actions card for the /ideas dashboard */
function renderTodayActions(scanStatus, funnel, signalsCount, relaxedMode) {
  const statusIcon = scanStatus.lastError ? "⚠️" : "✅";
  const statusText = scanStatus.lastError
    ? `Scanner degraded: ${escHtml(scanStatus.lastError)}`
    : "scanning OK";

  const lastScan = scanStatus.lastScanAt
    ? scanStatus.lastScanAt.toLocaleString("cs-CZ")
    : "not yet";
  const nextScan = scanStatus.nextScanAt
    ? scanStatus.nextScanAt.toLocaleString("cs-CZ")
    : "not scheduled";

  let recommendation;
  if (scanStatus.lastError) {
    recommendation = `Scanner degraded: ${escHtml(scanStatus.lastError)}`;
  } else if (funnel.finalCandidates >= 10) {
    recommendation = `Ready: ${funnel.finalCandidates} candidates. Start micro-trades.`;
  } else if (signalsCount < 10) {
    recommendation = "Too few signals \u2014 relaxing thresholds automatically.";
  } else {
    recommendation = `${funnel.finalCandidates} candidates available. Review top picks.`;
  }

  const modeLabel = relaxedMode
    ? '<span style="color:#d97706;font-weight:600;">relaxed</span>'
    : '<span style="color:#059669;font-weight:600;">normal</span>';

  return `
    <div class="card" style="border-left:4px solid ${scanStatus.lastError ? "#dc2626" : "#059669"};">
      <h2 style="margin-top:0;font-size:1.1rem;">Today's Actions</h2>
      <p style="font-size:0.92rem;">${statusIcon} Status: <strong>${statusText}</strong></p>
      <div style="margin:8px 0;padding:8px 12px;border-radius:8px;background:#eff6ff;font-size:0.88rem;color:#1e40af;">
        🌐 Universe scanned this run: <strong>${scanStatus.lastEventsFetched || 0}</strong> events →
        <strong>${scanStatus.lastMarketsFlattened || 0}</strong> markets
        (<strong>${scanStatus.lastPagesFetched || 0}</strong> pages)
      </div>
      <div class="grid-2" style="margin:8px 0;">
        <p><span style="color:#6b7280;">Last scan:</span> <strong>${lastScan}</strong></p>
        <p><span style="color:#6b7280;">Next scan:</span> <strong>${nextScan}</strong></p>
        <p><span style="color:#6b7280;">fetched (markets):</span> <strong>${funnel.fetched}</strong></p>
        <p><span style="color:#6b7280;">saved:</span> <strong>${funnel.saved}</strong></p>
        <p><span style="color:#6b7280;">watchlist:</span> <strong>${funnel.watchlist}</strong></p>
        <p><span style="color:#6b7280;">signals:</span> <strong>${funnel.signals}</strong></p>
        <p><span style="color:#6b7280;">final candidates:</span> <strong>${funnel.finalCandidates}</strong></p>
        <p><span style="color:#6b7280;">movers:</span> <strong>${funnel.movers}</strong></p>
        <p><span style="color:#6b7280;">mispricing:</span> <strong>${funnel.mispricing || 0}</strong></p>
        <p><span style="color:#6b7280;">Mode:</span> ${modeLabel}</p>
      </div>
      <p style="font-size:0.95rem;font-weight:600;margin-top:10px;padding:8px 12px;border-radius:8px;background:#f0fdf4;color:#166534;">${recommendation}</p>
    </div>
  `;
}

/** "Why no movers?" explanation card */
function renderWhyNoMovers(thresholds, closestToThreshold) {
  const rows = (closestToThreshold || []).map((m) => `
    <tr>
      <td style="padding:4px 8px;font-size:0.82rem;">${escHtml(m.question)}</td>
      <td style="padding:4px 8px;font-size:0.82rem;text-align:right;">${m.absMove.toFixed(4)}</td>
      <td style="padding:4px 8px;font-size:0.82rem;text-align:right;">${m.volatility.toFixed(4)}</td>
    </tr>
  `).join("");

  return `
    <div class="card" style="border-left:4px solid #d97706;">
      <h2 style="margin-top:0;font-size:1rem;color:#92400e;">Why no movers?</h2>
      <p style="font-size:0.85rem;color:#6b7280;">No markets met the momentum/breakout thresholds this run.</p>
      <div class="grid-2" style="margin:8px 0;">
        <p><span class="label">globalMedianMove:</span> <strong>${thresholds.globalMedianMove.toFixed(6)}</strong></p>
        <p><span class="label">momentumThreshold:</span> <strong>${thresholds.momentumThreshold.toFixed(6)}</strong></p>
        <p><span class="label">breakoutMoveThreshold:</span> <strong>${thresholds.breakoutMoveThreshold.toFixed(6)}</strong></p>
        <p><span class="label">breakoutVolThreshold:</span> <strong>${thresholds.breakoutVolThreshold.toFixed(6)}</strong></p>
      </div>
      <h3 style="font-size:0.9rem;margin:12px 0 6px;">Top 3 closest to threshold</h3>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:1px solid #e5e7eb;">
            <th style="padding:4px 8px;text-align:left;font-size:0.78rem;color:#6b7280;">Market</th>
            <th style="padding:4px 8px;text-align:right;font-size:0.78rem;color:#6b7280;">absMove</th>
            <th style="padding:4px 8px;text-align:right;font-size:0.78rem;color:#6b7280;">volatility</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

/** Render /health-ui page */
function renderHealthUi(healthData) {
  const statusColor = healthData.ok ? "#059669" : "#dc2626";
  const statusIcon = healthData.ok ? "✅" : "❌";
  return `
    <h1>Health</h1>
    <div class="card" style="border-left:4px solid ${statusColor};">
      <h2 style="margin-top:0;">${statusIcon} System Health</h2>
      <div class="grid-2">
        <p><span style="color:#6b7280;">Status:</span> <strong style="color:${statusColor};">${healthData.ok ? "OK" : "DEGRADED"}</strong></p>
        <p><span style="color:#6b7280;">MongoDB:</span> <strong>${healthData.mongoConnected ? "connected" : "disconnected"}</strong></p>
        <p><span style="color:#6b7280;">Last scan:</span> <strong>${healthData.lastScanAt || "never"}</strong></p>
        <p><span style="color:#6b7280;">Scan running:</span> <strong>${healthData.scanRunning ? "yes" : "no"}</strong></p>
        <p><span style="color:#6b7280;">Timestamp:</span> <strong>${healthData.ts}</strong></p>
      </div>
    </div>
    <p style="font-size:0.8rem;color:#6b7280;margin-top:12px;">Raw JSON: <a href="/health" style="color:#2563eb;">/health</a></p>
  `;
}

/** Render /metrics-ui page */
function renderMetricsUi(metrics) {
  const scanRows = (metrics.last3Scans || []).map((s) => `
    <tr>
      <td style="padding:4px 8px;font-size:0.82rem;">${escHtml(s.scanId || "-")}</td>
      <td style="padding:4px 8px;font-size:0.82rem;text-align:right;">${s.durationMs != null ? s.durationMs + " ms" : "-"}</td>
    </tr>
  `).join("");

  return `
    <h1>Metrics</h1>
    <div class="card">
      <h2 style="margin-top:0;">Scan Overview</h2>
      <div class="grid-2">
        <p><span style="color:#6b7280;">Last scan:</span> <strong>${metrics.lastScanAt || "never"}</strong></p>
        <p><span style="color:#6b7280;">Scan ID:</span> <strong>${metrics.lastScanId || "-"}</strong></p>
        <p><span style="color:#6b7280;">Duration:</span> <strong>${metrics.lastDurationMs != null ? metrics.lastDurationMs + " ms" : "-"}</strong></p>
        <p><span style="color:#6b7280;">Running:</span> <strong>${metrics.scanRunning ? "yes" : "no"}</strong></p>
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0;">Funnel Counts</h2>
      <div class="grid-2">
        <p><span style="color:#6b7280;">fetched:</span> <strong>${metrics.lastTotalFetched}</strong></p>
        <p><span style="color:#6b7280;">savedTarget:</span> <strong>${metrics.savedTarget}</strong></p>
        <p><span style="color:#6b7280;">savedActual:</span> <strong>${metrics.savedActual}</strong></p>
        <p><span style="color:#6b7280;">watchlist:</span> <strong>${metrics.lastWatchlistCount}</strong></p>
        <p><span style="color:#6b7280;">signals:</span> <strong>${metrics.lastSignalsCount}</strong></p>
        <p><span style="color:#6b7280;">final candidates:</span> <strong>${metrics.lastInterestingCount}</strong></p>
        <p><span style="color:#6b7280;">movers:</span> <strong>${metrics.lastMoverCount}</strong></p>
        <p><span style="color:#6b7280;">mispricing:</span> <strong>${metrics.lastMispricingCount}</strong></p>
        <p><span style="color:#6b7280;">filtered (guardrails):</span> <strong>${metrics.filteredOutByGuardrails}</strong></p>
        <p><span style="color:#6b7280;">eligible mispricing:</span> <strong>${metrics.eligibleForMispricing}</strong></p>
      </div>
    </div>
    ${metrics.lastError ? `<div class="card" style="border-left:4px solid #dc2626;"><p style="color:#b91c1c;"><strong>Last error:</strong> ${escHtml(metrics.lastError)}</p></div>` : ""}
    <div class="card">
      <h2 style="margin-top:0;">Database</h2>
      <div class="grid-2">
        <p><span style="color:#6b7280;">Snapshots:</span> <strong>${metrics.dbSnapshotCount ?? "-"}</strong></p>
        <p><span style="color:#6b7280;">Scans:</span> <strong>${metrics.dbScanCount ?? "-"}</strong></p>
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0;">Last 3 Scans</h2>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="border-bottom:1px solid #e5e7eb;">
            <th style="padding:4px 8px;text-align:left;font-size:0.78rem;color:#6b7280;">Scan ID</th>
            <th style="padding:4px 8px;text-align:right;font-size:0.78rem;color:#6b7280;">Duration</th>
          </tr>
        </thead>
        <tbody>${scanRows}</tbody>
      </table>
    </div>
    <p style="font-size:0.8rem;color:#6b7280;margin-top:12px;">Raw JSON: <a href="/metrics" style="color:#2563eb;">/metrics</a></p>
  `;
}

function renderCandidate(item) {
  const movePrefix = item.delta1 > 0 ? "+" : "";
  const reasonTags = (item.reasonCodes || []).map((r) => {
    const c = r === "novel" ? "#059669" : r === "near-expiry" ? "#d97706" : r === "filtered" ? "#ef4444" : "#6b7280";
    return `<span style="display:inline-block;padding:1px 6px;border-radius:3px;background:${c}22;color:${c};font-size:0.7rem;border:1px solid ${c}44;margin-right:3px;">${r}</span>`;
  }).join("");

  const link = polymarketUrl(item);
  const questionHtml = link
    ? `<a href="${escHtml(link)}" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:none;font-weight:600;flex:1;font-size:0.95rem;line-height:1.3;">${escHtml(item.question)}</a>`
    : `<strong style="flex:1;font-size:0.95rem;line-height:1.3;">${escHtml(item.question)}</strong>`;
  const whyBullets = computeWhyPick(item);
  const trade = computeTradeability(item);
  const safeLink = link ? escHtml(link) : "";

  return `
    <li class="candidate-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
        ${questionHtml}
        <span style="margin-left:12px;font-size:1.1rem;font-weight:700;color:#111;white-space:nowrap;">${item.signalScore2.toFixed(1)}</span>
      </div>
      <div style="margin-bottom:6px;">${signalBadge(item.signalType)} ${reasonTags}${item.category ? ` <span class="cat-badge">${escHtml(item.category)}</span>` : ""}${item.subcategory ? ` <span class="cat-badge sub">${escHtml(item.subcategory)}</span>` : ""}</div>
      <div class="candidate-grid">
        <div><span class="label">YES now</span><span class="val">${item.latestYes.toFixed(3)}</span></div>
        <div><span class="label">spreadPct</span><span class="val">${(item.spreadPct * 100).toFixed(1)}%</span></div>
        <div><span class="label">24h Vol</span><span class="val bold">${formatVolume(item.volume24hr)}</span></div>
        <div><span class="label">liquidity</span><span class="val">${Math.round(item.liquidity).toLocaleString("en-US")}</span></div>
        <div><span class="label">hoursLeft</span><span class="val">${formatHoursLeft(item.hoursLeft)}</span></div>
      </div>
      <div class="why-pick-card">
        <div class="${trade.cls}" style="margin-bottom:6px;font-weight:600;font-size:0.85rem;">${trade.icon} ${escHtml(trade.label)}</div>
        <p style="margin:0 0 4px;font-weight:600;font-size:0.82rem;color:#1d1d1f;">Why this is a pick</p>
        <ul style="margin:0;padding-left:18px;font-size:0.82rem;color:#374151;">
          ${whyBullets.map((b) => `<li>${escHtml(b)}</li>`).join("")}
        </ul>
      </div>
      ${link ? `<div class="cta-row">
        <a href="${safeLink}" target="_blank" rel="noopener" class="cta-primary">Open on Polymarket</a>
        <button class="cta-secondary" data-copy-url="${safeLink}">Copy link</button>
      </div>` : ""}
      <details style="margin-top:6px;">
        <summary style="cursor:pointer;font-size:0.75rem;color:#6b7280;">Debug</summary>
        <div class="candidate-grid" style="margin-top:4px;font-size:0.78rem;">
          <div><span class="label">YES prev</span><span class="val">${item.previousYes.toFixed(3)}</span></div>
          <div><span class="label">absMove</span><span class="val">${item.absMove.toFixed(4)}</span></div>
          <div><span class="label">delta1</span><span class="val">${movePrefix}${item.delta1.toFixed(4)}</span></div>
          <div><span class="label">volatility</span><span class="val">${item.volatility.toFixed(4)}</span></div>
          <div><span class="label">spread</span><span class="val">${item.spread.toFixed(4)}</span></div>
          <div><span class="label">spreadPct</span><span class="val">${item.spreadPct.toFixed(4)}</span></div>
          <div><span class="label">bestBid</span><span class="val">${item.bestBidNum.toFixed(3)}</span></div>
          <div><span class="label">bestAsk</span><span class="val">${item.bestAskNum.toFixed(3)}</span></div>
        </div>
        <pre class="breakdown">${renderBreakdown(item)}</pre>
        <div class="candidate-grid" style="margin-top:4px;font-size:0.72rem;">
          <div><span class="label">category</span><span class="val">${escHtml(item.category || "-")}</span></div>
          <div><span class="label">subcategory</span><span class="val">${escHtml(item.subcategory || "-")}</span></div>
          <div><span class="label">eventSlug</span><span class="val">${escHtml(item.eventSlug || "-")}</span></div>
          <div><span class="label">tags</span><span class="val">${(item.tagSlugs || []).map((t) => escHtml(t)).join(", ") || "-"}</span></div>
          <div><span class="label">eventGroup</span><span class="val">${escHtml(item.eventGroup || "-")}</span></div>
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
  .why-pick-card {
    background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px;
    padding: 10px 14px; margin-top: 8px;
  }
  .tradeability-ok { color: #166534; }
  .tradeability-watch { color: #92400e; }
  .tradeability-excluded { color: #b91c1c; }
  .cta-row {
    display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap;
  }
  .cta-primary {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 7px 16px; border-radius: 8px; font-size: 0.85rem; font-weight: 600;
    background: #2563eb; color: #fff; text-decoration: none; border: none; cursor: pointer;
    transition: background .15s;
  }
  .cta-primary:hover { background: #1d4ed8; }
  .cta-secondary {
    display: inline-flex; align-items: center; justify-content: center;
    padding: 7px 16px; border-radius: 8px; font-size: 0.85rem; font-weight: 600;
    background: #fff; color: #2563eb; border: 1px solid #2563eb; cursor: pointer;
    transition: background .15s;
  }
  .cta-secondary:hover { background: #eff6ff; }
  .cat-badge {
    display: inline-block; padding: 1px 6px; border-radius: 3px;
    background: #dbeafe; color: #1e40af; font-size: 0.7rem;
    border: 1px solid #93c5fd; margin-left: 3px;
  }
  .cat-badge.sub { background: #fef3c7; color: #92400e; border-color: #fcd34d; }
  .filter-bar {
    display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px;
    align-items: center; font-size: 0.85rem;
  }
  .filter-bar select, .filter-bar input {
    padding: 5px 10px; border-radius: 6px; border: 1px solid #d1d5db;
    font-size: 0.85rem; background: #fff;
  }

  /* Trade page styles */
  .status-bar {
    display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center;
    background: #fff; border-radius: 12px; padding: 14px 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08); margin-bottom: 8px;
  }
  .status-item { display: flex; flex-direction: column; font-size: 0.82rem; }
  .status-label { color: #6b7280; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .status-value { font-weight: 600; color: #1d1d1f; }
  .mode-normal { color: #059669; }
  .mode-relaxed { color: #d97706; }

  .trade-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 16px;
  }
  @media (max-width: 700px) {
    .trade-grid { grid-template-columns: 1fr; }
  }

  .trade-card {
    background: #fff; border-radius: 12px; padding: 20px;
    box-shadow: 0 1px 4px rgba(0,0,0,.08);
  }
  .trade-card-header { margin-bottom: 10px; }
  .trade-card-title {
    font-weight: 700; font-size: 0.95rem; line-height: 1.35;
    color: #2563eb; text-decoration: none;
  }
  .trade-card-title:hover { text-decoration: underline; }

  .action-pill {
    display: inline-block; padding: 6px 18px; border-radius: 20px;
    font-weight: 700; font-size: 0.9rem; letter-spacing: 0.03em;
    margin-bottom: 12px;
  }
  .pill-buy-yes { background: #dcfce7; color: #166534; }
  .pill-buy-no { background: #fef3c7; color: #92400e; }
  .pill-watch { background: #f3f4f6; color: #6b7280; }

  .trade-plan-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px;
    margin-bottom: 10px;
  }
  .trade-plan-item { display: flex; flex-direction: column; }
  .trade-plan-label {
    font-size: 0.68rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em; color: #6b7280;
  }
  .trade-plan-value { font-size: 0.92rem; font-weight: 700; color: #1d1d1f; }

  .why-now {
    font-size: 0.82rem; color: #374151; margin: 0 0 10px;
    padding: 6px 10px; background: #f9fafb; border-radius: 6px;
    border-left: 3px solid #2563eb;
  }

  .trade-details { margin-top: 8px; }
  .trade-details summary {
    cursor: pointer; font-size: 0.78rem; color: #6b7280; font-weight: 600;
  }
  .trade-details-inner { padding-top: 8px; }
</style>`;
}

/** Shared top navigation bar. */
function renderNav(active) {
  const links = [
    { href: "/trade", label: "Trade" },
    { href: "/explore", label: "Explore" },
    { href: "/system", label: "System" },
  ];
  const items = links.map((l) => {
    const style = l.href === active ? "color:#fff;font-weight:600;" : "";
    return `<a href="${l.href}" style="${style}">${l.label}</a>`;
  }).join("");
  return `<nav class="top-bar"><div class="inner"><a href="/trade" class="brand" style="color:#f5f5f7;text-decoration:none;">Polyrich</a>${items}</div></nav>`;
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
  <script>
  document.addEventListener("click", function(e) {
    var btn = e.target.closest("[data-copy-url]");
    if (btn) {
      var url = btn.getAttribute("data-copy-url");
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url).then(function() {
          var orig = btn.textContent;
          btn.textContent = "Copied!";
          setTimeout(function() { btn.textContent = orig; }, 1500);
        }, function() {
          btn.textContent = "Copy failed";
          setTimeout(function() { btn.textContent = "Copy link"; }, 1500);
        });
      } else {
        btn.textContent = "Copy not supported";
        setTimeout(function() { btn.textContent = "Copy link"; }, 1500);
      }
      return;
    }
    var planBtn = e.target.closest("[data-copy-plan]");
    if (planBtn) {
      var plan = planBtn.getAttribute("data-copy-plan");
      if (navigator.clipboard) {
        navigator.clipboard.writeText(plan).then(function() {
          var orig = planBtn.textContent;
          planBtn.textContent = "Copied!";
          setTimeout(function() { planBtn.textContent = orig; }, 1500);
        }, function() {
          planBtn.textContent = "Copy failed";
          setTimeout(function() { planBtn.textContent = "Copy plan"; }, 1500);
        });
      } else {
        planBtn.textContent = "Copy not supported";
        setTimeout(function() { planBtn.textContent = "Copy plan"; }, 1500);
      }
    }
  });
  </script>
</body>
</html>`;
}

/**
 * Render a filter bar for category/tag/subcategory filtering.
 * categories and tags are arrays of strings (distinct values).
 * active = { cat, sub, tag } from current query params.
 */
function renderFilterBar(categories, subcategories, tagSlugs, active, actionUrl) {
  active = active || {};
  const formAction = actionUrl || "/ideas";
  function opts(values, selected) {
    return values.map((v) => {
      const sel = v === selected ? " selected" : "";
      return `<option value="${escHtml(v)}"${sel}>${escHtml(v)}</option>`;
    }).join("");
  }

  const catHtml = categories.length > 0 ? `
    <label>Category
      <select name="cat">
        <option value="">All</option>
        ${opts(categories, active.cat)}
      </select>
    </label>` : "";

  const subHtml = subcategories.length > 0 ? `
    <label>Subcategory
      <select name="sub">
        <option value="">All</option>
        ${opts(subcategories, active.sub)}
      </select>
    </label>` : "";

  return `
    <form class="filter-bar" method="get" action="${escHtml(formAction)}">
      ${catHtml}
      ${subHtml}
      <label>Tag
        <select name="tag">
          <option value="">All</option>
          ${opts(tagSlugs, active.tag)}
        </select>
      </label>
      <button type="submit" class="cta-primary" style="padding:5px 14px;font-size:0.85rem;">Filter</button>
      <a href="${escHtml(formAction)}" style="color:#6b7280;font-size:0.82rem;text-decoration:none;">Reset</a>
    </form>
  `;
}

/** Render a single time-bucket section (INTRADAY / THIS_WEEK / WATCH). */
function renderBucketSection(bucketName, items, totalCount, gateSummary, collapsed) {
  const icons = { INTRADAY: "⏱️", THIS_WEEK: "📅", WATCH: "👀" };
  const labels = { INTRADAY: "Intraday (≤48 h)", THIS_WEEK: "This Week (≤168 h)", WATCH: "Watch (>168 h)" };
  const icon = icons[bucketName] || "📊";
  const label = labels[bucketName] || bucketName;
  const openAttr = collapsed ? "" : " open";

  const itemsHtml = items.length === 0
    ? '<p style="color:#6b7280;font-size:0.85rem;padding:8px 0;">No markets passed the gates this scan.</p>'
    : `<ol class="candidates">${items.map((item) => {
        try { return renderCandidate(item); }
        catch (e) { return `<li class="candidate-card">render error: ${escHtml((item && item.marketSlug) || "unknown")} — ${escHtml(e.message)}</li>`; }
      }).join("")}</ol>`;

  return `
    <details class="section-toggle"${openAttr}>
      <summary>${icon} ${escHtml(label)} <span class="badge-count">${totalCount}</span></summary>
      <p style="color:#6b7280;font-size:0.82rem;margin:0 0 8px;">Gates: ${escHtml(gateSummary)} · Showing top ${items.length} of ${totalCount}</p>
      ${itemsHtml}
    </details>
  `;
}

// ---------------------------------------------------------------------------
// Trade plan heuristics
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Trade plan heuristics — constants
// ---------------------------------------------------------------------------
const DIRECTION_DELTA_THRESHOLD = 0.005; // min |delta1| to infer directional trade
const PRICE_MIDPOINT = 0.5;              // YES price midpoint for side selection
const SIZE_LIQUIDITY_PCT = 0.01;         // max 1% of liquidity
const SIZE_VOLUME_PCT = 0.02;            // max 2% of 24h volume
const SIZE_CAP = 50;                     // max position size in $
const TP_MULTIPLIER = 1.10;              // take profit at +10%
const STOP_MULTIPLIER = 0.92;            // stop loss at -8%
const PRICE_CEILING = 0.99;
const PRICE_FLOOR = 0.01;
const RISK_PCT_DEFAULT = 0.01;         // 1% of bankroll per trade
const MAX_TRADE_CAP_USD = 50;          // absolute max position cap (matches SIZE_CAP)
const MIN_ABS_MOVE_FOR_EXEC = 0.003;   // min |absMove| for direction confidence
const MIN_VOL_FOR_EXEC = 0.002;        // min volatility for direction confidence

/**
 * Infer trade direction from candidate fields with safety gates.
 * Returns { action, actionCls, whyWatch, nextStep }.
 * Gates: tradeability, movement/volatility, direction indicator, pricing integrity.
 */
function inferDirection(item) {
  const trade = computeTradeability(item);
  if (trade.label === "Excluded" || trade.label === "Watch") {
    let whyWatch, nextStep;
    if (trade.label === "Excluded") {
      whyWatch = "Market excluded (expired or filtered)";
      nextStep = "Market must be active and within time window";
    } else if (item.hoursLeft !== null && item.hoursLeft > 240) {
      whyWatch = "Too far from expiry (>10 days)";
      nextStep = "Wait for market to approach expiry window";
    } else if (item.spreadPct > 0.15) {
      whyWatch = `Spread too wide (${(item.spreadPct * 100).toFixed(1)}%)`;
      nextStep = "Need spread \u2264 15%";
    } else if (item.liquidity < 500) {
      whyWatch = `Low liquidity ($${Math.round(item.liquidity)})`;
      nextStep = "Need liquidity \u2265 $500";
    } else if (item.volume24hr < 50) {
      whyWatch = `Low 24h volume (${formatVolume(item.volume24hr)})`;
      nextStep = "Need higher trading activity";
    } else if (item.hoursLeft !== null && item.hoursLeft < 2) {
      whyWatch = "Too close to expiry (< 2h)";
      nextStep = "Avoid entries near resolution";
    } else {
      whyWatch = "Market conditions insufficient";
      nextStep = "Improve liquidity, volume, or spread";
    }
    return { action: "WATCH", actionCls: "pill-watch", whyWatch, nextStep };
  }

  // Gate: movement / volatility (real action required)
  const hasMovement = item.absMove >= MIN_ABS_MOVE_FOR_EXEC || item.volatility >= MIN_VOL_FOR_EXEC;

  // Determine raw direction from existing fields (no new logic)
  let rawAction = null;
  if (item.mispricing) {
    rawAction = item.latestYes < PRICE_MIDPOINT ? "BUY YES" : "BUY NO";
  } else if (item.delta1 < -DIRECTION_DELTA_THRESHOLD && item.latestYes < PRICE_MIDPOINT) {
    rawAction = "BUY YES";
  } else if (item.delta1 > DIRECTION_DELTA_THRESHOLD && item.latestYes > PRICE_MIDPOINT) {
    rawAction = "BUY NO";
  } else if (item.momentum || item.breakout) {
    if (item.delta1 > 0) rawAction = "BUY YES";
    else if (item.delta1 < 0) rawAction = "BUY NO";
  }

  if (!rawAction) {
    return { action: "WATCH", actionCls: "pill-watch",
      whyWatch: "Direction unclear \u2014 no strong signal",
      nextStep: "Need clearer directional indicator (delta, mispricing, or momentum)" };
  }

  if (!hasMovement) {
    return { action: "WATCH", actionCls: "pill-watch",
      whyWatch: "Insufficient price movement or volatility",
      nextStep: "Need absMove \u2265 0.3% or volatility \u2265 0.2%" };
  }

  // Gate: BUY NO requires real NO-side orderbook pricing (not synthetic 1\u2212yesPrice)
  if (rawAction === "BUY NO") {
    return { action: "WATCH", actionCls: "pill-watch",
      whyWatch: "No reliable NO-side orderbook pricing",
      nextStep: "Need real NO-side bestAsk (synthetic 1\u2212yesPrice not executable)" };
  }

  // Gate: BUY YES requires executable pricing (bestAskNum from orderbook)
  if (rawAction === "BUY YES" && !(item.bestAskNum > 0)) {
    return { action: "WATCH", actionCls: "pill-watch",
      whyWatch: "No executable YES-side pricing (bestAsk missing)",
      nextStep: "Need reliable orderbook bestAsk price" };
  }

  return { action: rawAction, actionCls: "pill-buy-yes", whyWatch: "", nextStep: "" };
}

/** Infer entry limit price (numeric). Returns null if not executable. */
function inferEntry(item, direction) {
  if (direction === "BUY YES") {
    // Only real orderbook bestAsk — no latestYes fallback
    if (item.bestAskNum > 0) return item.bestAskNum;
    return null;
  }
  // BUY NO would need real NO-side bestAsk — not available in current data
  return null;
}

/** Infer conservative max size (numeric $) from liquidity/volume. Returns null if not computable. */
function inferSize(item) {
  if (item.liquidity < 500 || item.volume24hr < 50) return null;
  const fromLiq = item.liquidity * SIZE_LIQUIDITY_PCT;
  const fromVol = item.volume24hr * SIZE_VOLUME_PCT;
  const raw = Math.min(fromLiq, fromVol, MAX_TRADE_CAP_USD);
  if (raw < 1) return null;
  return Math.floor(raw);
}

/** Infer exit plan (take profit + stop-loss) from entry price. Returns { tp, stop } as numbers or null. */
function inferExit(entryNum) {
  if (entryNum === null || entryNum <= 0 || entryNum >= PRICE_CEILING) return { tp: null, stop: null };
  const tp = Math.min(entryNum * TP_MULTIPLIER, PRICE_CEILING);
  const stop = Math.max(entryNum * STOP_MULTIPLIER, PRICE_FLOOR);
  return { tp, stop };
}

/** One-line "Why now" summary. */
function whyNowSummary(item) {
  const parts = [];
  if (item.delta1 !== 0) {
    const sign = item.delta1 > 0 ? "+" : "";
    parts.push(`Move ${sign}${(item.delta1 * 100).toFixed(1)}%`);
  }
  if (item.volume24hr > 0) parts.push(`Vol ${formatVolume(item.volume24hr)}`);
  if (item.spreadPct > 0) parts.push(`Spread ${(item.spreadPct * 100).toFixed(1)}%`);
  if (item.hoursLeft !== null && item.hoursLeft > 0) parts.push(`${formatHoursLeft(item.hoursLeft)} left`);
  return parts.join(" · ") || "—";
}

/** Render a single trade card for the /trade page. */
function renderTradeCard(item) {
  let { action, actionCls, whyWatch, nextStep } = inferDirection(item);
  const whyNow = whyNowSummary(item);
  const link = polymarketUrl(item);
  const safeLink = link ? escHtml(link) : "";
  const questionHtml = link
    ? `<a href="${safeLink}" target="_blank" rel="noopener" class="trade-card-title">${escHtml(item.question)}</a>`
    : `<span class="trade-card-title">${escHtml(item.question)}</span>`;

  let entryNum = null, sizeNum = null, tpNum = null, stopNum = null;

  if (action !== "WATCH") {
    entryNum = inferEntry(item, action);
    if (entryNum !== null) {
      sizeNum = inferSize(item);
      const exits = inferExit(entryNum);
      tpNum = exits.tp;
      stopNum = exits.stop;
    }
    // EXECUTE completeness rule: all must be numeric
    if (entryNum === null || sizeNum === null || tpNum === null || stopNum === null) {
      if (entryNum === null) {
        whyWatch = "No executable pricing available";
        nextStep = "Need reliable orderbook bestAsk price";
      } else if (sizeNum === null) {
        whyWatch = "Cannot determine safe position size";
        nextStep = "Need liquidity \u2265 $500 and 24h volume \u2265 $50";
      } else {
        whyWatch = "Cannot determine exit levels";
        nextStep = "Entry price at extreme \u2014 no room for TP/SL";
      }
      action = "WATCH";
      actionCls = "pill-watch";
    }
  }

  const isExecute = action !== "WATCH";

  // Debug section (shared between EXECUTE and WATCH)
  const debugHtml = `
    <details class="trade-details">
      <summary>Details</summary>
      <div class="trade-details-inner">
        <p style="font-weight:600;font-size:0.82rem;margin:0 0 6px;">Why this is a pick</p>
        <ul style="margin:0 0 8px;padding-left:18px;font-size:0.82rem;color:#374151;">
          ${computeWhyPick(item).map((b) => `<li>${escHtml(b)}</li>`).join("")}
        </ul>
        <p style="font-weight:600;font-size:0.82rem;margin:0 0 4px;">Debug / scoring</p>
        <pre class="breakdown">${renderBreakdown(item)}</pre>
        <div class="candidate-grid" style="margin-top:6px;font-size:0.78rem;">
          <div><span class="label">absMove</span><span class="val">${item.absMove.toFixed(4)}</span></div>
          <div><span class="label">volatility</span><span class="val">${item.volatility.toFixed(4)}</span></div>
          <div><span class="label">spreadPct</span><span class="val">${(item.spreadPct * 100).toFixed(1)}%</span></div>
          <div><span class="label">liquidity</span><span class="val">${Math.round(item.liquidity).toLocaleString("en-US")}</span></div>
          <div><span class="label">volume24h</span><span class="val">${formatVolume(item.volume24hr)}</span></div>
          <div><span class="label">timeLeftHours</span><span class="val">${formatHoursLeft(item.hoursLeft)}</span></div>
          <div><span class="label">bestBid</span><span class="val">${item.bestBidNum.toFixed(3)}</span></div>
          <div><span class="label">bestAsk</span><span class="val">${item.bestAskNum.toFixed(3)}</span></div>
          <div><span class="label">tags</span><span class="val">${(item.tagSlugs || []).map((t) => escHtml(t)).join(", ") || "-"}</span></div>
        </div>
      </div>
    </details>
  `;

  if (isExecute) {
    // --- EXECUTE card ---
    const pnlTpPct = (tpNum - entryNum) / entryNum * 100;
    const pnlStopPct = (stopNum - entryNum) / entryNum * 100;
    const pnlTpUsd = sizeNum * (tpNum - entryNum) / entryNum;
    const pnlStopUsd = sizeNum * (stopNum - entryNum) / entryNum;

    const ticketText = [
      `ACTION: ${action}`,
      `MARKET: ${item.question}`,
      `ENTRY LIMIT: $${entryNum.toFixed(2)}`,
      `MAX SIZE: $${sizeNum}`,
      `TAKE PROFIT: $${tpNum.toFixed(2)}`,
      `STOP-LOSS: $${stopNum.toFixed(2)}`,
      `EST PnL @ TP: +$${pnlTpUsd.toFixed(2)} (+${pnlTpPct.toFixed(1)}% of stake)`,
      `EST PnL @ SL: -$${Math.abs(pnlStopUsd).toFixed(2)} (${pnlStopPct.toFixed(1)}% of stake)`,
      `WHY NOW: ${whyNow}`,
    ].join("\n");

    return `
      <div class="trade-card" data-execute="1" data-entry-num="${entryNum}" data-heuristic-max="${sizeNum}" data-tp-num="${tpNum}" data-stop-num="${stopNum}" data-market="${escHtml(item.question)}" data-action="${escHtml(action)}">
        <div class="trade-card-header">${questionHtml}</div>
        <div class="action-pill ${actionCls}">\u26A1 EXECUTE \u00B7 ${escHtml(action)}</div>
        <div class="trade-plan-grid">
          <div class="trade-plan-item"><span class="trade-plan-label">ENTRY LIMIT</span><span class="trade-plan-value">$${entryNum.toFixed(2)}</span></div>
          <div class="trade-plan-item"><span class="trade-plan-label">MAX SIZE (guideline)</span><span class="trade-plan-value trade-size">$${sizeNum} <span class="size-note">(bankroll not set)</span></span></div>
          <div class="trade-plan-item"><span class="trade-plan-label">TAKE PROFIT</span><span class="trade-plan-value">$${tpNum.toFixed(2)}</span></div>
          <div class="trade-plan-item"><span class="trade-plan-label">STOP-LOSS</span><span class="trade-plan-value">$${stopNum.toFixed(2)}</span></div>
          <div class="trade-plan-item"><span class="trade-plan-label">PnL @ TP (approx)</span><span class="trade-plan-value trade-pnl-tp" style="color:#166534;">+$${pnlTpUsd.toFixed(2)} (+${pnlTpPct.toFixed(1)}% of stake)</span></div>
          <div class="trade-plan-item"><span class="trade-plan-label">PnL @ SL (approx)</span><span class="trade-plan-value trade-pnl-stop" style="color:#dc2626;">-$${Math.abs(pnlStopUsd).toFixed(2)} (${pnlStopPct.toFixed(1)}% of stake)</span></div>
        </div>
        <p class="bankroll-note" style="font-size:0.75rem;color:#6b7280;margin:0 0 8px;">\u2139\uFE0F Set bankroll to get % sizing</p>
        <p class="why-now">WHY NOW: ${escHtml(whyNow)}</p>
        <div class="cta-row">
          ${link ? `<a href="${safeLink}" target="_blank" rel="noopener" class="cta-primary">Open on Polymarket</a>` : ""}
          <button class="cta-secondary copy-ticket" data-copy-plan="${escHtml(ticketText)}">Copy ticket</button>
        </div>
        ${debugHtml}
      </div>
    `;
  }

  // --- WATCH card ---
  const watchReason = whyWatch || "Missing executable trade parameters";
  const watchNext = nextStep || "Entry, size, TP, or stop-loss could not be determined";
  const watchPlanText = [
    "ACTION: WATCH",
    `MARKET: ${item.question}`,
    `WHY WATCH: ${watchReason}`,
    `NEXT: ${watchNext}`,
  ].join("\n");

  return `
    <div class="trade-card">
      <div class="trade-card-header">${questionHtml}</div>
      <div class="action-pill pill-watch">\uD83D\uDC41 WATCH</div>
      <div style="padding:8px 0;">
        <p style="margin:0 0 6px;font-size:0.88rem;"><strong>WHY WATCH:</strong> ${escHtml(watchReason)}</p>
        <p style="margin:0;font-size:0.85rem;color:#6b7280;"><strong>NEXT:</strong> ${escHtml(watchNext)}</p>
      </div>
      <div class="cta-row">
        ${link ? `<a href="${safeLink}" target="_blank" rel="noopener" class="cta-primary">Open on Polymarket</a>` : ""}
        <button class="cta-secondary" data-copy-plan="${escHtml(watchPlanText)}">Copy plan</button>
      </div>
      ${debugHtml}
    </div>
  `;
}

/** Render the compact status bar at top of /trade. */
function renderStatusBar(scanStatus, candidateCount, relaxedMode) {
  const lastScan = scanStatus.lastScanAt
    ? scanStatus.lastScanAt.toLocaleString("en-US", { hour12: false })
    : "not yet";
  const nextScan = scanStatus.nextScanAt
    ? scanStatus.nextScanAt.toLocaleString("en-US", { hour12: false })
    : "—";
  const modeLabel = relaxedMode ? "relaxed" : "normal";
  const modeCls = relaxedMode ? "mode-relaxed" : "mode-normal";
  const eventsScanned = scanStatus.lastEventsFetched || 0;
  const marketsScanned = scanStatus.lastMarketsFlattened || 0;

  return `
    <div class="status-bar">
      <div class="status-item"><span class="status-label">Last scan</span><span class="status-value">${escHtml(lastScan)}</span></div>
      <div class="status-item"><span class="status-label">Next scan</span><span class="status-value">${escHtml(nextScan)}</span></div>
      <div class="status-item"><span class="status-label">Universe</span><span class="status-value">${eventsScanned} events / ${marketsScanned} markets</span></div>
      <div class="status-item"><span class="status-label">Mode</span><span class="status-value ${modeCls}">${modeLabel}</span></div>
      <div class="status-item"><span class="status-label">Ready</span><span class="status-value" style="font-weight:700;">${candidateCount} candidates</span></div>
      <div class="status-item">
        <label class="status-label" for="bankroll-input">Bankroll (USD) <small style="text-transform:none;letter-spacing:0;">(optional)</small></label>
        <input id="bankroll-input" type="number" min="0" step="1" placeholder="e.g. 1000"
          style="width:100px;padding:3px 6px;border:1px solid #d1d5db;border-radius:6px;font-size:0.85rem;font-weight:600;">
      </div>
      <a href="/scan" class="cta-primary" style="padding:5px 14px;font-size:0.82rem;white-space:nowrap;">Refresh scan</a>
    </div>
  `;
}

/** Render the full /trade page body. */
function renderTradePage(scanStatus, tradeCandidates, relaxedMode) {
  const cards = tradeCandidates.slice(0, 10);
  const statusBar = renderStatusBar(scanStatus, cards.length, relaxedMode);

  const cardsHtml = cards.length === 0
    ? '<div class="card" style="text-align:center;padding:40px 20px;"><p style="font-size:1.1rem;color:#6b7280;">No candidates yet. Run a scan or wait for the next scheduled scan.</p><a href="/scan" class="cta-primary" style="margin-top:12px;display:inline-flex;">Run scan now</a></div>'
    : `<div class="trade-grid">${cards.map((item) => {
        try { return renderTradeCard(item); }
        catch (_) { return `<div class="trade-card"><p style="color:#b91c1c;">Render error: ${escHtml((item && item.marketSlug) || "unknown")}</p></div>`; }
      }).join("")}</div>`;

  return `
    ${statusBar}
    <h2 style="margin:20px 0 12px;font-size:1.25rem;">Today's Playbook</h2>
    ${cardsHtml}
    <script>
    (function() {
      var RISK_PCT = ${RISK_PCT_DEFAULT};
      var MAX_CAP = ${MAX_TRADE_CAP_USD};
      var KEY = 'polyrich_bankroll_usd';
      var input = document.getElementById('bankroll-input');
      if (!input) return;

      var saved = localStorage.getItem(KEY);
      if (saved) input.value = saved;

      function updateCards() {
        var bankroll = parseFloat(input.value);
        var hasBankroll = !isNaN(bankroll) && bankroll > 0;
        if (hasBankroll) localStorage.setItem(KEY, String(bankroll));
        else localStorage.removeItem(KEY);

        var cards = document.querySelectorAll('[data-execute="1"]');
        for (var i = 0; i < cards.length; i++) {
          var card = cards[i];
          var hMax = parseFloat(card.getAttribute('data-heuristic-max'));
          var entry = parseFloat(card.getAttribute('data-entry-num'));
          var tp = parseFloat(card.getAttribute('data-tp-num'));
          var stop = parseFloat(card.getAttribute('data-stop-num'));
          var market = card.getAttribute('data-market') || '';
          var act = card.getAttribute('data-action') || '';
          if (isNaN(hMax) || isNaN(entry) || entry <= 0) continue;

          var maxSize, sizeNote;
          if (hasBankroll) {
            var riskBudget = bankroll * RISK_PCT;
            maxSize = Math.floor(Math.min(MAX_CAP, riskBudget, hMax));
            var pct = (maxSize / bankroll * 100).toFixed(1);
            sizeNote = '(' + pct + '% of bankroll)';
          } else {
            maxSize = hMax;
            sizeNote = '(bankroll not set)';
          }

          var sizeEl = card.querySelector('.trade-size');
          if (sizeEl) sizeEl.innerHTML = '$' + maxSize + ' <span class="size-note">' + sizeNote + '</span>';

          if (!isNaN(tp) && !isNaN(stop)) {
            var pTpU = maxSize * (tp - entry) / entry;
            var pTpP = (tp - entry) / entry * 100;
            var pSlU = maxSize * (stop - entry) / entry;
            var pSlP = (stop - entry) / entry * 100;
            var tpEl = card.querySelector('.trade-pnl-tp');
            if (tpEl) tpEl.textContent = '+$' + pTpU.toFixed(2) + ' (+' + pTpP.toFixed(1) + '% of stake)';
            var slEl = card.querySelector('.trade-pnl-stop');
            if (slEl) slEl.textContent = '-$' + Math.abs(pSlU).toFixed(2) + ' (' + pSlP.toFixed(1) + '% of stake)';
          }

          var copyBtn = card.querySelector('.copy-ticket');
          if (copyBtn) {
            var lines = [
              'ACTION: ' + act,
              'MARKET: ' + market,
              'ENTRY LIMIT: $' + entry.toFixed(2),
              'MAX SIZE: $' + maxSize,
              'TAKE PROFIT: $' + tp.toFixed(2),
              'STOP-LOSS: $' + stop.toFixed(2)
            ];
            if (!isNaN(tp) && !isNaN(stop)) {
              var ptu = maxSize * (tp - entry) / entry;
              var ptp = (tp - entry) / entry * 100;
              var psu = maxSize * (stop - entry) / entry;
              var psp = (stop - entry) / entry * 100;
              lines.push('EST PnL @ TP: +$' + ptu.toFixed(2) + ' (+' + ptp.toFixed(1) + '% of stake)');
              lines.push('EST PnL @ SL: -$' + Math.abs(psu).toFixed(2) + ' (' + psp.toFixed(1) + '% of stake)');
            }
            copyBtn.setAttribute('data-copy-plan', lines.join('\\n'));
          }

          var noteEl = card.querySelector('.bankroll-note');
          if (noteEl) noteEl.style.display = hasBankroll ? 'none' : 'block';
        }
      }

      input.addEventListener('input', updateCards);
      updateCards();
    })();
    </script>
  `;
}

/**
 * Render the /explore page body.
 * Reuses filters, buckets, candidate lists from /ideas.
 */
function renderExplorePage(data) {
  const {
    categories, subcategories, tagSlugsAll,
    filterActive, tradeCandidates, movers, mispricing,
    buckets, thresholds, closestToThreshold,
  } = data;

  const hasCategories = categories.length > 0 || subcategories.length > 0;
  const filterBarHtml = hasCategories
    ? renderFilterBar(categories, subcategories, tagSlugsAll, filterActive, "/explore")
    : '<p style="color:#6b7280;font-size:0.85rem;margin-bottom:16px;">Categories not available yet.</p>' +
      (tagSlugsAll.length > 0 ? renderFilterBar([], [], tagSlugsAll, filterActive, "/explore") : "");

  return `
    <h1>Explore Markets</h1>
    ${filterBarHtml}
    ${buckets ? renderBucketSection("INTRADAY", data.filteredBuckets.INTRADAY, buckets.counts.INTRADAY, buckets.gates.INTRADAY, false) : ""}
    ${buckets ? renderBucketSection("THIS_WEEK", data.filteredBuckets.THIS_WEEK, buckets.counts.THIS_WEEK, buckets.gates.THIS_WEEK, false) : ""}
    ${buckets ? renderBucketSection("WATCH", data.filteredBuckets.WATCH.slice(0, 10), buckets.counts.WATCH, buckets.gates.WATCH, true) : ""}

    <details class="section-toggle">
      <summary>All trade candidates <span class="badge-count">${tradeCandidates.length}</span></summary>
      <ol class="candidates">
        ${tradeCandidates.map((item) => {
          try { return renderCandidate(item); }
          catch (_) { return `<li class="candidate-card">render error: ${escHtml((item && item.marketSlug) || "unknown")}</li>`; }
        }).join("")}
      </ol>
    </details>

    ${movers.length === 0 && thresholds ? renderWhyNoMovers(thresholds, closestToThreshold) : ""}

    <details class="section-toggle">
      <summary>Movers <span class="badge-count">${movers.length}</span></summary>
      <ol class="candidates">
        ${movers.map((item) => {
          try { return renderCandidate(item); }
          catch (_) { return `<li class="candidate-card">render error</li>`; }
        }).join("")}
      </ol>
    </details>

    <details class="section-toggle">
      <summary>Mispricing <span class="badge-count">${mispricing.length}</span></summary>
      <ol class="candidates">
        ${mispricing.map((item) => {
          try { return renderCandidate(item); }
          catch (_) { return `<li class="candidate-card">render error</li>`; }
        }).join("")}
      </ol>
    </details>
  `;
}

/** Render the /system page body. */
function renderSystemPage(healthData, metrics) {
  return `
    <h1>System</h1>
    ${renderHealthUi(healthData)}
    ${renderMetricsUi(metrics)}
    <div class="card">
      <h2 style="margin-top:0;">Quick Links</h2>
      <div class="grid-2">
        <p><a href="/scan" style="color:#2563eb;font-weight:600;">Run scan</a></p>
        <p><a href="/snapshots" style="color:#2563eb;font-weight:600;">Snapshots</a></p>
        <p><a href="/health" style="color:#2563eb;font-weight:600;">Health JSON</a></p>
        <p><a href="/metrics" style="color:#2563eb;font-weight:600;">Metrics JSON</a></p>
      </div>
    </div>
  `;
}

module.exports = {
  renderBreakdown,
  computeWhyPick,
  computeTradeability,
  renderCandidate,
  renderTopPick,
  renderTodayActions,
  renderWhyNoMovers,
  renderHealthUi,
  renderMetricsUi,
  renderFilterBar,
  renderBucketSection,
  renderTradeCard,
  renderStatusBar,
  renderTradePage,
  renderExplorePage,
  renderSystemPage,
  pageShell,
};
