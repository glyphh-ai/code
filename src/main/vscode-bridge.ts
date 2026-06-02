/**
 * vscode-bridge — drive the embedded editor's Yo Bridge companion extension.
 *
 * The extension (see vscode-bridge/extension.js) runs a localhost HTTP
 * listener inside the running VS Code instance and writes its OS-assigned
 * port to ~/yo/.yo-bridge-port. Posting a file path to that port opens the
 * file via `showTextDocument` — instantly, with no page reload.
 */
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";

/** The Yo Bridge extension writes its live port here (matches extension.js). */
const PORT_FILE = path.join(os.homedir(), "yo", ".yo-bridge-port");

/** The port the most-recently-activated VS Code extension host is listening on. */
function readBridgePort(): number {
  try {
    const p = parseInt(fs.readFileSync(PORT_FILE, "utf-8").trim(), 10);
    return Number.isInteger(p) && p > 0 ? p : 0;
  } catch {
    return 0;
  }
}

/**
 * Open a file in the running embedded VS Code. Resolves true on success.
 *
 * A cold VS Code panel takes several seconds to load its web UI, start the
 * extension host, activate the Yo Bridge extension, and publish its port —
 * so the retry window is generous (~30s). When VS Code is already warm the
 * first attempt wins instantly. Resolves false (never rejects) when the
 * editor isn't reachable. The port file is re-read every attempt, so a host
 * that activates mid-retry is picked up.
 */
export function openInVscode(filePath: string, attempts = 30): Promise<boolean> {
  return new Promise((resolve) => {
    const tryOnce = (left: number) => {
      const port = readBridgePort();
      if (!port) { retry(left); return; }
      const body = JSON.stringify({ path: filePath });
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/open",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: 2000,
        },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve(true);
          else retry(left);
        },
      );
      req.on("error", () => retry(left));
      req.on("timeout", () => { req.destroy(); retry(left); });
      req.end(body);
    };
    const retry = (left: number) => {
      if (left <= 0) { resolve(false); return; }
      setTimeout(() => tryOnce(left - 1), 1000);
    };
    tryOnce(attempts);
  });
}
