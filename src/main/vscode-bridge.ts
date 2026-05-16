/**
 * vscode-bridge — drive the embedded editor's Yo Bridge companion extension.
 *
 * The extension (see vscode-bridge/extension.js) runs a localhost HTTP
 * listener inside the running VS Code instance. Posting a file path to it
 * opens that file via `showTextDocument` — instantly, with no page reload.
 */
import http from "http";

/** Port the Yo Bridge extension listens on (must match extension.js). */
export const BRIDGE_PORT = 9438;

/**
 * Open a file in the running embedded VS Code. Resolves true on success.
 *
 * The extension host needs a moment to activate after the VS Code panel
 * first loads, so a few quick retries cover that startup window. Resolves
 * false (never rejects) when the editor isn't reachable.
 */
export function openInVscode(filePath: string, attempts = 3): Promise<boolean> {
  return new Promise((resolve) => {
    const tryOnce = (left: number) => {
      const body = JSON.stringify({ path: filePath });
      const req = http.request(
        {
          host: "127.0.0.1",
          port: BRIDGE_PORT,
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
      setTimeout(() => tryOnce(left - 1), 600);
    };
    tryOnce(attempts);
  });
}
