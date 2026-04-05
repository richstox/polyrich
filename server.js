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
      <p><a href="/events">Otevřít skupiny marketů</a></p>
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

  if (url.pathname === "/events") {
    const response = await fetch("https://gamma-api.polymarket.com/events?active=true&closed=false");
    const data = await response.json();

    const top = data.slice(0, 30);

    const html = `
      <h1>Skupiny marketů</h1>
      <p>Klikni na skupinu:</p>
      <ul>
        ${top.map((item) => `
          <li>
            <a href="/event/${item.slug}">
              ${item.title || item.slug}
            </a>
          </li>
        `).join("")}
      </ul>
      <p><a href="/">Zpět</a></p>
    `;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (url.pathname.startsWith("/event/")) {
    const slug = url.pathname.replace("/event/", "");

    const response = await fetch("https://gamma-api.polymarket.com/events?active=true&closed=false");
    const data = await response.json();

    const event = data.find((item) => item.slug === slug);

    if (!event) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h1>Skupina nenalezena</h1><p><a href='/events'>Zpět</a></p>");
      return;
    }

    const markets = (event.markets || []).map((item) => {
      let prices = ["?", "?"];
      try {
        prices = JSON.parse(item.outcomePrices || "[\"?\",\"?\"]");
      } catch (e) {}

      return `
        <li>
          <strong>${item.question}</strong><br>
          YES: ${prices[0]} | NO: ${prices[1]}<br>
          volume: ${item.volume || 0}<br>
          endDate: ${item.endDate || "-"}
        </li>
      `;
    }).join("");

    const html = `
      <h1>${event.title || event.slug}</h1>
      <p><a href="/events">← Zpět na skupiny</a></p>
      <ul>
        ${markets || "<li>Žádné markety</li>"}
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
