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
  lastError: null
};

async function runScan() {
  console.log("running auto scan...");

  const response = await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200");
  const data = await response.json();

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
      const score =
        liquidity * 0.5 +
        volume * 0.3 +
        (spread > 0 ? (1 / spread) * 1000 : 0) * 0.2;

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
    .slice(0, 20);

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
        liquidity: String(item.liquidity)
      }))
    );
  }

  const now = new Date();
  const next = new Date(now.getTime() + 5 * 60 * 1000);

  scanStatus.lastScanAt = now;
  scanStatus.nextScanAt = next;
  scanStatus.lastSavedCount = candidates.length;
  scanStatus.lastTotalFetched = data.length;
  scanStatus.lastInterestingCount = candidates.length;
  scanStatus.lastError = null;

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
      <p><a href="/changes">Změny</a></p>
      <p><a href="/ideas">Scanner dashboard</a></p>
    `;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname.startsWith("/category/")) {
    const key = url.pathname.replace("/category/", "");

    const response = await fetch("https://gamma-api.polymarket.com/markets?closed=false");
    const data = await response.json();

    const filtered = data.filter((item) => {
      const category = String(item.category || "").toLowerCase();
      return category.includes(key);
    });

    const top = filtered.slice(0, 30);

    const html = `
      <h1>Kategorie: ${key}</h1>
      <p><a href="/">← Zpět</a></p>
      <ul>
        ${top.map((item) => {
          let prices = ["?", "?"];
          try {
            prices = JSON.parse(item.outcomePrices || "[\"?\",\"?\"]");
          } catch (e) {}

          return `
            <li style="margin-bottom:16px;">
              <strong>${item.question}</strong><br>
              YES: ${prices[0]} | NO: ${prices[1]}<br>
              volume: ${item.volume || 0}<br>
              endDate: ${item.endDate || "-"}
            </li>
          `;
        }).join("")}
      </ul>
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
            createdAt: ${new Date(item.createdAt).toLocaleString("cs-CZ")}
          </li>
        `).join("")}
      </ul>
    `;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname === "/changes") {
    const items = await MarketSnapshot.find().sort({ createdAt: -1 }).lean();

    const latestByQuestion = new Map();
    const previousByQuestion = new Map();

    for (const item of items) {
      if (!latestByQuestion.has(item.question)) {
        latestByQuestion.set(item.question, item);
      } else if (!previousByQuestion.has(item.question)) {
        previousByQuestion.set(item.question, item);
      }
    }

    const changes = [];

    for (const [question, latest] of latestByQuestion.entries()) {
      const previous = previousByQuestion.get(question);
      if (!previous) continue;

      const latestYes = Number(latest.priceYes || 0);
      const previousYes = Number(previous.priceYes || 0);
      const latestSpread = Number(latest.spread || 0);
      const previousSpread = Number(previous.spread || 0);
      const latestLiquidity = Number(latest.liquidity || 0);
      const previousLiquidity = Number(previous.liquidity || 0);

      changes.push({
        question,
        category: latest.category || "",
        latestYes,
        previousYes,
        yesDiff: latestYes - previousYes,
        latestSpread,
        previousSpread,
        spreadDiff: latestSpread - previousSpread,
        latestLiquidity,
        previousLiquidity,
        liquidityDiff: latestLiquidity - previousLiquidity,
        latestCreatedAt: latest.createdAt
      });
    }

    changes.sort((a, b) => Math.abs(b.yesDiff) - Math.abs(a.yesDiff));

    const html = `
      <h1>Změny</h1>
      <p><a href="/">← Zpět</a></p>
      <ul>
        ${changes.slice(0, 30).map((item) => `
          <li style="margin-bottom:18px;">
            <strong>${item.question}</strong><br>
            category: ${item.category}<br>
            YES změna: ${item.previousYes} → ${item.latestYes} (${item.yesDiff >= 0 ? "+" : ""}${item.yesDiff.toFixed(3)})<br>
            spread změna: ${item.previousSpread} → ${item.latestSpread} (${item.spreadDiff >= 0 ? "+" : ""}${item.spreadDiff.toFixed(3)})<br>
            liquidity změna: ${item.previousLiquidity} → ${item.latestLiquidity} (${item.liquidityDiff >= 0 ? "+" : ""}${item.liquidityDiff.toFixed(2)})
          </li>
        `).join("")}
      </ul>
    `;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname === "/ideas") {
    const items = await MarketSnapshot.find().sort({ createdAt: -1 }).lean();

    const latestByQuestion = new Map();
    const previousByQuestion = new Map();

    for (const item of items) {
      if (!latestByQuestion.has(item.question)) {
        latestByQuestion.set(item.question, item);
      } else if (!previousByQuestion.has(item.question)) {
        previousByQuestion.set(item.question, item);
      }
    }

    const ideas = [];

    for (const [question, latest] of latestByQuestion.entries()) {
      const previous = previousByQuestion.get(question);
      if (!previous) continue;

      const latestYes = Number(latest.priceYes || 0);
      const previousYes = Number(previous.priceYes || 0);
      const spread = Number(latest.spread || 999);
      const liquidity = Number(latest.liquidity || 0);
      const volume24hr = Number(latest.volume24hr || 0);
      const move = Math.abs(latestYes - previousYes);

      const tradable =
        spread > 0 &&
        spread < 0.03 &&
        liquidity > 1000 &&
        latestYes > 0.1 &&
        latestYes < 0.9 &&
        move > 0.01;

      const score =
        move * 100 +
        (liquidity / 1000) * 2 +
        (volume24hr / 1000) -
        spread * 100;

      if (tradable) {
        ideas.push({
          question,
          category: latest.category || "",
          latestYes,
          previousYes,
          move,
          spread,
          liquidity,
          volume24hr,
          score
        });
      }
    }

    ideas.sort((a, b) => b.score - a.score);

    const html = `
      <h1>Scanner dashboard</h1>
      <p><a href="/">← Zpět</a></p>

      <div style="padding:12px;border:1px solid #ccc;border-radius:8px;margin-bottom:20px;">
        <p><strong>Poslední scan:</strong> ${scanStatus.lastScanAt ? scanStatus.lastScanAt.toLocaleString("cs-CZ") : "zatím neproběhl"}</p>
        <p><strong>Další scan:</strong> ${scanStatus.nextScanAt ? scanStatus.nextScanAt.toLocaleString("cs-CZ") : "nenaplánován"}</p>
        <p><strong>Stažených marketů:</strong> ${scanStatus.lastTotalFetched}</p>
        <p><strong>Uložených kandidátů:</strong> ${scanStatus.lastSavedCount}</p>
        <p><strong>Zajímavých tradable nápadů:</strong> ${ideas.length}</p>
        <p><strong>Chyba:</strong> ${scanStatus.lastError || "žádná"}</p>
      </div>

      <p>Tady jsou kandidáti, kde je pohyb, rozumná likvidita a rozumný spread.</p>

      <ol>
        ${ideas.slice(0, 20).map((item) => `
          <li style="margin-bottom:18px;">
            <strong>${item.question}</strong><br>
            category: ${item.category}<br>
            YES: ${item.previousYes} → ${item.latestYes}<br>
            move: ${item.move.toFixed(3)}<br>
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
