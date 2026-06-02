/**
 * Yo Bridge — companion extension for the .Yo workspace.
 *
 * Runs a localhost HTTP listener so the .Yo main process can open a file in
 * this editor instantly (showTextDocument) — no page reload.
 *
 *   POST http://127.0.0.1:<port>/open   { "path": "/abs/path/to/file" }
 *
 * VS Code keeps previous extension hosts alive through a long reconnection
 * grace, and orphaned hosts can outlive a restarted server — so a *fixed*
 * port conflicts. Instead each host binds an OS-assigned free port and writes
 * it to ~/yo/.yo-bridge-port. The .Yo main process reads that file, so the
 * most-recently-activated host (the live window) always wins. No conflicts.
 *
 * Plain JS, zero dependencies — copied verbatim into the extensions dir.
 */
const vscode = require("vscode");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT_FILE = path.join(os.homedir(), "yo", ".yo-bridge-port");

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

  server.on("error", (err) => {
    console.error("[yo-bridge]", (err && err.message) || err);
  });

  server.on("listening", () => {
    const addr = server.address();
    const port = addr && typeof addr === "object" ? addr.port : 0;
    try {
      fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
      fs.writeFileSync(PORT_FILE, String(port), "utf-8");
      console.log("[yo-bridge] listening on", port);
    } catch (e) {
      console.error("[yo-bridge] could not write port file:", (e && e.message) || e);
    }
  });

  // Port 0 → the OS hands us a free port; no fixed-port conflicts.
  server.listen(0, "127.0.0.1");

  context.subscriptions.push({
    dispose: () => { try { server.close(); } catch (_e) { /* ignore */ } },
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
