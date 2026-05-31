/**
 * adaL bridge — a loopback-only HTTP surface over the in-process substrate so
 * external processes (Claude Code hooks, CLIs) can route memory into the adaL
 * primitive runtime instead of a separate file store. adaL is built for
 * Electron's better-sqlite3 ABI and can't be opened by plain node, so the only
 * way in from outside is to talk to the running app — that's what this is.
 *
 * Hardening: binds 127.0.0.1 only, requires a per-launch bearer token, caps body
 * size, and gates every call on adalEnabled(). The token + port are written to
 * ~/yo/substrate/adal-bridge.json (mode 0600) so local hooks can discover them;
 * nothing on the network can reach it without reading that file.
 *
 * Endpoints:
 *   GET  /health         → { ok, count }
 *   POST /think  {input,topK?}      → { groundedContext, count }
 *   POST /tell   {text,speaker?,key?} → { id }   (id null on dup / disabled)
 */

import http from "http";
import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { getAdal } from "./index";
import { adalEnabled } from "./gate";
import type { Speaker } from "./thought/space";

const SUBSTRATE_DIR = path.join(os.homedir(), "yo", "substrate");
const DESCRIPTOR_PATH = path.join(SUBSTRATE_DIR, "adal-bridge.json");
const MAX_BODY = 256 * 1024; // 256 KB per request

let server: http.Server | null = null;
let token = "";

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

function authed(req: http.IncomingMessage): boolean {
  const h = req.headers["authorization"];
  const provided = typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!provided || provided.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!authed(req)) return send(res, 401, { error: "unauthorized" });

  const url = (req.url || "").split("?")[0];

  if (req.method === "GET" && url === "/health") {
    return send(res, 200, { ok: true, enabled: adalEnabled(), count: getAdal().count });
  }

  if (req.method !== "POST") return send(res, 404, { error: "not found" });

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return send(res, 400, { error: "invalid json" });
  }

  if (!adalEnabled()) return send(res, 200, { disabled: true });

  try {
    if (url === "/think") {
      const input = String(payload.input || "").trim();
      if (!input) return send(res, 400, { error: "input required" });
      const topK = Number.isFinite(payload.topK) ? Number(payload.topK) : 8;
      const act = getAdal().think(input, topK);
      return send(res, 200, { groundedContext: act.thoughts.length ? act.groundedContext : "", count: act.thoughts.length });
    }
    if (url === "/tell") {
      const text = String(payload.text || "").trim();
      if (!text) return send(res, 400, { error: "text required" });
      const speaker = (payload.speaker === "outgoing" ? "outgoing" : "incoming") as Speaker;
      const key = payload.key ? String(payload.key) : null;
      const id = getAdal().tell(text, speaker, key);
      return send(res, 200, { id });
    }
  } catch (err) {
    return send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }

  return send(res, 404, { error: "not found" });
}

/** Start the bridge (idempotent). Safe no-op on failure — memory still works
 *  in-process; only the external hook path goes dark. */
export function ensureAdalBridge(): void {
  if (server) return;
  try {
    token = crypto.randomBytes(24).toString("hex");
    server = http.createServer((req, res) => {
      handle(req, res).catch(() => send(res, 500, { error: "internal" }));
    });
    server.on("error", (err) => {
      console.warn("[adaL bridge] server error:", err instanceof Error ? err.message : err);
    });
    // Port 0 → OS-assigned free port, loopback only.
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      fs.mkdirSync(SUBSTRATE_DIR, { recursive: true });
      fs.writeFileSync(
        DESCRIPTOR_PATH,
        JSON.stringify({ url: `http://127.0.0.1:${port}`, token, pid: process.pid }),
        { mode: 0o600 },
      );
      console.log(`[adaL bridge] listening on 127.0.0.1:${port}`);
    });
  } catch (err) {
    console.warn("[adaL bridge] failed to start:", err instanceof Error ? err.message : err);
    server = null;
  }
}

export function stopAdalBridge(): void {
  if (server) {
    server.close();
    server = null;
  }
  try {
    fs.rmSync(DESCRIPTOR_PATH, { force: true });
  } catch {
    /* noop */
  }
}
