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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <h1>polyrich ok</h1>
      <p><a href="/tags">Otevřít kategorie</a></p>
    `);
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

  if (url.pathname === "/tags") {
    const response = await fetch("https://gamma-api.polymarket.com/tags");
    const data = await response.json();

    const top = data.slice(0, 30);

    const html = `
      <h1>Kategorie</h1>
      <p>Klikni na kategorii:</p>
      <ul>
        ${top.map((item) => `
          <li>
            ${item.label || item.slug || item.id}
          </li>
        `).join("")}
      </ul>
      <p><a href="/">Zpět</a></p>
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
