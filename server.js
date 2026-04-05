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

    const html = `
      <h1>Top kandidáti pro první trade</h1>
      <p><a href="/">← Zpět</a></p>
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

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`server running on ${port}`);
});
