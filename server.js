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
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("polyrich ok");
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

  if (url.pathname === "/markets") {
    const limit = Number(url.searchParams.get("limit")) || 20;

    const response = await fetch("https://gamma-api.polymarket.com/markets?closed=false");
    const data = await response.json();

    const simple = data.slice(0, limit).map((item) => ({
      question: item.question,
      priceYes: JSON.parse(item.outcomePrices)[0],
      priceNo: JSON.parse(item.outcomePrices)[1],
      volume: item.volume,
      endDate: item.endDate
    }));

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(simple, null, 2));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`server running on ${port}`);
});
