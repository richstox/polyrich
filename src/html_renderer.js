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
        <p><span style="color:#6b7280;">saved:</span> <strong>${metrics.lastSavedCount}</strong></p>
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
</style>`;
}

/** Shared top navigation bar. */
function renderNav(active) {
  const links = [
    { href: "/", label: "Domů" },
    { href: "/ideas", label: "Dashboard" },
    { href: "/snapshots", label: "Snapshoty" },
    { href: "/scan", label: "Scan" },
    { href: "/health-ui", label: "Health" },
    { href: "/metrics-ui", label: "Metrics" },
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
  <script>
  document.addEventListener("click", function(e) {
    var btn = e.target.closest("[data-copy-url]");
    if (!btn) return;
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
function renderFilterBar(categories, subcategories, tagSlugs, active) {
  active = active || {};
  function opts(values, selected) {
    return values.map((v) => {
      const sel = v === selected ? " selected" : "";
      return `<option value="${escHtml(v)}"${sel}>${escHtml(v)}</option>`;
    }).join("");
  }

  return `
    <form class="filter-bar" method="get" action="/ideas">
      <label>Category
        <select name="cat">
          <option value="">All</option>
          ${opts(categories, active.cat)}
        </select>
      </label>
      <label>Subcategory
        <select name="sub">
          <option value="">All</option>
          ${opts(subcategories, active.sub)}
        </select>
      </label>
      <label>Tag
        <select name="tag">
          <option value="">All</option>
          ${opts(tagSlugs, active.tag)}
        </select>
      </label>
      <button type="submit" class="cta-primary" style="padding:5px 14px;font-size:0.85rem;">Filter</button>
      <a href="/ideas" style="color:#6b7280;font-size:0.82rem;text-decoration:none;">Reset</a>
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
  pageShell,
};
