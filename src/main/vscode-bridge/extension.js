/**
 * Yo Bridge — a minimal companion extension for the .Yo workspace.
 *
 * Runs a localhost HTTP listener so the .Yo main process can open a specific
 * file in this running editor instantly (vscode.window.showTextDocument) —
 * no page reload, no payload-URL navigation.
 *
 *   POST http://127.0.0.1:9438/open   { "path": "/abs/path/to/file" }
 *
 * Plain JS, zero dependencies — it is copied verbatim into the code-server
 * extensions directory; there is no build step.
 */
const vscode = require("vscode");
const http = require("http");

const PORT = 9438;

function activate(context) {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url || !req.url.startsWith("/open")) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const filePath = data && data.path;
        if (filePath && typeof filePath === "string") {
          const uri = vscode.Uri.file(filePath);
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc, { preview: true });
        }
        res.writeHead(200);
        res.end("ok");
      } catch (err) {
        res.writeHead(500);
        res.end(String((err && err.message) || err));
      }
    });
  });

  // EADDRINUSE simply means another editor window already holds the port —
  // one listener is enough, so swallow it.
  server.on("error", (err) => {
    console.error("[yo-bridge]", (err && err.message) || err);
  });
  server.listen(PORT, "127.0.0.1");
  context.subscriptions.push({ dispose: () => server.close() });
}

function deactivate() {}

module.exports = { activate, deactivate };
