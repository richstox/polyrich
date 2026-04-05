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
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("polyrich ok");
    return;
  }

  if (req.url === "/save-settings") {
    const item = await Settings.create({
      walletAddress: "sem_prijde_wallet",
      privateKey: "sem_prijde_private_key"
    });

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(item));
    return;
  }

  if (req.url === "/settings") {
    const items = await Settings.find().sort({ _id: -1 }).lean();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(items));
    return;
  }

  if (req.url === "/markets") {
    const response = await fetch("https://gamma-api.polymarket.com/markets?closed=false");
    const data = await response.json();

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data.slice(0, 5), null, 2));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`server running on ${port}`);
});
