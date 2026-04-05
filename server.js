const http = require("http");
const mongoose = require("mongoose");

mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log("mongo connected"))
  .catch((err) => console.error("mongo error", err));

const settingsSchema = new mongoose.Schema({
  walletAddress: String,
  privateKey: String
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

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`server running on ${port}`);
});
