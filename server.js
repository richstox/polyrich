const http = require("http");
const mongoose = require("mongoose");

mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log("mongo connected"))
  .catch((err) => console.error("mongo error", err));

const marketSnapshotSchema = new mongoose.Schema({
  question: String,
  category: String,
  marketSlug: String,
  eventSlug: String,
  priceYes: String,
  priceNo: String,
  bestBid: String,
  bestAsk: String,
  spread: String,
  volume24hr: String,
  liquidity: String,
  endDate: String,
  hoursLeft: Number,
  scanId: String,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const MarketSnapshot = mongoose.model("MarketSnapshot", marketSnapshotSchema);

let scanStatus = {
  lastScanAt: null,
  nextScanAt: null,
  previousScanId: null,
  lastScanId: null,
  lastSavedCount: 0,
  lastTotalFetched: 0,
  lastInterestingCount: 0,
  lastMoverCount: 0,
  lastError: null
};

async function fetchPolymarkets() {
  const urls = [
    "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&offset=0",
    "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&offset=500"
  ];

  const results = await Promise.all(
    urls.map(async (url) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
      }
      return response.json();
    })
  );

  return results.flat();
}

function getHoursLeft(endDate) {
  if (!endDate) return null;
  const end = new Date(endDate).getTime();
  if (Number.isNaN(end)) return null;
  return (end - Date.now()) / (1000 * 60 * 60);
}

function formatHoursLeft(hoursLeft) {
  if (hoursLeft === null || Number.isNaN(hoursLeft)) return "-";
  if (hoursLeft <= 0) return "ended";
  if (hoursLeft < 1) return `${Math.round(hoursLeft * 60)} min`;
  if (hoursLeft < 24) return `${hoursLeft.toFixed(1)} h`;

  const days = Math.floor(hoursLeft / 24);
  const remHours = hoursLeft % 24;
  return `${days} d ${remHours.toFixed(1)} h`;
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatVolume(volume) {
  if (volume >= 1000000) return `${(volume / 1000000).toFixed(2)}M`;
  if (volume >= 1000) return `${(volume / 1000).toFixed(1)}k`;
  return volume.toFixed(2);
}

function normalizeMarket(item) {
  let prices = ["0", "0"];
  try {
    prices = JSON.parse(item.outcomePrices || "[\"0\",\"0\"]");
  } catch (e) {}

  const priceYes = asNumber(prices[0], 0);
  const priceNo = asNumber(prices[1], 0);
  const liquidity = asNumber(item.liquidityNum || item.liquidity, 0);
  const volume24hr = asNumber(item.volume24hr || item.volume, 0);
  const spread = asNumber(item.spread, 999);
  const endDate = item.endDate || "";
  const hoursLeft = getHoursLeft(endDate);

  return {
    question: item.question || "",
    category: item.category || "",
    marketSlug: item.slug || "",
    eventSlug: item.eventSlug || "",
    priceYes,
    priceNo,
    bestBid: asNumber(item.bestBid, 0),
    bestAsk: asNumber(item.bestAsk, 0),
    spread,
    volume24hr,
    liquidity,
    endDate,
    hoursLeft
  };
}

function marketKey(item) {
  return item.marketSlug || item.question;
}

async function runScan() {
  console.log("running auto scan...");

  const data = await fetchPolymarkets();
  const scanId = new Date().toISOString();

  const candidates = data
    .filter((item) =>
      item.acceptingOrders === true &&
      item.active === true &&
      item.closed === false &&
      item.bestBid !== null &&
      item.bestAsk !== null &&
      item.spread !== null
    )
    .map(normalizeMarket)
    .sort((a, b) => {
      const aScore = a.liquidity + a.volume24hr * 100 - a.spread * 1000;
      const bScore = b.liquidity + b.volume24hr * 100 - b.spread * 1000;
      return bScore - aScore;
    })
    .slice(0, 200);

  const previousScanId = scanStatus.lastScanId || null;

  if (candidates.length > 0) {
    await MarketSnapshot.insertMany(
      candidates.map((item) => ({
        question: item.question,
        category: item.category,
        marketSlug: item.marketSlug,
        eventSlug: item.eventSlug,
        priceYes: String(item.priceYes),
        priceNo: String(item.priceNo),
        bestBid: String(item.bestBid),
        bestAsk: String(item.bestAsk),
        spread: String(item.spread),
        volume24hr: String(item.volume24hr),
        liquidity: String(item.liquidity),
        endDate: item.endDate,
        hoursLeft: item.hoursLeft,
        scanId
      }))
    );
  }

  const now = new Date();
  const next = new Date(now.getTime() + 5 * 60 * 1000);

  scanStatus.previousScanId = previousScanId;
  scanStatus.lastScanId = scanId;
  scanStatus.lastScanAt = now;
  scanStatus.nextScanAt = next;
  scanStatus.lastSavedCount = candidates.length;
  scanStatus.lastTotalFetched = data.length;
  scanStatus.lastError = null;

  console.log(`auto scan done: fetched=${data.length} saved=${candidates.length} scanId=${scanId}`);
  return candidates;
}

async function buildIdeas() {
  if (!scanStatus.lastScanId) {
    return {
      ideas: [],
      movers: []
    };
  }

  const latestItems = await MarketSnapshot.find({ scanId: scanStatus.lastScanId }).lean();
  const previousItems = scanStatus.previousScanId
    ? await MarketSnapshot.find({ scanId: scanStatus.previousScanId }).lean()
    : [];

  const previousMap = new Map(
    previousItems.map((item) => [marketKey(item), item])
  );

  const enriched = latestItems.map((item) => {
    const latestYes = asNumber(item.priceYes, 0);
    const spread = asNumber(item.spread, 999);
    const liquidity = asNumber(item.liquidity, 0);
    const volume24hr = asNumber(item.volume24hr, 0);
    const hoursLeft =
      typeof item.hoursLeft === "number" ? item.hoursLeft : asNumber(item.hoursLeft, null);

    const prev = previousMap.get(marketKey(item));
    const previousYes = prev ? asNumber(prev.priceYes, latestYes) : latestYes;
    const moveAbs = Math.abs(latestYes - previousYes);
    const moveSigned = latestYes - previousYes;
    const moveBps = moveSigned * 10000;

    const nearEnd = hoursLeft !== null && hoursLeft > 0 && hoursLeft < 48;
    const balancedPrice = latestYes >= 0.20 && latestYes <= 0.80;
    const liquid = liquidity >= 1000;
    const liveVolume = volume24hr >= 100;
    const tightSpread = spread > 0 && spread <= 0.03;

    const intradayCandidate =
      hoursLeft !== null &&
      hoursLeft > 0 &&
      hoursLeft < 168 &&
      latestYes >= 0.15 &&
      latestYes <= 0.85 &&
      spread > 0 &&
      spread <= 0.05 &&
      liquidity >= 1000 &&
      volume24hr >= 500;

    let tag = "watch";
    if (intradayCandidate && tightSpread && nearEnd) {
      tag = "live intraday";
    } else if (intradayCandidate) {
      tag = "active setup";
    } else if (!liveVolume) {
      tag = "low activity";
    }

    const intradayScore =
      moveAbs * 8000 +
      Math.min(liquidity / 2000, 200) +
      Math.min(volume24hr * 0.5, 250) +
      (tightSpread ? 40 : 0) +
      (nearEnd ? 30 : 0) +
      (balancedPrice ? 20 : 0) -
      spread * 200;

    return {
      question: item.question,
      category: item.category || "",
      marketSlug: item.marketSlug || "",
      eventSlug: item.eventSlug || "",
      latestYes,
      previousYes,
      moveAbs,
      moveSigned,
      moveBps,
      spread,
      liquidity,
      volume24hr,
      endDate: item.endDate || "",
      hoursLeft,
      intradayCandidate,
      intradayScore,
      tag
    };
  });

  const movers = enriched
    .filter((item) =>
      item.moveAbs > 0 &&
      item.volume24hr >= 100 &&
      item.latestYes >= 0.10 &&
      item.latestYes <= 0.90
    )
    .sort((a, b) => b.moveAbs - a.moveAbs)
    .slice(0, 15);

  const ideas = enriched
    .filter((item) => item.intradayCandidate)
    .sort((a, b) => {
      if (b.intradayScore !== a.intradayScore) return b.intradayScore - a.intradayScore;
      return a.hoursLeft - b.hoursLeft;
    })
    .slice(0, 15);

  scanStatus.lastMoverCount = movers.length;
  scanStatus.lastInterestingCount = ideas.length;

  return { ideas, movers };
}

function renderIdea(item) {
  const movePrefix = item.moveSigned > 0 ? "+" : "";
  return `
    <li style="margin-bottom:18px;padding:12px;border:1px solid #ddd;border-radius:8px;">
      <strong>${item.question}</strong><br>
      tag: ${item.tag}<br>
      YES: ${item.previousYes.toFixed(3)} → ${item.latestYes.toFixed(3)}<br>
      move: ${movePrefix}${item.moveSigned.toFixed(3)} (${movePrefix}${item.moveBps.toFixed(0)} bps)<br>
      spread: ${item.spread}<br>
      liquidity: ${Math.round(item.liquidity).toLocaleString("en-US")}<br>
      <strong>24h Volume: ${formatVolume(item.volume24hr)}</strong><br>
      endDate: ${item.endDate || "-"}<br>
      time left: ${formatHoursLeft(item.hoursLeft)}<br>
      score: ${item.intradayScore.toFixed(2)}
    </li>
  `;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/") {
    const html = `
      <h1>Polyrich</h1>
      <p><a href="/scan">Spustit scan teď</a></p>
      <p><a href="/snapshots">Snapshoty</a></p>
      <p><a href="/ideas">Scanner dashboard</a></p>
    `;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname === "/scan") {
    let candidates = [];

    try {
      candidates = await runScan();
    } catch (err) {
      scanStatus.lastError = err.message;
    }

    const html = `
      <h1>Scan trhu</h1>
      <p><a href="/">← Zpět</a></p>
      <p>Scan byl právě spuštěn ručně.</p>
      <p><a href="/ideas">Otevřít scanner dashboard</a></p>
      <ol>
        ${candidates.slice(0, 30).map((item) => `
          <li style="margin-bottom:18px;">
            <strong>${item.question}</strong><br>
            YES: ${item.priceYes.toFixed(3)} | NO: ${item.priceNo.toFixed(3)}<br>
            spread: ${item.spread}<br>
            liquidity: ${Math.round(item.liquidity).toLocaleString("en-US")}<br>
            <strong>24h Volume: ${formatVolume(item.volume24hr)}</strong><br>
            endDate: ${item.endDate || "-"}<br>
            time left: ${formatHoursLeft(item.hoursLeft)}
          </li>
        `).join("")}
      </ol>
    `;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname === "/snapshots") {
    const items = await MarketSnapshot.find().sort({ _id: -1 }).limit(100).lean();

    const html = `
      <h1>Snapshoty</h1>
      <p><a href="/">← Zpět</a></p>
      <ul>
        ${items.map((item) => `
          <li style="margin-bottom:16px;">
            <strong>${item.question}</strong><br>
            scanId: ${item.scanId || "-"}<br>
            slug: ${item.marketSlug || "-"}<br>
            YES: ${item.priceYes}<br>
            spread: ${item.spread}<br>
            liquidity: ${Math.round(asNumber(item.liquidity, 0)).toLocaleString("en-US")}<br>
            <strong>24h Volume: ${formatVolume(asNumber(item.volume24hr, 0))}</strong><br>
            endDate: ${item.endDate || "-"}<br>
            time left: ${formatHoursLeft(item.hoursLeft)}<br>
            createdAt: ${new Date(item.createdAt).toLocaleString("cs-CZ")}
          </li>
        `).join("")}
      </ul>
    `;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname === "/ideas") {
    try {
      const { ideas, movers } = await buildIdeas();

      const html = `
        <h1>Scanner dashboard</h1>
        <p><a href="/">← Zpět</a></p>

        <div style="padding:12px;border:1px solid #ccc;border-radius:8px;margin-bottom:20px;">
          <p><strong>Poslední scan:</strong> ${scanStatus.lastScanAt ? scanStatus.lastScanAt.toLocaleString("cs-CZ") : "zatím neproběhl"}</p>
          <p><strong>Další scan:</strong> ${scanStatus.nextScanAt ? scanStatus.nextScanAt.toLocaleString("cs-CZ") : "nenaplánován"}</p>
          <p><strong>Aktuální scanId:</strong> ${scanStatus.lastScanId || "-"}</p>
          <p><strong>Předchozí scanId:</strong> ${scanStatus.previousScanId || "-"}</p>
          <p><strong>Stažených marketů:</strong> ${scanStatus.lastTotalFetched}</p>
          <p><strong>Uložených kandidátů:</strong> ${scanStatus.lastSavedCount}</p>
          <p><strong>Živých intraday kandidátů:</strong> ${scanStatus.lastInterestingCount}</p>
          <p><strong>Živých moverů mezi 2 scany:</strong> ${scanStatus.lastMoverCount}</p>
          <p><strong>Min 24h Volume filtr pro movers:</strong> 100</p>
          <p><strong>Min 24h Volume filtr pro intraday:</strong> 500</p>
          <p><strong>Chyba:</strong> ${scanStatus.lastError || "žádná"}</p>
        </div>

        <h2>Movers</h2>
        <p>Jen markety s 24h Volume >= 100 a cenou YES mezi 0.10 a 0.90.</p>
        <ol>
          ${movers.map(renderIdea).join("")}
        </ol>

        <h2>Intraday kandidáti</h2>
        <p>Jen markety do 7 dní, s 24h Volume >= 500 a spread <= 0.05.</p>
        <ol>
          ${ideas.map(renderIdea).join("")}
        </ol>
      `;

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    } catch (err) {
      scanStatus.lastError = err.message;

      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`ideas error: ${err.message}`);
      return;
    }
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

const port = process.env.PORT || 3000;
server.listen(port, async () => {
  console.log(`server running on ${port}`);

  try {
    await runScan();
  } catch (err) {
    scanStatus.lastError = err.message;
    console.error("initial auto scan failed", err);
  }

  setInterval(async () => {
    try {
      await runScan();
    } catch (err) {
      scanStatus.lastError = err.message;
      console.error("scheduled auto scan failed", err);
    }
  }, 5 * 60 * 1000);
});
