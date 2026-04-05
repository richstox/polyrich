const http = require("http");
const mongoose = require("mongoose");

mongoose.connect(process.env.MONGO_URL)
  .then(() => console.log("mongo connected"))
  .catch((err) => console.error("mongo error", err));

const noteSchema = new mongoose.Schema({
  text: String
});

const Note = mongoose.model("Note", noteSchema);

const server = http.createServer(async (req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("polyrich ok");
    return;
  }

  if (req.url === "/mongo") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      mongoReady: mongoose.connection.readyState
    }));
    return;
  }

  if (req.url === "/save") {
    const note = await Note.create({ text: "ahoj z mongo" });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(note));
    return;
  }

  if (req.url === "/notes") {
    const notes = await Note.find().sort({ _id: -1 }).lean();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(notes));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`server running on ${port}`);
});
