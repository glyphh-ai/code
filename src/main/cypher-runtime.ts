/**
 * cypher-runtime — provider-side loop that drives joined cyphers.
 *
 * For each cypher I'm joined to:
 *   - hold an SSE connection to /api/cyphers/:id/events/stream
 *   - track last-seen event seq across reconnects
 *   - dispatch `prompt` events to the registered handler (Phase 3.5 wires the
 *     real Claude Agent SDK; v1 ships with no-op so the protocol can be
 *     exercised end-to-end without an LLM bill)
 *   - post `text` + `usage` events back to the cypher feed; server settles
 *     yos atomically via the kitty when it sees `usage`
 *
 * Phase 3.5: SSE replaces the previous 3s poll. One persistent connection
 * per cypher; events arrive in <1s. Reconnect attaches `?since=<lastSeq>`
 * (and the EventSource-style `Last-Event-ID` header) so we never miss
 * events across drops.
 *
 * This file owns the transport + dispatch infrastructure ONLY. The "agent
 * brain" is injected via setPromptHandler() so the runner stays decoupled
 * from any specific SDK / model / provider.
 */

import { net } from "electron";
import { isAuthenticated, serverGetAuthed, serverPostAuthed, getAuthToken, AUTH_SERVER } from "./auth";
import { guardPrompt } from "./firewall";

// ── Types ──────────────────────���────────────────────────────

export interface CypherPromptEvent {
  cypherId: string;
  jamId: string | null;
  seq: number;
  fromUserId: string | null;
  fromAgentId: string | null;
  prompt: string;
}

export interface AgentTurnResult {
  text: string;
  yos_used?: number;
  /** Optional metadata (model, tokens) — embedded into the usage event payload. */
  meta?: Record<string, unknown>;
}

export type PromptHandler = (
  event: CypherPromptEvent,
  byAgentId: string,
) => Promise<AgentTurnResult | null>;

/** Handler for non-prompt events targeting a specific agent (agent_message, post_to). */
export type AgentMessageHandler = (
  cypherId: string,
  toAgentId: string,
  fromAgentId: string | null,
  body: string,
  kind: string,
  meta?: Record<string, unknown>,
) => void;

/**
 * Observer for cypher feed events. The feed renders ONLY from this stream —
 * `seq` is the server-assigned monotonic id (unique → the renderer dedups on
 * it); `isOwn` is true when this client originated the event (lets the
 * observer suppress re-playing our own one-shot effects that already fired
 * locally on send, e.g. drips).
 */
export type EventObserver = (
  cypherId: string,
  kind: string,
  payload: Record<string, unknown>,
  byAgentId: string | null,
  seq: number,
  isOwn: boolean,
) => void;

interface CypherSubscription {
  cypherId: string;
  /** All local agent IDs participating in this cypher from this client.
   *  Used to echo-skip our own events on the SSE stream. */
  agentLocalIds: Set<string>;
  /** Subset of agentLocalIds that are real agents able to answer an inbound
   *  `prompt` event. Excludes the viewer sentinel and the maestro id. */
  responderIds: Set<string>;
  lastSeenSeq: number;
  /** Active SSE request, null when disconnected and waiting to reconnect. */
  request: Electron.ClientRequest | null;
  /** Reconnect timer; non-null while a reconnect is scheduled. */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Successive failure count for backoff. Resets on a successful frame. */
  failures: number;
  /** Buffer for partial SSE frame data across chunks. */
  buffer: string;
}

// ── State ───────────────────────────────────────────────────

/**
 * Sentinel agent id used to keep a cypher's SSE stream open for a viewer
 * (the cypher panel) that has no local agent of its own — e.g. the cypher
 * owner before they start any jammers, or a jammer who opened the panel
 * before the leader. It never names a real agent, so it is excluded from
 * prompt-response selection and never matches an inbound by_agent_id.
 */
export const CYPHER_VIEWER_AGENT = "__viewer__";

/**
 * Canonical id for the maestro's own published cypher activity. Registered on
 * a subscription as a non-responder so the maestro's events are echo-skipped
 * on its own client (already rendered locally) but it is never picked to
 * answer an inbound prompt.
 */
export const CYPHER_MAESTRO_AGENT = "mistro";

const subscriptions = new Map<string, CypherSubscription>();   // cypher_id → sub
let promptHandler: PromptHandler | null = null;
let agentMessageHandler: AgentMessageHandler | null = null;
let eventObserver: EventObserver | null = null;
let stopped = false;
/** This client's own platform user id — used to echo-skip our own events. */
let myUserId: string | null = null;

const RECONNECT_BACKOFF_MS = [500, 2_000, 5_000, 5_000, 5_000] as const;

// ── Public API ──────────────────────────────────────────────

/** Inject the agent brain. Pass null to clear (runtime then drops prompts on the floor). */
export function setPromptHandler(handler: PromptHandler | null): void {
  promptHandler = handler;
}

/** Set handler for directed messages (agent_message, post_to events). */
export function setAgentMessageHandler(handler: AgentMessageHandler | null): void {
  agentMessageHandler = handler;
}

/** Set observer for visibility events (thinking, tool_use, tool_result). */
export function setEventObserver(observer: EventObserver | null): void {
  eventObserver = observer;
}

/**
 * Track a cypher subscription. Idempotent. Opens an SSE connection to the
 * server and dispatches new `prompt` events to the registered handler under
 * the given agent identity.
 */
export function subscribeCypher(cypherId: string, agentLocalId: string, responder = true): void {
  const existing = subscriptions.get(cypherId);
  if (existing) {
    existing.agentLocalIds.add(agentLocalId);
    if (responder) existing.responderIds.add(agentLocalId);
    return;
  }
  const sub: CypherSubscription = {
    cypherId,
    agentLocalIds: new Set([agentLocalId]),
    responderIds: new Set(responder ? [agentLocalId] : []),
    lastSeenSeq: 0,
    request: null,
    reconnectTimer: null,
    failures: 0,
    buffer: "",
  };
  subscriptions.set(cypherId, sub);
  if (!stopped && isAuthenticated()) connectSubscription(sub);
}

/** Add a real agent to an existing cypher subscription (multi-agent per SSE stream). */
export function subscribeCypherAgent(cypherId: string, agentLocalId: string): void {
  subscribeCypher(cypherId, agentLocalId, true);
}

/** Remove a single agent from a cypher subscription. Closes the stream if no agents remain. */
export function unsubscribeCypherAgent(cypherId: string, agentLocalId: string): void {
  const sub = subscriptions.get(cypherId);
  if (!sub) return;
  sub.agentLocalIds.delete(agentLocalId);
  sub.responderIds.delete(agentLocalId);
  if (sub.agentLocalIds.size === 0) {
    closeSubscription(sub);
    subscriptions.delete(cypherId);
  }
}

export function unsubscribeCypher(cypherId: string): void {
  const sub = subscriptions.get(cypherId);
  if (!sub) return;
  closeSubscription(sub);
  subscriptions.delete(cypherId);
}

export function listSubscriptions(): Array<{ cypherId: string; agentLocalIds: string[]; lastSeenSeq: number }> {
  return Array.from(subscriptions.values()).map((s) => ({
    cypherId: s.cypherId, agentLocalIds: Array.from(s.agentLocalIds), lastSeenSeq: s.lastSeenSeq,
  }));
}

/**
 * Post an event to a cypher's event stream via REST.
 * Used by CypherBus to push agent events (thinking, tool_use, messages) to the server.
 */
export async function postCypherEvent(
  cypherId: string,
  kind: string,
  payload: Record<string, unknown>,
  byAgentId: string,
  jamId?: string,
): Promise<boolean> {
  try {
    await serverPostAuthed(`/api/cyphers/${encodeURIComponent(cypherId)}/events`, {
      kind,
      by_agent_id: byAgentId,
      ...(jamId ? { jam_id: jamId } : {}),
      payload,
    });
    return true;
  } catch (err) {
    console.warn(`[cypher-runtime] postCypherEvent(${kind}) failed:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Start the runtime. Idempotent. */
export function startCypherRuntime(): void {
  if (!stopped && subscriptions.size > 0) return;
  stopped = false;
  // Cache our own user id so handleFrame can echo-skip events this client
  // originated (chat, drips, dot-commands all post as by_agent_id:"user" —
  // not in agentLocalIds — so without this they render twice: once on the
  // immediate local echo, once on the SSE round-trip).
  if (isAuthenticated()) {
    void serverGetAuthed<{ user: { id: string } }>(`/api/heartbeat`)
      .then((r) => { myUserId = r.user?.id ?? null; })
      .catch(() => { /* best-effort */ });
  }
  // Hydrate subscriptions from server: any live cypher I've joined as a non-observer.
  void hydrateSubscriptions();
  console.log("[cypher-runtime] started");
}

export function stopCypherRuntime(): void {
  stopped = true;
  for (const sub of subscriptions.values()) closeSubscription(sub);
  subscriptions.clear();
  console.log("[cypher-runtime] stopped");
}

// ── Internals ───────────────────────────────────────────────

async function hydrateSubscriptions(): Promise<void> {
  if (!isAuthenticated()) return;
  try {
    const r = await serverGetAuthed<{ cyphers: Array<{ id: string; status: string }> }>(`/api/cyphers/mine`);
    for (const c of r.cyphers) {
      // Subscribe to any non-terminal cypher — not just "live". A jammer can
      // join while the cypher is still in "lobby"/"draft" (before the leader
      // starts it); restricting to "live" left those clients unsubscribed and
      // their feed dark until a restart after the cypher went live.
      if (c.status === "wrapped" || c.status === "cancelled" || c.status === "archived") continue;
      try {
        const j = await serverGetAuthed<{ jammers: Array<{ user_id: string; agent_local_id: string; left_at: string | null; role: string }> }>(
          `/api/cyphers/${encodeURIComponent(c.id)}/jammers`,
        );
        const me = await serverGetAuthed<{ user: { id: string } }>(`/api/heartbeat`);
        const myJam = j.jammers.find((x) => x.user_id === me.user.id && !x.left_at);
        if (myJam && myJam.role !== "observer") {
          subscribeCypher(c.id, myJam.agent_local_id);
        }
      } catch { /* per-cypher hydration is best-effort */ }
    }
  } catch (err) {
    console.warn("[cypher-runtime] hydrate failed:", err instanceof Error ? err.message : err);
  }
}

function connectSubscription(sub: CypherSubscription): void {
  if (stopped) return;
  if (sub.request) return;
  if (sub.reconnectTimer) { clearTimeout(sub.reconnectTimer); sub.reconnectTimer = null; }

  const token = getAuthToken();
  if (!token) {
    scheduleReconnect(sub);
    return;
  }

  const url = `${AUTH_SERVER}/api/cyphers/${encodeURIComponent(sub.cypherId)}/events/stream?since=${sub.lastSeenSeq}`;
  const request = net.request({ url, method: "GET" });
  request.setHeader("Authorization", `Bearer ${token}`);
  request.setHeader("Accept", "text/event-stream");
  if (sub.lastSeenSeq > 0) request.setHeader("Last-Event-ID", String(sub.lastSeenSeq));
  sub.request = request;
  sub.buffer = "";

  request.on("response", (response) => {
    const status = response.statusCode ?? 500;
    if (status < 200 || status >= 300) {
      console.warn(`[cypher-runtime] stream ${sub.cypherId} got HTTP ${status}; will reconnect`);
      sub.request = null;
      scheduleReconnect(sub);
      return;
    }

    response.on("data", (chunk: Buffer) => {
      sub.buffer += chunk.toString("utf8");
      // SSE frames are separated by a blank line (\n\n). Drain complete frames.
      let split: number;
      while ((split = sub.buffer.indexOf("\n\n")) !== -1) {
        const frame = sub.buffer.slice(0, split);
        sub.buffer = sub.buffer.slice(split + 2);
        if (frame.trim()) void handleFrame(sub, frame);
      }
    });

    response.on("end", () => {
      sub.request = null;
      if (!stopped) scheduleReconnect(sub);
    });

    response.on("error", (err: Error) => {
      console.warn(`[cypher-runtime] stream ${sub.cypherId} response error:`, err.message);
      sub.request = null;
      if (!stopped) scheduleReconnect(sub);
    });
  });

  request.on("error", (err: Error) => {
    console.warn(`[cypher-runtime] stream ${sub.cypherId} request error:`, err.message);
    sub.request = null;
    if (!stopped) scheduleReconnect(sub);
  });

  request.end();
}

function closeSubscription(sub: CypherSubscription): void {
  if (sub.reconnectTimer) { clearTimeout(sub.reconnectTimer); sub.reconnectTimer = null; }
  if (sub.request) {
    try { sub.request.abort(); } catch { /* ignore */ }
    sub.request = null;
  }
}

function scheduleReconnect(sub: CypherSubscription): void {
  if (stopped) return;
  if (sub.reconnectTimer) return;
  const delay = RECONNECT_BACKOFF_MS[Math.min(sub.failures, RECONNECT_BACKOFF_MS.length - 1)];
  sub.failures++;
  sub.reconnectTimer = setTimeout(() => {
    sub.reconnectTimer = null;
    if (subscriptions.get(sub.cypherId) === sub) connectSubscription(sub);
  }, delay);
}

interface ParsedFrame {
  id: number | null;
  event: string;
  data: string;
}

function parseFrame(frame: string): ParsedFrame {
  const out: ParsedFrame = { id: null, event: "message", data: "" };
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") {
      const n = Number(value);
      if (Number.isFinite(n)) out.id = n;
    } else if (field === "event") {
      out.event = value;
    } else if (field === "data") {
      out.data = out.data ? out.data + "\n" + value : value;
    }
  }
  return out;
}

async function handleFrame(sub: CypherSubscription, frameText: string): Promise<void> {
  const frame = parseFrame(frameText);

  // Successful frame → reset backoff
  sub.failures = 0;

  if (frame.event === "reconnect") {
    if (sub.request) { try { sub.request.abort(); } catch { /* ignore */ } sub.request = null; }
    scheduleReconnect(sub);
    return;
  }

  if (frame.event === "error") {
    console.warn(`[cypher-runtime] stream ${sub.cypherId} server error frame:`, frame.data);
    return;
  }

  let payload: { id: string; seq: string | number; kind: string; jam_id: string | null; by_user_id: string | null; by_agent_id: string | null; payload: Record<string, unknown> };
  try {
    payload = JSON.parse(frame.data);
  } catch {
    return;
  }

  const seqNum = Number(payload.seq);
  if (Number.isFinite(seqNum) && seqNum > sub.lastSeenSeq) sub.lastSeenSeq = seqNum;

  const kind = payload.kind;

  // ── Feed: observe EVERY event — the single source of truth ──
  // The cypher feed renders ONLY from this SSE stream (never from local
  // echoes), so every event renders exactly once, keyed by its server `seq`.
  // This permanently kills the duplicate-render class — no echo-skip
  // heuristics, no double-append. Fires for our own events too (the renderer
  // shows them when the round-trip lands). `isOwn` lets the observer suppress
  // re-playing our own one-shot effects (drips) that fired locally on send.
  const isOwn = !!myUserId && payload.by_user_id === myUserId;
  if (eventObserver) {
    eventObserver(sub.cypherId, kind, payload.payload, payload.by_agent_id, seqNum, isOwn);
  }

  // ── Dispatch: drive our local agent brains. Skip events from our own
  //    agents — an agent must not act on its own echoed output. (This guards
  //    only the dispatch below; the feed observer above already ran.)
  if (payload.by_agent_id && sub.agentLocalIds.has(payload.by_agent_id)) return;

  // ── Prompt dispatch (existing behavior) ──
  if (kind === "prompt") {
    if (!promptHandler) return;
    const promptText = typeof payload.payload?.text === "string" ? payload.payload.text : "";
    // Prompt-injection firewall: this is untrusted cross-machine input from
    // another jammer. Hard-block before it ever reaches a local agent.
    const guard = guardPrompt(promptText, `cypher-prompt cypher=${sub.cypherId} from=${payload.by_agent_id ?? "?"}`);
    if (!guard.allowed) {
      console.warn(`[cypher-runtime] dropped prompt event ${payload.id}: ${guard.reason}`);
      return;
    }
    // Pick the first real agent to respond (deterministic; for multi-agent
    // cyphers with external prompts, the dispatcher picks by capability).
    // responderIds excludes the viewer sentinel and the maestro id.
    const respondAs = Array.from(sub.responderIds)[0];
    if (!respondAs) return;

    let result: AgentTurnResult | null = null;
    try {
      result = await promptHandler({
        cypherId: sub.cypherId,
        jamId: payload.jam_id,
        seq: seqNum,
        fromUserId: payload.by_user_id,
        fromAgentId: payload.by_agent_id,
        prompt: promptText,
      }, respondAs);
    } catch (err) {
      console.warn("[cypher-runtime] prompt handler threw:", err instanceof Error ? err.message : err);
      return;
    }

    if (!result) return;

    try {
      await serverPostAuthed(`/api/cyphers/${encodeURIComponent(sub.cypherId)}/events`, {
        kind: "text",
        jam_id: payload.jam_id,
        by_agent_id: respondAs,
        payload: { text: result.text, in_response_to: payload.id, ...(result.meta ?? {}) },
      });
    } catch (err) {
      console.warn("[cypher-runtime] failed to post text:", err instanceof Error ? err.message : err);
    }

    const hasTokens = result.meta && (result.meta.input_tokens || result.meta.output_tokens);
    if (result.yos_used || hasTokens) {
      try {
        await serverPostAuthed(`/api/cyphers/${encodeURIComponent(sub.cypherId)}/events`, {
          kind: "usage",
          jam_id: payload.jam_id,
          by_agent_id: respondAs,
          payload: {
            yos_amount: result.yos_used ?? 0,
            turn_id: payload.id,
            description: `turn response by ${respondAs}`,
            ...(result.meta ?? {}),
          },
        });
      } catch (err) {
        console.warn("[cypher-runtime] usage post failed:", err instanceof Error ? err.message : err);
      }
    }
    return;
  }

  // ── Directed message dispatch (agent_message / post_to) ──
  if (kind === "agent_message" || kind === "post_to" || kind === "post") {
    const toAgent = typeof payload.payload?.to === "string" ? payload.payload.to : null;
    const body = typeof payload.payload?.text === "string" ? payload.payload.text : "";
    // Firewall untrusted cross-machine messages before they reach an agent.
    const guard = guardPrompt(body, `cypher-${kind} cypher=${sub.cypherId} from=${payload.by_agent_id ?? "?"}`);
    if (!guard.allowed) {
      console.warn(`[cypher-runtime] dropped ${kind} event ${payload.id}: ${guard.reason}`);
      return;
    }
    if (toAgent && sub.agentLocalIds.has(toAgent) && agentMessageHandler) {
      agentMessageHandler(sub.cypherId, toAgent, payload.by_agent_id, body, kind, payload.payload);
    }
    // Broadcast posts (no `to` field) with "broadcast" tag
    if (!toAgent && kind === "post" && agentMessageHandler) {
      const tags = Array.isArray(payload.payload?.tags) ? payload.payload.tags as string[] : [];
      if (tags.includes("broadcast")) {
        for (const agentId of sub.agentLocalIds) {
          agentMessageHandler(sub.cypherId, agentId, payload.by_agent_id, body, kind, payload.payload);
        }
      }
    }
    return;
  }

  // All other kinds were already surfaced to the observer at the top of this
  // function — nothing more to do.
}
