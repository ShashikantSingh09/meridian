// Stand-in for a local OpenAI-compatible server, on LM Studio's default port.
import http from "node:http";
const words = "Hello from a local model. Streaming reaches the panel word by word.".split(" ");
http.createServer((req, res) => {
  if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "local-test-model" }, { id: "text-embedding-nomic" }] }));
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    console.log("CHAT", body.slice(0, 200));
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const w of words) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w + " " } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 90));
    }
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 12 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
}).listen(1234, "127.0.0.1", () => console.log("fake llm up"));
