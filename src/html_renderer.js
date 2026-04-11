"use strict";

const { formatHoursLeft, formatVolume } = require("./normalizer");
const config = require("./config");

// ---------------------------------------------------------------------------
// Canonical diagnostic reasons — operator-facing copywriting
// ---------------------------------------------------------------------------
const DIAGNOSTIC_REASONS = {
  MISSING_TOKEN_ID: {
    label: "Token ID missing",
    explanation: "This ticket was created before CLOB token IDs were stored. Auto-close is disabled for safety.",
    whatToDo: "Create a new ticket (or re-save) so token IDs are captured.",
    queryParam: "blockedReason",
  },
  NO_ORDERBOOK: {
    label: "CLOB 404 (no book)",
    explanation: "CLOB returned 404 for this token. There is no orderbook to close against.",
    whatToDo: "Ignore it, disable auto-close, or choose a different market.",
    queryParam: "blockedReason",
  },
  NO_BIDS: {
    label: "No bids",
    explanation: "There are no bids at the top of the book, so you cannot sell to close.",
    whatToDo: "Wait for liquidity or close manually when bids appear.",
    queryParam: "monitorReason",
  },
  INVALID_TOP_BID: {
    label: "Invalid top bid",
    explanation: "The top bid on the orderbook is invalid or unparseable.",
    whatToDo: "Wait for a valid bid or close manually.",
    queryParam: "monitorReason",
  },
  IDENTITY_SKIP: {
    label: "Identity skip",
    explanation: "This ticket lacks a valid conditionId (0x…). The monitor skips it as a fail-closed safety measure.",
    whatToDo: "Re-save the ticket from a market with a valid conditionId, or close manually.",
    queryParam: "monitorReason",
  },
  SETTLED: {
    label: "Settled markets",
    explanation: "The market outcome has been resolved/settled.",
    whatToDo: "Close the ticket manually at the settled outcome price, or wait for auto-close if enabled.",
    queryParam: "monitorReason",
  },
  ENDED: {
    label: "Ended markets",
    explanation: "The market end date has passed or the market is no longer active.",
    whatToDo: "Close the ticket manually, or wait for settlement.",
    queryParam: "monitorReason",
  },
  INSUFFICIENT_BID_SIZE: {
    label: "Insufficient bid size",
    explanation: "Top-of-book bid notional (USD) at entry was below MIN_BID_SIZE_USD. Not enough close-side liquidity.",
    whatToDo: "Wait for deeper bids or close manually. Reduce MIN_BID_SIZE_USD if comfortable.",
    queryParam: "blockedReason",
  },
  MISSING_ENTRY_EXEC_PRICES: {
    label: "Missing entry microstructure",
    explanation: "This ticket was created before entry bid/ask were persisted. Auto-close is disabled because TP/SL cannot be verified as bid-based.",
    whatToDo: "Create a new ticket so entry microstructure is captured, or close manually.",
    queryParam: "blockedReason",
  },
  NO_EXECUTABLE_BID: {
    label: "No executable bid",
    explanation: "The CLOB orderbook did not return a valid executable bid (finite, > 0, < 1). The ticket cannot be auto-closed without a real bid to sell into.",
    whatToDo: "Wait for a valid bid to appear, or close manually.",
    queryParam: "monitorReason",
  },
  SPREAD_TOO_WIDE: {
    label: "Spread too wide (warning)",
    explanation: "The entry spread exceeded the advisory threshold. This is a warning — the ticket is saved but auto-close may be blocked.",
    whatToDo: "Review the market manually. The wide spread suggests low liquidity.",
    queryParam: "blockedReason",
  },
};

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
    item.spreadPct > config.MAX_ENTRY_SPREAD_PCT ||
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
  // Expand abbreviated O/U labels (e.g. "O/U 2.5" → "Over/Under 2.5") for clarity.
  let groupTitle = (item.groupItemTitle || "").trim();
  const ouMatch = OU_PATTERN.exec(groupTitle);
  if (ouMatch) groupTitle = `Over/Under ${ouMatch[1]}`;

  // When groupItemTitle is empty, derive a fallback from the first non-generic
  // outcome name (e.g. "MIN" for a sports moneyline).  Used only in branches
  // where the subtext would otherwise be blank.
  let firstOutcomeFallback = "";
  if (!groupTitle) {
    const outcomesList = Array.isArray(item.outcomes) ? item.outcomes : [];
    const firstOutcome = (outcomesList[0] || "").trim();
    if (firstOutcome && !GENERIC_OUTCOMES.has(firstOutcome.toLowerCase())) {
      firstOutcomeFallback = firstOutcome;
    }
  }

  if (validEvent && validMkt && eventTitle !== mktLabel) {
    // Event title as headline; use groupItemTitle when available instead of verbose token question
    const sub = groupTitle || mktLabel;
    return { headline: eventTitle, subtext: sub };
  }
  if (validEvent && !validMkt) {
    // No usable market label — show groupItemTitle or outcome fallback
    return { headline: eventTitle, subtext: groupTitle || firstOutcomeFallback };
  }
  if (validMkt) {
    // Use groupTitle / outcome fallback as subtext when headline equals the market label
    // (e.g. sports moneylines where eventTitle and question both resolve to "Wild vs Stars")
    const sub = (validEvent && eventTitle !== mktLabel) ? eventTitle : (groupTitle || firstOutcomeFallback);
    return { headline: mktLabel, subtext: sub };
  }
  return { headline: "Market detail unavailable", subtext: "" };
}

/** Compact "Top Pick" card for micro-trade action list */
function renderTopPick(item) {
  const link = polymarketUrl(item);
  const qText = safeQuestion(item);
  const questionHtml = link
    ? `<a href="${escHtml(link)}" target="_blank" rel="noopener" style="color:#60a5fa;text-decoration:none;font-weight:600;">${escHtml(qText)}</a>`
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
        <p style="margin:0 0 4px;font-weight:600;font-size:0.82rem;color:#e2e8f0;">Why this is a pick</p>
        <ul style="margin:0;padding-left:18px;font-size:0.82rem;color:#cbd5e1;">
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
      <div style="margin:8px 0;padding:8px 12px;border-radius:8px;background:rgba(37,99,235,.15);font-size:0.88rem;color:#60a5fa;">
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
      <p style="font-size:0.95rem;font-weight:600;margin-top:10px;padding:8px 12px;border-radius:8px;background:rgba(22,101,52,.2);color:#22c55e;">${recommendation}</p>
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
      <h2 style="margin-top:0;font-size:1rem;color:#eab308;">Why no movers?</h2>
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
          <tr style="border-bottom:1px solid #1e293b;">
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
    <p style="font-size:0.8rem;color:#6b7280;margin-top:12px;">Raw JSON: <a href="/health" style="color:#60a5fa;">/health</a></p>
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
    ${metrics.lastError ? `<div class="card" style="border-left:4px solid #dc2626;"><p style="color:#ef4444;"><strong>Last error:</strong> ${escHtml(metrics.lastError)}</p></div>` : ""}
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
          <tr style="border-bottom:1px solid #1e293b;">
            <th style="padding:4px 8px;text-align:left;font-size:0.78rem;color:#6b7280;">Scan ID</th>
            <th style="padding:4px 8px;text-align:right;font-size:0.78rem;color:#6b7280;">Duration</th>
          </tr>
        </thead>
        <tbody>${scanRows}</tbody>
      </table>
    </div>
    <p style="font-size:0.8rem;color:#6b7280;margin-top:12px;">Raw JSON: <a href="/metrics" style="color:#60a5fa;">/metrics</a></p>
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
    ? `<a href="${escHtml(link)}" target="_blank" rel="noopener" style="color:#60a5fa;text-decoration:none;font-weight:600;flex:1;font-size:0.95rem;line-height:1.3;">${escHtml(qText)}</a>`
    : `<strong style="flex:1;font-size:0.95rem;line-height:1.3;">${escHtml(qText)}</strong>`;
  const whyBullets = computeWhyPick(item);
  const trade = computeTradeability(item);
  const safeLink = link ? escHtml(link) : "";

  return `
    <li class="candidate-card">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
        ${questionHtml}
        <span style="margin-left:12px;font-size:1.1rem;font-weight:700;color:#e2e8f0;white-space:nowrap;">${item.signalScore2.toFixed(1)}</span>
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
        <p style="margin:0 0 4px;font-weight:600;font-size:0.82rem;color:#e2e8f0;">Why this is a pick</p>
        <ul style="margin:0;padding-left:18px;font-size:0.82rem;color:#cbd5e1;">
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
    background: #0b1120; color: #e2e8f0; line-height: 1.5;
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
  h2 { font-size: 1.15rem; font-weight: 600; margin: 24px 0 10px; color: #e2e8f0; }
  .card {
    background: #131b2e; border: 1px solid #1e293b; border-radius: 12px; padding: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,.2); margin-bottom: 16px;
  }
  .card p { margin: 4px 0; font-size: 0.88rem; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; }
  .nav-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px;
  }
  .nav-card {
    display: flex; align-items: center; justify-content: center;
    background: #131b2e; border: 1px solid #1e293b; border-radius: 12px; padding: 20px 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,.2); text-decoration: none;
    color: #e2e8f0; font-weight: 600; font-size: 0.95rem;
    transition: box-shadow .15s, transform .15s;
  }
  .nav-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,.3); transform: translateY(-2px); }
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
    background: #131b2e; border: 1px solid #1e293b; border-radius: 10px; padding: 14px 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,.2); margin-bottom: 10px;
    overflow: hidden;
  }
  .candidate-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 2px 12px; font-size: 0.78rem;
  }
  .candidate-grid .label { color: #6b7280; margin-right: 4px; }
  .candidate-grid .val { font-weight: 500; color: #e2e8f0; }
  .candidate-grid .val.bold { font-weight: 700; }
  .breakdown {
    font-family: "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.72rem; background: #0f172a; padding: 8px 10px;
    border-radius: 6px; margin: 6px 0 0; white-space: pre-wrap;
    line-height: 1.6; color: #94a3b8;
  }
  .section-toggle { width: 100%; }
  .section-toggle summary {
    cursor: pointer; list-style: none; padding: 12px 16px;
    background: #131b2e; border: 1px solid #1e293b; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.2);
    font-weight: 600; font-size: 1rem; margin-bottom: 8px;
    display: flex; align-items: center; gap: 8px;
  }
  .section-toggle summary::before { content: "▸"; transition: transform .15s; }
  .section-toggle[open] summary::before { transform: rotate(90deg); }
  .section-toggle summary::-webkit-details-marker { display: none; }
  .badge-count {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 22px; height: 22px; border-radius: 11px;
    background: #e5e7eb; color: #0b1120; font-size: 0.75rem; font-weight: 600; padding: 0 6px;
  }
  .snapshot-item {
    background: #131b2e; border: 1px solid #1e293b; border-radius: 10px; padding: 14px 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,.2); margin-bottom: 10px;
  }
  .snapshot-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 2px 12px; font-size: 0.82rem; margin-top: 6px;
  }
  .snapshot-grid .label { color: #6b7280; margin-right: 4px; }
  .snapshot-grid .val { font-weight: 500; }
  .error-banner {
    background: rgba(127,29,29,.3); border: 1px solid #7f1d1d; border-radius: 10px;
    padding: 12px 16px; color: #fecaca; font-weight: 600; margin-bottom: 16px;
  }
  .info-banner {
    background: rgba(133,77,14,.2); border: 1px solid #854d0e; border-radius: 10px;
    padding: 10px 16px; color: #fef3c7; font-size: 0.88rem; margin-bottom: 16px;
  }
  .why-pick-card {
    background: rgba(22,101,52,.15); border: 1px solid rgba(34,197,94,.2); border-radius: 8px;
    padding: 10px 14px; margin-top: 8px;
  }
  .tradeability-ok { color: #22c55e; }
  .tradeability-watch { color: #eab308; }
  .tradeability-excluded { color: #ef4444; }
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
    background: #1e293b; color: #60a5fa; border: 1px solid #334155; cursor: pointer;
    transition: background .15s;
  }
  .cta-secondary:hover { background: #334155; }
  .cat-badge {
    display: inline-block; padding: 1px 6px; border-radius: 3px;
    background: rgba(37,99,235,.15); color: #60a5fa; font-size: 0.7rem;
    border: 1px solid rgba(37,99,235,.3); margin-left: 3px;
  }
  .cat-badge.sub { background: rgba(234,179,8,.15); color: #eab308; border-color: rgba(234,179,8,.3); }
  .filter-bar {
    display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px;
    align-items: center; font-size: 0.85rem;
  }
  .filter-bar select, .filter-bar input {
    padding: 5px 10px; border-radius: 6px; border: 1px solid #334155;
    font-size: 0.85rem; background: #0f172a; color: #e2e8f0;
  }

  /* Trade page styles */
  .status-bar {
    display: flex; flex-wrap: wrap; gap: 12px 20px; align-items: center;
    background: #131b2e; border: 1px solid #1e293b; border-radius: 12px; padding: 14px 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,.2); margin-bottom: 8px;
  }
  .status-item { display: flex; flex-direction: column; font-size: 0.82rem; }
  .status-label { color: #64748b; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .status-value { font-weight: 600; color: #e2e8f0; }
  .mode-normal { color: #059669; }
  .mode-relaxed { color: #d97706; }

  .trade-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 16px;
  }
  @media (max-width: 700px) {
    .trade-grid { grid-template-columns: 1fr; }
  }

  .trade-card {
    background: #131b2e; border: 1px solid #1e293b; border-radius: 12px; padding: 20px;
    box-shadow: 0 1px 4px rgba(0,0,0,.2);
  }
  .trade-card-header { margin-bottom: 10px; }
  .trade-card-title {
    font-weight: 700; font-size: 0.95rem; line-height: 1.35;
    color: #60a5fa; text-decoration: none;
  }
  .trade-card-title:hover { text-decoration: underline; }

  .action-pill {
    display: inline-block; padding: 6px 18px; border-radius: 20px;
    font-weight: 700; font-size: 0.9rem; letter-spacing: 0.03em;
    margin-bottom: 12px;
  }
  .pill-buy-yes { background: rgba(34,197,94,.15); color: #22c55e; }
  .pill-buy-no { background: rgba(234,179,8,.15); color: #eab308; }
  .pill-watch { background: rgba(100,116,139,.18); color: #94a3b8; }

  .trade-plan-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px;
    margin-bottom: 10px;
  }
  .trade-plan-item { display: flex; flex-direction: column; }
  .trade-plan-label {
    font-size: 0.68rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.05em; color: #6b7280;
  }
  .trade-plan-value { font-size: 0.92rem; font-weight: 700; color: #e2e8f0; }

  .why-now {
    font-size: 0.82rem; color: #cbd5e1; margin: 0 0 10px;
    padding: 6px 10px; background: #0f172a; border-radius: 6px;
    border-left: 3px solid #3b82f6;
  }

  .trade-details { margin-top: 8px; }
  .trade-details summary {
    cursor: pointer; font-size: 0.78rem; color: #6b7280; font-weight: 600;
  }
  .trade-details-inner { padding-top: 8px; }

  /* Ticket card styles (mobile-first) */
  .ticket-list { display: flex; flex-direction: column; gap: 10px; }
  .ticket-card {
    background: #131b2e; border: 1px solid #1e293b; border-radius: 10px; padding: 14px 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,.2);
  }
  .ticket-meta-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
    gap: 4px 12px; font-size: 0.82rem;
  }
  .ticket-meta-label { display: block; color: #6b7280; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .ticket-meta-value { display: block; font-weight: 600; color: #e2e8f0; }
  .type-badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px;
    font-size: 0.72rem; font-weight: 700;
  }
  .type-badge-exec { background: rgba(34,197,94,.15); color: #22c55e; }
  .type-badge-watch { background: rgba(100,116,139,.18); color: #94a3b8; }

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
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
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
  .tk-action-pill {
    display: inline-block; padding: 4px 14px; border-radius: 20px;
    font-weight: 700; font-size: 0.82rem; letter-spacing: 0.03em;
    margin-bottom: 4px;
  }
  .tk-pill-buy { background: rgba(34,197,94,.15); color: var(--tk-green); }
  .tk-pill-watch { background: rgba(100,116,139,.18); color: var(--tk-muted); }
  .tk-sort-row {
    display: inline-flex; align-items: center; gap: 6px; margin-left: auto; flex-wrap: wrap;
  }
  .tk-sort-btn {
    background: var(--tk-border); color: var(--tk-text); border: none;
    border-radius: 6px; padding: 4px 12px; font-size: 0.72rem; font-weight: 600;
    cursor: pointer; letter-spacing: 0.04em; transition: background .15s;
  }
  .tk-sort-btn:hover { background: #334155; }
  .tk-sort-btn.tk-sort-active { background: var(--tk-accent); color: #fff; }
  .tk-time-left {
    font-size: 0.72rem; color: var(--tk-muted);
  }
  .tk-time-urgent {
    color: #f59e0b; font-weight: 600;
  }
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
  /* Inline edit icon */
  .tk-edit-icon {
    cursor: pointer; font-size: 0.72rem; color: var(--tk-muted);
    margin-left: 4px; opacity: 0.6; transition: opacity .15s;
  }
  .tk-edit-icon:hover { opacity: 1; color: var(--tk-accent); }
  .tk-inline-edit {
    display: flex; align-items: center; gap: 4px; margin-top: 3px;
  }
  .tk-inline-edit input {
    width: 70px; padding: 3px 6px; border-radius: 5px;
    border: 1px solid var(--tk-border); background: #0f172a; color: var(--tk-text);
    font-size: 0.82rem; font-family: var(--tk-mono);
  }
  .tk-inline-edit input:focus { outline: none; border-color: var(--tk-accent); }
  .tk-inline-edit button {
    padding: 3px 8px; border-radius: 5px; border: none;
    font-size: 0.72rem; font-weight: 600; cursor: pointer;
  }
  .tk-inline-save { background: var(--tk-accent); color: #fff; }
  .tk-inline-save:hover { background: #2563eb; }
  .tk-inline-cancel { background: #374151; color: #9ca3af; }
  .tk-inline-cancel:hover { background: #4b5563; }
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
  .tk-sim-badge {
    display: inline-block; padding: 2px 8px; border-radius: 4px;
    font-size: 0.72rem; font-weight: 700; font-family: var(--tk-mono);
    background: rgba(234,179,8,.18); color: #eab308;
    position: absolute; top: 40px; right: 18px;
    cursor: help; letter-spacing: 0.04em;
  }
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
    { href: "/history", label: "History" },
    { href: "/paper-runner", label: "Runner" },
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
      // Inject defaultAutoCloseEnabled from trade page setting
      if (typeof window.__polyrich_defaultAutoClose === "boolean") {
        try {
          var pObj = JSON.parse(payload);
          pObj.autoCloseEnabled = window.__polyrich_defaultAutoClose;
          payload = JSON.stringify(pObj);
        } catch (_) {}
      }
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving...";
      fetch("/api/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      }).then(function(r) { return r.json(); }).then(function(d) {
        if (d.error) { saveBtn.textContent = d.error === "SPREAD_TOO_WIDE" ? "Spread too wide" : d.error === "BID_BELOW_SL" ? "Bid below SL" : "Error"; saveBtn.disabled = false; }
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
    } else if (item.spreadPct > config.MAX_ENTRY_SPREAD_PCT) {
      whyWatch = `Spread too wide (${(item.spreadPct * 100).toFixed(1)}%)`;
      nextStep = `Need spread \u2264 ${(config.MAX_ENTRY_SPREAD_PCT * 100).toFixed(0)}%`;
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
function inferSize(item, opts) {
  opts = opts || {};
  if (item.liquidity < 500 || item.volume24hr < 50) return null;
  const fromLiq = item.liquidity * SIZE_LIQUIDITY_PCT;
  const fromVol = item.volume24hr * SIZE_VOLUME_PCT;
  // User cap or default hard cap
  const capUsd = (typeof opts.maxTradeCapUsd === "number" && opts.maxTradeCapUsd > 0)
    ? opts.maxTradeCapUsd : MAX_TRADE_CAP_USD_DEFAULT;
  // Risk budget: bankroll × riskPct (when both provided)
  const riskBudget = (typeof opts.bankrollUsd === "number" && opts.bankrollUsd > 0 &&
                      typeof opts.riskPct === "number" && opts.riskPct > 0)
    ? opts.bankrollUsd * opts.riskPct : Infinity;
  const raw = Math.min(fromLiq, fromVol, capUsd, riskBudget);
  if (raw < 1) return null;
  return Math.floor(raw);
}

/**
 * Infer exit plan (take profit + stop-loss) using volatility-adaptive targets.
 *
 * When `opts.volatility` is provided (from enrichItem's stddev of price series),
 * targets scale with observed market movement:
 *   TP = entry + K_TP × volatility   (wider on volatile markets)
 *   SL = entry − K_SL × volatility   (asymmetric R:R since K_TP > K_SL)
 *
 * Minimum distances ensure quiet markets don't get absurdly tight targets.
 * Clamped to [PRICE_FLOOR, PRICE_CEILING].
 *
 * Returns { tp, stop } as numbers or null.
 */
function inferExit(entryNum, opts) {
  if (!Number.isFinite(entryNum) || entryNum <= 0 || entryNum >= PRICE_CEILING)
    return { tp: null, stop: null };

  const kTp = config.K_TP;
  const kSl = config.K_SL;
  const minTpDist = config.MIN_TP_DISTANCE;
  const minSlDist = config.MIN_SL_DISTANCE;

  const vol = (opts && Number.isFinite(opts.volatility) && opts.volatility > 0)
    ? opts.volatility : 0;

  const tpDist = Math.max(kTp * vol, minTpDist);
  const slDist = Math.max(kSl * vol, minSlDist);

  const tp = Math.min(entryNum + tpDist, PRICE_CEILING);
  const stop = Math.max(entryNum - slDist, PRICE_FLOOR);
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

/**
 * For Over/Under markets whose groupItemTitle is "O/U <line>" (e.g. "O/U 2.5"),
 * rewrite the display so the action pill reads clearly:
 *   "Over 2.5 Buy Over @ $0.43"  instead of  "O/U 2.5 BUY YES @ $0.43"
 *
 * For other multi-outcome markets, use the Polymarket button label from the
 * outcomes array (e.g. "MIN" for Minnesota Wild) so the pill matches what the
 * user clicks on Polymarket.  Falls back to groupItemTitle when outcomes is
 * absent or generic ("Yes"/"No").
 *
 * Returns { displayLabel, displayAction } — the human-readable outcome label and
 * action text.  For binary markets the values pass through unchanged.
 */
const OU_PATTERN = /^O\/U\s+(.+)$/i;
const GENERIC_OUTCOMES = new Set(["yes", "no"]);

function formatOutcomeAction(rawLabel, rawAction, outcomes) {
  const m = OU_PATTERN.exec(rawLabel);
  if (m) {
    const line = m[1]; // e.g. "2.5"
    if (rawAction === "BUY YES") {
      return { displayLabel: `Over ${line}`, displayAction: "Buy Over" };
    }
    if (rawAction === "BUY NO") {
      return { displayLabel: `Under ${line}`, displayAction: "Buy Under" };
    }
    // WATCH — keep descriptive label but expand abbreviation
    return { displayLabel: `Over/Under ${line}`, displayAction: rawAction };
  }

  // Non-O/U multi-outcome: fold outcome name into the action so the pill
  // reads "Buy {buttonName}" matching the Polymarket buy button.
  // Prefer outcomes[0] (the Polymarket button label, e.g. "MIN") over
  // groupItemTitle (the full name, e.g. "Wild").
  // When the button label differs from groupItemTitle, keep groupItemTitle as
  // displayLabel so the pill shows both: "Wild Buy MIN @ $0.45".
  // When groupItemTitle is empty but outcomes have non-generic names (e.g.
  // sports moneylines with ["MIN","STL"]), still use them so the pill reads
  // "Buy MIN" instead of the opaque "BUY YES".
  const arr = Array.isArray(outcomes) ? outcomes : [];
  const yesName = arr[0] && !GENERIC_OUTCOMES.has(arr[0].toLowerCase()) ? arr[0] : rawLabel;
  const noName  = arr[1] && !GENERIC_OUTCOMES.has(arr[1].toLowerCase()) ? arr[1] : rawLabel;
  if (rawAction === "BUY YES" && yesName) {
    return { displayLabel: yesName !== rawLabel ? rawLabel : "", displayAction: `Buy ${yesName}` };
  }
  if (rawAction === "BUY NO" && noName) {
    return { displayLabel: noName !== rawLabel ? rawLabel : "", displayAction: `Fade ${noName}` };
  }

  return { displayLabel: rawLabel, displayAction: rawAction };
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
  // so the customer knows exactly which outcome to act on (e.g. "Over 2.5 Buy Over")
  const outcomeLabel = (item.groupItemTitle || "").trim();
  const outcomes = item.outcomes || [];
  const subtextHtml = subtext ? `<div style="font-size:0.78rem;color:#6b7280;margin-top:2px;">${escHtml(subtext)}</div>` : "";
  const questionHtml = link
    ? `<a href="${safeLink}" target="_blank" rel="noopener" class="trade-card-title">${escHtml(headline)}</a>${subtextHtml}`
    : `<span class="trade-card-title">${escHtml(headline)}</span>${subtextHtml}`;

  let entryNum = null, sizeNum = null, tpNum = null, stopNum = null;
  // Entry microstructure: bid is the closeable price basis
  const entryBidNum = (item.bestBidNum > 0) ? item.bestBidNum : null;

  if (action !== "WATCH") {
    entryNum = inferEntry(item, action);
    if (entryNum !== null) {
      sizeNum = inferSize(item);
      const exits = inferExit(entryNum, { volatility: item.volatility });
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

  // Rewrite abbreviated O/U labels into clear Over/Under text
  const { displayLabel, displayAction } = formatOutcomeAction(outcomeLabel, action, outcomes);

  // Debug section (shared between EXECUTE and WATCH)
  const debugHtml = `
    <details class="trade-details">
      <summary>Details</summary>
      <div class="trade-details-inner">
        <p style="font-weight:600;font-size:0.82rem;margin:0 0 6px;">Why this is a pick</p>
        <ul style="margin:0 0 8px;padding-left:18px;font-size:0.82rem;color:#cbd5e1;">
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

    // Entry microstructure for save payload
    const entryAskNum = entryNum;  // inferEntry returns bestAsk
    const midNum = (Number.isFinite(entryBidNum) && entryBidNum > 0 && entryAskNum) ? (entryAskNum + entryBidNum) / 2 : null;
    const spreadAbs = (Number.isFinite(entryBidNum) && entryBidNum > 0 && entryAskNum) ? (entryAskNum - entryBidNum) : null;
    const spreadPct = (midNum && midNum > 0 && spreadAbs !== null) ? spreadAbs / midNum : null;

    const savePayload = JSON.stringify({
      scanId: item.scanId || null,
      source: "TRADE_PAGE",
      marketId: item.conditionId || item.marketSlug || item.question,
      conditionId: item.conditionId || null,
      marketSlug: item.marketSlug || null,
      yesTokenId: item.yesTokenId || null,
      noTokenId: item.noTokenId || null,
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
      endDate: item.endDate || null,
      // Entry microstructure snapshot
      entryBid: entryBidNum,
      entryAsk: entryAskNum,
      entryMid: midNum ? Math.round(midNum * 10000) / 10000 : null,
      entrySpreadAbs: spreadAbs !== null ? Math.round(spreadAbs * 10000) / 10000 : null,
      entrySpreadPct: spreadPct !== null ? Math.round(spreadPct * 10000) / 10000 : null,
      entryBidSize: item.bestBidSize || null,
      entryAskSize: item.bestAskSize || null,
      entryExecutionBasis: "ASK",
      triggerReferenceBasis: "BID",
    });

    return `
      <div class="trade-card" data-execute="1" data-entry-num="${entryNum}" data-entry-bid="${entryBidNum || ""}" data-heuristic-max="${sizeNum}" data-tp-num="${tpNum}" data-stop-num="${stopNum}" data-market="${escHtml(qText)}" data-action="${escHtml(action)}" data-outcome="${escHtml(outcomeLabel)}" data-outcomes="${escHtml(JSON.stringify(outcomes))}" data-end-date="${escHtml(item.endDate || "")}" data-liquidity="${item.liquidity || 0}" data-volume24hr="${item.volume24hr || 0}">
        <div class="trade-card-header">${questionHtml}</div>
        <div class="action-pill ${actionCls}">\u26A1 ${displayLabel ? escHtml(displayLabel) + " " : ""}${escHtml(displayAction)} @ $${entryNum.toFixed(2)}</div>
        <div class="trade-size-row trade-plan-item" style="margin-bottom:6px;"><span class="trade-plan-label">MAX SIZE (guideline)</span><span class="trade-plan-value trade-size">$${sizeNum} <span class="size-note">(bankroll not set)</span></span></div>
        <div class="trade-plan-grid">
          <div class="trade-plan-item"><span class="trade-plan-label">Entry (ask)</span><span class="trade-plan-value">$${entryNum.toFixed(2)}</span></div>
          <div class="trade-plan-item"><span class="trade-plan-label">Entry closeable (bid)</span><span class="trade-plan-value">${(Number.isFinite(entryBidNum) && entryBidNum > 0) ? "$" + entryBidNum.toFixed(2) : "\u2014"}</span></div>
          <div class="trade-plan-item"><span class="trade-plan-label">TAKE PROFIT</span><span class="trade-plan-value">$${tpNum.toFixed(2)}</span></div>
          <div class="trade-plan-item"><span class="trade-plan-label">STOP-LOSS</span><span class="trade-plan-value">$${stopNum.toFixed(2)}</span></div>
          <div class="trade-plan-item"><span class="trade-plan-label">PnL @ TP (approx)</span><span class="trade-plan-value trade-pnl-tp" style="color:#22c55e;">+$${pnlTpUsd.toFixed(2)} (+${pnlTpPct.toFixed(1)}% of stake)</span></div>
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
    conditionId: item.conditionId || null,
    marketSlug: item.marketSlug || null,
    yesTokenId: item.yesTokenId || null,
    noTokenId: item.noTokenId || null,
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
    endDate: item.endDate || null,
  });

  return `
    <div class="trade-card">
      <div class="trade-card-header">${questionHtml}</div>
      <div class="action-pill pill-watch">\uD83D\uDC41 WATCH${displayLabel ? " \u00B7 " + escHtml(displayLabel) : ""}</div>
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
function renderStatusBar(scanStatus, candidateCount, relaxedMode, systemSettings) {
  const lastScan = utcSpan(scanStatus.lastScanAt, "not yet");
  const nextScan = utcSpan(scanStatus.nextScanAt, "\u2014");
  const eventsScanned = scanStatus.lastEventsFetched || 0;
  const marketsScanned = scanStatus.lastMarketsFlattened || 0;
  const defaultAutoClose = (systemSettings && systemSettings.defaultAutoCloseEnabled) || false;
  const acToggleChecked = defaultAutoClose ? "checked" : "";
  const acBadgeStyle = defaultAutoClose
    ? "background:rgba(34,197,94,.15);color:#22c55e;"
    : "background:rgba(239,68,68,.15);color:#ef4444;";
  const acBadgeText = defaultAutoClose ? "ON" : "OFF";

  const autoSaveEnabled = (systemSettings && systemSettings.autoSaveExecuteEnabled) || false;
  const asBadgeStyle = autoSaveEnabled
    ? "background:rgba(34,197,94,.15);color:#22c55e;"
    : "background:rgba(239,68,68,.15);color:#ef4444;";
  const asBadgeText = autoSaveEnabled ? "ON" : "OFF";
  const autoSaveStatusLine = autoSaveEnabled
    ? '<div style="background:rgba(34,197,94,.15);border:1px solid rgba(34,197,94,.3);border-radius:8px;padding:6px 14px;margin-bottom:8px;font-size:0.82rem;color:#22c55e;">💾 Auto‑Save ON: will save new EXECUTE ideas after each scan.</div>'
    : "";

  return `
    <div class="status-bar">
      <div class="status-item"><span class="status-label">Last scan</span><span class="status-value">${lastScan}</span></div>
      <div class="status-item"><span class="status-label">Next scan</span><span class="status-value">${nextScan}</span></div>
      <div class="status-item"><span class="status-label">Universe</span><span class="status-value">${eventsScanned} events / ${marketsScanned} markets</span></div>
      <div class="status-item"><span class="status-label">Ready</span><span class="status-value" style="font-weight:700;">${candidateCount} candidates</span></div>
      <div class="status-item">
        <label class="status-label" for="risk-profile-select">Risk Profile</label>
        <select id="risk-profile-select" style="padding:3px 6px;border:1px solid #334155;border-radius:6px;font-size:0.85rem;font-weight:600;background:#0f172a;color:#e2e8f0;">
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
          style="width:100px;padding:3px 6px;border:1px solid #334155;border-radius:6px;font-size:0.85rem;font-weight:600;background:#0f172a;color:#e2e8f0;">
      </div>
      <div class="status-item">
        <label class="status-label" for="risk-pct-input">Risk per trade (%) <span id="risk-badge" style="display:inline-block;padding:1px 7px;border-radius:9px;font-size:0.7rem;font-weight:700;vertical-align:middle;margin-left:4px;background:rgba(34,197,94,.15);color:#22c55e;">Conservative (default)</span></label>
        <input id="risk-pct-input" type="number" min="0.1" max="100" step="0.1" placeholder="1"
          style="width:80px;padding:3px 6px;border:1px solid #334155;border-radius:6px;font-size:0.85rem;font-weight:600;background:#0f172a;color:#e2e8f0;">
        <span style="display:block;font-size:0.68rem;color:#6b7280;margin-top:2px;">Default is 1.00%. Aggressive starts at 1.50%.</span>
      </div>
      <div class="status-item">
        <label class="status-label" for="max-cap-input">Max trade cap (USD) <span class="info-tooltip" style="position:relative;cursor:pointer;font-size:0.78rem;color:#6b7280;">ℹ️<span class="info-tooltip-text" style="display:none;position:absolute;bottom:120%;left:50%;transform:translateX(-50%);background:#1f2937;color:#fff;padding:8px 12px;border-radius:8px;font-size:0.78rem;white-space:normal;width:260px;z-index:10;font-weight:400;line-height:1.4;box-shadow:0 2px 8px rgba(0,0,0,.18);">LIMIT orders (recommended) require at least $5 per order. If computed max size is &lt; $5, cards will show WATCH.</span></span></label>
        <input id="max-cap-input" type="number" min="1" step="1" placeholder="50"
          style="width:80px;padding:3px 6px;border:1px solid #334155;border-radius:6px;font-size:0.85rem;font-weight:600;background:#0f172a;color:#e2e8f0;">
      </div>
      <div class="status-item">
        <label class="status-label">Default Auto-Close <span style="display:inline-block;padding:1px 7px;border-radius:9px;font-size:0.7rem;font-weight:700;vertical-align:middle;margin-left:4px;${acBadgeStyle}">${acBadgeText}</span></label>
        <label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;margin-top:2px;">
          <input id="default-autoclose-toggle" type="checkbox" ${acToggleChecked} style="width:16px;height:16px;cursor:pointer;">
          <span style="font-size:0.82rem;font-weight:600;">${defaultAutoClose ? "ON" : "OFF"}</span>
        </label>
      </div>

      <div class="status-item">
        <span class="status-label">Default Auto-Close</span>
        <button id="default-autoclose-toggle"
          style="padding:3px 12px;border-radius:6px;font-size:0.82rem;font-weight:700;cursor:pointer;border:1px solid ${defaultAutoClose ? "#166534" : "#d1d5db"};background:${defaultAutoClose ? "#dcfce7" : "#f3f4f6"};color:${defaultAutoClose ? "#166534" : "#6b7280"};"
        >${defaultAutoClose ? "ON" : "OFF"}</button>
      </div>

      <div class="status-item">
        <span class="status-label">Auto‑Save EXECUTE <span style="display:inline-block;padding:1px 7px;border-radius:9px;font-size:0.7rem;font-weight:700;vertical-align:middle;margin-left:4px;${asBadgeStyle}">${asBadgeText}</span></span>
        <button id="autosave-execute-toggle"
          style="padding:3px 12px;border-radius:6px;font-size:0.82rem;font-weight:700;cursor:pointer;border:1px solid ${autoSaveEnabled ? "#166534" : "#d1d5db"};background:${autoSaveEnabled ? "#dcfce7" : "#f3f4f6"};color:${autoSaveEnabled ? "#166534" : "#6b7280"};"
        >${autoSaveEnabled ? "ON" : "OFF"}</button>
      </div>

      <a href="/scan?returnTo=/trade" class="cta-primary" style="padding:5px 14px;font-size:0.82rem;white-space:nowrap;">Refresh scan</a>
    </div>
    ${autoSaveStatusLine}
    <div id="sizing-block-warning" style="display:none;background:rgba(127,29,29,.35);border:2px solid #991b1b;border-radius:10px;padding:12px 16px;margin-bottom:10px;font-size:0.88rem;color:#fecaca;line-height:1.5;">
    </div>
    <div id="limit-order-warning" style="display:none;background:rgba(127,29,29,.3);border:1px solid #7f1d1d;border-radius:8px;padding:8px 14px;margin-bottom:8px;font-size:0.82rem;color:#fecaca;">
      ⚠️ Max trade cap must be at least $5 for limit orders.
      <button id="set-cap-5-btn" style="margin-left:8px;padding:3px 10px;border-radius:6px;border:1px solid #991b1b;background:#1e293b;color:#fecaca;font-weight:600;font-size:0.82rem;cursor:pointer;">Set cap to $5</button>
    </div>
  `;
}

/** Render the full /trade page body. */
function renderTradePage(scanStatus, tradeCandidates, relaxedMode, systemSettings) {
  const cards = tradeCandidates.slice(0, 20);
  const statusBar = renderStatusBar(scanStatus, cards.length, relaxedMode, systemSettings);
  const defaultAutoClose = (systemSettings && systemSettings.defaultAutoCloseEnabled) || false;

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
          const exits = inferExit(entryNum, { volatility: item.volatility });
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
        catch (_) { return `<div class="trade-card"><p style="color:#ef4444;">Render error: ${escHtml((item && item.marketSlug) || "unknown")}</p></div>`; }
      }).join("")}</div>`;

  const watchHtml = watchSlice.length === 0
    ? '<p style="color:#6b7280;font-size:0.92rem;padding:12px 0;">No watch items this scan.</p>'
    : `<div class="trade-grid">${watchSlice.map((item) => {
        try { return renderTradeCard(item); }
        catch (_) { return `<div class="trade-card"><p style="color:#ef4444;">Render error: ${escHtml((item && item.marketSlug) || "unknown")}</p></div>`; }
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
      var SIZE_LIQ_PCT = ${SIZE_LIQUIDITY_PCT};
      var SIZE_VOL_PCT = ${SIZE_VOLUME_PCT};
      var DEFAULT_AUTOCLOSE = ${defaultAutoClose ? "true" : "false"};
      var KEY_BR = 'polyrich_bankroll_usd';
      var KEY_RISK = 'polyrich_risk_pct';
      var KEY_CAP = 'polyrich_max_trade_cap_usd';
      var KEY_PROFILE = 'polyrich_risk_profile';
      var DEFAULT_AUTOCLOSE = ${defaultAutoClose};
      window.__polyrich_defaultAutoClose = DEFAULT_AUTOCLOSE;

      // Default Auto-Close toggle
      var dacToggle = document.getElementById('default-autoclose-toggle');
      if (dacToggle) {
        dacToggle.addEventListener('click', function() {
          var newVal = dacToggle.textContent.trim() === 'OFF';
          dacToggle.disabled = true;
          dacToggle.textContent = '...';
          fetch('/api/system/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ defaultAutoCloseEnabled: newVal })
          }).then(function() { window.location.reload(); })
            .catch(function() { dacToggle.textContent = 'Error'; dacToggle.disabled = false; });
        });
      }

      // Auto-Save EXECUTE toggle
      var asToggle = document.getElementById('autosave-execute-toggle');
      if (asToggle) {
        asToggle.addEventListener('click', function() {
          var newVal = asToggle.textContent.trim() === 'OFF';
          asToggle.disabled = true;
          asToggle.textContent = '...';
          fetch('/api/system/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ autoSaveExecuteEnabled: newVal })
          }).then(function() { window.location.reload(); })
            .catch(function() { asToggle.textContent = 'Error'; asToggle.disabled = false; });
        });
      }

      function escH(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

      // Client-side O/U → Over/Under rewrite (mirrors server-side formatOutcomeAction)
      var OU_RE = /^O\\/U\\s+(.+)$/i;
      var GENERIC_OC = { yes: 1, no: 1 };
      function fmtOA(label, act, outcomes) {
        var m = OU_RE.exec(label);
        if (m) {
          var line = m[1];
          if (act === 'BUY YES') return { dl: 'Over ' + line, da: 'Buy Over' };
          if (act === 'BUY NO') return { dl: 'Under ' + line, da: 'Buy Under' };
          return { dl: 'Over/Under ' + line, da: act };
        }
        // Non-O/U multi-outcome: prefer Polymarket button label from outcomes
        // Keep groupItemTitle as dl when it differs from the button label
        if (label) {
          var arr = Array.isArray(outcomes) ? outcomes : [];
          var yn = arr[0] && !GENERIC_OC[arr[0].toLowerCase()] ? arr[0] : label;
          var nn = arr[1] && !GENERIC_OC[arr[1].toLowerCase()] ? arr[1] : label;
          if (act === 'BUY YES') return { dl: yn !== label ? label : '', da: 'Buy ' + yn };
          if (act === 'BUY NO') return { dl: nn !== label ? label : '', da: 'Fade ' + nn };
        }
        return { dl: label, da: act };
      }

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
      var sizingBlockWarn = document.getElementById('sizing-block-warning');
      var setCap5Btn = document.getElementById('set-cap-5-btn');
      if (!brInput || !riskInput || !capInput || !profileSelect) return;

      // Default Auto-Close toggle handler
      var acToggle = document.getElementById('default-autoclose-toggle');
      if (acToggle) {
        acToggle.addEventListener('change', function() {
          var newVal = acToggle.checked;
          fetch('/api/system/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ defaultAutoCloseEnabled: newVal })
          }).then(function() { window.location.reload(); })
            .catch(function() { acToggle.checked = !newVal; alert('Failed to update Default Auto-Close setting.'); });
        });
      }

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
          badge.style.background = 'rgba(34,197,94,.15)'; badge.style.color = '#22c55e';
        } else if (riskDec <= 0.015) {
          badge.textContent = 'Slightly aggressive (above default)';
          badge.style.background = 'rgba(234,179,8,.15)'; badge.style.color = '#eab308';
        } else if (riskDec <= 0.05) {
          badge.textContent = 'Aggressive';
          badge.style.background = 'rgba(234,179,8,.25)'; badge.style.color = '#eab308';
        } else {
          badge.textContent = 'Very aggressive \\u2014 high risk';
          badge.style.background = 'rgba(239,68,68,.15)'; badge.style.color = '#ef4444';
        }
      }

      function updateLimitWarning(capUsd) {
        if (capUsd < 5) {
          if (limitWarn) limitWarn.style.display = 'block';
        } else {
          if (limitWarn) limitWarn.style.display = 'none';
        }
      }

      function updateSizingBlockWarning(bankroll, hasBankroll, riskDec, capUsd) {
        if (!sizingBlockWarn) return;
        var problems = [];
        var advice = [];
        var effectiveBudget;

        if (hasBankroll) {
          var riskBudget = bankroll * riskDec;
          effectiveBudget = Math.min(capUsd, riskBudget);

          if (riskBudget < MIN_ORDER && capUsd < MIN_ORDER) {
            problems.push('Risk budget is $' + riskBudget.toFixed(2) + ' (bankroll $' + bankroll + ' × ' + (riskDec * 100).toFixed(1) + '%) AND max trade cap is $' + capUsd.toFixed(0) + '. Both are below the $' + MIN_ORDER + ' minimum.');
            var minRiskPct = Math.ceil(MIN_ORDER / bankroll * 10000) / 100;
            advice.push('Set Risk % to at least ' + minRiskPct + '% OR increase bankroll to at least $' + Math.ceil(MIN_ORDER / riskDec));
            advice.push('Set Max Trade Cap to at least $' + MIN_ORDER);
          } else if (riskBudget < MIN_ORDER) {
            problems.push('Risk budget is only $' + riskBudget.toFixed(2) + ' (bankroll $' + bankroll + ' × ' + (riskDec * 100).toFixed(1) + '%). This is below the $' + MIN_ORDER + ' Polymarket minimum order.');
            var minRiskPct2 = Math.ceil(MIN_ORDER / bankroll * 10000) / 100;
            advice.push('Increase Risk % to at least ' + minRiskPct2 + '%');
            advice.push('Or increase bankroll to at least $' + Math.ceil(MIN_ORDER / riskDec));
          } else if (capUsd < MIN_ORDER) {
            problems.push('Max trade cap is $' + capUsd.toFixed(0) + ', below the $' + MIN_ORDER + ' Polymarket minimum order.');
            advice.push('Set Max Trade Cap to at least $' + MIN_ORDER);
          }
        } else {
          effectiveBudget = capUsd;
          if (capUsd < MIN_ORDER) {
            problems.push('Max trade cap is $' + capUsd.toFixed(0) + ', below the $' + MIN_ORDER + ' Polymarket minimum order.');
            advice.push('Set Max Trade Cap to at least $' + MIN_ORDER);
          }
        }

        if (problems.length === 0) {
          sizingBlockWarn.style.display = 'none';
          return;
        }

        var html = '<div style="font-weight:700;font-size:1rem;margin-bottom:6px;">🚫 Settings block ALL trades</div>';
        html += '<div style="margin-bottom:6px;">' + problems.join(' ') + '</div>';
        html += '<div style="font-weight:600;">What to do:</div><ul style="margin:4px 0 0 18px;padding:0;">';
        for (var i = 0; i < advice.length; i++) {
          html += '<li>' + advice[i] + '</li>';
        }
        html += '</ul>';
        sizingBlockWarn.innerHTML = html;
        sizingBlockWarn.style.display = 'block';
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

      // Debounced sync of sizing settings to server (for auto-save)
      var _syncTimer = null;
      var _lastSyncKey = '';
      function syncSizingToServer(bankroll, riskDec, capUsd) {
        var key = String(bankroll) + '|' + String(riskDec) + '|' + String(capUsd);
        if (key === _lastSyncKey) return;
        _lastSyncKey = key;
        if (_syncTimer) clearTimeout(_syncTimer);
        _syncTimer = setTimeout(function() {
          fetch('/api/system/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              bankrollUsd: bankroll,
              riskPct: riskDec > 0 ? riskDec : null,
              maxTradeCapUsd: capUsd > 0 ? capUsd : null
            })
          }).catch(function() { /* silent */ });
        }, 500);
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

        // Sync risk/sizing settings to server (for auto-save to use)
        syncSizingToServer(hasBankroll ? bankroll : null, riskDec, capUsd);

        updateBadge(riskDec);
        updateLimitWarning(capUsd);
        updateSizingBlockWarning(bankroll, hasBankroll, riskDec, capUsd);

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
          var outcomesRaw = card.getAttribute('data-outcomes') || '[]';
          var outcomesArr; try { outcomesArr = JSON.parse(outcomesRaw); } catch(_) { outcomesArr = []; }
          // Market microstructure for bottleneck identification
          var cardLiq = parseFloat(card.getAttribute('data-liquidity')) || 0;
          var cardVol = parseFloat(card.getAttribute('data-volume24hr')) || 0;
          if (isNaN(hMax) || isNaN(entry) || entry <= 0) continue;

          // Compute individual sizing components to identify bottleneck
          var fromLiq = cardLiq * SIZE_LIQ_PCT;
          var fromVol = cardVol * SIZE_VOL_PCT;
          var riskBudget = hasBankroll ? bankroll * riskDec : Infinity;

          var maxSizeRaw;
          if (hasBankroll) {
            maxSizeRaw = Math.min(capUsd, riskBudget, hMax);
          } else {
            maxSizeRaw = Math.min(capUsd, hMax);
          }
          // Bump to exchange minimum ($5) when heuristic sizing is conservative
          // but user's cap allows it — matches server-side autoSave bump logic.
          if (maxSizeRaw < MIN_ORDER && capUsd >= MIN_ORDER) {
            maxSizeRaw = MIN_ORDER;
          }
          var maxSizeDisplay = Math.round(maxSizeRaw * 100) / 100;

          // Min $5 gating — downgrade to WATCH per-card (uses raw, not rounded)
          if (maxSizeRaw < MIN_ORDER) {
            // Identify the actual bottleneck for accurate user messaging
            var bottleneck, nextStep;
            if (capUsd < MIN_ORDER) {
              bottleneck = 'Your cap ($' + capUsd.toFixed(0) + ') is below $' + MIN_ORDER + ' minimum';
              nextStep = 'Increase your trade cap to at least $' + MIN_ORDER;
            } else if (riskBudget < MIN_ORDER && riskBudget <= fromLiq && riskBudget <= fromVol) {
              bottleneck = 'Risk budget $' + riskBudget.toFixed(2) + ' (bankroll \u00D7 risk%) is below $' + MIN_ORDER;
              nextStep = 'Increase bankroll or risk%';
            } else if (fromLiq <= fromVol) {
              bottleneck = 'Low market liquidity ($' + Math.round(cardLiq).toLocaleString() + ') limits size to $' + Math.floor(fromLiq);
              nextStep = 'Wait for more liquidity, or increase cap to \u2265$' + MIN_ORDER + ' to force minimum';
            } else {
              bottleneck = 'Low 24h volume ($' + Math.round(cardVol).toLocaleString() + ') limits size to $' + Math.floor(fromVol);
              nextStep = 'Wait for more volume, or increase cap to \u2265$' + MIN_ORDER + ' to force minimum';
            }
            var whyWatchMsg = 'Max size $' + maxSizeDisplay.toFixed(2) + ' \u2014 ' + bottleneck;

            var pillEl = card.querySelector('.action-pill');
            if (pillEl) {
              pillEl.className = 'action-pill pill-watch';
              pillEl.innerHTML = '\\uD83D\\uDC41 WATCH' + (outcome ? ' \\u00B7 ' + escH(fmtOA(outcome, act, outcomesArr).dl || outcome) : '');
            }
            var planGrid = card.querySelector('.trade-plan-grid');
            if (planGrid) planGrid.style.display = 'none';
            var sizeRow = card.querySelector('.trade-size-row');
            if (sizeRow) sizeRow.style.display = 'none';
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
            whyBlock.innerHTML = '<p style="margin:0 0 6px;font-size:0.88rem;"><strong>WHY WATCH:</strong> ' + whyWatchMsg + '</p>' +
              '<p style="margin:0;font-size:0.85rem;color:#6b7280;"><strong>NEXT:</strong> ' + nextStep + '</p>';
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
                base0.whyWatch = whyWatchMsg;
                base0.nextStep = nextStep;
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
            var oa = fmtOA(outcome, act, outcomesArr);
            pillEl2.innerHTML = '\\u26A1 ' + (oa.dl ? escH(oa.dl) + ' ' : '') + escH(oa.da) + ' @ $' + entry.toFixed(2);
          }
          var planGrid3 = card.querySelector('.trade-plan-grid');
          if (planGrid3) planGrid3.style.display = '';
          var sizeRow2 = card.querySelector('.trade-size-row');
          if (sizeRow2) sizeRow2.style.display = '';
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
            b.style.background = 'rgba(34,197,94,.15)';
            b.style.color = '#22c55e';
            b.style.borderColor = 'rgba(34,197,94,.3)';
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
        const exits = inferExit(entryNum, { volatility: item.volatility });
        if (sizeNum !== null && exits.tp !== null && exits.stop !== null) {
          return `<div style="margin-top:8px;padding:8px 10px;background:rgba(22,101,52,.15);border:1px solid rgba(34,197,94,.2);border-radius:6px;font-size:0.78rem;">
            <span style="font-weight:700;color:#22c55e;">⚡ EXECUTE</span>
            <span style="margin-left:10px;"><span style="color:#6b7280;">ENTRY</span> <strong>$${entryNum.toFixed(2)}</strong></span>
            <span style="margin-left:10px;"><span style="color:#6b7280;">TP</span> <strong>$${exits.tp.toFixed(2)}</strong></span>
            <span style="margin-left:10px;"><span style="color:#6b7280;">SL</span> <strong>$${exits.stop.toFixed(2)}</strong></span>
          </div>`;
        }
      }
    }
    return '<div style="margin-top:8px;padding:6px 10px;background:rgba(100,116,139,.15);border-radius:6px;font-size:0.78rem;color:#94a3b8;"><span style="font-weight:600;">👁 WATCH</span> — Plan: TBD</div>';
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
function renderSystemPage(healthData, metrics, autoModeStatus, recentCloseAttempts, systemSettings, envKillSwitches, autoSavedToday, ticketCloseStats, debugSnapshot) {
  autoModeStatus = autoModeStatus || {};
  recentCloseAttempts = recentCloseAttempts || [];
  systemSettings = systemSettings || { autoModeEnabled: false, paperCloseEnabled: false };
  envKillSwitches = envKillSwitches || { autoModeEnv: false, paperCloseEnv: false };
  autoSavedToday = autoSavedToday || 0;
  ticketCloseStats = ticketCloseStats || { total: 0, auto: 0, manual: 0, other: 0 };
  debugSnapshot = debugSnapshot || null;

  const envAutoAllows = envKillSwitches.autoModeEnv;
  const envPaperAllows = envKillSwitches.paperCloseEnv;
  const dbAutoEnabled = systemSettings.autoModeEnabled || false;
  const dbPaperEnabled = systemSettings.paperCloseEnabled || false;
  const effectiveAuto = envAutoAllows && dbAutoEnabled;
  const effectivePaper = envPaperAllows && dbPaperEnabled;

  const autoEnabled = autoModeStatus.enabled || false;
  const statusBadge = autoEnabled
    ? '<span style="background:#166534;color:#bbf7d0;padding:2px 10px;border-radius:8px;font-size:0.82rem;font-weight:600;">ENABLED</span>'
    : '<span style="background:#7f1d1d;color:#fecaca;padding:2px 10px;border-radius:8px;font-size:0.82rem;font-weight:600;">DISABLED</span>';
  const paperCloseBadge = autoModeStatus.paperCloseEnabled
    ? '<span style="background:#854d0e;color:#fef08a;padding:2px 10px;border-radius:8px;font-size:0.82rem;font-weight:600;">ON</span>'
    : '<span style="background:#374151;color:#9ca3af;padding:2px 10px;border-radius:8px;font-size:0.82rem;font-weight:600;">OFF</span>';
  const leaseBadge = autoModeStatus.leaseHeld
    ? '<span style="color:#22c55e;">● held</span>'
    : '<span style="color:#ef4444;">● not held</span>';

  const backoffLabel = autoModeStatus.backoffMs > 0
    ? `<span style="color:#f59e0b;font-weight:600;">${(autoModeStatus.backoffMs / 1000).toFixed(0)}s</span>`
    : '<span style="color:#6b7280;">none</span>';

  const lastLoopLabel = autoModeStatus.lastLoopAt
    ? utcSpan(autoModeStatus.lastLoopAt)
    : '<span style="color:#6b7280;">—</span>';

  const lastErrLabel = autoModeStatus.lastError
    ? `<span style="color:#ef4444;">${escHtml(autoModeStatus.lastError)}</span>`
    : '<span style="color:#6b7280;">—</span>';

  // --- Operator toggles panel ---
  function toggleRow(label, fieldName, envAllows, dbEnabled, effective) {
    const lockedByEnv = !envAllows;
    const envBadge = envAllows
      ? '<span style="background:#166534;color:#bbf7d0;padding:2px 8px;border-radius:6px;font-size:0.75rem;font-weight:600;">ENV ✓</span>'
      : '<span style="background:#7f1d1d;color:#fecaca;padding:2px 8px;border-radius:6px;font-size:0.75rem;font-weight:600;">Locked by env</span>';
    const dbBadge = dbEnabled
      ? '<span style="background:#166534;color:#bbf7d0;padding:2px 8px;border-radius:6px;font-size:0.75rem;font-weight:600;">DB ON</span>'
      : '<span style="background:#374151;color:#9ca3af;padding:2px 8px;border-radius:6px;font-size:0.75rem;font-weight:600;">DB OFF</span>';
    const effectiveBadge = effective
      ? '<span style="background:#166534;color:#bbf7d0;padding:2px 8px;border-radius:6px;font-size:0.78rem;font-weight:700;">● ACTIVE</span>'
      : '<span style="background:#7f1d1d;color:#fecaca;padding:2px 8px;border-radius:6px;font-size:0.78rem;font-weight:700;">● INACTIVE</span>';

    const btnDisabled = lockedByEnv ? "disabled" : "";
    const btnStyle = lockedByEnv
      ? "opacity:0.5;cursor:not-allowed;"
      : "cursor:pointer;";
    const nextState = dbEnabled ? "false" : "true";
    const btnLabel = dbEnabled ? "Disable" : "Enable";
    const btnColor = dbEnabled ? "#7f1d1d" : "#166534";

    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid #1e293b;">
        <div>
          <strong style="font-size:0.9rem;">${escHtml(label)}</strong>
          <div style="margin-top:4px;display:flex;gap:6px;flex-wrap:wrap;">
            ${envBadge} ${dbBadge} ${effectiveBadge}
          </div>
        </div>
        <button class="sys-toggle-btn" data-field="${escHtml(fieldName)}" data-value="${nextState}"
          ${btnDisabled}
          style="background:${btnColor};color:#fff;border:none;padding:6px 16px;border-radius:6px;font-size:0.82rem;font-weight:600;${btnStyle}">
          ${lockedByEnv ? "🔒 Locked" : escHtml(btnLabel)}
        </button>
      </div>
    `;
  }

  /** Render a drillable diagnostic metric row with explanation, action, and link to tickets. */
  function diagMetricRow(reasonCode, count) {
    const info = DIAGNOSTIC_REASONS[reasonCode] || { label: reasonCode, explanation: "", whatToDo: "", queryParam: "monitorReason" };
    const countColor = count > 0 ? "#ef4444" : "#6b7280";
    const ticketLink = count > 0
      ? ` <a href="/tickets?${escHtml(info.queryParam)}=${escHtml(reasonCode)}" style="color:#60a5fa;font-size:0.75rem;text-decoration:none;font-weight:600;margin-left:8px;" title="View affected tickets">View tickets →</a>`
      : "";
    return `<div style="background:#1e293b;border-radius:6px;padding:8px 10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px;">
        <span style="font-size:0.82rem;font-weight:600;color:#e2e8f0;">${escHtml(info.label)}</span>
        <span><strong style="color:${countColor};font-size:0.9rem;">${count}</strong>${ticketLink}</span>
      </div>
      <div style="font-size:0.75rem;color:#94a3b8;margin-top:4px;"><strong>What is this?</strong> ${escHtml(info.explanation)}</div>
      <div style="font-size:0.75rem;color:#818cf8;margin-top:2px;"><strong>What to do:</strong> ${escHtml(info.whatToDo)}</div>
    </div>`;
  }

  const togglesPanel = `
    <div class="card" style="margin-top:16px;">
      <h2 style="margin-top:0;">⚙️ Operator Toggles</h2>
      <p style="font-size:0.8rem;color:#94a3b8;margin:0 0 12px 0;">
        Settings persist in MongoDB. Env vars are hard kill-switches — if <code>false</code> in env, the feature cannot be enabled here.
      </p>
      ${toggleRow("Auto Mode", "autoModeEnabled", envAutoAllows, dbAutoEnabled, effectiveAuto)}
      ${toggleRow("Paper Close (SIM)", "paperCloseEnabled", envPaperAllows, dbPaperEnabled, effectivePaper)}
    </div>
    <script>
    (function() {
      document.addEventListener("click", function(e) {
        var btn = e.target.closest(".sys-toggle-btn");
        if (!btn || btn.disabled) return;
        var field = btn.getAttribute("data-field");
        var value = btn.getAttribute("data-value") === "true";
        btn.disabled = true;
        btn.textContent = "Saving…";
        var payload = {};
        payload[field] = value;
        fetch("/api/system/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).then(function(r) { return r.json(); }).then(function(d) {
          if (d.error) { btn.textContent = "Error"; btn.disabled = false; alert(d.error); }
          else { location.reload(); }
        }).catch(function() { btn.textContent = "Error"; btn.disabled = false; });
      });
    })();
    </script>
  `;

  const attemptRows = recentCloseAttempts.map((a) => {
    const resultCls = a.result === "INTENT_RECORDED" ? "color:#22c55e"
      : a.result === "PAPER_CLOSED" ? "color:#eab308"
      : a.result === "FAILED" ? "color:#ef4444"
      : "color:#6b7280";
    const ticketIdStr = String(a.ticketId);
    const ticketIdShort = ticketIdStr.slice(-6);
    return `<tr>
      <td style="padding:4px 8px;font-size:0.8rem;">${utcSpan(a.createdAt)}</td>
      <td style="padding:4px 8px;font-size:0.8rem;"><a href="/tickets/${escHtml(ticketIdStr)}" style="color:#60a5fa;text-decoration:none;" title="View ticket detail">${escHtml(ticketIdShort)}</a></td>
      <td style="padding:4px 8px;font-size:0.8rem;">${escHtml(a.reason || "—")}</td>
      <td style="padding:4px 8px;font-size:0.8rem;">${typeof a.observedPrice === "number" ? a.observedPrice.toFixed(4) : "—"}</td>
      <td style="padding:4px 8px;font-size:0.8rem;${resultCls};font-weight:600;">${escHtml(a.result || "—")}</td>
      <td style="padding:4px 8px;font-size:0.8rem;color:#ef4444;">${a.error ? escHtml(a.error) : "—"}</td>
    </tr>`;
  }).join("");

  const autoModePanel = `
    <div class="card" style="margin-top:16px;">
      <h2 style="margin-top:0;">🤖 Auto Mode Monitor</h2>
      <div class="grid-2" style="gap:12px 24px;">
        <div><span class="label">Status</span> ${statusBadge}</div>
        <div><span class="label">Paper Close</span> ${paperCloseBadge}</div>
        <div><span class="label">Lease</span> ${leaseBadge}</div>
        <div><span class="label">Lease owner</span> <span style="font-family:monospace;font-size:0.78rem;">${escHtml(autoModeStatus.leaseOwnerId || "—")}</span></div>
        <div><span class="label">Lease expires</span> ${autoModeStatus.leaseExpiresAt ? utcSpan(autoModeStatus.leaseExpiresAt) : '<span style="color:#6b7280;">—</span>'}</div>
        <div><span class="label">Last loop</span> ${lastLoopLabel}</div>
        <div><span class="label">Loop duration</span> <span>${autoModeStatus.lastLoopDurationMs != null ? autoModeStatus.lastLoopDurationMs + "ms" : "—"}</span></div>
        <div><span class="label">Backoff</span> ${backoffLabel}</div>
        <div><span class="label">Last error</span> ${lastErrLabel}</div>
      </div>
      <hr style="border-color:#1e293b;margin:12px 0;">
      <div class="grid-2" style="gap:8px 24px;">
        <div title="Number of OPEN tickets with autoClose enabled — the monitor checks these every tick"><span class="label">OPEN monitored</span> <strong>${autoModeStatus.openMonitored || 0}</strong></div>
        <div title="Number of close intents recorded today (trigger confirmed, close queued)"><span class="label">Intents today</span> <strong>${autoModeStatus.intentsToday || 0}</strong></div>
        <div title="Number of tickets successfully closed (paper or on-chain) today"><span class="label">Closes today</span> <strong>${autoModeStatus.closesToday || 0}</strong></div>
        <div title="Number of close attempts that failed today (API error, network issue)"><span class="label">Failures today</span> <strong style="color:${(autoModeStatus.failuresToday || 0) > 0 ? "#ef4444" : "inherit"};">${autoModeStatus.failuresToday || 0}</strong></div>
      </div>
      <hr style="border-color:#1e293b;margin:12px 0;">
      <div style="font-size:0.82rem;color:#94a3b8;margin-bottom:6px;font-weight:600;">📊 Ticket Close Breakdown (all time)</div>
      <div class="grid-2" style="gap:6px 24px;">
        <div title="Total number of closed tickets across all time"><span class="label">Total closed</span> <strong>${ticketCloseStats.total}</strong></div>
        <div title="Tickets closed automatically by the monitor (TP_HIT or EXIT_HIT triggers)"><span class="label">\u{1F916} Auto-closed</span> <strong style="color:#22c55e;">${ticketCloseStats.auto}</strong></div>
        <div title="Tickets closed manually by the user via the Close button"><span class="label">\u{1F590} Manual</span> <strong>${ticketCloseStats.manual}</strong></div>${ticketCloseStats.other > 0 ? `
        <div title="Tickets closed with other/unknown reason"><span class="label">Other</span> <strong>${ticketCloseStats.other}</strong></div>` : ""}
      </div>
      <hr style="border-color:#1e293b;margin:12px 0;">
      <div style="font-size:0.82rem;color:#94a3b8;margin-bottom:6px;font-weight:600;">🔬 Last Tick Diagnostics
        <span style="font-size:0.7rem;color:#64748b;font-weight:400;margin-left:8px;">(per-tick counters — drill-down queries persisted state, counts may differ)</span>
      </div>
      <div class="grid-2" style="gap:6px 24px;">
        <div title="Number of open tickets with autoClose enabled that were checked in this tick"><span class="label">Batch size</span> <strong>${autoModeStatus.lastTickBatchSize || 0}</strong></div>
        <div title="Tickets where the current market price was successfully fetched"><span class="label">Price OK</span> <strong style="color:#22c55e;">${autoModeStatus.lastTickPriceOk || 0}</strong></div>
        <div title="Tickets where price API returned no usable data"><span class="label">Price NULL</span> <strong style="color:${(autoModeStatus.lastTickPriceNull || 0) > 0 ? "#f59e0b" : "inherit"};">${autoModeStatus.lastTickPriceNull || 0}</strong></div>
        <div title="Tickets where the price API call failed (HTTP 429/5xx — triggers backoff)"><span class="label">Price error</span> <strong style="color:${(autoModeStatus.lastTickPriceError || 0) > 0 ? "#ef4444" : "inherit"};">${autoModeStatus.lastTickPriceError || 0}</strong></div>
        <div title="Tickets skipped because they are in cooldown after a failed close attempt"><span class="label">Cooldown skip</span> <strong>${autoModeStatus.lastTickCooldownSkip || 0}</strong></div>
        <div title="Tickets where price reached Take Profit or Exit (risk) level — trigger condition met"><span class="label">Trigger HIT</span> <strong style="color:${(autoModeStatus.lastTickTriggerHit || 0) > 0 ? "#22c55e" : "inherit"};">${autoModeStatus.lastTickTriggerHit || 0}</strong></div>
        <div title="Tickets where price was fetched OK but has NOT reached TP or Exit level yet — no action needed, still monitoring"><span class="label">Trigger miss</span> <strong>${autoModeStatus.lastTickTriggerMiss || 0}</strong></div>
        <div title="Trigger condition met but held by debounce — requires 2 consecutive checks or 15+ seconds to confirm (prevents false triggers from price noise)"><span class="label">Debounce hold</span> <strong style="color:${(autoModeStatus.lastTickDebounceHold || 0) > 0 ? "#f59e0b" : "inherit"};">${autoModeStatus.lastTickDebounceHold || 0}</strong></div>
        <div title="Actual auto-close attempts made after debounce confirmed the trigger"><span class="label">Close attempt</span> <strong style="color:${(autoModeStatus.lastTickCloseAttempt || 0) > 0 ? "#22c55e" : "inherit"};">${autoModeStatus.lastTickCloseAttempt || 0}</strong></div>
      </div>
      <hr style="border-color:#1e293b;margin:12px 0;">
      <div style="font-size:0.82rem;color:#94a3b8;margin-bottom:6px;font-weight:600;">⚠️ Problem / Blocked Reasons
        <span style="font-size:0.7rem;color:#64748b;font-weight:400;margin-left:8px;">(click "View tickets" to drill down to affected tickets)</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${diagMetricRow("IDENTITY_SKIP", autoModeStatus.lastTickIdentitySkip || 0)}
        ${diagMetricRow("MISSING_TOKEN_ID", autoModeStatus.lastTickClobTokenIdMissing || 0)}
        ${diagMetricRow("NO_ORDERBOOK", autoModeStatus.lastTickClobPrice404 || 0)}
        ${diagMetricRow("NO_BIDS", autoModeStatus.lastTickClobPriceNull || 0)}
        ${diagMetricRow("SETTLED", autoModeStatus.lastTickSettledMarkets || 0)}
        ${diagMetricRow("ENDED", autoModeStatus.lastTickEndedMarkets || 0)}
      </div>
      <hr style="border-color:#1e293b;margin:12px 0;">
      <div style="font-size:0.82rem;color:#94a3b8;margin-bottom:6px;font-weight:600;">📡 CLOB Orderbook Diagnostics <span style="background:#166534;color:#bbf7d0;padding:1px 6px;border-radius:4px;font-size:0.72rem;font-weight:700;">PRIMARY</span></div>
      <div class="grid-2" style="gap:6px 24px;">
        <div title="Tickets where CLOB orderbook returned a valid top-of-book bid price"><span class="label">CLOB Price OK</span> <strong style="color:#22c55e;">${autoModeStatus.lastTickClobPriceOk || 0}</strong></div>
        <div title="Tickets where CLOB returned no usable price (no bids, invalid data)"><span class="label">CLOB Price NULL</span> <strong style="color:${(autoModeStatus.lastTickClobPriceNull || 0) > 0 ? "#f59e0b" : "inherit"};">${autoModeStatus.lastTickClobPriceNull || 0}</strong></div>
        <div title="Tickets where CLOB returned 429 — rate limited"><span class="label">CLOB rate limit</span> <strong style="color:${(autoModeStatus.lastTickClobRateLimit || 0) > 0 ? "#ef4444" : "inherit"};">${autoModeStatus.lastTickClobRateLimit || 0}</strong></div>
        <div title="Price monitoring source"><span class="label">Source</span> <strong style="color:#22c55e;">CLOB</strong></div>
      </div>${autoModeStatus.lastTickNullPriceSample ? `
      <div style="margin-top:8px;font-size:0.78rem;color:#94a3b8;background:#1e293b;padding:6px 10px;border-radius:6px;">
        <span style="color:#f59e0b;">⚠ Null-price sample (in-memory):</span>
        tokenId <code>${escHtml(String(autoModeStatus.lastTickNullPriceSample.tokenId || "—"))}</code>
        · ${escHtml(String(autoModeStatus.lastTickNullPriceSample.action || "—"))}
        · ticket …${escHtml(String(autoModeStatus.lastTickNullPriceSample.ticketId || "—"))}
        · reason: <strong style="color:#ef4444;">${escHtml(String(autoModeStatus.lastTickNullPriceSample.nullReason || "—"))}</strong>
        · source: ${escHtml(String(autoModeStatus.lastTickNullPriceSample.source || "—"))}
        · HTTP ${escHtml(String(autoModeStatus.lastTickNullPriceSample.httpStatus ?? "—"))}
        <br>bestBid: ${escHtml(String(autoModeStatus.lastTickNullPriceSample.bestBid ?? "null"))}
        · bestAsk: ${escHtml(String(autoModeStatus.lastTickNullPriceSample.bestAsk ?? "null"))}
        · spread: ${escHtml(String(autoModeStatus.lastTickNullPriceSample.spread ?? "—"))}
        · bids: ${escHtml(String(autoModeStatus.lastTickNullPriceSample.bidsCount ?? "—"))}
        · asks: ${escHtml(String(autoModeStatus.lastTickNullPriceSample.asksCount ?? "—"))}
      </div>` : ""}${debugSnapshot && debugSnapshot.nullPriceSample ? `
      <div style="margin-top:8px;font-size:0.78rem;color:#94a3b8;background:#1a2332;padding:8px 10px;border-radius:6px;border:1px solid #334155;">
        <span style="color:#818cf8;">💾 Persisted debug sample</span> <span style="color:#64748b;">(${escHtml(String(debugSnapshot.capturedAt || "—"))})</span><br>
        tokenId <code>${escHtml(String(debugSnapshot.nullPriceSample.tokenId || debugSnapshot.nullPriceSample.conditionId || "—"))}</code>
        · ${escHtml(String(debugSnapshot.nullPriceSample.action || "—"))}
        · ticket …${escHtml(String(debugSnapshot.nullPriceSample.ticketId || "—"))}
        · reason: <strong style="color:#ef4444;">${escHtml(String(debugSnapshot.nullPriceSample.nullReason || "—"))}</strong>
        · source: ${escHtml(String(debugSnapshot.nullPriceSample.source || "—"))}
        · HTTP ${escHtml(String(debugSnapshot.nullPriceSample.httpStatus ?? "—"))}
        <br><span style="color:#64748b;">Tick: priceOk=${debugSnapshot.tickSummary.priceOk} priceNull=${debugSnapshot.tickSummary.priceNull} priceErr=${debugSnapshot.tickSummary.priceError} clobOk=${debugSnapshot.tickSummary.clobOk || 0} clob404=${debugSnapshot.tickSummary.clob404 || 0} clobTokenMissing=${debugSnapshot.tickSummary.clobTokenMissing || 0}</span>
      </div>` : ""}
    </div>

    <div class="card" style="margin-top:16px;">
      <h2 style="margin-top:0;">📋 Recent Close Attempts</h2>
      ${recentCloseAttempts.length === 0
        ? '<p style="color:#6b7280;font-size:0.85rem;">No close attempts yet.</p>'
        : `<div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;">
              <thead>
                <tr style="border-bottom:1px solid #1e293b;">
                  <th style="padding:4px 8px;text-align:left;font-size:0.78rem;color:#94a3b8;" title="When the close attempt was made">Time</th>
                  <th style="padding:4px 8px;text-align:left;font-size:0.78rem;color:#94a3b8;" title="Last 6 chars of ticket ID — click to view detail">Ticket</th>
                  <th style="padding:4px 8px;text-align:left;font-size:0.78rem;color:#94a3b8;" title="Why the close was triggered: TP_HIT = take profit reached, EXIT_HIT = stop loss reached, MARKET_ENDED = market ended/closed, MARKET_SETTLED = market outcome resolved">Reason</th>
                  <th style="padding:4px 8px;text-align:left;font-size:0.78rem;color:#94a3b8;" title="Market price at the time of the close attempt">Price</th>
                  <th style="padding:4px 8px;text-align:left;font-size:0.78rem;color:#94a3b8;" title="PAPER_CLOSED = simulated close, INTENT_RECORDED = real close queued, FAILED = close failed">Result</th>
                  <th style="padding:4px 8px;text-align:left;font-size:0.78rem;color:#94a3b8;" title="Error message if the close attempt failed">Error</th>
                </tr>
              </thead>
              <tbody>${attemptRows}</tbody>
            </table>
          </div>`
      }
    </div>
  `;

  const autoSaveEnabled = systemSettings.autoSaveExecuteEnabled || false;
  const autoSaveBadge = autoSaveEnabled
    ? '<span style="background:#166534;color:#bbf7d0;padding:2px 10px;border-radius:8px;font-size:0.82rem;font-weight:600;">ON</span>'
    : '<span style="background:#7f1d1d;color:#fecaca;padding:2px 10px;border-radius:8px;font-size:0.82rem;font-weight:600;">OFF</span>';
  const autoSavePanel = `
    <div class="card" style="margin-top:16px;">
      <h2 style="margin-top:0;">💾 Auto-Save EXECUTE</h2>
      <div class="grid-2" style="gap:8px 24px;">
        <div><span class="label">Auto-Save EXECUTE</span> ${autoSaveBadge}</div>
        <div><span class="label">Auto-saved today</span> <strong>${autoSavedToday}</strong></div>
      </div>
      <div style="margin-top:10px;">
        <button class="sys-toggle-btn" data-field="autoSaveExecuteEnabled" data-value="${autoSaveEnabled ? "false" : "true"}"
          style="background:${autoSaveEnabled ? "#7f1d1d" : "#166534"};color:#fff;border:none;padding:6px 16px;border-radius:6px;font-size:0.82rem;font-weight:600;cursor:pointer;">
          ${autoSaveEnabled ? "Disable" : "Enable"}
        </button>
      </div>
    </div>
  `;

  return `
    <h1>System <span id="tz-label" style="font-size:0.55em;font-weight:400;color:#6b7280;"></span></h1>
    ${renderHealthUi(healthData)}
    ${renderMetricsUi(metrics)}
    ${togglesPanel}
    ${autoSavePanel}
    ${autoModePanel}
    <div class="card">
      <h2 style="margin-top:0;">Quick Links</h2>
      <div class="grid-2">
        <p><a href="/scan" style="color:#60a5fa;font-weight:600;">Run scan</a></p>
        <p><a href="/snapshots" style="color:#60a5fa;font-weight:600;">Snapshots</a></p>
        <p><a href="/health" style="color:#60a5fa;font-weight:600;">Health JSON</a></p>
        <p><a href="/metrics" style="color:#60a5fa;font-weight:600;">Metrics JSON</a></p>
      </div>
    </div>

    <div class="card" style="border: 2px solid #dc2626; margin-top:24px;">
      <h2 style="margin-top:0;color:#dc2626;">⚠️ Danger Zone</h2>
      <p style="font-size:0.82rem;color:#94a3b8;margin:0 0 12px;">
        Destructive actions. Type <strong style="color:#ef4444;">RESET</strong> to unlock. These cannot be undone.
      </p>
      <div id="dz-counts" style="margin-bottom:12px;font-size:0.82rem;color:#94a3b8;">Loading counts…</div>
      <div style="margin-bottom:12px;">
        <label style="font-size:0.82rem;color:#94a3b8;display:block;margin-bottom:4px;">Type RESET to confirm:</label>
        <input id="dz-confirm" type="text" placeholder="RESET" autocomplete="off" spellcheck="false"
          style="width:160px;padding:6px 10px;border-radius:6px;border:2px solid #374151;background:#0f172a;color:#e2e8f0;font-size:0.88rem;font-family:monospace;letter-spacing:0.1em;">
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        <button class="dz-action-btn" data-action="RESET_ALL" disabled
          style="background:#7f1d1d;color:#fecaca;border:none;padding:8px 18px;border-radius:6px;font-size:0.82rem;font-weight:700;cursor:not-allowed;opacity:0.5;">
          🗑 Reset all data
        </button>
        <button class="dz-action-btn" data-action="DELETE_CLOSED" disabled
          style="background:#854d0e;color:#fef3c7;border:none;padding:8px 18px;border-radius:6px;font-size:0.82rem;font-weight:700;cursor:not-allowed;opacity:0.5;">
          🗑 Delete CLOSED only
        </button>
        <button class="dz-action-btn" data-action="DELETE_OPEN" disabled
          style="background:#1e40af;color:#dbeafe;border:none;padding:8px 18px;border-radius:6px;font-size:0.82rem;font-weight:700;cursor:not-allowed;opacity:0.5;">
          🗑 Delete OPEN only
        </button>
        <button class="dz-action-btn" data-action="RESET_TRADES" disabled
          style="background:#9f1239;color:#ffe4e6;border:none;padding:8px 18px;border-radius:6px;font-size:0.82rem;font-weight:700;cursor:not-allowed;opacity:0.5;">
          📊 Reset statistiky (smazat tikety)
        </button>
        <button class="dz-action-btn" data-action="FACTORY_RESET" disabled
          style="background:#581c87;color:#f3e8ff;border:none;padding:8px 18px;border-radius:6px;font-size:0.82rem;font-weight:700;cursor:not-allowed;opacity:0.5;">
          ☢️ Factory reset (vše z nuly)
        </button>
      </div>
      <div id="dz-result" style="margin-top:10px;font-size:0.82rem;display:none;"></div>
    </div>
    <script>
    (function() {
      var confirmInput = document.getElementById("dz-confirm");
      var buttons = document.querySelectorAll(".dz-action-btn");
      var countsEl = document.getElementById("dz-counts");
      var resultEl = document.getElementById("dz-result");

      function updateButtons() {
        var valid = confirmInput && confirmInput.value.trim() === "RESET";
        buttons.forEach(function(btn) {
          btn.disabled = !valid;
          btn.style.opacity = valid ? "1" : "0.5";
          btn.style.cursor = valid ? "pointer" : "not-allowed";
        });
      }

      if (confirmInput) {
        confirmInput.addEventListener("input", updateButtons);
      }

      // Fetch counts
      fetch("/api/system/danger-zone/counts")
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) { countsEl.textContent = "Could not load counts."; return; }
          var html = '<div style="display:flex;flex-wrap:wrap;gap:16px;">';
          html += '<div><strong style="color:#ef4444;">Reset all:</strong> ' + data.RESET_ALL.tickets + ' tickets, ' + data.RESET_ALL.closeAttempts + ' close attempts, ' + data.RESET_ALL.autoSaveLogs + ' auto-save logs</div>';
          html += '<div><strong style="color:#eab308;">CLOSED only:</strong> ' + data.DELETE_CLOSED.tickets + ' tickets, ' + data.DELETE_CLOSED.closeAttempts + ' close attempts</div>';
          html += '<div><strong style="color:#3b82f6;">OPEN only:</strong> ' + data.DELETE_OPEN.tickets + ' tickets</div>';
          html += '<div><strong style="color:#e11d48;">Reset statistiky:</strong> ' + data.RESET_TRADES.tickets + ' tickets, ' + data.RESET_TRADES.closeAttempts + ' close attempts (zachová auto-save logy, scany, snapshoty)</div>';
          html += '<div><strong style="color:#a855f7;">Factory reset:</strong> ' + data.FACTORY_RESET.tickets + ' tickets, ' + data.FACTORY_RESET.closeAttempts + ' close attempts, ' + data.FACTORY_RESET.autoSaveLogs + ' auto-save logs, ' + data.FACTORY_RESET.snapshots + ' snapshots, ' + data.FACTORY_RESET.scans + ' scans</div>';
          html += '</div>';
          countsEl.innerHTML = html;
        })
        .catch(function() { countsEl.textContent = "Could not load counts."; });

      // Action buttons
      buttons.forEach(function(btn) {
        btn.addEventListener("click", function() {
          if (btn.disabled) return;
          var action = btn.getAttribute("data-action");
          var labels = { RESET_ALL: "Reset ALL data", DELETE_CLOSED: "Delete all CLOSED tickets", DELETE_OPEN: "Delete all OPEN tickets", RESET_TRADES: "RESET STATISTIKY — smazat všechny tikety a close attempts (zachová logy, scany, snapshoty)", FACTORY_RESET: "FACTORY RESET — smazat úplně vše a začít z nuly" };
          if (!confirm("Are you sure you want to: " + (labels[action] || action) + "? This cannot be undone.")) return;
          btn.disabled = true;
          btn.textContent = "Working…";
          fetch("/api/system/danger-zone", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: action, confirmation: "RESET" })
          })
          .then(function(r) { return r.json(); })
          .then(function(d) {
            if (d.error) {
              resultEl.style.display = "block";
              resultEl.style.color = "#ef4444";
              resultEl.textContent = "Error: " + d.error;
              btn.textContent = "Error";
              btn.disabled = false;
              updateButtons();
              return;
            }
            resultEl.style.display = "block";
            resultEl.style.color = "#22c55e";
            var parts = [];
            if (d.deleted.tickets !== undefined) parts.push(d.deleted.tickets + " tickets");
            if (d.deleted.closeAttempts !== undefined) parts.push(d.deleted.closeAttempts + " close attempts");
            if (d.deleted.autoSaveLogs !== undefined) parts.push(d.deleted.autoSaveLogs + " auto-save logs");
            if (d.deleted.snapshots !== undefined) parts.push(d.deleted.snapshots + " snapshots");
            if (d.deleted.scans !== undefined) parts.push(d.deleted.scans + " scans");
            if (d.deleted.shownCandidates !== undefined) parts.push(d.deleted.shownCandidates + " shown candidates");
            if (d.deleted.tagCaches !== undefined) parts.push(d.deleted.tagCaches + " tag caches");
            if (d.deleted.monitorLeases !== undefined) parts.push(d.deleted.monitorLeases + " monitor leases");
            resultEl.textContent = "✓ " + action + " complete. Deleted: " + parts.join(", ");
            // Refresh counts
            confirmInput.value = "";
            updateButtons();
            setTimeout(function() { location.reload(); }, 1500);
          })
          .catch(function() {
            resultEl.style.display = "block";
            resultEl.style.color = "#ef4444";
            resultEl.textContent = "Network error";
            btn.disabled = false;
            updateButtons();
          });
        });
      });
    })();
    </script>
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
    })();
    </script>
  `;
}

/** Render the /history page body (closed tickets + stats + equity curve with time filters). */
function renderHistoryPage(closedTickets, activeRange, customFrom, customTo) {
  activeRange = activeRange || "all";

  const extIcon = '<svg class="tk-ext-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3"/><path d="M9 1h6v6"/><path d="M15 1L7 9"/></svg>';

  function pnlCls(val) {
    if (typeof val !== "number") return "pnl-zero";
    return val > 0 ? "pnl-pos" : val < 0 ? "pnl-neg" : "pnl-zero";
  }

  // --- Stats ---
  const closedCount = closedTickets.length;
  const closedWithPnl = closedTickets.filter((t) => typeof t.realizedPnlUsd === "number");
  const realizedPnlSumUsd = closedWithPnl.reduce((s, t) => s + t.realizedPnlUsd, 0);
  const wins = closedWithPnl.filter((t) => t.realizedPnlUsd > 0).length;
  const winRate = closedWithPnl.length > 0 ? (wins / closedWithPnl.length * 100) : 0;
  const autoClosedCount = closedTickets.filter((t) => t.closeReason === "TP_HIT" || t.closeReason === "EXIT_HIT").length;
  const manualClosedCount = closedTickets.filter((t) => t.closeReason === "MANUAL").length;

  // --- Time filter bar ---
  const ranges = [
    { value: "24h", label: "24h" },
    { value: "7d", label: "7d" },
    { value: "30d", label: "30d" },
    { value: "all", label: "All time" },
    { value: "custom", label: "Custom" },
  ];
  const filterBtns = ranges.map((r) => {
    const isActive = r.value === activeRange;
    if (r.value === "custom") {
      return `<a href="#" class="tk-sort-btn${isActive ? " tk-sort-active" : ""}" data-range="custom">Custom</a>`;
    }
    return `<a href="/history?range=${r.value}" class="tk-sort-btn${isActive ? " tk-sort-active" : ""}" style="text-decoration:none;">${r.label}</a>`;
  }).join("");

  const customFormStyle = activeRange === "custom" ? "" : "display:none;";
  const customFromVal = customFrom || "";
  const customToVal = customTo || "";

  const filterBarHtml = `
    <div style="margin:10px 0;padding:10px 12px;background:#1e293b;border-radius:8px;">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:6px;">
        <span style="font-size:0.78rem;color:#94a3b8;font-weight:600;">📅 Period:</span>
        ${filterBtns}
      </div>
      <form id="history-custom-form" method="get" action="/history" style="${customFormStyle}display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px;">
        <input type="hidden" name="range" value="custom">
        <label style="font-size:0.78rem;color:#94a3b8;">From <input type="date" name="from" value="${escHtml(customFromVal)}" style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:4px;padding:3px 6px;font-size:0.82rem;"></label>
        <label style="font-size:0.78rem;color:#94a3b8;">To <input type="date" name="to" value="${escHtml(customToVal)}" style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:4px;padding:3px 6px;font-size:0.82rem;"></label>
        <button type="submit" style="background:#3b82f6;color:#fff;border:none;padding:4px 12px;border-radius:4px;font-size:0.78rem;font-weight:600;cursor:pointer;">Apply</button>
      </form>
    </div>
  `;

  // --- Stats cards ---
  const pnlSign = realizedPnlSumUsd >= 0 ? "+" : "";
  const rangeLabel = activeRange === "all" ? "All time" : activeRange === "custom" ? "Custom range" : "Last " + activeRange;
  const statsHtml = `
    <div class="tk-card">
      <p class="tk-card-title">Archive · ${escHtml(rangeLabel)}</p>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;text-align:center;">
        <div>
          <div style="font-size:0.68rem;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">Total</div>
          <div style="font-size:1.3rem;font-weight:700;font-family:var(--tk-mono);">${closedCount}</div>
        </div>
        <div>
          <div style="font-size:0.68rem;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">Win Rate</div>
          <div style="font-size:1.3rem;font-weight:700;font-family:var(--tk-mono);">${winRate.toFixed(0)}%</div>
          <div style="font-size:0.72rem;color:#94a3b8;">(${wins}/${closedWithPnl.length})</div>
        </div>
        <div>
          <div style="font-size:0.68rem;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">PnL</div>
          <div class="tk-summary-value ${pnlCls(realizedPnlSumUsd)}" style="font-size:1.3rem;">${pnlSign}$${realizedPnlSumUsd.toFixed(2)}</div>
        </div>
      </div>
    </div>
  `;

  // --- Equity chart (reuse logic from tickets page) ---
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

    const niceStep = Math.pow(10, Math.floor(Math.log10(range))) || 1;
    let step = niceStep;
    if (range / step < 3) step = niceStep / 2;
    if (range / step > 6) step = niceStep * 2;
    const yTicks = [];
    for (let v = Math.floor(minVal / step) * step; v <= maxVal + step * 0.01; v += step) {
      yTicks.push(Math.round(v * 100) / 100);
    }

    const xLabels = [];
    const labelIdxs = [0, Math.floor(points.length / 3), Math.floor(2 * points.length / 3), points.length - 1];
    const seen = new Set();
    labelIdxs.forEach((idx) => { if (!seen.has(idx)) { seen.add(idx); xLabels.push(idx); } });

    const yGridLines = yTicks.map((v) =>
      `<line x1="${padL}" y1="${yOf(v).toFixed(1)}" x2="${chartW - padR}" y2="${yOf(v).toFixed(1)}" stroke="#1e293b" stroke-width="0.5"/>`
    ).join("");
    const yLabelsEl = yTicks.map((v) =>
      `<text x="${padL - 6}" y="${yOf(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle" fill="#64748b" font-size="10" font-family="SF Mono,SFMono-Regular,Menlo,Consolas,monospace">$${v}</text>`
    ).join("");
    const xLabelEls = xLabels.map((idx) => {
      const p = points[idx];
      const d = p.rawDate ? new Date(p.rawDate) : null;
      const label = idx === 0 ? "Start" : (d ? `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.` : "");
      return `<text x="${xOf(idx).toFixed(1)}" y="${chartH - 6}" text-anchor="middle" fill="#64748b" font-size="10" font-family="SF Mono,SFMono-Regular,Menlo,Consolas,monospace">${escHtml(label)}</text>`;
    }).join("");

    equityChartHtml = `<div class="tk-card">
      <p class="tk-card-title">Equity Curve · ${escHtml(rangeLabel)}</p>
      <svg viewBox="0 0 ${chartW} ${chartH}" preserveAspectRatio="xMidYMid meet" style="width:100%;height:auto;display:block;">
        ${yGridLines}
        ${yLabelsEl}
        <polygon points="${areaPoints}" fill="${fillColor}" />
        <polyline points="${linePoints}" fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        ${xLabelEls}
      </svg>
    </div>`;
  }

  // --- Search bar ---
  const searchBarHtml = `
    <div style="margin:10px 0;">
      <input id="history-search" type="text" placeholder="Search by name…"
        style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:0.88rem;">
    </div>
  `;

  // --- Sort / filter row ---
  const sortFilterHtml = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;align-items:center;">
      <select id="history-side-filter" style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:4px;padding:4px 8px;font-size:0.78rem;">
        <option value="">All sides</option>
        <option value="BUY_YES">BUY YES</option>
        <option value="BUY_NO">BUY NO</option>
      </select>
      <select id="history-result-filter" style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:4px;padding:4px 8px;font-size:0.78rem;">
        <option value="">All results</option>
        <option value="win">Win</option>
        <option value="loss">Loss</option>
      </select>
      <select id="history-sort" style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:4px;padding:4px 8px;font-size:0.78rem;">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="pnl-high">PnL high → low</option>
        <option value="pnl-low">PnL low → high</option>
      </select>
    </div>
  `;

  // --- Closed ticket card ---
  function historyCard(t) {
    const { headline, subtext } = cardHeadline(t);
    const polyUrl = t.marketUrl || (t.eventSlug
      ? `https://polymarket.com/event/${encodeURIComponent(t.eventSlug)}`
      : null);
    const subtextEl = subtext ? `<div style="font-size:0.78rem;color:#64748b;margin-top:2px;">${escHtml(subtext)}</div>` : "";
    const questionLink = polyUrl
      ? `<span class="tk-q-link" style="cursor:pointer;">${escHtml(headline)} <a href="${escHtml(polyUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation();" style="display:inline;">${extIcon}</a></span>${subtextEl}`
      : `<span class="tk-q-link">${escHtml(headline)}</span>${subtextEl}`;

    const actionLabel = (t.action || "\u2014").replace(/_/g, " ");
    const ticketOutcome = (t.groupItemTitle || "").trim();
    const { displayAction } = formatOutcomeAction(ticketOutcome, actionLabel, t.outcomes);
    const entry = typeof t.entryLimit === "number" ? "$" + t.entryLimit.toFixed(2) : "\u2014";
    const size = typeof t.maxSizeUsd === "number" ? "$" + t.maxSizeUsd.toFixed(2) : "\u2014";

    let pnlBadgeHtml = "";
    let pnlPctHtml = "";
    if (typeof t.realizedPnlUsd === "number") {
      const sign = t.realizedPnlUsd >= 0 ? "+" : "";
      const cls = t.realizedPnlUsd > 0 ? "tk-pnl-pos" : t.realizedPnlUsd < 0 ? "tk-pnl-neg" : "tk-pnl-zero";
      pnlBadgeHtml = `<span class="tk-pnl-badge ${cls}">${sign}$${t.realizedPnlUsd.toFixed(2)}</span>`;
      if (typeof t.realizedPnlPct === "number") {
        pnlPctHtml = `<span style="font-size:0.72rem;color:${t.realizedPnlPct >= 0 ? "#22c55e" : "#ef4444"};font-weight:600;position:absolute;top:38px;right:18px;">${t.realizedPnlPct >= 0 ? "+" : ""}${(t.realizedPnlPct * 100).toFixed(1)}%</span>`;
      }
    }

    const simBadgeHtml = t.isSimulated
      ? '<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:0.68rem;font-weight:700;background:rgba(234,179,8,.18);color:#eab308;margin-left:6px;">SIM</span>'
      : "";

    return `
      <div class="tk-ticket history-card"
         tabindex="0" role="link"
         style="position:relative;cursor:pointer;"
         data-detail-url="/tickets/${escHtml(String(t._id))}"
         data-question="${escHtml(headline.toLowerCase())}"
         data-action="${escHtml(t.action || "")}"
         data-pnl="${typeof t.realizedPnlUsd === "number" ? t.realizedPnlUsd : 0}"
         data-closed-at="${escHtml(t.closedAt || t.createdAt || "")}">
        <div style="padding-right:80px;">${questionLink}</div>
        ${pnlBadgeHtml}
        ${pnlPctHtml}
        <div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:0.78rem;color:#64748b;">
          <span>Entry (ask) ${entry}</span>
          <span>·</span>
          <span>${escHtml(displayAction)}${simBadgeHtml}</span>
          <span>·</span>
          <span>${size}</span>
          <span style="margin-left:auto;">${utcSpan(t.closedAt || t.createdAt)}</span>
          <span style="color:#60a5fa;">→</span>
        </div>
      </div>
    `;
  }

  const listHtml = closedTickets.length === 0
    ? '<p class="tk-empty">No closed tickets in this period.</p>'
    : closedTickets.map((t) => historyCard(t)).join("");

  return `
    <div class="tk-page">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;">
        <a href="/tickets" style="color:#60a5fa;text-decoration:none;font-size:0.88rem;">\u{2190} Back</a>
        <h1 style="margin:0;font-size:1.2rem;">Archive</h1>
        <span class="tk-badge" style="margin-left:4px;">${closedCount}</span>
      </div>
      ${filterBarHtml}
      ${statsHtml}
      ${equityChartHtml}
      ${searchBarHtml}
      ${sortFilterHtml}
      <div style="font-size:0.78rem;color:#64748b;margin-bottom:8px;">${closedCount} positions</div>
      <div id="history-list">${listHtml}</div>
    </div>
    <script>
    (function() {

      // Navigate to detail on card click (excluding inner links)
      var listEl = document.getElementById("history-list");
      if (listEl) {
        function navigateCard(e) {
          var card = e.target.closest(".history-card");
          if (!card) return;
          if (e.target.closest("a[target]") || e.target.closest("button")) return;
          var url = card.getAttribute("data-detail-url");
          if (url) window.location.href = url;
        }
        listEl.addEventListener("click", navigateCard);
        listEl.addEventListener("keydown", function(e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            navigateCard(e);
          }
        });
      }

      // Custom range toggle
      var customBtn = document.querySelector('[data-range="custom"]');
      var customForm = document.getElementById("history-custom-form");
      if (customBtn && customForm) {
        customBtn.addEventListener("click", function(e) {
          e.preventDefault();
          customForm.style.display = customForm.style.display === "none" ? "flex" : "none";
        });
      }

      // Client-side search + filter
      var searchInput = document.getElementById("history-search");
      var sideFilter = document.getElementById("history-side-filter");
      var resultFilter = document.getElementById("history-result-filter");
      var sortSelect = document.getElementById("history-sort");
      var listEl = document.getElementById("history-list");

      function applyFilters() {
        if (!listEl) return;
        var cards = Array.prototype.slice.call(listEl.querySelectorAll(".history-card"));
        var query = (searchInput ? searchInput.value : "").toLowerCase().trim();
        var side = sideFilter ? sideFilter.value : "";
        var result = resultFilter ? resultFilter.value : "";

        cards.forEach(function(c) {
          var q = c.getAttribute("data-question") || "";
          var a = c.getAttribute("data-action") || "";
          var pnl = parseFloat(c.getAttribute("data-pnl") || "0");
          var show = true;
          if (query && q.indexOf(query) === -1) show = false;
          if (side && a !== side) show = false;
          if (result === "win" && pnl <= 0) show = false;
          if (result === "loss" && pnl >= 0) show = false;
          c.style.display = show ? "" : "none";
        });

        // Sort
        var sort = sortSelect ? sortSelect.value : "newest";
        var visible = cards.filter(function(c) { return c.style.display !== "none"; });
        visible.sort(function(a, b) {
          if (sort === "pnl-high") return parseFloat(b.getAttribute("data-pnl")) - parseFloat(a.getAttribute("data-pnl"));
          if (sort === "pnl-low") return parseFloat(a.getAttribute("data-pnl")) - parseFloat(b.getAttribute("data-pnl"));
          if (sort === "oldest") return new Date(a.getAttribute("data-closed-at")) - new Date(b.getAttribute("data-closed-at"));
          return new Date(b.getAttribute("data-closed-at")) - new Date(a.getAttribute("data-closed-at"));
        });
        visible.forEach(function(c) { listEl.appendChild(c); });
      }

      if (searchInput) searchInput.addEventListener("input", applyFilters);
      if (sideFilter) sideFilter.addEventListener("change", applyFilters);
      if (resultFilter) resultFilter.addEventListener("change", applyFilters);
      if (sortSelect) sortSelect.addEventListener("change", applyFilters);
    })();
    </script>
  `;
}

/** Render the /tickets page body — ACTIVE only (OPEN/CLOSING/ERROR). */
function renderTicketsPage(tickets, highlightId, filterCtx) {
  filterCtx = filterCtx || {};
  const activeBlockedReason = filterCtx.blockedReason || null;
  const activeMonitorReason = filterCtx.monitorReason || null;
  const hasActiveFilter = !!(activeBlockedReason || activeMonitorReason);
  const closedCount = filterCtx.closedCount || 0;
  const realizedPnlSumUsd = filterCtx.realizedPnlSumUsd || 0;
  const winRate = filterCtx.winRate || 0;
  // Only active tickets
  const openTickets = tickets.filter((t) => t.status === "OPEN" || t.status === "CLOSING" || t.status === "ERROR").sort((a, b) => {
    const ea = a.endDate ? new Date(a.endDate).getTime() : Infinity;
    const eb = b.endDate ? new Date(b.endDate).getTime() : Infinity;
    return ea - eb;
  });
  const openCount = openTickets.length;

  const extIcon = '<svg class="tk-ext-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3"/><path d="M9 1h6v6"/><path d="M15 1L7 9"/></svg>';

  // --- Deterministic category icon ---
  const CATEGORY_ICONS = {
    sports: "\u26BD", crypto: "\u{1FA99}", politics: "\u{1F3DB}", science: "\u{1F52C}",
    entertainment: "\u{1F3AC}", finance: "\u{1F4B9}", tech: "\u{1F4BB}", weather: "\u{1F326}",
    culture: "\u{1F3A8}", "pop-culture": "\u{1F3A4}", economics: "\u{1F4CA}",
    soccer: "\u26BD", basketball: "\u{1F3C0}", baseball: "\u26BE", hockey: "\u{1F3D2}",
    football: "\u{1F3C8}", tennis: "\u{1F3BE}", mma: "\u{1F94A}", boxing: "\u{1F94A}",
    esports: "\u{1F3AE}", "current-affairs": "\u{1F4F0}",
  };
  function categoryIcon(t) {
    const cat = ((t.category || "") + " " + (t.subcategory || "")).toLowerCase().trim();
    const tags = (t.reasonCodes || []).concat(t.tagSlugs || []).map((s) => s.toLowerCase());
    for (const key of Object.keys(CATEGORY_ICONS)) {
      if (cat.indexOf(key) !== -1 || tags.some((tag) => tag.indexOf(key) !== -1)) return CATEGORY_ICONS[key];
    }
    return "\u{1F4CA}"; // default chart icon
  }

  // --- Compact summary ---
  const pnlSign = realizedPnlSumUsd >= 0 ? "+" : "";
  const pnlColor = realizedPnlSumUsd > 0 ? "#22c55e" : realizedPnlSumUsd < 0 ? "#ef4444" : "#94a3b8";
  const summaryHtml = `
    <div class="tk-card" style="padding:14px 16px;">
      <p class="tk-card-title" style="margin-bottom:8px;">Portfolio Overview</p>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;text-align:center;">
        <div>
          <div style="font-size:0.62rem;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">\u{1F4CA} Open</div>
          <div style="font-size:1.15rem;font-weight:700;">${openCount}</div>
        </div>
        <div>
          <div style="font-size:0.62rem;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">\u{2705} Closed</div>
          <div style="font-size:1.15rem;font-weight:700;">${closedCount}</div>
        </div>
        <div>
          <div style="font-size:0.62rem;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">\u{1F4C8} Realized PnL</div>
          <div style="font-size:1.15rem;font-weight:700;color:${pnlColor};">${pnlSign}$${realizedPnlSumUsd.toFixed(2)}</div>
        </div>
        <div>
          <div style="font-size:0.62rem;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;">\u{1F3AF} Win rate</div>
          <div style="font-size:1.15rem;font-weight:700;">${winRate.toFixed(1)}%</div>
        </div>
      </div>
    </div>
  `;

  // --- Reason filter (inline, for combined filter+sort bar) ---
  const allReasonCodes = Object.keys(DIAGNOSTIC_REASONS);
  const filterBarInlineHtml = `
      <select id="tk-reason-filter" style="background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:4px 8px;font-size:0.72rem;margin-right:4px;">
        <option value="">\u{1F50D} All tickets</option>
        <optgroup label="Blocked (autoClose)">
          ${allReasonCodes.filter((r) => DIAGNOSTIC_REASONS[r].queryParam === "blockedReason").map((r) => {
            const sel = activeBlockedReason === r ? " selected" : "";
            return `<option value="blockedReason:${escHtml(r)}"${sel}>${escHtml(DIAGNOSTIC_REASONS[r].label)}</option>`;
          }).join("")}
        </optgroup>
        <optgroup label="Monitor (runtime)">
          ${allReasonCodes.filter((r) => DIAGNOSTIC_REASONS[r].queryParam === "monitorReason").map((r) => {
            const sel = activeMonitorReason === r ? " selected" : "";
            return `<option value="monitorReason:${escHtml(r)}"${sel}>${escHtml(DIAGNOSTIC_REASONS[r].label)}</option>`;
          }).join("")}
        </optgroup>
      </select>
      ${hasActiveFilter ? '<a href="/tickets" style="color:#60a5fa;font-size:0.72rem;text-decoration:none;margin-right:4px;">\u2715</a>' : ""}
  `;

  // --- Reason badges ---
  function reasonBadgesHtml(t) {
    const badges = [];
    if (t.autoCloseBlockedReason) {
      const info = DIAGNOSTIC_REASONS[t.autoCloseBlockedReason] || {};
      badges.push(`<span style="display:inline-block;padding:1px 5px;border-radius:3px;background:#7f1d1d;color:#fecaca;font-size:0.68rem;font-weight:600;" title="${escHtml(info.explanation || t.autoCloseBlockedReason)}">\u26D4 ${escHtml(t.autoCloseBlockedReason)}</span>`);
    }
    if (t.lastMonitorBlockedReason) {
      const info = DIAGNOSTIC_REASONS[t.lastMonitorBlockedReason] || {};
      badges.push(`<span style="display:inline-block;padding:1px 5px;border-radius:3px;background:#854d0e;color:#fef08a;font-size:0.68rem;font-weight:600;" title="${escHtml(info.explanation || t.lastMonitorBlockedReason)}">\u26A0 ${escHtml(t.lastMonitorBlockedReason)}</span>`);
    }
    return badges.length > 0 ? badges.join(" ") : "";
  }

  // --- Compact active ticket card ---
  function compactTicketCard(t) {
    const isExec = t.tradeability === "EXECUTE";
    const { headline, subtext } = cardHeadline(t);
    const polyUrl = t.marketUrl || (t.eventSlug
      ? `https://polymarket.com/event/${encodeURIComponent(t.eventSlug)}`
      : null);
    const icon = categoryIcon(t);

    // Action label
    const actionLabel = (t.action || "\u2014").replace(/_/g, " ");
    const ticketOutcome = (t.groupItemTitle || "").trim();
    const { displayAction } = formatOutcomeAction(ticketOutcome, actionLabel, t.outcomes);

    // Entry price
    const entry = typeof t.entryLimit === "number" ? "$" + t.entryLimit.toFixed(2) : "";
    const size = typeof t.maxSizeUsd === "number" ? "$" + t.maxSizeUsd.toFixed(0) : "";

    // Time remaining
    const ticketEndDate = t.endDate || "";
    const ticketHoursLeft = ticketEndDate ? ((new Date(ticketEndDate).getTime() - Date.now()) / (1000 * 60 * 60)) : null;
    const timeLeftLabel = ticketHoursLeft !== null && Number.isFinite(ticketHoursLeft)
      ? (ticketHoursLeft <= 0 ? "ended" : formatHoursLeft(ticketHoursLeft))
      : "";
    const timeLeftCls = ticketHoursLeft !== null && ticketHoursLeft <= 24 && ticketHoursLeft > 0 ? "color:#f59e0b;font-weight:600;" : "color:#64748b;";

    // Created date
    const createdLabel = t.createdAt ? utcSpan(t.createdAt) : "";

    // Status badge for non-OPEN
    const statusBadge = t.status !== "OPEN"
      ? `<span style="display:inline-block;padding:1px 5px;border-radius:3px;background:${t.status === "ERROR" ? "#7f1d1d" : "#854d0e"};color:${t.status === "ERROR" ? "#fecaca" : "#fef3c7"};font-size:0.68rem;font-weight:600;">${escHtml(t.status)}</span>`
      : "";

    // Auto-close indicator
    const acIndicator = isExec
      ? (t.autoCloseEnabled
        ? '<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:0.72rem;font-weight:600;background:rgba(34,197,94,.15);color:#22c55e;" title="Auto-close ON">\u{1F916} ON</span>'
        : '<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:0.72rem;font-weight:600;background:rgba(100,116,139,.15);color:#94a3b8;" title="Auto-close OFF">\u{1F916} OFF</span>')
      : "";

    const reasonBadges = reasonBadgesHtml(t);
    const isHighlighted = highlightId && String(t._id) === highlightId;
    const hlCls = isHighlighted ? " tk-highlight" : "";

    // Quick actions (icons)
    const detailUrl = `/tickets/${escHtml(String(t._id))}`;
    const copyUrlAttr = polyUrl ? `data-copy-url="${escHtml(polyUrl)}"` : "";

    return `
      <div class="tk-ticket${hlCls}" id="ticket-${escHtml(String(t._id))}" style="position:relative;padding:10px 14px;" data-end-date="${escHtml(t.endDate || "")}" data-created-at="${escHtml(t.createdAt || "")}" data-autoclose="${isExec ? (t.autoCloseEnabled ? "1" : "0") : ""}">
        <div style="display:flex;align-items:flex-start;gap:10px;">
          <span style="font-size:1.3rem;line-height:1;flex-shrink:0;margin-top:2px;">${icon}</span>
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              <span style="font-size:0.88rem;font-weight:600;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:calc(100% - 80px);">${escHtml(headline)}</span>
              ${statusBadge}
              ${acIndicator}
            </div>
            ${subtext ? `<div style="font-size:0.72rem;color:#64748b;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(subtext)}</div>` : ""}
            <div style="display:flex;align-items:center;gap:6px;margin-top:4px;font-size:0.75rem;flex-wrap:wrap;">
              <span style="color:#94a3b8;">${escHtml(displayAction)}</span>
              ${entry ? `<span style="color:#e2e8f0;font-weight:600;font-family:var(--tk-mono);">${entry}</span>` : ""}
              ${size ? `<span style="color:#64748b;">\u00B7 ${size}</span>` : ""}
              ${timeLeftLabel ? `<span style="${timeLeftCls}">\u23F3 ${escHtml(timeLeftLabel)}</span>` : ""}
              ${createdLabel ? `<span style="color:#64748b;">\u{1F4C5} ${createdLabel}</span>` : ""}
              ${reasonBadges ? `<span>${reasonBadges}</span>` : ""}
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
            ${polyUrl ? `<a href="${escHtml(polyUrl)}" target="_blank" rel="noopener" style="color:#64748b;font-size:1.25rem;text-decoration:none;padding:6px;" title="Open on Polymarket">\u{1F517}</a>` : ""}
            ${copyUrlAttr ? `<button ${copyUrlAttr} style="background:none;border:none;color:#64748b;font-size:1.25rem;cursor:pointer;padding:6px;" title="Copy URL">\u{1F4CB}</button>` : ""}
            <a href="${detailUrl}" style="color:#60a5fa;font-size:1.25rem;text-decoration:none;padding:6px;" title="Detail">\u{276F}</a>
          </div>
        </div>
      </div>
    `;
  }

  const openListHtml = openTickets.length === 0
    ? '<p class="tk-empty">No open tickets.</p>'
    : openTickets.map((t) => compactTicketCard(t)).join("");

  // --- Archive link card ---
  const archiveCardHtml = `
    <a href="/history" class="tk-ticket" style="display:flex;align-items:center;gap:12px;padding:12px 16px;text-decoration:none;margin-top:10px;">
      <span style="font-size:1.3rem;">\u{1F4E6}</span>
      <div style="flex:1;">
        <div style="font-size:0.88rem;font-weight:600;color:#e2e8f0;">Archive of closed positions</div>
        <div style="font-size:0.75rem;color:#64748b;">${closedCount} positions \u00B7 filtering, search</div>
      </div>
      <span class="tk-badge" style="flex-shrink:0;">${closedCount}</span>
      <span style="color:#60a5fa;font-size:0.88rem;">\u{276F}</span>
    </a>
  `;

  return `
    <div class="tk-page">
      ${summaryHtml}
      <div class="tk-section-hdr">OPEN <span class="tk-badge">${openCount}</span>
        <span class="tk-sort-row">
          ${filterBarInlineHtml}
          <button class="tk-sort-btn tk-sort-active" data-sort="end" data-section="open" title="Sort by end date">End \u2191</button>
          <button class="tk-sort-btn" data-sort="saved" data-section="open" title="Sort by date created">Created \u2191</button>
          <button class="tk-sort-btn" data-sort="autoclose" data-section="open" title="Sort by AutoClose status">AutoClose</button>
        </span>
      </div>
      <div style="margin-bottom:10px;text-align:right;padding:0 4px;">
        <button id="tk-autoclose-all-btn" style="background:#166534;color:#fff;border:none;padding:5px 14px;border-radius:5px;font-size:0.75rem;font-weight:600;cursor:pointer;margin-right:6px;" data-value="true" title="Enable AutoClose for all open tickets">Enable All AutoClose</button>
        <button id="tk-autoclose-none-btn" style="background:#7f1d1d;color:#fff;border:none;padding:5px 14px;border-radius:5px;font-size:0.75rem;font-weight:600;cursor:pointer;" data-value="false" title="Disable AutoClose for all open tickets">Disable All AutoClose</button>
      </div>
      <div id="tk-open-list">${openListHtml}</div>
      ${archiveCardHtml}
    </div>
    <script>
    (function() {
      // --- Reason filter dropdown ---
      var filterEl = document.getElementById("tk-reason-filter");
      if (filterEl) {
        filterEl.addEventListener("change", function() {
          var val = filterEl.value;
          if (!val) { window.location.href = "/tickets"; return; }
          var parts = val.split(":");
          window.location.href = "/tickets?" + encodeURIComponent(parts[0]) + "=" + encodeURIComponent(parts[1]);
        });
      }

      // --- Bulk Enable/Disable All AutoClose ---
      function handleBulkAutoClose(value) {
        return function(e) {
          var btn = e.target;
          btn.disabled = true;
          btn.textContent = "Saving\u2026";
          fetch("/api/tickets/autoclose-all", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ autoCloseEnabled: value }),
          }).then(function(r) { return r.json(); }).then(function(d) {
            if (d.error) { btn.textContent = "Error"; btn.disabled = false; alert(d.error); return; }
            location.reload();
          }).catch(function() { btn.textContent = "Error"; btn.disabled = false; });
        };
      }
      var enableAllBtn = document.getElementById("tk-autoclose-all-btn");
      var disableAllBtn = document.getElementById("tk-autoclose-none-btn");
      if (enableAllBtn) enableAllBtn.addEventListener("click", handleBulkAutoClose(true));
      if (disableAllBtn) disableAllBtn.addEventListener("click", handleBulkAutoClose(false));

      // --- Sort toggle ---
      function sortContainer(containerId, sortKey, ascending) {
        var container = document.getElementById(containerId);
        if (!container) return;
        var cards = Array.prototype.slice.call(container.querySelectorAll(".tk-ticket"));
        if (cards.length === 0) return;
        cards.sort(function(a, b) {
          var va, vb;
          if (sortKey === "end") {
            va = a.getAttribute("data-end-date") ? new Date(a.getAttribute("data-end-date")).getTime() : Infinity;
            vb = b.getAttribute("data-end-date") ? new Date(b.getAttribute("data-end-date")).getTime() : Infinity;
          } else if (sortKey === "autoclose") {
            va = a.getAttribute("data-autoclose") === "1" ? 1 : 0;
            vb = b.getAttribute("data-autoclose") === "1" ? 1 : 0;
          } else {
            va = a.getAttribute("data-created-at") ? new Date(a.getAttribute("data-created-at")).getTime() : 0;
            vb = b.getAttribute("data-created-at") ? new Date(b.getAttribute("data-created-at")).getTime() : 0;
          }
          return ascending ? va - vb : vb - va;
        });
        cards.forEach(function(c) { container.appendChild(c); });
      }

      var sortState = { open: { key: "end", asc: true } };

      document.addEventListener("click", function(e) {
        var sortBtn = e.target.closest(".tk-sort-btn");
        if (!sortBtn) return;
        var section = sortBtn.getAttribute("data-section");
        var key = sortBtn.getAttribute("data-sort");
        var containerId = "tk-open-list";
        var state = sortState[section] || sortState.open;
        if (state.key === key) {
          state.asc = !state.asc;
        } else {
          state.key = key;
          state.asc = key === "end";
        }
        sortContainer(containerId, state.key, state.asc);
        var row = sortBtn.parentElement;
        var btns = row.querySelectorAll(".tk-sort-btn");
        btns.forEach(function(b) {
          b.classList.remove("tk-sort-active");
          var bKey = b.getAttribute("data-sort");
          var label = bKey === "end" ? "End" : bKey === "autoclose" ? "AutoClose" : "Created";
          if (bKey === state.key) {
            b.classList.add("tk-sort-active");
            b.textContent = label + (state.asc ? " \u2191" : " \u2193");
          } else {
            b.textContent = label;
          }
        });
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
    })();
    </script>
  `;
}

// ---------------------------------------------------------------------------
// Ticket Detail Page
// ---------------------------------------------------------------------------
function renderTicketDetailPage(ticket, prevId, nextId) {
  const t = ticket;
  const isExec = t.tradeability === "EXECUTE";
  const isClosed = t.status === "CLOSED";

  function pnlCls(val) {
    if (typeof val !== "number") return "";
    return val > 0 ? "pnl-pos" : val < 0 ? "pnl-neg" : "";
  }

  const extIcon = '<svg style="width:12px;height:12px;vertical-align:middle;margin-left:3px;" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2H3a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3"/><path d="M9 1h6v6"/><path d="M15 1L7 9"/></svg>';

  // Navigation
  const prevLink = prevId
    ? `<a href="/tickets/${escHtml(String(prevId))}" style="color:#60a5fa;text-decoration:none;font-size:0.85rem;" title="Previous ticket">\u{2190} Prev</a>`
    : '<span style="color:#374151;font-size:0.85rem;">\u{2190} Prev</span>';
  const nextLink = nextId
    ? `<a href="/tickets/${escHtml(String(nextId))}" style="color:#60a5fa;text-decoration:none;font-size:0.85rem;" title="Next ticket">Next \u{2192}</a>`
    : '<span style="color:#374151;font-size:0.85rem;">Next \u{2192}</span>';

  // Headline
  const { headline, subtext } = cardHeadline(t);
  const polyUrl = t.marketUrl || (t.eventSlug
    ? `https://polymarket.com/event/${encodeURIComponent(t.eventSlug)}`
    : null);
  const headlineHtml = polyUrl
    ? `<a href="${escHtml(polyUrl)}" target="_blank" rel="noopener" style="color:#e2e8f0;text-decoration:none;font-size:1.1rem;font-weight:700;">${escHtml(headline)} ${extIcon}</a>`
    : `<span style="color:#e2e8f0;font-size:1.1rem;font-weight:700;">${escHtml(headline)}</span>`;
  const subtextHtml = subtext ? `<div style="font-size:0.82rem;color:#64748b;margin-top:2px;">${escHtml(subtext)}</div>` : "";

  // Action display
  const actionLabel = (t.action || "\u2014").replace(/_/g, " ");
  const ticketOutcome = (t.groupItemTitle || "").trim();
  const { displayLabel, displayAction } = formatOutcomeAction(ticketOutcome, actionLabel, t.outcomes);
  const actionDisplay = displayLabel ? displayLabel + " " + displayAction : displayAction;
  const pillIcon = isExec ? "\u26A1" : "\uD83D\uDC41";
  const pillCls = isExec ? "background:#166534;color:#bbf7d0;" : "background:#374151;color:#94a3b8;";
  const entryAtPrice = typeof t.entryLimit === "number" ? ` @ $${t.entryLimit.toFixed(2)} (ask)` : "";

  // Status badge
  const statusColors = { OPEN: "#166534", CLOSING: "#854d0e", CLOSED: "#374151", ERROR: "#7f1d1d" };
  const statusBg = statusColors[t.status] || "#374151";

  // Close reason badge
  const closeReasonLabels = { TP_HIT: "\u{1F916} TP Hit (auto)", EXIT_HIT: "\u{1F916} Exit Hit (auto)", MANUAL: "\u{1F590} Manual", ERROR: "\u{26A0} Error" };
  const closeReasonHtml = t.closeReason
    ? `<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:#1e293b;color:#94a3b8;font-size:0.78rem;font-weight:600;">${closeReasonLabels[t.closeReason] || escHtml(t.closeReason)}</span>`
    : "";

  // PnL
  let pnlHtml = "";
  if (typeof t.realizedPnlUsd === "number") {
    const sign = t.realizedPnlUsd >= 0 ? "+" : "";
    const cls = pnlCls(t.realizedPnlUsd);
    const pctStr = typeof t.realizedPnlPct === "number" ? ` (${t.realizedPnlPct >= 0 ? "+" : ""}${(t.realizedPnlPct * 100).toFixed(1)}%)` : "";
    pnlHtml = `<div class="td-row"><span class="td-label">Realized PnL</span><span class="td-val ${cls}" style="font-weight:700;">${sign}$${t.realizedPnlUsd.toFixed(2)}${pctStr}</span></div>`;
  }

  // Reason codes / signal tags
  const reasonTagColors = { momentum: "#2563eb", breakout: "#7c3aed", mispricing: "#dc2626", reversal: "#d97706", novel: "#0891b2", "near-expiry": "#c2410c", filtered: "#6b7280" };
  const reasonTagsHtml = (t.reasonCodes || []).length > 0
    ? (t.reasonCodes || []).map((r) => {
        const bg = reasonTagColors[r] || "#6b7280";
        return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${bg};color:#fff;font-size:0.75rem;font-weight:600;margin-right:4px;margin-bottom:4px;">${escHtml(r)}</span>`;
      }).join("")
    : '<span style="color:#6b7280;font-size:0.82rem;">—</span>';

  // Time remaining
  const ticketEndDate = t.endDate || "";
  const ticketHoursLeft = ticketEndDate ? ((new Date(ticketEndDate).getTime() - Date.now()) / (1000 * 60 * 60)) : null;
  const timeLeftLabel = ticketHoursLeft !== null && Number.isFinite(ticketHoursLeft)
    ? (ticketHoursLeft <= 0 ? "ended" : formatHoursLeft(ticketHoursLeft) + " left")
    : "\u2014";

  // Optional fields — never render null/invalid as "$0.00"
  const fmtPrice = (v) => (Number.isFinite(v) && v > 0) ? "$" + v.toFixed(2) : "\u2014";
  const fmtPct = (v) => typeof v === "number" ? (v * 100).toFixed(1) + "%" : "\u2014";
  const fmtUsd = (v) => typeof v === "number" ? "$" + v.toFixed(2) : "\u2014";

  // Auto-close fields
  let autoCloseHtml = "";
  if (isExec) {
    const acEnabled = t.autoCloseEnabled ? "ON" : "OFF";
    const acBg = t.autoCloseEnabled ? "#166534" : "#374151";
    const acColor = t.autoCloseEnabled ? "#bbf7d0" : "#9ca3af";
    const lastPrice = typeof t.lastObservedPrice === "number" ? "$" + t.lastObservedPrice.toFixed(4) : "\u2014";
    const lastCheck = t.lastPriceCheckAt ? utcSpan(t.lastPriceCheckAt) : "\u2014";
    const intentAt = t.autoCloseIntentAt ? utcSpan(t.autoCloseIntentAt) : "\u2014";
    const intentReason = t.autoCloseIntentReason || "\u2014";
    const blockedReasonInfo = t.autoCloseBlockedReason ? DIAGNOSTIC_REASONS[t.autoCloseBlockedReason] || {} : null;
    const monitorReasonInfo = t.lastMonitorBlockedReason ? DIAGNOSTIC_REASONS[t.lastMonitorBlockedReason] || {} : null;
    const blockedBadgeHtml = t.autoCloseBlockedReason
      ? `<div class="td-row"><span class="td-label">Blocked reason</span><span style="display:inline-block;padding:1px 6px;border-radius:4px;background:#7f1d1d;color:#fecaca;font-size:0.75rem;font-weight:600;">⛔ ${escHtml(t.autoCloseBlockedReason)}</span></div>
         ${blockedReasonInfo.explanation ? `<div class="td-row"><span class="td-label"></span><span class="td-val" style="font-size:0.75rem;color:#94a3b8;">${escHtml(blockedReasonInfo.explanation)}</span></div>` : ""}
         ${blockedReasonInfo.whatToDo ? `<div class="td-row"><span class="td-label"></span><span class="td-val" style="font-size:0.75rem;color:#818cf8;">→ ${escHtml(blockedReasonInfo.whatToDo)}</span></div>` : ""}`
      : "";
    const monitorBadgeHtml = t.lastMonitorBlockedReason
      ? `<div class="td-row"><span class="td-label">Monitor reason</span><span style="display:inline-block;padding:1px 6px;border-radius:4px;background:#854d0e;color:#fef08a;font-size:0.75rem;font-weight:600;">⚠ ${escHtml(t.lastMonitorBlockedReason)}</span>${t.lastMonitorBlockedAt ? ` <span style="font-size:0.72rem;color:#64748b;">${utcSpan(t.lastMonitorBlockedAt)}</span>` : ""}</div>
         ${monitorReasonInfo.explanation ? `<div class="td-row"><span class="td-label"></span><span class="td-val" style="font-size:0.75rem;color:#94a3b8;">${escHtml(monitorReasonInfo.explanation)}</span></div>` : ""}
         ${monitorReasonInfo.whatToDo ? `<div class="td-row"><span class="td-label"></span><span class="td-val" style="font-size:0.75rem;color:#818cf8;">→ ${escHtml(monitorReasonInfo.whatToDo)}</span></div>` : ""}`
      : "";
    autoCloseHtml = `
      <div class="td-section">
        <div class="td-section-title">\u{1F916} Auto-Close</div>
        <div class="td-row"><span class="td-label">Auto-close</span><span style="display:inline-block;padding:1px 6px;border-radius:4px;background:${acBg};color:${acColor};font-size:0.75rem;font-weight:600;">${acEnabled}</span></div>
        ${blockedBadgeHtml}
        ${monitorBadgeHtml}
        <div class="td-row"><span class="td-label">Last observed price</span><span class="td-val">${lastPrice}</span></div>
        <div class="td-row"><span class="td-label">Last price check</span><span class="td-val">${lastCheck}</span></div>
        <div class="td-row"><span class="td-label">Intent at</span><span class="td-val">${intentAt}</span></div>
        <div class="td-row"><span class="td-label">Intent reason</span><span class="td-val">${escHtml(intentReason)}</span></div>
      </div>`;
  }

  return `
    <div class="td-page">
      <div class="td-nav-row">
        ${prevLink}
        <a href="/tickets" style="color:#60a5fa;text-decoration:none;font-size:0.85rem;">\u{2190} Back to Tickets</a>
        ${nextLink}
      </div>

      <div class="td-card">
        <div class="td-header">
          ${headlineHtml}
          ${subtextHtml}
        </div>

        <div style="margin:10px 0;">
          <span style="display:inline-block;padding:3px 10px;border-radius:6px;${pillCls}font-size:0.82rem;font-weight:700;">${pillIcon} ${escHtml(actionDisplay)}${entryAtPrice}</span>
          <span style="display:inline-block;padding:3px 10px;border-radius:6px;background:${statusBg};color:#fff;font-size:0.78rem;font-weight:600;margin-left:6px;">${escHtml(t.status)}</span>
          ${t.isSimulated ? '<span style="display:inline-block;padding:3px 10px;border-radius:6px;background:#854d0e;color:#fef3c7;font-size:0.78rem;font-weight:600;margin-left:6px;">SIM</span>' : ""}
          ${closeReasonHtml ? `<span style="margin-left:6px;">${closeReasonHtml}</span>` : ""}
        </div>

        <div class="td-section">
          <div class="td-section-title">\u{1F4CA} Signal Tags</div>
          <div style="margin-bottom:8px;">${reasonTagsHtml}</div>
        </div>

        ${t.whyNow ? `<div class="td-section">
          <div class="td-section-title">\u{26A1} Why Now</div>
          <div style="color:#e2e8f0;font-size:0.88rem;">${escHtml(t.whyNow)}</div>
        </div>` : ""}

        ${t.whyWatch ? `<div class="td-section">
          <div class="td-section-title">\u{1F440} Why Watch</div>
          <div style="color:#e2e8f0;font-size:0.88rem;">${escHtml(t.whyWatch)}</div>
        </div>` : ""}

        ${t.nextStep ? `<div class="td-section">
          <div class="td-section-title">\u{27A1} Next Step</div>
          <div style="color:#e2e8f0;font-size:0.88rem;">${escHtml(t.nextStep)}</div>
        </div>` : ""}

        <div class="td-section">
          <div class="td-section-title">\u{1F4B0} Trade Plan</div>
          <div class="td-grid">
            <div class="td-row"><span class="td-label">Entry (ask)</span><span class="td-val">${fmtPrice(t.entryLimit)}</span></div>
            <div class="td-row"><span class="td-label">Entry closeable (bid)</span><span class="td-val">${fmtPrice(t.entryBid)}</span></div>
            <div class="td-row"><span class="td-label">Take Profit</span><span class="td-val" id="td-tp-val">${fmtPrice(t.takeProfit)}${!isClosed ? ' <span class="tk-edit-icon" data-edit-field="takeProfit" title="Edit Take Profit">\u{270F}\u{FE0F}</span>' : ""}</span></div>
            <div class="td-row"><span class="td-label">Exit / risk</span><span class="td-val" id="td-exit-val">${fmtPrice(t.riskExitLimit)}${!isClosed ? ' <span class="tk-edit-icon" data-edit-field="riskExitLimit" title="Edit Exit (risk)">\u{270F}\u{FE0F}</span>' : ""}</span></div>
            <div class="td-row"><span class="td-label">Size (USD)</span><span class="td-val">${fmtUsd(t.maxSizeUsd)}</span></div>
            <div class="td-row"><span class="td-label">Bankroll</span><span class="td-val">${fmtUsd(t.bankrollUsd)}</span></div>
            <div class="td-row"><span class="td-label">Risk %</span><span class="td-val">${fmtPct(t.riskPct)}</span></div>
            <div class="td-row"><span class="td-label">Max trade cap</span><span class="td-val">${fmtUsd(t.maxTradeCapUsd)}</span></div>
            <div class="td-row"><span class="td-label">Min limit order</span><span class="td-val">${fmtUsd(t.minLimitOrderUsd)}</span></div>
            ${typeof t.entrySpreadPct === "number" ? `<div class="td-row"><span class="td-label">Entry spread</span><span class="td-val">${(t.entrySpreadPct * 100).toFixed(1)}%</span></div>` : ""}
          </div>
        </div>

        <div class="td-section">
          <div class="td-section-title">\u{1F4C8} Projected PnL</div>
          <div class="td-grid">
            <div class="td-row"><span class="td-label">PnL if TP hit</span><span class="td-val">${fmtUsd(t.pnlTpUsd)}${typeof t.pnlTpPct === "number" ? " (" + fmtPct(t.pnlTpPct) + ")" : ""}</span></div>
            <div class="td-row"><span class="td-label">PnL if Exit hit</span><span class="td-val">${fmtUsd(t.pnlExitUsd)}${typeof t.pnlExitPct === "number" ? " (" + fmtPct(t.pnlExitPct) + ")" : ""}</span></div>
          </div>
        </div>

        ${isClosed ? `<div class="td-section">
          <div class="td-section-title">\u{2705} Close Result</div>
          <div class="td-grid">
            <div class="td-row"><span class="td-label">Close price</span><span class="td-val" id="td-cp-val">${fmtPrice(t.closePrice)} <span class="tk-edit-icon" data-edit-field="closePrice" title="Edit Close Price">\u{270F}\u{FE0F}</span></span></div>
            <div class="td-row"><span class="td-label">Closed at</span><span class="td-val">${t.closedAt ? utcSpan(t.closedAt) : "\u2014"}</span></div>
            ${pnlHtml}
          </div>
        </div>` : `<div class="td-section">
          <div class="td-section-title">\u{1F512} Close Position</div>
          <div style="display:flex;gap:8px;align-items:center;margin-top:8px;">
            <input type="number" step="0.01" min="0" max="1" inputmode="decimal" placeholder="Close price (0\u20131)" id="td-close-price"
              style="flex:1;padding:8px 12px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;font-size:0.88rem;">
            <button id="td-close-btn" data-ticket-id="${escHtml(String(t._id))}"
              style="background:#dc2626;color:#fff;border:none;padding:8px 18px;border-radius:6px;font-size:0.85rem;font-weight:700;cursor:pointer;white-space:nowrap;">
              Close
            </button>
          </div>
          <p style="font-size:0.72rem;color:#64748b;margin:4px 0 0;">Enter close price (0\u20131). Example: 0.41</p>
        </div>`}

        ${autoCloseHtml}

        <div class="td-section">
          <div class="td-section-title">\u{1F4CB} Metadata</div>
          <div class="td-grid">
            <div class="td-row"><span class="td-label">Ticket ID</span><span class="td-val" style="font-family:monospace;font-size:0.78rem;">${escHtml(String(t._id))}</span></div>
            <div class="td-row"><span class="td-label">Market ID</span><span class="td-val" style="font-family:monospace;font-size:0.78rem;">${escHtml(t.marketId || "\u2014")}</span></div>
            <div class="td-row"><span class="td-label">Scan ID</span><span class="td-val" style="font-family:monospace;font-size:0.78rem;">${escHtml(t.scanId || "\u2014")}</span></div>
            <div class="td-row"><span class="td-label">Tradeability</span><span class="td-val">${escHtml(t.tradeability || "\u2014")}</span></div>
            <div class="td-row"><span class="td-label">Created</span><span class="td-val">${utcSpan(t.createdAt)}</span></div>
            <div class="td-row"><span class="td-label">Updated</span><span class="td-val">${utcSpan(t.updatedAt)}</span></div>
            <div class="td-row"><span class="td-label">End date</span><span class="td-val">${t.endDate ? utcSpan(t.endDate) : "\u2014"}</span></div>
            <div class="td-row"><span class="td-label">Time remaining</span><span class="td-val">${escHtml(timeLeftLabel)}</span></div>
            ${t.notes ? `<div class="td-row"><span class="td-label">Notes</span><span class="td-val">${escHtml(t.notes)}</span></div>` : ""}
          </div>
        </div>
      </div>

      <div class="td-nav-row" style="margin-top:16px;">
        ${prevLink}
        <a href="/tickets" style="color:#60a5fa;text-decoration:none;font-size:0.85rem;">\u{2190} Back to Tickets</a>
        ${nextLink}
      </div>
    </div>
    <style>
      .td-page { max-width:700px; margin:0 auto; padding:16px 8px; }
      .td-nav-row { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; padding:0 4px; }
      .td-card { background:#111827; border:1px solid #1e293b; border-radius:12px; padding:20px; }
      .td-header { margin-bottom:12px; }
      .td-section { margin-top:16px; padding-top:12px; border-top:1px solid #1e293b; }
      .td-section-title { font-size:0.82rem; color:#94a3b8; font-weight:600; margin-bottom:8px; }
      .td-grid { display:grid; grid-template-columns:1fr; gap:4px 0; }
      .td-row { display:flex; justify-content:space-between; align-items:baseline; padding:3px 0; font-size:0.85rem; }
      .td-label { color:#94a3b8; min-width:140px; flex-shrink:0; }
      .td-val { color:#e2e8f0; text-align:right; word-break:break-all; }
      .pnl-pos { color:#22c55e; }
      .pnl-neg { color:#ef4444; }
    </style>
    <script>
    (function() {
      document.addEventListener("keydown", function(e) {
        if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
        if (e.key === "ArrowLeft" || e.key === "k") {
          var prev = document.querySelector('.td-nav-row a[title="Previous ticket"]');
          if (prev) prev.click();
        }
        if (e.key === "ArrowRight" || e.key === "j") {
          var next = document.querySelector('.td-nav-row a[title="Next ticket"]');
          if (next) next.click();
        }
      });
      // Close ticket from detail page
      var closeBtn = document.getElementById("td-close-btn");
      var closePriceInput = document.getElementById("td-close-price");
      if (closeBtn && closePriceInput) {
        closeBtn.addEventListener("click", function() {
          var cp = parseFloat(closePriceInput.value);
          if (isNaN(cp) || cp <= 0) { alert("Enter a valid close price (0\u20131)"); return; }
          var ticketId = closeBtn.getAttribute("data-ticket-id");
          closeBtn.disabled = true;
          closeBtn.textContent = "Closing\u2026";
          fetch("/api/tickets/close", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticketId: ticketId, closePrice: cp }),
          }).then(function(r) { return r.json(); }).then(function(d) {
            if (d.error) { closeBtn.textContent = "Error"; closeBtn.disabled = false; alert(d.error); return; }
            location.reload();
          }).catch(function() { closeBtn.textContent = "Error"; closeBtn.disabled = false; });
        });
      }
      // Inline edit for TP, Exit, Close Price
      var TICKET_ID = "${escHtml(String(t._id))}";
      document.addEventListener("click", function(e) {
        var icon = e.target.closest(".tk-edit-icon");
        if (!icon) return;
        var field = icon.getAttribute("data-edit-field");
        if (!field) return;
        var valSpan = icon.closest(".td-val");
        if (!valSpan) return;
        // Prevent duplicate edit forms
        if (valSpan.querySelector(".tk-inline-edit")) return;
        var currentText = valSpan.childNodes[0].textContent.trim().replace("$", "");
        var currentVal = parseFloat(currentText);
        var origHtml = valSpan.innerHTML;
        valSpan.innerHTML = '<div class="tk-inline-edit">' +
          '<input type="number" step="0.01" min="0" max="1" value="' + (isNaN(currentVal) ? "" : currentVal) + '" inputmode="decimal" placeholder="0\u20131">' +
          '<button class="tk-inline-save">Save</button>' +
          '<button class="tk-inline-cancel">Cancel</button>' +
          '</div>';
        var inp = valSpan.querySelector("input");
        var saveBtn = valSpan.querySelector(".tk-inline-save");
        var cancelBtn = valSpan.querySelector(".tk-inline-cancel");
        inp.focus();
        inp.select();
        cancelBtn.addEventListener("click", function() { valSpan.innerHTML = origHtml; });
        inp.addEventListener("keydown", function(ev) {
          if (ev.key === "Escape") { valSpan.innerHTML = origHtml; }
          if (ev.key === "Enter") { saveBtn.click(); }
        });
        saveBtn.addEventListener("click", function() {
          var v = parseFloat(inp.value);
          if (isNaN(v) || v < 0) { alert("Enter a valid price (0\u20131)"); return; }
          saveBtn.disabled = true;
          saveBtn.textContent = "Saving\u2026";
          var payload = { ticketId: TICKET_ID };
          payload[field] = v;
          fetch("/api/tickets/edit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }).then(function(r) { return r.json(); }).then(function(d) {
            if (d.error) { alert(d.error); valSpan.innerHTML = origHtml; return; }
            location.reload();
          }).catch(function() { alert("Network error"); valSpan.innerHTML = origHtml; });
        });
      });
    })();
    </script>
  `;
}

module.exports = {
  DIAGNOSTIC_REASONS,
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
  renderHistoryPage,
  renderTicketsPage,
  renderTicketDetailPage,
  renderWatchlistPage,
  pageShell,
  inferDirection,
  inferEntry,
  inferSize,
  inferExit,
  formatOutcomeAction,
  polymarketUrl,
  safeQuestion,
  cardHeadline,
  isInvalidDisplayLabel,
  slugToLabel,
  marketDisplayLabel,
  whyNowSummary,
};
