const http = require("http");
const mongoose = require("mongoose");

mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log("mongo connected"))
  .catch((err) => console.error("mongo error", err));

const settingsSchema = new mongoose.Schema({
  walletAddress: String,
  privateKey: String
});

const marketSnapshotSchema = new mongoose.Schema({
  question: String,
  category: String,
  priceYes: String,
  priceNo: String,
  bestBid: String,
  bestAsk: String,
  spread: String,
  volume24hr: String,
  liquidity: String,
  scanId: String,
  createdAt: {
    type: Date,
    default: Date.now
  }
});

const Settings = mongoose.model("Settings", settingsSchema);
const MarketSnapshot = mongoose.model("MarketSnapshot", marketSnapshotSchema);

const categories = [
  { key: "politics", label: "Politics" },
  { key: "sports", label: "Sports" },
  { key: "crypto", label: "Crypto" },
  { key: "tech", label: "Tech" },
  { key: "culture", label: "Culture" },
  { key: "world", label: "World" }
];

let scanStatus = {
  lastScanAt: null,
  nextScanAt: null,
  lastSavedCount: 0,
  lastTotalFetched: 0,
  lastInterestingCount: 0,
  lastError: null,
  lastScanId: null
};

async function fetchPolymarkets() {
  const urls = [
    "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&offset=0&order=volume24hr&dir=desc",
    "https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=500&offset=500&order=volume24hr&dir=desc"
  ];

  const results = await Promise.all(
    urls.map(async (url) => {
      const response = await fetch(url);
      return response.json();
    })
  );

  return results.flat();
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
    .map((item) => {
      let prices = ["?", "?"];
      try {
        prices = JSON.parse(item.outcomePrices || "[\"?\",\"?\"]");
      } catch (e) {}

      const liquidity = Number(item.liquidityNum || item.liquidity || 0);
      const volume = Number(item.volume24hr || item.volume || 0);
      const spread = Number(item.spread || 999);
      const priceYes = Number(prices[0] || 0);

      const score =
        liquidity * 0.4 +
        volume * 0.4 +
        (spread > 0 ? (1 / spread) * 1000 : 0) * 0.2 +
        (priceYes > 0.1 && priceYes < 0.9 ? 500 : 0);

      return {
        question: item.question,
        category: item.category || "",
        priceYes: prices[0],
        priceNo: prices[1],
        bestBid: item.bestBid,
        bestAsk: item.bestAsk,
        spread: item.spread,
        volume24hr: item.volume24hr || 0,
        liquidity: item.liquidityNum || item.liquidity || 0,
        score
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 80);

  if (candidates.length > 0) {
    await MarketSnapshot.insertMany(
      candidates.map((item) => ({
        question: item.question,
        category: item.category,
        priceYes: item.priceYes,
        priceNo: item.priceNo,
        bestBid: String(item.bestBid),
        bestAsk: String(item.bestAsk),
        spread: String(item.spread),
        volume24hr: String(item.volume24hr),
        liquidity: String(item.liquidity),
        scanId
      }))
    );
  }

  const now = new Date();
  const next = new Date(now.getTime() + 5 * 60 * 1000);

  scanStatus.lastScanAt = now;
  scanStatus.nextScanAt = next;
  scanStatus.lastSavedCount = candidates.length;
  scanStatus.lastTotalFetched = data.length;
  scanStatus.lastError = null;
  scanStatus.lastScanId = scanId;

  console.log(`auto scan done: ${candidates.length} candidates saved`);
  return candidates;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/") {
    const html = `
      <h1>Polyrich</h1>
      <p>Vyber kategorii:</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        ${categories.map((cat) => `
          <a href="/category/${cat.key}" style="padding:10px 14px;border:1px solid #ccc;text-decoration:none;border-radius:8px;">
            ${cat.label}
          </a>
        `).join("")}
      </div>
      <p style="margin-top:20px;"><a href="/scan">Spustit scan teď</a></p>
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
        ${candidates.map((item) => `
          <li style="margin-bottom:18px;">
            <strong>${item.question}</strong><br>
            category: ${item.category}<br>
            YES: ${item.priceYes} | NO: ${item.priceNo}<br>
            bestBid: ${item.bestBid} | bestAsk: ${item.bestAsk} | spread: ${item.spread}<br>
            volume24hr: ${item.volume24hr}<br>
            liquidity: ${item.liquidity}
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
            category: ${item.category}<br>
            YES: ${item.priceYes} | NO: ${item.priceNo}<br>
            spread: ${item.spread}<br>
            volume24hr: ${item.volume24hr}<br>
            liquidity: ${item.liquidity}<br>
            scanId: ${item.scanId || "-"}<br>
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
    let ideas = [];

    if (scanStatus.lastScanId) {
      const items = await MarketSnapshot.find({ scanId: scanStatus.lastScanId }).lean();

      ideas = items
        .map((item) => {
          const latestYes = Number(item.priceYes || 0);
          const spread = Number(item.spread || 999);
          const liquidity = Number(item.liquidity || 0);
          const volume24hr = Number(item.volume24hr || 0);

          const tradable =
            latestYes > 0.15 &&
            latestYes < 0.85 &&
            spread > 0 &&
            spread < 0.15 &&
            liquidity > 100;

          const score =
            (volume24hr / 1000) * 3 +
            (liquidity / 1000) * 2 -
            spread * 50 +
            (latestYes > 0.2 && latestYes < 0.8 ? 5 : 0);

          return {
            question: item.question,
            category: item.category || "",
            latestYes,
            spread,
            liquidity,
            volume24hr,
            score,
            tradable
          };
        })
        .filter((item) => item.tradable)
        .sort((a, b) => b.score - a.score);
    }

    scanStatus.lastInterestingCount = ideas.length;

    const html = `
      <h1>Scanner dashboard</h1>
      <p><a href="/">← Zpět</a></p>

      <div style="padding:12px;border:1px solid #ccc;border-radius:8px;margin-bottom:20px;">
        <p><strong>Poslední scan:</strong> ${scanStatus.lastScanAt ? scanStatus.lastScanAt.toLocaleString("cs-CZ") : "zatím neproběhl"}</p>
        <p><strong>Další scan:</strong> ${scanStatus.nextScanAt ? scanStatus.nextScanAt.toLocaleString("cs-CZ") : "nenaplánován"}</p>
        <p><strong>Stažených marketů:</strong> ${scanStatus.lastTotalFetched}</p>
        <p><strong>Uložených kandidátů:</strong> ${scanStatus.lastSavedCount}</p>
        <p><strong>Zajímavých nápadů:</strong> ${scanStatus.lastInterestingCount}</p>
        <p><strong>Poslední scanId:</strong> ${scanStatus.lastScanId || "-"}</p>
        <p><strong>Chyba:</strong> ${scanStatus.lastError || "žádná"}</p>
      </div>

      <p>Tady jsou nejlepší aktuální kandidáti z posledního scanu.</p>

      <ol>
        ${ideas.slice(0, 30).map((item) => `
          <li style="margin-bottom:18px;">
            <strong>${item.question}</strong><br>
            category: ${item.category}<br>
            YES: ${item.latestYes}<br>
            spread: ${item.spread}<br>
            liquidity: ${item.liquidity}<br>
            volume24hr: ${item.volume24hr}<br>
            score: ${item.score.toFixed(2)}
          </li>
        `).join("")}
      </ol>
    `;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
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
