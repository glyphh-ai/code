/**
 * relay-client — persistent WebSocket to yo-server's /ws/relay endpoint.
 *
 * The local yo-client authenticates with a CLIENT-type MCP bearer token. Once
 * the socket is up, the server can forward MCP-style requests from external
 * callers (Claude code, etc.) holding an EXTERNAL token scoped to the same
 * user. Each request carries a reqId; this module dispatches it to a handler
 * by `method` and sends back a `{type:"response",reqId,ok,...}` frame.
 *
 * Wire protocol (JSON frames):
 *   server → client: { type:"request", reqId, method, params }
 *   client → server: { type:"response", reqId, ok, result?, error? }
 *                    { type:"ping" }  (heartbeat — optional, server also pings)
 *
 * Connection is opt-in: the relay only starts when a client token is set
 * (preference `relayClientToken` or env `YO_RELAY_CLIENT_TOKEN`). Reconnect
 * uses exponential backoff capped at 30s so a flapping server doesn't burn
 * the user's CPU or trip the rate limiter.
 */

import { WebSocket } from "ws";
import { getPreference } from "./stores/preferences-db.js";

const AUTH_SERVER = process.env.YO_AUTH_SERVER || "https://api.yosup.dev";

/** Build the WS URL from the HTTP API base — https → wss, http → ws. */
function relayUrl(): string {
  const base = AUTH_SERVER.replace(/\/+$/, "");
  return base.replace(/^http/i, (m) => (m.toLowerCase() === "https" ? "wss" : "ws")) + "/ws/relay";
}

type Handler = (params: unknown) => Promise<unknown> | unknown;

const handlers = new Map<string, Handler>();

/** Register a handler for a relay method (idempotent — last write wins). */
export function registerRelayHandler(method: string, handler: Handler): void {
  handlers.set(method, handler);
}

let socket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let backoffMs = 1_000;                            // grows on each failed attempt
let started = false;

function clientToken(): string | null {
  const envTok = process.env.YO_RELAY_CLIENT_TOKEN;
  if (envTok) return envTok;
  const pref = getPreference<string>("relayClientToken", "");
  return pref && pref.length > 0 ? pref : null;
}

function relayEnabled(): boolean {
  // Two ways to enable: explicit toggle, or just setting a token.
  const explicit = getPreference<boolean>("relayEnabled", false);
  return explicit || !!process.env.YO_RELAY_CLIENT_TOKEN;
}

async function dispatch(method: string, params: unknown): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const handler = handlers.get(method);
  if (!handler) return { ok: false, error: `unknown method: ${method}` };
  try {
    const result = await handler(params);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function scheduleReconnect(reason: string): void {
  if (reconnectTimer) return;
  console.log(`[relay] reconnect in ${Math.round(backoffMs / 1000)}s — ${reason}`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    backoffMs = Math.min(30_000, backoffMs * 2);
    connect();
  }, backoffMs);
}

function connect(): void {
  if (!relayEnabled()) return;
  const token = clientToken();
  if (!token) return;                              // wait for the user to set one

  const url = relayUrl();
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (err) {
    scheduleReconnect(`connect threw: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  socket = ws;

  ws.on("open", () => {
    console.log(`[relay] connected to ${url}`);
    backoffMs = 1_000;                             // reset on successful connect
  });

  ws.on("message", async (raw) => {
    let frame: { type?: string; reqId?: string; method?: string; params?: unknown };
    try { frame = JSON.parse(raw.toString()); }
    catch { return; }
    if (frame.type !== "request" || typeof frame.reqId !== "string" || typeof frame.method !== "string") return;
    const out = await dispatch(frame.method, frame.params);
    const responseFrame = { type: "response", reqId: frame.reqId, ...out };
    try { ws.send(JSON.stringify(responseFrame)); } catch { /* socket closed mid-handle */ }
  });

  ws.on("close", (code, reasonBuf) => {
    socket = null;
    const reason = reasonBuf ? reasonBuf.toString() : "";
    if (code === 1000 && reason === "replaced") {
      // A newer connection from the same user took over — don't reconnect.
      console.log("[relay] socket replaced by another connection");
      return;
    }
    scheduleReconnect(`closed (${code}${reason ? ` ${reason}` : ""})`);
  });

  ws.on("error", (err) => {
    console.log(`[relay] error: ${err instanceof Error ? err.message : String(err)}`);
    // close handler will schedule the reconnect
  });
}

/** Start the relay loop. Safe to call multiple times — only the first runs. */
export function initRelayClient(): void {
  if (started) return;
  started = true;

  // Built-in smoke-test handler — server's relay_ping tool routes to this.
  registerRelayHandler("relay.ping", (params) => {
    const message = (params as { message?: string } | null | undefined)?.message ?? "ping";
    return { echoed: message, at: new Date().toISOString() };
  });

  connect();
}

/** Force a reconnect — call this after the user changes the token in settings. */
export function reconnectRelay(): void {
  if (socket) {
    try { socket.close(1000, "token-changed"); } catch { /* ignore */ }
    socket = null;
  }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  backoffMs = 1_000;
  connect();
}
