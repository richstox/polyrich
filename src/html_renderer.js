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

/**
 * Emit a <span data-utc="..."> placeholder that the client-side
 * formatLocalDateTime() will replace with the user's local time.
 * Accepts Date | ISO string | null.  Returns pre-escaped HTML (safe to embed).
 * Fallback paths return escHtml()-escaped plain text for null/invalid values.
 */
function utcSpan(value, fallback) {
  if (!value) return escHtml(fallback || "\u2014");
  const iso = value instanceof Date ? value.toISOString() : String(value);
  if (isNaN(new Date(iso).getTime())) return escHtml(fallback || "\u2014");
  return `<span data-utc="${escHtml(iso)}">${escHtml(iso)}</span>`;
}

function polymarketUrl(item) {
  if (typeof item === "string") {
    // Legacy: called with a slug string
    if (!item) return null;
    return `https://polymarket.com/event/${encodeURIComponent(item)}`;
  }
  // Called with a market item object — prefer market-specific deep link
  if (item.eventSlug && item.marketSlug && item.marketSlug !== item.eventSlug && item.marketSlug !== item.question) {
    // Deep-link to the specific market within the event
    return `https://polymarket.com/event/${encodeURIComponent(item.eventSlug)}/${encodeURIComponent(item.marketSlug)}`;
  }
  if (item.eventSlug) {
    return `https://polymarket.com/event/${encodeURIComponent(item.eventSlug)}`;
  }
  if (item.question) {
    return `https://polymarket.com/search?q=${encodeURIComponent(item.question)}`;
  }
  return null;
}

/**
 * Returns true when a label is meaningless for display — YES, NO, empty,
 * too-short, or a generic placeholder.  Used to prevent confusing card titles.
 */
const INVALID_LABEL_SET = new Set(["yes", "no", "market", "unknown", "option", "outcome"]);

function isInvalidDisplayLabel(text) {
  if (!text || typeof text !== "string") return true;
  const trimmed = text.trim();
  if (trimmed.length < 4) return true;
  if (INVALID_LABEL_SET.has(trimmed.toLowerCase())) return true;
  return false;
}

/**
 * Convert a marketSlug (dash-separated) into a human-readable label.
 * e.g. "will-fight-go-the-distance" → "Will fight go the distance?"
 */
function slugToLabel(slug) {
  if (!slug || typeof slug !== "string") return "";
  const words = slug.split("-").filter(Boolean);
  if (words.length === 0) return "";
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  let label = words.join(" ");
  // Add trailing ? for question-like slugs
  if (/^(will|is|does|can|has|was|are|do|should|would|could|did|were|may|might)\b/i.test(label) && !label.endsWith("?")) {
    label += "?";
  }
  return label;
}

/**
 * Derive a meaningful display label for a market object.
 *
 * Preference order:
 *   1. mkt.question / canonical title — if valid
 *   2. outcomes / winner metadata — build a descriptive label
 *   3. mkt.marketSlug converted to readable text — if valid
 *   4. Safe fallback: "Market detail unavailable"
 */
function marketDisplayLabel(mkt) {
  if (!mkt || typeof mkt !== "object") return "Market detail unavailable";

  // 1. question / title
  const question = (mkt.question || "").trim();
  if (!isInvalidDisplayLabel(question)) return question;

  const slug = (mkt.slug || mkt.marketSlug || "").trim();

  // 2. outcomes / winner metadata — checked before generic slug conversion
  //    so that rich labels like "Moneyline (Winner): Name" beat plain slug text
  const outcomes = mkt.outcomes;
  if (Array.isArray(outcomes) && outcomes.length > 0) {
    const names = outcomes.map((o) => (typeof o === "string" ? o : (o && o.title) || "")).filter((n) => n.trim());
    if (names.length > 0) {
      const slugLower = slug.toLowerCase();
      // groupItemTitle is a Polymarket API field used on multi-outcome events
      const isWinner = slugLower.includes("winner") || slugLower.includes("moneyline")
        || (mkt.groupItemTitle || "").toLowerCase().includes("winner");
      if (isWinner) {
        return `Moneyline (Winner): ${names[0]}`;
      }
      return names.join(" vs ");
    }
  }

  // 3. marketSlug → human-readable
  if (slug && slug !== mkt.question) {
    const fromSlug = slugToLabel(slug);
    if (!isInvalidDisplayLabel(fromSlug)) return fromSlug;
  }

  // 4. Safe fallback
  return "Market detail unavailable";
}

/**
 * Safe question text: returns a valid market question or a safe fallback label.
 * Never returns an empty, YES/NO, or misleading string as the display title.
 */
function safeQuestion(item) {
  const label = marketDisplayLabel(item);
  if (label !== "Market detail unavailable") return label;
  console.warn(JSON.stringify({
    stage: "safeQuestion",
    msg: "missing market question — using fallback label",
    marketSlug: item.marketSlug || "",
    eventSlug: item.eventSlug || "",
    ts: new Date().toISOString(),
  }));
  return "Market detail unavailable";
}

/**
 * Determine the canonical headline and optional subtext for a card.
 *
 * When eventTitle is present and differs from the market label, use it as the
 * headline (e.g. "Curtis Blaydes vs Josh Hokit") and put the market-specific
 * label as the subtext (e.g. "Moneyline (Winner): Curtis Blaydes").
 *
 * This prevents showing a confusing "YES" as the main title for multi-market
 * sports events.
 */
function cardHeadline(item) {
  const eventTitle = (item.eventTitle || "").trim();
  const mktLabel = marketDisplayLabel(item);
  const validEvent = !isInvalidDisplayLabel(eventTitle);
  const validMkt = mktLabel !== "Market detail unavailable";

  // For multi-outcome grouped markets (e.g. "240-259" tweet-count ranges),
  // prefer the short groupItemTitle over the verbose per-token question as subtext.
  const groupTitle = (item.groupItemTitle || "").trim();

  if (validEvent && validMkt && eventTitle !== mktLabel) {
    // Event title as headline; use groupItemTitle when available instead of verbose token question
    const sub = groupTitle || mktLabel;
    return { headline: eventTitle, subtext: sub };
  }
  if (validEvent && !validMkt) {
    // No usable market label — show groupItemTitle if present
    return { headline: eventTitle, subtext: groupTitle };
  }
  if (validMkt) {
    return { headline: mktLabel, subtext: validEvent && eventTitle !== mktLabel ? eventTitle : "" };
  }
  return { headline: "Market detail unavailable", subtext: "" };
}

/** Compact "Top Pick" card for micro-trade action list */
function renderTopPick(item) {
  const link = polymarketUrl(item);
  const qText = safeQuestion(item);
  const questionHtml = link
    ? `<a href="${escHtml(link)}" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:none;font-weight:600;">${escHtml(qText)}</a>`
    : `<strong>${escHtml(qText)}</strong>`;
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

  const lastScan = utcSpan(scanStatus.lastScanAt, "not yet");
  const nextScan = utcSpan(scanStatus.nextScanAt, "not scheduled");

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
        <p><span style="color:#6b7280;">Last scan:</span> <strong>${utcSpan(healthData.lastScanAt, "never")}</strong></p>
        <p><span style="color:#6b7280;">Scan running:</span> <strong>${healthData.scanRunning ? "yes" : "no"}</strong></p>
        <p><span style="color:#6b7280;">Timestamp:</span> <strong>${utcSpan(healthData.ts)}</strong></p>
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
        <p><span style="color:#6b7280;">Last scan:</span> <strong>${utcSpan(metrics.lastScanAt, "never")}</strong></p>
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
  const qText = safeQuestion(item);
  const questionHtml = link
    ? `<a href="${escHtml(link)}" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:none;font-weight:600;flex:1;font-size:0.95rem;line-height:1.3;">${escHtml(qText)}</a>`
    : `<strong style="flex:1;font-size:0.95rem;line-height:1.3;">${escHtml(qText)}</strong>`;
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

  /* Ticket card styles (mobile-first) */
  .ticket-list { display: flex; flex-direction: column; gap: 10px; }
  .ticket-card {
    background: #fff; border-radius: 10px; padding: 14px 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,.06);
  }
  .ticket-meta-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
    gap: 4px 12px; font-size: 0.82rem;
  }
  .ticket-meta-label { display: block; color: #6b7280; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .ticket-meta-value { display: block; font-weight: 600; color: #1d1d1f; }
  .type-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 0.72rem; font-weight: 700;
  }
  .type-badge-exec { background: #dcfce7; color: #166534; }
  .type-badge-watch { background: #f3f4f6; color: #6b7280; }

  /* ── Tickets page dark theme ────────────────────────────────── */
  .tk-page {
    --tk-bg: #0b1120; --tk-surface: #131b2e; --tk-border: #1e293b;
    --tk-text: #e2e8f0; --tk-muted: #64748b; --tk-accent: #3b82f6;
    --tk-green: #22c55e; --tk-red: #ef4444;
    --tk-mono: "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    color: var(--tk-text);
  }
  .tk-page .container { max-width: 520px; }
  .tk-card {
    background: var(--tk-surface); border: 1px solid var(--tk-border);
    border-radius: 12px; padding: 18px 20px; margin-bottom: 14px;
  }
  .tk-card-title {
    font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--tk-text); margin: 0 0 14px;
  }
  /* Summary grid */
  .tk-summary-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 16px 24px;
  }
  .tk-summary-item {}
  .tk-summary-label {
    display: flex; align-items: center; gap: 5px;
    font-size: 0.72rem; color: var(--tk-muted); margin-bottom: 2px;
  }
  .tk-summary-value {
    font-size: 1.35rem; font-weight: 700;
    font-family: var(--tk-mono); letter-spacing: -0.02em;
  }
  .tk-summary-value.pnl-pos { color: var(--tk-green); }
  .tk-summary-value.pnl-neg { color: var(--tk-red); }
  .tk-summary-value.pnl-zero { color: var(--tk-muted); }
  .tk-wr-sub { font-size: 0.78rem; color: var(--tk-muted); font-family: var(--tk-mono); }
  /* Section headers */
  .tk-section-hdr {
    display: flex; align-items: center; gap: 8px;
    font-size: 0.78rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--tk-text); margin: 22px 0 10px;
  }
  .tk-badge {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 22px; height: 22px; border-radius: 11px; padding: 0 7px;
    background: var(--tk-border); font-size: 0.72rem; font-weight: 700;
    color: var(--tk-text);
  }
  /* Ticket cards */
  .tk-ticket {
    background: var(--tk-surface); border: 1px solid var(--tk-border);
    border-radius: 12px; padding: 16px 18px; margin-bottom: 10px;
    transition: border-color .2s;
  }
  .tk-ticket:hover { border-color: #334155; }
  .tk-ticket.tk-highlight { border-color: var(--tk-accent); }
  .tk-q-link {
    color: var(--tk-text); text-decoration: none; font-weight: 700;
    font-size: 0.92rem; line-height: 1.4;
  }
  .tk-q-link:hover { color: var(--tk-accent); }
  .tk-ext-icon {
    display: inline-block; width: 12px; height: 12px; margin-left: 5px;
    vertical-align: middle; opacity: 0.5;
  }
  .tk-meta-row {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    margin: 8px 0 12px; font-size: 0.78rem; color: var(--tk-muted);
  }
  .tk-type-badge {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 2px 8px; border-radius: 6px;
    font-size: 0.7rem; font-weight: 700;
  }
  .tk-type-exec { background: rgba(34,197,94,.15); color: var(--tk-green); }
  .tk-type-watch { background: rgba(100,116,139,.18); color: var(--tk-muted); }
  .tk-price-grid {
    display: grid; grid-template-columns: repeat(4, 1fr);
    gap: 4px 8px; margin-bottom: 10px;
  }
  .tk-price-label {
    font-size: 0.62rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--tk-muted);
  }
  .tk-price-val {
    font-size: 0.95rem; font-weight: 700; font-family: var(--tk-mono);
    color: var(--tk-text);
  }
  /* Close form */
  .tk-close-form {
    border-top: 1px solid var(--tk-border); padding-top: 12px; margin-top: 10px;
  }
  .tk-close-input {
    width: 100%; padding: 10px 12px; border-radius: 8px;
    border: 1px solid var(--tk-border); background: #0f172a; color: var(--tk-text);
    font-size: 0.92rem; font-family: var(--tk-mono);
    margin-bottom: 4px;
  }
  .tk-close-input::placeholder { color: var(--tk-muted); }
  .tk-close-input:focus { outline: none; border-color: var(--tk-accent); }
  .tk-close-helper {
    font-size: 0.68rem; color: var(--tk-muted); margin: 0 0 8px; line-height: 1.4;
  }
  .tk-close-btn {
    width: 100%; padding: 10px; border-radius: 8px; border: none;
    background: var(--tk-accent); color: #fff; font-size: 0.88rem;
    font-weight: 700; cursor: pointer; transition: background .15s;
  }
  .tk-close-btn:hover { background: #2563eb; }
  .tk-close-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  /* Closed footer */
  .tk-closed-footer {
    display: flex; justify-content: space-between; align-items: baseline;
    border-top: 1px solid var(--tk-border); padding-top: 10px; margin-top: 10px;
    font-size: 0.82rem; color: var(--tk-muted);
  }
  .tk-pnl-badge {
    display: inline-block; padding: 3px 10px; border-radius: 6px;
    font-size: 0.78rem; font-weight: 700; font-family: var(--tk-mono);
    position: absolute; top: 16px; right: 18px;
  }
  .tk-pnl-pos { background: rgba(34,197,94,.15); color: var(--tk-green); }
  .tk-pnl-neg { background: rgba(239,68,68,.15); color: var(--tk-red); }
  .tk-pnl-zero { background: rgba(100,116,139,.18); color: var(--tk-muted); }
  .tk-pnl-pct { font-weight: 700; font-family: var(--tk-mono); }
  .tk-pnl-pct.pnl-pos { color: var(--tk-green); }
  .tk-pnl-pct.pnl-neg { color: var(--tk-red); }
  /* Equity chart */
  .tk-chart-msg { color: var(--tk-muted); font-size: 0.88rem; padding: 8px 0; }
  /* Misc */
  .tk-empty { color: var(--tk-muted); font-size: 0.88rem; }
  /* ── Watchlist page ────────────────────────────────────────────── */
  .wl-page {
    --wl-bg: #0b1120; --wl-surface: #141c2e; --wl-border: #1e293b;
    --wl-text: #e2e8f0; --wl-muted: #64748b; --wl-accent: #3b82f6;
    --wl-green: #22c55e; --wl-mono: 'SF Mono',SFMono-Regular,Menlo,Consolas,monospace;
    color: var(--wl-text); padding-bottom: 32px;
  }
  .wl-explainer {
    background: var(--wl-surface); border: 1px solid var(--wl-border);
    border-radius: 12px; padding: 14px 18px; margin-bottom: 16px;
    font-size: 0.88rem; color: var(--wl-muted); line-height: 1.5;
  }
  .wl-explainer strong { color: var(--wl-text); }
  .wl-section-hdr {
    font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em;
    color: var(--wl-muted); margin: 20px 0 10px; text-transform: uppercase;
  }
  .wl-badge {
    display: inline-block; background: var(--wl-accent); color: #fff;
    font-size: 0.68rem; border-radius: 8px; padding: 2px 8px;
    margin-left: 6px; vertical-align: middle;
  }
  .wl-card {
    background: var(--wl-surface); border: 1px solid var(--wl-border);
    border-radius: 12px; padding: 16px 18px; margin-bottom: 10px;
  }
  .wl-card.wl-highlight { border-color: var(--wl-accent); }
  .wl-title { margin-bottom: 8px; }
  .wl-title-link {
    color: var(--wl-text); text-decoration: none; font-weight: 600;
    font-size: 0.95rem; line-height: 1.35;
  }
  .wl-title-link:hover { text-decoration: underline; }
  a.wl-title-link { color: var(--wl-accent); }
  .wl-meta {
    font-size: 0.78rem; color: var(--wl-muted); margin-bottom: 6px;
  }
  .wl-tag {
    display: inline-block; background: rgba(59,130,246,.12); color: var(--wl-accent);
    font-size: 0.7rem; border-radius: 4px; padding: 1px 6px; margin-right: 4px;
  }
  .wl-time { font-size: 0.75rem; color: var(--wl-muted); margin-bottom: 6px; }
  .wl-why {
    font-size: 0.82rem; color: var(--wl-text); margin-bottom: 10px;
    line-height: 1.4;
  }
  .wl-open-btn {
    display: inline-block; padding: 9px 18px; border-radius: 8px;
    background: var(--wl-accent); color: #fff; font-size: 0.85rem;
    font-weight: 700; text-decoration: none; cursor: pointer;
    transition: background .15s;
  }
  .wl-open-btn:hover { background: #2563eb; }
</style>`;
}

/** Shared top navigation bar. */
function renderNav(active) {
  const links = [
    { href: "/trade", label: "Trade" },
    { href: "/explore", label: "Explore" },
    { href: "/watchlist", label: "Watchlist" },
    { href: "/tickets", label: "Tickets" },
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
    // Save ticket button
    var saveBtn = e.target.closest("[data-save-ticket]");
    if (saveBtn) {
      var payload = saveBtn.getAttribute("data-save-ticket");
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";
      fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (d.error) { saveBtn.textContent = "Error"; }
        else {
          saveBtn.textContent = "Saved ✓";
          saveBtn.style.background = "#dcfce7";
          saveBtn.style.color = "#166534";
          saveBtn.style.borderColor = "#bbf7d0";
          saveBtn.style.cursor = "pointer";
          saveBtn.disabled = false;
          saveBtn.removeAttribute("data-save-ticket");
          saveBtn.setAttribute("data-goto-ticket", d._id);
          if (d.tradeability === "WATCH") saveBtn.setAttribute("data-goto-watchlist", "1");
        }
      }).catch(function() { saveBtn.textContent = "Error"; saveBtn.disabled = false; });
      return;
    }
    // Navigate to tickets page on "Saved" click
    var gotoBtn = e.target.closest("[data-goto-ticket]");
    if (gotoBtn) {
      var tid = gotoBtn.getAttribute("data-goto-ticket");
      var dest = gotoBtn.hasAttribute("data-goto-watchlist") ? "/watchlist" : "/tickets";
      window.location.href = dest + "?highlight=" + encodeURIComponent(tid);
      return;
    }
  });
  // Tooltip hover for info icons
  document.querySelectorAll(".info-tooltip").forEach(function(el) {
    var tip = el.querySelector(".info-tooltip-text");
    if (!tip) return;
    el.addEventListener("mouseenter", function() { tip.style.display = "block"; });
    el.addEventListener("mouseleave", function() { tip.style.display = "none"; });
    el.addEventListener("click", function(ev) { ev.preventDefault(); tip.style.display = tip.style.display === "block" ? "none" : "block"; });
  });
  // --- Local-timezone formatting for all [data-utc] elements ---
  (function() {
    function formatLocalDateTime(value) {
      if (!value) return "\u2014";
      var d = (value instanceof Date) ? value : new Date(value);
      if (isNaN(d.getTime())) return "\u2014";
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(d);
    }
    document.querySelectorAll("[data-utc]").forEach(function(el) {
      el.textContent = formatLocalDateTime(el.getAttribute("data-utc"));
    });
    // Show timezone label if placeholder exists
    var tzEl = document.getElementById("tz-label");
    if (tzEl) {
      try { tzEl.textContent = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch(_) {}
    }
  })();
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
const MAX_TRADE_CAP_USD_DEFAULT = 50;  // absolute max position cap (matches SIZE_CAP)
const MIN_LIMIT_ORDER_USD = 5;         // minimum limit order size
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
  // OR logic matches signal_engine mispricing gate — either metric suffices
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
  const raw = Math.min(fromLiq, fromVol, MAX_TRADE_CAP_USD_DEFAULT);
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
  const { headline, subtext } = cardHeadline(item);
  const qText = safeQuestion(item);
  // For multi-outcome grouped markets, prefix the action with the outcome label
  // so the customer knows exactly which outcome to act on (e.g. "240-259 BUY YES")
  const outcomeLabel = (item.groupItemTitle || "").trim();
  const subtextHtml = subtext ? `<div style="font-size:0.78rem;color:#6b7280;margin-top:2px;">${escHtml(subtext)}</div>` : "";
  const questionHtml = link
    ? `<a href="${safeLink}" target="_blank" rel="noopener" class="trade-card-title">${escHtml(headline)}</a>${subtextHtml}`
    : `<span class="trade-card-title">${escHtml(headline)}</span>${subtextHtml}`;

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

    const savePayload = JSON.stringify({
      scanId: item.scanId || null,
      source: "TRADE_PAGE",
      marketId: item.conditionId || item.marketSlug || item.question,
      eventSlug: item.eventSlug || null,
      eventTitle: item.eventTitle || null,
      groupItemTitle: item.groupItemTitle || null,
      marketUrl: link || null,
      question: qText,
      tradeability: "EXECUTE",
      action: action === "BUY YES" ? "BUY_YES" : action === "BUY NO" ? "BUY_NO" : "WATCH",
      reasonCodes: item.reasonCodes || [],
      whyNow: whyNow,
      planTbd: false,
      entryLimit: entryNum,
      takeProfit: tpNum,
      riskExitLimit: stopNum,
      maxSizeUsd: sizeNum,
      bankrollUsd: null,
      riskPct: null,
      maxTradeCapUsd: null,
      minLimitOrderUsd: MIN_LIMIT_ORDER_USD,
      pnlTpUsd: Math.round(pnlTpUsd * 100) / 100,
      pnlTpPct: Math.round(pnlTpPct * 10) / 1000,
      pnlExitUsd: Math.round(pnlStopUsd * 100) / 100,
      pnlExitPct: Math.round(pnlStopPct * 10) / 1000,
    });

    return `
      <div class="trade-card" data-execute="1" data-entry-num="${entryNum}" data-heuristic-max="${sizeNum}" data-tp-num="${tpNum}" data-stop-num="${stopNum}" data-market="${escHtml(qText)}" data-action="${escHtml(action)}" data-outcome="${escHtml(outcomeLabel)}">
        <div class="trade-card-header">${questionHtml}</div>
        <div class="action-pill ${actionCls}">\u26A1 EXECUTE \u00B7 ${outcomeLabel ? escHtml(outcomeLabel) + " " : ""}${escHtml(action)}</div>
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
          <button class="cta-secondary save-ticket-btn" data-save-ticket="${escHtml(savePayload)}">Save ticket</button>
        </div>
        ${debugHtml}
      </div>
    `;
  }

  // --- WATCH card ---
  const watchReason = whyWatch || "Missing executable trade parameters";
  const watchNext = nextStep || "Entry, size, TP, or stop-loss could not be determined";

  const watchSavePayload = JSON.stringify({
    scanId: item.scanId || null,
    source: "TRADE_PAGE",
    marketId: item.conditionId || item.marketSlug || item.question,
    eventSlug: item.eventSlug || null,
    eventTitle: item.eventTitle || null,
    groupItemTitle: item.groupItemTitle || null,
    marketUrl: link || null,
    question: qText,
    tradeability: "WATCH",
    action: "WATCH",
    reasonCodes: item.reasonCodes || [],
    whyWatch: watchReason,
    nextStep: watchNext,
    planTbd: true,
    bankrollUsd: null,
    riskPct: null,
    maxTradeCapUsd: null,
    minLimitOrderUsd: MIN_LIMIT_ORDER_USD,
  });

  return `
    <div class="trade-card">
      <div class="trade-card-header">${questionHtml}</div>
      <div class="action-pill pill-watch">\uD83D\uDC41 WATCH${outcomeLabel ? " \u00B7 " + escHtml(outcomeLabel) : ""}</div>
      <div style="padding:8px 0;">
        <p style="margin:0 0 6px;font-size:0.88rem;"><strong>WHY WATCH:</strong> ${escHtml(watchReason)}</p>
        <p style="margin:0;font-size:0.85rem;color:#6b7280;"><strong>NEXT:</strong> ${escHtml(watchNext)}</p>
      </div>
      <div class="cta-row">
        <button class="cta-secondary save-ticket-btn" data-save-ticket="${escHtml(watchSavePayload)}">Save watch</button>
      </div>
      ${debugHtml}
    </div>
  `;
}

/** Render the compact status bar at top of /trade. */
function renderStatusBar(scanStatus, candidateCount, relaxedMode) {
  const lastScan = utcSpan(scanStatus.lastScanAt, "not yet");
  const nextScan = utcSpan(scanStatus.nextScanAt, "\u2014");
  const eventsScanned = scanStatus.lastEventsFetched || 0;
  const marketsScanned = scanStatus.lastMarketsFlattened || 0;

  return `
    <div class="status-bar">
      <div class="status-item"><span class="status-label">Last scan</span><span class="status-value">${lastScan}</span></div>
      <div class="status-item"><span class="status-label">Next scan</span><span class="status-value">${nextScan}</span></div>
      <div class="status-item"><span class="status-label">Universe</span><span class="status-value">${eventsScanned} events / ${marketsScanned} markets</span></div>
      <div class="status-item"><span class="status-label">Ready</span><span class="status-value" style="font-weight:700;">${candidateCount} candidates</span></div>
      <div class="status-item">
        <label class="status-label" for="risk-profile-select">Risk Profile</label>
        <select id="risk-profile-select" style="padding:3px 6px;border:1px solid #d1d5db;border-radius:6px;font-size:0.85rem;font-weight:600;">
          <option value="conservative">Conservative</option>
          <option value="default" selected>Default (Polyrich)</option>
          <option value="aggressive">Aggressive</option>
          <option value="very-aggressive">Very aggressive</option>
          <option value="custom">Custom</option>
        </select>
      </div>
      <div class="status-item">
        <label class="status-label" for="bankroll-input">Bankroll (USD) <small style="text-transform:none;letter-spacing:0;">(optional)</small></label>
        <input id="bankroll-input" type="number" min="0" step="1" placeholder="e.g. 1000"
          style="width:100px;padding:3px 6px;border:1px solid #d1d5db;border-radius:6px;font-size:0.85rem;font-weight:600;">
      </div>
      <div class="status-item">
        <label class="status-label" for="risk-pct-input">Risk per trade (%) <span id="risk-badge" style="display:inline-block;padding:1px 7px;border-radius:9px;font-size:0.7rem;font-weight:700;vertical-align:middle;margin-left:4px;background:#dcfce7;color:#166534;">Conservative (default)</span></label>
        <input id="risk-pct-input" type="number" min="0.1" max="100" step="0.1" placeholder="1"
          style="width:80px;padding:3px 6px;border:1px solid #d1d5db;border-radius:6px;font-size:0.85rem;font-weight:600;">
        <span style="display:block;font-size:0.68rem;color:#6b7280;margin-top:2px;">Default is 1.00%. Aggressive starts at 1.50%.</span>
      </div>
      <div class="status-item">
        <label class="status-label" for="max-cap-input">Max trade cap (USD) <span class="info-tooltip" style="position:relative;cursor:pointer;font-size:0.78rem;color:#6b7280;">ℹ️<span class="info-tooltip-text" style="display:none;position:absolute;bottom:120%;left:50%;transform:translateX(-50%);background:#1f2937;color:#fff;padding:8px 12px;border-radius:8px;font-size:0.78rem;white-space:normal;width:260px;z-index:10;font-weight:400;line-height:1.4;box-shadow:0 2px 8px rgba(0,0,0,.18);">LIMIT orders (recommended) require at least $5 per order. If computed max size is &lt; $5, cards will show WATCH.</span></span></label>
        <input id="max-cap-input" type="number" min="1" step="1" placeholder="50"
          style="width:80px;padding:3px 6px;border:1px solid #d1d5db;border-radius:6px;font-size:0.85rem;font-weight:600;">
      </div>

      <a href="/scan" class="cta-primary" style="padding:5px 14px;font-size:0.82rem;white-space:nowrap;">Refresh scan</a>
    </div>
    <div id="limit-order-warning" style="display:none;background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;padding:8px 14px;margin-bottom:8px;font-size:0.82rem;color:#991b1b;">
      ⚠️ Max trade cap must be at least $5 for limit orders.
      <button id="set-cap-5-btn" style="margin-left:8px;padding:3px 10px;border-radius:6px;border:1px solid #991b1b;background:#fff;color:#991b1b;font-weight:600;font-size:0.82rem;cursor:pointer;">Set cap to $5</button>
    </div>
  `;
}

/** Render the full /trade page body. */
function renderTradePage(scanStatus, tradeCandidates, relaxedMode) {
  const cards = tradeCandidates.slice(0, 20);
  const statusBar = renderStatusBar(scanStatus, cards.length, relaxedMode);

  // Split cards into EXECUTE vs WATCH at render time (presentation-only)
  const executeCards = [];
  const watchCards = [];
  for (const item of cards) {
    try {
      const dir = inferDirection(item);
      if (dir.action !== "WATCH") {
        const entryNum = inferEntry(item, dir.action);
        if (entryNum !== null) {
          const sizeNum = inferSize(item);
          const exits = inferExit(entryNum);
          if (sizeNum !== null && exits.tp !== null && exits.stop !== null) {
            executeCards.push(item);
            continue;
          }
        }
      }
      watchCards.push(item);
    } catch (_) {
      watchCards.push(item);
    }
  }

  const execSlice = executeCards.slice(0, 10);
  const watchSlice = watchCards.slice(0, 10);

  const execHtml = execSlice.length === 0
    ? '<p style="color:#6b7280;font-size:0.92rem;padding:12px 0;">No executable trades right now. Check WATCH list or run a new scan.</p>'
    : `<div class="trade-grid">${execSlice.map((item) => {
        try { return renderTradeCard(item); }
        catch (_) { return `<div class="trade-card"><p style="color:#b91c1c;">Render error: ${escHtml((item && item.marketSlug) || "unknown")}</p></div>`; }
      }).join("")}</div>`;

  const watchHtml = watchSlice.length === 0
    ? '<p style="color:#6b7280;font-size:0.92rem;padding:12px 0;">No watch items this scan.</p>'
    : `<div class="trade-grid">${watchSlice.map((item) => {
        try { return renderTradeCard(item); }
        catch (_) { return `<div class="trade-card"><p style="color:#b91c1c;">Render error: ${escHtml((item && item.marketSlug) || "unknown")}</p></div>`; }
      }).join("")}</div>`;

  const noDataHtml = cards.length === 0
    ? '<div class="card" style="text-align:center;padding:40px 20px;"><p style="font-size:1.1rem;color:#6b7280;">No candidates yet. Run a scan or wait for the next scheduled scan.</p><a href="/scan" class="cta-primary" style="margin-top:12px;display:inline-flex;">Run scan now</a></div>'
    : "";

  return `
    ${statusBar}
    ${noDataHtml}
    ${cards.length > 0 ? `
    <h2 style="margin:20px 0 12px;font-size:1.25rem;">Today: EXECUTE (${execSlice.length})</h2>
    ${execHtml}
    <details class="section-toggle" style="margin-top:20px;">
      <summary>Today: WATCH (${watchSlice.length})</summary>
      ${watchHtml}
    </details>
    ` : ""}
    <script>
    (function() {
      var RISK_PCT_DEF = ${RISK_PCT_DEFAULT};
      var MAX_CAP_DEF = ${MAX_TRADE_CAP_USD_DEFAULT};
      var MIN_ORDER = ${MIN_LIMIT_ORDER_USD};
      var KEY_BR = 'polyrich_bankroll_usd';
      var KEY_RISK = 'polyrich_risk_pct';
      var KEY_CAP = 'polyrich_max_trade_cap_usd';
      var KEY_PROFILE = 'polyrich_risk_profile';

      var PRESETS = {
        'conservative':      { riskPct: 0.5, cap: 10 },
        'default':           { riskPct: 1.0, cap: 50 },
        'aggressive':        { riskPct: 2.0, cap: 50 },
        'very-aggressive':   { riskPct: 5.0, cap: 50 }
      };

      var brInput = document.getElementById('bankroll-input');
      var riskInput = document.getElementById('risk-pct-input');
      var capInput = document.getElementById('max-cap-input');
      var profileSelect = document.getElementById('risk-profile-select');
      var badge = document.getElementById('risk-badge');
      var limitWarn = document.getElementById('limit-order-warning');
      var setCap5Btn = document.getElementById('set-cap-5-btn');
      if (!brInput || !riskInput || !capInput || !profileSelect) return;

      // Restore saved values
      var sBr = localStorage.getItem(KEY_BR);
      if (sBr) brInput.value = sBr;
      var sRisk = localStorage.getItem(KEY_RISK);
      riskInput.value = sRisk || '1';
      var sCap = localStorage.getItem(KEY_CAP);
      capInput.value = sCap || '50';
      var sProfile = localStorage.getItem(KEY_PROFILE);
      if (sProfile && profileSelect.querySelector('option[value="' + sProfile + '"]')) {
        profileSelect.value = sProfile;
      }

      function fmtPct(val, denom) {
        var p = val / denom * 100;
        return p.toFixed(2);
      }

      function updateBadge(riskDec) {
        if (!badge) return;
        if (riskDec <= 0.01) {
          badge.textContent = 'Conservative (default)';
          badge.style.background = '#dcfce7'; badge.style.color = '#166534';
        } else if (riskDec <= 0.015) {
          badge.textContent = 'Slightly aggressive (above default)';
          badge.style.background = '#fef9c3'; badge.style.color = '#854d0e';
        } else if (riskDec <= 0.05) {
          badge.textContent = 'Aggressive';
          badge.style.background = '#fde68a'; badge.style.color = '#92400e';
        } else {
          badge.textContent = 'Very aggressive \\u2014 high risk';
          badge.style.background = '#fee2e2'; badge.style.color = '#991b1b';
        }
      }

      function updateLimitWarning(capUsd) {
        if (capUsd < 5) {
          if (limitWarn) limitWarn.style.display = 'block';
        } else {
          if (limitWarn) limitWarn.style.display = 'none';
        }
      }

      // Profile dropdown handler
      profileSelect.addEventListener('change', function() {
        var preset = PRESETS[profileSelect.value];
        if (preset) {
          riskInput.value = String(preset.riskPct);
          capInput.value = String(preset.cap);
        }
        localStorage.setItem(KEY_PROFILE, profileSelect.value);
        updateCards();
      });

      // Manual edit switches to Custom
      function onManualEdit() {
        profileSelect.value = 'custom';
        localStorage.setItem(KEY_PROFILE, 'custom');
        updateCards();
      }

      if (setCap5Btn) {
        setCap5Btn.addEventListener('click', function() {
          capInput.value = '5';
          profileSelect.value = 'custom';
          localStorage.setItem(KEY_PROFILE, 'custom');
          updateCards();
        });
      }

      function updateCards() {
        var bankroll = parseFloat(brInput.value);
        var hasBankroll = !isNaN(bankroll) && bankroll > 0;
        if (hasBankroll) localStorage.setItem(KEY_BR, String(bankroll));
        else localStorage.removeItem(KEY_BR);

        var riskPctNum = parseFloat(riskInput.value);
        riskPctNum = Math.max(0.1, Math.min(100, isNaN(riskPctNum) ? 1 : riskPctNum));
        var riskDec = riskPctNum / 100;
        localStorage.setItem(KEY_RISK, String(riskPctNum));

        var capUsd = parseFloat(capInput.value);
        if (isNaN(capUsd) || capUsd <= 0) capUsd = MAX_CAP_DEF;
        localStorage.setItem(KEY_CAP, String(capUsd));
        localStorage.setItem(KEY_PROFILE, profileSelect.value);

        updateBadge(riskDec);
        updateLimitWarning(capUsd);

        var cards = document.querySelectorAll('[data-execute="1"]');
        for (var i = 0; i < cards.length; i++) {
          var card = cards[i];
          var hMax = parseFloat(card.getAttribute('data-heuristic-max'));
          var entry = parseFloat(card.getAttribute('data-entry-num'));
          var tp = parseFloat(card.getAttribute('data-tp-num'));
          var stop = parseFloat(card.getAttribute('data-stop-num'));
          var market = card.getAttribute('data-market') || '';
          var act = card.getAttribute('data-action') || '';
          var outcome = card.getAttribute('data-outcome') || '';
          if (isNaN(hMax) || isNaN(entry) || entry <= 0) continue;

          var maxSizeRaw;
          if (hasBankroll) {
            var riskBudget = bankroll * riskDec;
            maxSizeRaw = Math.min(capUsd, riskBudget, hMax);
          } else {
            maxSizeRaw = Math.min(capUsd, hMax);
          }
          var maxSizeDisplay = Math.round(maxSizeRaw * 100) / 100;

          // Min $5 gating — downgrade to WATCH per-card (uses raw, not rounded)
          if (maxSizeRaw < MIN_ORDER) {
            var pillEl = card.querySelector('.action-pill');
            if (pillEl) {
              pillEl.className = 'action-pill pill-watch';
              pillEl.innerHTML = '\\uD83D\\uDC41 WATCH' + (outcome ? ' \\u00B7 ' + outcome : '');
            }
            var planGrid = card.querySelector('.trade-plan-grid');
            if (planGrid) planGrid.style.display = 'none';
            var whyBlock = card.querySelector('.min-order-watch');
            if (!whyBlock) {
              whyBlock = document.createElement('div');
              whyBlock.className = 'min-order-watch';
              whyBlock.style.padding = '8px 0';
              var planGrid2 = card.querySelector('.trade-plan-grid');
              var ref = planGrid2 || card.querySelector('.action-pill');
              if (ref && ref.nextSibling) ref.parentNode.insertBefore(whyBlock, ref.nextSibling);
              else card.appendChild(whyBlock);
            }
            whyBlock.style.display = 'block';
            whyBlock.innerHTML = '<p style="margin:0 0 6px;font-size:0.88rem;"><strong>WHY WATCH:</strong> Max size $' + maxSizeDisplay.toFixed(2) + ' is below $' + MIN_ORDER + ' minimum limit order</p>' +
              '<p style="margin:0;font-size:0.85rem;color:#6b7280;"><strong>NEXT:</strong> Increase risk% or cap, or increase bankroll</p>';
            var noteEl = card.querySelector('.bankroll-note');
            if (noteEl) noteEl.style.display = 'none';
            // Update save-ticket to WATCH snapshot with context fields
            var saveBtn0 = card.querySelector('.save-ticket-btn');
            if (saveBtn0) {
              try {
                var base0 = JSON.parse(saveBtn0.getAttribute('data-save-ticket'));
                base0.tradeability = 'WATCH';
                base0.action = 'WATCH';
                base0.planTbd = true;
                base0.whyWatch = 'Max size $' + maxSizeDisplay.toFixed(2) + ' is below $' + MIN_ORDER + ' minimum limit order';
                base0.nextStep = 'Increase risk% or cap, or increase bankroll';
                base0.entryLimit = null; base0.takeProfit = null; base0.riskExitLimit = null;
                base0.maxSizeUsd = null; base0.pnlTpUsd = null; base0.pnlTpPct = null;
                base0.pnlExitUsd = null; base0.pnlExitPct = null;
                base0.bankrollUsd = hasBankroll ? bankroll : null;
                base0.riskPct = riskDec;
                base0.maxTradeCapUsd = capUsd;
                base0.minLimitOrderUsd = MIN_ORDER;
                saveBtn0.setAttribute('data-save-ticket', JSON.stringify(base0));
                saveBtn0.textContent = 'Save watch';
              } catch (_) {}
            }
            continue;
          }

          // Restore EXECUTE state if previously downgraded
          var pillEl2 = card.querySelector('.action-pill');
          if (pillEl2 && pillEl2.className.indexOf('pill-watch') !== -1) {
            pillEl2.className = 'action-pill pill-buy-yes';
            pillEl2.innerHTML = '\\u26A1 EXECUTE \\u00B7 ' + (outcome ? outcome + ' ' : '') + act;
          }
          var planGrid3 = card.querySelector('.trade-plan-grid');
          if (planGrid3) planGrid3.style.display = '';
          var whyBlock2 = card.querySelector('.min-order-watch');
          if (whyBlock2) whyBlock2.style.display = 'none';

          var sizeNote;
          if (hasBankroll) {
            var pctStr = fmtPct(maxSizeRaw, bankroll);
            sizeNote = '(' + pctStr + '% of bankroll)';
          } else {
            sizeNote = '(bankroll not set)';
          }

          var sizeEl = card.querySelector('.trade-size');
          if (sizeEl) sizeEl.innerHTML = '$' + maxSizeDisplay.toFixed(2) + ' <span class="size-note">' + sizeNote + '</span>';

          if (!isNaN(tp) && !isNaN(stop)) {
            var pTpU = maxSizeDisplay * (tp - entry) / entry;
            var pTpP = (tp - entry) / entry * 100;
            var pSlU = maxSizeDisplay * (stop - entry) / entry;
            var pSlP = (stop - entry) / entry * 100;
            var tpEl = card.querySelector('.trade-pnl-tp');
            if (tpEl) tpEl.textContent = '+$' + pTpU.toFixed(2) + ' (+' + pTpP.toFixed(1) + '% of stake)';
            var slEl = card.querySelector('.trade-pnl-stop');
            if (slEl) slEl.textContent = '-$' + Math.abs(pSlU).toFixed(2) + ' (' + pSlP.toFixed(1) + '% of stake)';
          }

          var noteEl2 = card.querySelector('.bankroll-note');
          if (noteEl2) noteEl2.style.display = hasBankroll ? 'none' : 'block';

          // Update save-ticket to match current display values + context fields
          var saveBtn1 = card.querySelector('.save-ticket-btn');
          if (saveBtn1) {
            try {
              var base1 = JSON.parse(saveBtn1.getAttribute('data-save-ticket'));
              base1.tradeability = 'EXECUTE';
              base1.action = act === 'BUY YES' ? 'BUY_YES' : act === 'BUY NO' ? 'BUY_NO' : 'WATCH';
              base1.planTbd = false;
              base1.maxSizeUsd = maxSizeDisplay;
              base1.bankrollUsd = hasBankroll ? bankroll : null;
              base1.riskPct = riskDec;
              base1.maxTradeCapUsd = capUsd;
              base1.minLimitOrderUsd = MIN_ORDER;
              delete base1.whyWatch; delete base1.nextStep;
              if (!isNaN(tp) && !isNaN(stop)) {
                var sTpU = maxSizeDisplay * (tp - entry) / entry;
                var sTpP = (tp - entry) / entry * 100;
                var sSlU = maxSizeDisplay * (stop - entry) / entry;
                var sSlP = (stop - entry) / entry * 100;
                base1.pnlTpUsd = Math.round(sTpU * 100) / 100;
                base1.pnlTpPct = Math.round(sTpP * 10) / 1000;
                base1.pnlExitUsd = Math.round(sSlU * 100) / 100;
                base1.pnlExitPct = Math.round(sSlP * 10) / 1000;
              }
              saveBtn1.setAttribute('data-save-ticket', JSON.stringify(base1));
              saveBtn1.textContent = 'Save ticket';
            } catch (_) {}
          }
        }

        // Update context fields on native WATCH cards (not data-execute="1")
        var allSaveBtns = document.querySelectorAll('.save-ticket-btn');
        for (var j = 0; j < allSaveBtns.length; j++) {
          var sb = allSaveBtns[j];
          var parentCard = sb.closest('.trade-card');
          if (parentCard && parentCard.getAttribute('data-execute') === '1') continue;
          try {
            var baseW = JSON.parse(sb.getAttribute('data-save-ticket'));
            baseW.bankrollUsd = hasBankroll ? bankroll : null;
            baseW.riskPct = riskDec;
            baseW.maxTradeCapUsd = capUsd;
            baseW.minLimitOrderUsd = MIN_ORDER;
            sb.setAttribute('data-save-ticket', JSON.stringify(baseW));
          } catch (_) {}
        }

        // Re-check saved state after payload updates
        if (typeof window.__polyrichMarkSaved === 'function') window.__polyrichMarkSaved();
      }

      brInput.addEventListener('input', updateCards);
      riskInput.addEventListener('input', onManualEdit);
      capInput.addEventListener('input', onManualEdit);
      updateCards();

      // ── Saved-state persistence ──────────────────────────────────
      // Fetch open tickets and mark cards whose dedupeKey already exists
      var openDedupeKeys = {};  // dedupeKey → ticketId
      var openWatchIds = {};    // ticketId → true for WATCH items

      function canon(v) {
        if (v === null || v === undefined) return 'null';
        if (typeof v === 'number') return Number(v).toString();
        return String(v).trim();
      }

      function computeDedupeKeyClient(data) {
        return [
          canon(data.marketId),
          canon(data.tradeability),
          canon(data.action),
          canon(data.entryLimit),
          canon(data.takeProfit),
          canon(data.riskExitLimit),
          canon(data.maxSizeUsd),
          canon(data.scanId)
        ].join('|');
      }

      async function sha1(str) {
        var buf = new TextEncoder().encode(str);
        var hash = await crypto.subtle.digest('SHA-1', buf);
        var arr = Array.from(new Uint8Array(hash));
        return arr.map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
      }

      async function markSavedCards() {
        var allBtns = document.querySelectorAll('.save-ticket-btn');
        var items = [];
        for (var k = 0; k < allBtns.length; k++) {
          var btn = allBtns[k];
          var raw = btn.getAttribute('data-save-ticket');
          if (!raw) continue;
          try {
            var payload = JSON.parse(raw);
            var keyStr = computeDedupeKeyClient(payload);
            items.push({ btn: btn, keyPromise: sha1(keyStr) });
          } catch (_) {}
        }
        var keys = await Promise.all(items.map(function(it) { return it.keyPromise; }));
        for (var m = 0; m < items.length; m++) {
          var key = keys[m];
          if (openDedupeKeys[key]) {
            var b = items[m].btn;
            var ticketId = openDedupeKeys[key];
            b.textContent = 'Saved \u2713';
            b.style.background = '#dcfce7';
            b.style.color = '#166534';
            b.style.borderColor = '#bbf7d0';
            b.style.cursor = 'pointer';
            b.disabled = false;
            b.removeAttribute('data-save-ticket');
            b.setAttribute('data-goto-ticket', ticketId);
            if (openWatchIds[ticketId]) b.setAttribute('data-goto-watchlist', '1');
          }
        }
      }

      // Expose markSavedCards for updateCards to call
      window.__polyrichMarkSaved = markSavedCards;

      fetch('/api/tickets?status=OPEN').then(function(r) {
        if (!r.ok) return [];
        return r.json();
      }).then(function(tickets) {
        if (!Array.isArray(tickets)) return;
        for (var t = 0; t < tickets.length; t++) {
          if (tickets[t].dedupeKey) {
            openDedupeKeys[tickets[t].dedupeKey] = String(tickets[t]._id);
            if (tickets[t].tradeability === 'WATCH') {
              openWatchIds[String(tickets[t]._id)] = true;
            }
          }
        }
        markSavedCards();
      }).catch(function() {});
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

  // Collect signal tags present on items for the signal tag filter.
  // Use item.reasonCodes (richest item-level tag array, includes near-expiry etc.)
  // with fallback to [item.signalType] when reasonCodes is absent.
  const allExploreItems = [...tradeCandidates, ...movers, ...mispricing];
  const signalTagsPresent = [...new Set(
    allExploreItems.flatMap((x) => {
      const codes = Array.isArray(x.reasonCodes) && x.reasonCodes.length > 0
        ? x.reasonCodes
        : (x.signalType ? [x.signalType] : []);
      return codes.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
    })
  )].sort();

  const hasCategories = categories.length > 0 || subcategories.length > 0;

  // Build explore-specific filter bar (Tradeability + Signal tag + existing cat/sub/tag filters)
  const tradeabilityActive = (filterActive || {}).tradeability || "";
  const signalTagActive = (filterActive || {}).signalTag || "";

  function filterOpts(values, selected) {
    return values.map((v) => {
      const sel = v === selected ? " selected" : "";
      return `<option value="${escHtml(v)}"${sel}>${escHtml(v)}</option>`;
    }).join("");
  }

  const exploreFilterHtml = `
    <form class="filter-bar" method="get" action="/explore">
      <label>Tradeability
        <select name="tradeability">
          <option value="">All</option>
          <option value="EXECUTE"${tradeabilityActive === "EXECUTE" ? " selected" : ""}>EXECUTE</option>
          <option value="WATCH"${tradeabilityActive === "WATCH" ? " selected" : ""}>WATCH</option>
        </select>
      </label>
      ${signalTagsPresent.length > 0 ? `<label>Signal tag
        <select name="signalTag">
          <option value="">All</option>
          ${filterOpts(signalTagsPresent, signalTagActive)}
        </select>
      </label>` : ""}
      ${categories.length > 0 ? `<label>Category
        <select name="cat">
          <option value="">All</option>
          ${filterOpts(categories, (filterActive || {}).cat || "")}
        </select>
      </label>` : ""}
      ${subcategories.length > 0 ? `<label>Subcategory
        <select name="sub">
          <option value="">All</option>
          ${filterOpts(subcategories, (filterActive || {}).sub || "")}
        </select>
      </label>` : ""}
      <label>Tag
        <select name="tag">
          <option value="">All</option>
          ${filterOpts(tagSlugsAll, (filterActive || {}).tag || "")}
        </select>
      </label>
      <button type="submit" class="cta-primary" style="padding:5px 14px;font-size:0.85rem;">Filter</button>
      <a href="/explore" style="color:#6b7280;font-size:0.82rem;text-decoration:none;">Reset</a>
    </form>
  `;

  // Tag legend
  const tagLegendHtml = `
    <details style="margin-bottom:16px;">
      <summary style="cursor:pointer;font-size:0.82rem;color:#6b7280;font-weight:600;">What do these mean?</summary>
      <div style="padding:8px 0;font-size:0.82rem;color:#374151;line-height:1.7;">
        <strong>breakout</strong>: recent sharp move with activity<br>
        <strong>momentum</strong>: sustained directional move<br>
        <strong>reversal</strong>: move suggests turning point<br>
        <strong>mispricing</strong>: eligible event/market inconsistency signal<br>
        <strong>near-expiry</strong>: resolves soon
      </div>
    </details>
  `;

  // Helper: compact plan preview for /explore candidate cards
  function explorePlanPreview(item) {
    const dir = inferDirection(item);
    if (dir.action !== "WATCH") {
      const entryNum = inferEntry(item, dir.action);
      if (entryNum !== null) {
        const sizeNum = inferSize(item);
        const exits = inferExit(entryNum);
        if (sizeNum !== null && exits.tp !== null && exits.stop !== null) {
          return `<div style="margin-top:8px;padding:8px 10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;font-size:0.78rem;">
            <span style="font-weight:700;color:#166534;">⚡ EXECUTE</span>
            <span style="margin-left:10px;"><span style="color:#6b7280;">ENTRY LIMIT</span> <strong>$${entryNum.toFixed(2)}</strong></span>
            <span style="margin-left:10px;"><span style="color:#6b7280;">TAKE PROFIT</span> <strong>$${exits.tp.toFixed(2)}</strong></span>
            <span style="margin-left:10px;"><span style="color:#6b7280;">RISK EXIT LIMIT</span> <strong>$${exits.stop.toFixed(2)}</strong></span>
          </div>`;
        }
      }
    }
    return '<div style="margin-top:8px;padding:6px 10px;background:#f3f4f6;border-radius:6px;font-size:0.78rem;color:#6b7280;"><span style="font-weight:600;">👁 WATCH</span> — Plan: TBD</div>';
  }

  // Wrap renderCandidate to add plan preview
  function renderCandidateWithPlan(item) {
    return renderCandidate(item) + explorePlanPreview(item);
  }

  // Render bucket section with plan previews
  function renderBucketSectionWithPlan(bucketName, items, totalCount, gateSummary) {
    const icons = { INTRADAY: "⏱️", THIS_WEEK: "📅", WATCH: "👀" };
    const labels = { INTRADAY: "Intraday (≤48 h)", THIS_WEEK: "This Week (≤168 h)", WATCH: "Watch (>168 h)" };
    const icon = icons[bucketName] || "📊";
    const label = labels[bucketName] || bucketName;

    const itemsHtml = items.length === 0
      ? '<p style="color:#6b7280;font-size:0.85rem;padding:8px 0;">No markets passed the gates this scan.</p>'
      : `<ol class="candidates">${items.map((item) => {
          try { return renderCandidateWithPlan(item); }
          catch (e) { return `<li class="candidate-card">render error: ${escHtml((item && item.marketSlug) || "unknown")} — ${escHtml(e.message)}</li>`; }
        }).join("")}</ol>`;

    return `
      <details class="section-toggle">
        <summary>${icon} ${escHtml(label)} <span class="badge-count">${totalCount}</span></summary>
        <p style="color:#6b7280;font-size:0.82rem;margin:0 0 8px;">Gates: ${escHtml(gateSummary)} · Showing top ${items.length} of ${totalCount}</p>
        ${itemsHtml}
      </details>
    `;
  }

  return `
    <h1>Explore Markets</h1>
    ${exploreFilterHtml}
    ${tagLegendHtml}
    ${buckets ? renderBucketSectionWithPlan("INTRADAY", data.filteredBuckets.INTRADAY, buckets.counts.INTRADAY, buckets.gates.INTRADAY) : ""}
    ${buckets ? renderBucketSectionWithPlan("THIS_WEEK", data.filteredBuckets.THIS_WEEK, buckets.counts.THIS_WEEK, buckets.gates.THIS_WEEK) : ""}
    ${buckets ? renderBucketSectionWithPlan("WATCH", data.filteredBuckets.WATCH.slice(0, 10), buckets.counts.WATCH, buckets.gates.WATCH) : ""}

    <details class="section-toggle">
      <summary>All trade candidates <span class="badge-count">${tradeCandidates.length}</span></summary>
      <ol class="candidates">
        ${tradeCandidates.map((item) => {
          try { return renderCandidateWithPlan(item); }
          catch (_) { return `<li class="candidate-card">render error: ${escHtml((item && item.marketSlug) || "unknown")}</li>`; }
        }).join("")}
      </ol>
    </details>

    ${movers.length === 0 && thresholds ? renderWhyNoMovers(thresholds, closestToThreshold) : ""}

    <details class="section-toggle">
      <summary>Movers <span class="badge-count">${movers.length}</span></summary>
      <ol class="candidates">
        ${movers.map((item) => {
          try { return renderCandidateWithPlan(item); }
          catch (_) { return `<li class="candidate-card">render error</li>`; }
        }).join("")}
      </ol>
    </details>

    <details class="section-toggle">
      <summary>Mispricing <span class="badge-count">${mispricing.length}</span></summary>
      <ol class="candidates">
        ${mispricing.map((item) => {
          try { return renderCandidateWithPlan(item); }
          catch (_) { return `<li class="candidate-card">render error</li>`; }
        }).join("")}
      </ol>
    </details>
  `;
}

/** Render the /system page body. */
function renderSystemPage(healthData, metrics) {
  return `
    <h1>System <span id="tz-label" style="font-size:0.55em;font-weight:400;color:#6b7280;"></span></h1>
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

/** Render the /watchlist page body. */
function renderWatchlistPage(items, highlightId) {
  const extIcon = '<svg style="width:12px;height:12px;vertical-align:middle;margin-left:4px;" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3"/><path d="M9 1h6v6"/><path d="M15 1L7 9"/></svg>';

  function watchCard(t) {
    const polyUrl = t.marketUrl || (t.eventSlug
      ? `https://polymarket.com/event/${encodeURIComponent(t.eventSlug)}`
      : null);
    const { headline, subtext } = cardHeadline(t);
    const subtextEl = subtext ? `<div style="font-size:0.78rem;color:#64748b;margin-top:2px;">${escHtml(subtext)}</div>` : "";
    const titleHtml = polyUrl
      ? `<a href="${escHtml(polyUrl)}" target="_blank" rel="noopener" class="wl-title-link">${escHtml(headline)} ${extIcon}</a>${subtextEl}`
      : `<span class="wl-title-link">${escHtml(headline)}</span>${subtextEl}`;

    // Metadata: category / subcategory / tags
    const metaParts = [];
    if (t.category) metaParts.push(escHtml(t.category));
    if (t.subcategory) metaParts.push(escHtml(t.subcategory));
    if (Array.isArray(t.reasonCodes) && t.reasonCodes.length) {
      metaParts.push(t.reasonCodes.map((r) => `<span class="wl-tag">${escHtml(r)}</span>`).join(" "));
    }
    const metaHtml = metaParts.length > 0
      ? `<div class="wl-meta">${metaParts.join(" · ")}</div>`
      : "";

    // Time left / created date
    const timeHtml = `<div class="wl-time">\u{1F552} Added ${utcSpan(t.createdAt)}</div>`;

    // Why watch
    const whyWatchText = t.whyWatch || t.nextStep || "";
    const whyHtml = whyWatchText
      ? `<div class="wl-why"><strong>WHY WATCH:</strong> ${escHtml(whyWatchText)}</div>`
      : "";

    // Open on Polymarket button
    const polyBtn = polyUrl
      ? `<a href="${escHtml(polyUrl)}" target="_blank" rel="noopener" class="wl-open-btn">Open on Polymarket ${extIcon}</a>`
      : "";

    const isHighlighted = highlightId && String(t._id) === highlightId;
    const hlCls = isHighlighted ? " wl-highlight" : "";

    return `
      <div class="wl-card${hlCls}" id="ticket-${escHtml(String(t._id))}">
        <div class="wl-title">${titleHtml}</div>
        ${metaHtml}
        ${timeHtml}
        ${whyHtml}
        ${polyBtn}
      </div>
    `;
  }

  const listHtml = items.length === 0
    ? '<p style="color:#64748b;text-align:center;padding:32px 0;">No watchlist items yet. Save a WATCH from the Trade page.</p>'
    : items.map((t) => watchCard(t)).join("");

  return `
    <div class="wl-page">
      <div class="wl-explainer">
        <p>\uD83D\uDC41 <strong>Watchlist</strong> is a shortlist of markets to monitor. It\u2019s not a trade journal.</p>
      </div>
      <div class="wl-section-hdr">WATCHLIST <span class="wl-badge">${items.length}</span></div>
      ${listHtml}
    </div>
    <script>
    (function() {
      var params = new URLSearchParams(window.location.search);
      var hl = params.get("highlight");
      if (hl) {
        var el = document.getElementById("ticket-" + hl);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.style.borderColor = "#3b82f6";
          el.style.transition = "border-color 2s ease";
          setTimeout(function() { el.style.borderColor = ""; }, 3000);
        }
      }
      document.body.style.background = "#0b1120";
    })();
    </script>
  `;
}

/** Render the /tickets page body. */
function renderTicketsPage(tickets, highlightId) {
  const openTickets = tickets.filter((t) => t.status === "OPEN");
  const closedTickets = tickets.filter((t) => t.status === "CLOSED");
  const openCount = openTickets.length;
  const closedCount = closedTickets.length;
  const closedWithPnl = closedTickets.filter((t) => typeof t.realizedPnlUsd === "number");
  const realizedPnlSumUsd = closedWithPnl.reduce((s, t) => s + t.realizedPnlUsd, 0);
  const wins = closedWithPnl.filter((t) => t.realizedPnlUsd > 0).length;
  const winRate = closedWithPnl.length > 0 ? (wins / closedWithPnl.length * 100) : 0;

  function pnlCls(val) {
    if (typeof val !== "number") return "pnl-zero";
    return val > 0 ? "pnl-pos" : val < 0 ? "pnl-neg" : "pnl-zero";
  }

  const extIcon = '<svg class="tk-ext-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3"/><path d="M9 1h6v6"/><path d="M15 1L7 9"/></svg>';

  // --- Equity chart ---
  const MIN_CLOSED_FOR_CHART = 2;
  let equityChartHtml;
  if (closedWithPnl.length < MIN_CLOSED_FOR_CHART) {
    equityChartHtml = `<div class="tk-card">
      <p class="tk-card-title">Equity Curve</p>
      <p class="tk-chart-msg">Equity curve will appear after at least 2 tickets are closed.</p>
    </div>`;
  } else {
    const sorted = closedWithPnl.slice().sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
    let cumPnl = 0;
    const points = [{ rawDate: sorted[0].closedAt, pnl: 0 }];
    sorted.forEach((t) => {
      cumPnl += t.realizedPnlUsd;
      points.push({ rawDate: t.closedAt, pnl: Math.round(cumPnl * 100) / 100 });
    });
    const maxVal = Math.max(...points.map((p) => p.pnl));
    const minVal = Math.min(...points.map((p) => p.pnl), 0);
    const range = maxVal - minVal || 1;
    const chartW = 400;
    const chartH = 160;
    const padL = 40;
    const padR = 10;
    const padT = 10;
    const padB = 28;
    const plotW = chartW - padL - padR;
    const plotH = chartH - padT - padB;
    const xOf = (i) => padL + (i / (points.length - 1)) * plotW;
    const yOf = (v) => padT + plotH - ((v - minVal) / range) * plotH;
    const linePoints = points.map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.pnl).toFixed(1)}`).join(" ");
    const areaPoints = linePoints + ` ${xOf(points.length - 1).toFixed(1)},${yOf(0).toFixed(1)} ${xOf(0).toFixed(1)},${yOf(0).toFixed(1)}`;
    const strokeColor = cumPnl >= 0 ? "#22c55e" : "#ef4444";
    const fillColor = cumPnl >= 0 ? "rgba(34,197,94,.12)" : "rgba(239,68,68,.12)";

    // Y-axis ticks (4-5 values)
    const niceStep = Math.pow(10, Math.floor(Math.log10(range))) || 1;
    let step = niceStep;
    if (range / step < 3) step = niceStep / 2;
    if (range / step > 6) step = niceStep * 2;
    const yTicks = [];
    for (let v = Math.floor(minVal / step) * step; v <= maxVal + step * 0.01; v += step) {
      yTicks.push(Math.round(v * 100) / 100);
    }

    // X-axis labels
    const xLabels = [];
    const labelIdxs = [0, Math.floor(points.length / 3), Math.floor(2 * points.length / 3), points.length - 1];
    const seen = new Set();
    labelIdxs.forEach((idx) => { if (!seen.has(idx)) { seen.add(idx); xLabels.push(idx); } });

    const yGridLines = yTicks.map((v) =>
      `<line x1="${padL}" y1="${yOf(v).toFixed(1)}" x2="${chartW - padR}" y2="${yOf(v).toFixed(1)}" stroke="#1e293b" stroke-width="0.5"/>`
    ).join("");
    const yLabels = yTicks.map((v) =>
      `<text x="${padL - 6}" y="${yOf(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle" fill="#64748b" font-size="10" font-family="SF Mono,SFMono-Regular,Menlo,Consolas,monospace">$${v}</text>`
    ).join("");
    const xLabelEls = xLabels.map((idx) => {
      const p = points[idx];
      const d = p.rawDate ? new Date(p.rawDate) : null;
      const label = idx === 0 ? "Start" : (d ? `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.` : "");
      return `<text x="${xOf(idx).toFixed(1)}" y="${chartH - 6}" text-anchor="middle" fill="#64748b" font-size="10" font-family="SF Mono,SFMono-Regular,Menlo,Consolas,monospace">${escHtml(label)}</text>`;
    }).join("");

    equityChartHtml = `<div class="tk-card">
      <p class="tk-card-title">Equity Curve</p>
      <svg viewBox="0 0 ${chartW} ${chartH}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block;">
        ${yGridLines}
        ${yLabels}
        <polygon points="${areaPoints}" fill="${fillColor}" />
        <polyline points="${linePoints}" fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        ${xLabelEls}
      </svg>
    </div>`;
  }

  // --- Summary card ---
  const pnlSign = realizedPnlSumUsd >= 0 ? "+" : "";
  const summaryHtml = `
    <div class="tk-card">
      <p class="tk-card-title">Portfolio Overview</p>
      <div class="tk-summary-grid">
        <div class="tk-summary-item">
          <div class="tk-summary-label"><span>\u{1F4CA}</span> Open</div>
          <div class="tk-summary-value">${openCount}</div>
        </div>
        <div class="tk-summary-item">
          <div class="tk-summary-label"><span>\u{2705}</span> Closed</div>
          <div class="tk-summary-value">${closedCount}</div>
        </div>
        <div class="tk-summary-item">
          <div class="tk-summary-label"><span>\u{1F4C8}</span> Realized PnL</div>
          <div class="tk-summary-value ${pnlCls(realizedPnlSumUsd)}">${pnlSign}$${realizedPnlSumUsd.toFixed(2)}</div>
        </div>
        <div class="tk-summary-item">
          <div class="tk-summary-label"><span>\u{1F3AF}</span> Win rate</div>
          <div class="tk-summary-value">${winRate.toFixed(1)}% <span class="tk-wr-sub">(${wins}/${closedWithPnl.length})</span></div>
        </div>
      </div>
    </div>
  `;

  // --- Ticket card renderer ---
  function ticketCard(t, showClose) {
    const isExec = t.tradeability === "EXECUTE";
    const typeBadge = isExec
      ? '<span class="tk-type-badge tk-type-exec">\u26A1 EXEC</span>'
      : '<span class="tk-type-badge tk-type-watch">\uD83D\uDC41 WATCH</span>';
    const actionLabel = t.action || "\u2014";
    const ticketOutcome = (t.groupItemTitle || "").trim();
    const actionDisplay = ticketOutcome
      ? ticketOutcome + " " + actionLabel
      : actionLabel;
    const entry = typeof t.entryLimit === "number" ? "$" + t.entryLimit.toFixed(2) : "\u2014";
    const size = typeof t.maxSizeUsd === "number" ? "$" + t.maxSizeUsd.toFixed(2) : "\u2014";
    const tp = typeof t.takeProfit === "number" ? "$" + t.takeProfit.toFixed(2) : "\u2014";
    const sl = typeof t.riskExitLimit === "number" ? "$" + t.riskExitLimit.toFixed(2) : "\u2014";
    const polyUrl = t.marketUrl || (t.eventSlug
      ? `https://polymarket.com/event/${encodeURIComponent(t.eventSlug)}`
      : null);
    const { headline: ticketHeadline, subtext: ticketSubtext } = cardHeadline(t);
    const subtextEl = ticketSubtext ? `<div style="font-size:0.78rem;color:#64748b;margin-top:2px;">${escHtml(ticketSubtext)}</div>` : "";
    const questionLink = polyUrl
      ? `<a href="${escHtml(polyUrl)}" target="_blank" rel="noopener" class="tk-q-link">${escHtml(ticketHeadline)} ${extIcon}</a>${subtextEl}`
      : `<span class="tk-q-link">${escHtml(ticketHeadline)}</span>${subtextEl}`;
    const isHighlighted = highlightId && String(t._id) === highlightId;
    const hlCls = isHighlighted ? " tk-highlight" : "";

    // PnL badge for closed tickets (top-right)
    let pnlBadgeHtml = "";
    if (!showClose && typeof t.realizedPnlUsd === "number") {
      const sign = t.realizedPnlUsd >= 0 ? "+" : "";
      const cls = t.realizedPnlUsd > 0 ? "tk-pnl-pos" : t.realizedPnlUsd < 0 ? "tk-pnl-neg" : "tk-pnl-zero";
      pnlBadgeHtml = `<span class="tk-pnl-badge ${cls}">${sign}$${t.realizedPnlUsd.toFixed(2)}</span>`;
    }

    const closeHtml = showClose ? `
      <div class="tk-close-form">
        <input type="number" step="0.01" min="0" inputmode="decimal" placeholder="Close price" class="tk-close-input close-price-input" data-ticket-id="${escHtml(String(t._id))}" aria-label="Close price">
        <p class="tk-close-helper">Enter close price (0\u20131 or 0\u2013100 cents). Example: 0.41 or 41.</p>
        <button class="tk-close-btn close-ticket-btn" data-ticket-id="${escHtml(String(t._id))}">Close</button>
      </div>
    ` : "";

    // Closed footer
    let closedFooterHtml = "";
    if (!showClose) {
      const cpLabel = typeof t.closePrice === "number" ? "$" + t.closePrice.toFixed(2) : "\u2014";
      const pctLabel = typeof t.realizedPnlPct === "number"
        ? `<span class="tk-pnl-pct ${pnlCls(t.realizedPnlPct)}">${t.realizedPnlPct >= 0 ? "+" : ""}${(t.realizedPnlPct * 100).toFixed(1)}%</span>`
        : "";
      closedFooterHtml = `
        <div class="tk-closed-footer">
          <span>Closed: ${cpLabel}</span>
          ${pctLabel}
        </div>
      `;
    }

    return `
      <div class="tk-ticket${hlCls}" id="ticket-${escHtml(String(t._id))}" style="position:relative;">
        <div style="margin-bottom:6px;padding-right:${pnlBadgeHtml ? "80px" : "0"};">${questionLink}</div>
        ${pnlBadgeHtml}
        <div class="tk-meta-row">
          ${typeBadge}
          <span>${escHtml(actionDisplay)}</span>
          <span>\u{1F552} ${utcSpan(t.createdAt)}</span>
        </div>
        <div class="tk-price-grid">
          <div><span class="tk-price-label">Entry</span><div class="tk-price-val">${entry}</div></div>
          <div><span class="tk-price-label">TP</span><div class="tk-price-val">${tp}</div></div>
          <div><span class="tk-price-label">Exit (risk)</span><div class="tk-price-val">${sl}</div></div>
          <div><span class="tk-price-label">Size (USD)</span><div class="tk-price-val">${size}</div></div>
        </div>
        ${closeHtml}
        ${closedFooterHtml}
      </div>
    `;
  }

  const openListHtml = openTickets.length === 0
    ? '<p class="tk-empty">No open tickets.</p>'
    : openTickets.map((t) => ticketCard(t, true)).join("");

  const closedListHtml = closedTickets.length === 0
    ? '<p class="tk-empty">No closed tickets yet.</p>'
    : closedTickets.map((t) => ticketCard(t, false)).join("");

  return `
    <div class="tk-page">
      ${summaryHtml}
      ${equityChartHtml}
      <div class="tk-section-hdr">OPEN <span class="tk-badge">${openCount}</span></div>
      ${openListHtml}
      <div class="tk-section-hdr">CLOSED <span class="tk-badge">${closedCount}</span></div>
      ${closedListHtml}
    </div>
    <script>
    (function() {
      document.addEventListener("click", function(e) {
        var btn = e.target.closest(".close-ticket-btn");
        if (!btn) return;
        var ticketId = btn.getAttribute("data-ticket-id");
        var input = document.querySelector('.close-price-input[data-ticket-id="' + ticketId + '"]');
        if (!input) return;
        var closePrice = parseFloat(input.value);
        if (isNaN(closePrice) || closePrice <= 0) { alert("Enter a valid close price"); return; }
        btn.disabled = true;
        btn.textContent = "Closing\u2026";
        fetch("/api/tickets/close", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticketId: ticketId, closePrice: closePrice }),
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (d.error) { btn.textContent = "Error"; btn.disabled = false; alert(d.error); }
          else { location.reload(); }
        }).catch(function() { btn.textContent = "Error"; btn.disabled = false; });
      });
      // Scroll to highlighted ticket
      var params = new URLSearchParams(window.location.search);
      var hl = params.get("highlight");
      if (hl) {
        var el = document.getElementById("ticket-" + hl);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.style.borderColor = "#3b82f6";
          el.style.transition = "border-color 2s ease";
          setTimeout(function() { el.style.borderColor = ""; }, 3000);
        }
      }
      // Apply dark bg to body on tickets page
      document.body.style.background = "#0b1120";
    })();
    </script>
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
  renderTicketsPage,
  renderWatchlistPage,
  pageShell,
  inferDirection,
  inferEntry,
  inferSize,
  inferExit,
  polymarketUrl,
  safeQuestion,
  cardHeadline,
  isInvalidDisplayLabel,
  slugToLabel,
  marketDisplayLabel,
};
