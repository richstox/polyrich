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
      <p style="margin-top:20px;">
        <a href="/scan">Najít top markety pro první trade</a>
      </p>
      <p style="margin-top:10px;">
        <a href="/snapshots">Zobrazit uložené snapshoty</a>
      </p>
      <p style="margin-top:10px;">
        <a href="/changes">Zobrazit změny mezi snapshoty</a>
      </p>
    `;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname === "/save-settings") {
    const item = await Settings.create({
      walletAddress: "sem_prijde_wallet",
      privateKey: "sem_prijde_private_key"
    });

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(item));
    return;
  }

  if (url.pathname === "/settings") {
    const items = await Settings.find().sort({ _id: -1 }).lean();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(items));
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
          rewardsMinSize: item.rewardsMinSize || 0,
          rewardsMaxSpread: item.rewardsMaxSpread || 0,
          score
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

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

    const html = `
      <h1>Top kandidáti pro první trade</h1>
      <p><a href="/">← Zpět</a></p>
      <p><a href="/snapshots">Zobrazit uložené snapshoty</a></p>
      <p><a href="/changes">Zobrazit změny mezi snapshoty</a></p>
      <ol>
        ${candidates.map((item) => `
          <li style="margin-bottom:18px;">
            <strong>${item.question}</strong><br>
            category: ${item.category}<br>
            YES: ${item.priceYes} | NO: ${item.priceNo}<br>
            bestBid: ${item.bestBid} | bestAsk: ${item.bestAsk} | spread: ${item.spread}<br>
            volume24hr: ${item.volume24hr}<br>
            liquidity: ${item.liquidity}<br>
            rewardsMinSize: ${item.rewardsMinSize} | rewardsMaxSpread: ${item.rewardsMaxSpread}
          </li>
        `).join("")}
      </ol>
    `;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname === "/snapshots") {
    const items = await MarketSnapshot.find().sort({ _id: -1 }).limit(50).lean();

    const html = `
      <h1>Uložené snapshoty</h1>
      <p><a href="/">← Zpět</a></p>
      <ul>
        ${items.map((item) => `
          <li style="margin-bottom:16px;">
            <strong>${item.question}</strong><br>
            category: ${item.category}<br>
            YES: ${item.priceYes} | NO: ${item.priceNo}<br>
            bestBid: ${item.bestBid} | bestAsk: ${item.bestAsk}<br>
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
      <h1>Změny mezi snapshoty</h1>
      <p><a href="/">← Zpět</a></p>
      <ul>
        ${changes.slice(0, 30).map((item) => `
          <li style="margin-bottom:18px;">
            <strong>${item.question}</strong><br>
            category: ${item.category}<br>
            YES změna: ${item.previousYes} → ${item.latestYes} (${item.yesDiff >= 0 ? "+" : ""}${item.yesDiff.toFixed(3)})<br>
            spread změna: ${item.previousSpread} → ${item.latestSpread} (${item.spreadDiff >= 0 ? "+" : ""}${item.spreadDiff.toFixed(3)})<br>
            liquidity změna: ${item.previousLiquidity} → ${item.latestLiquidity} (${item.liquidityDiff >= 0 ? "+" : ""}${item.liquidityDiff.toFixed(2)})<br>
            poslední snapshot: ${new Date(item.latestCreatedAt).toLocaleString("cs-CZ")}
          </li>
        `).join("")}
      </ul>
    `;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`server running on ${port}`);
});
