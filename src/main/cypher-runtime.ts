/**
 * cypher-runtime — provider-side loop that drives joined cyphers.
 *
 * For each cypher I'm joined to:
 *   - track last-seen event seq
 *   - poll for new events
 *   - dispatch `prompt` events to the registered handler (Phase 3.5 wires the
 *     real Claude Agent SDK; v1 ships with no-op so the protocol can be
 *     exercised end-to-end without an LLM bill)
 *   - post `text` + `usage` events back to the cypher feed; server settles
 *     yos atomically via the kitty when it sees `usage`
 *
 * This file owns the polling + dispatch infrastructure ONLY. The "agent brain"
 * is injected via setPromptHandler() so the runner stays decoupled from any
 * specific SDK / model.
 */

import { isAuthenticated, serverGetAuthed, serverPostAuthed } from "./auth";

// ── Types ───────────────────────────────────────────────────

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

interface CypherSubscription {
  cypherId: string;
  /** The local agent_local_id this client is using to participate. */
  agentLocalId: string;
  lastSeenSeq: number;
}

// ── State ───────────────────────────────────────────────────

const subscriptions = new Map<string, CypherSubscription>();   // cypher_id → sub
let pollTimer: ReturnType<typeof setInterval> | null = null;
let promptHandler: PromptHandler | null = null;
let stopped = false;

const POLL_INTERVAL_MS = 3000;

// ── Public API ──────────────────────────────────────────────

/** Inject the agent brain. Pass null to clear (runtime then drops prompts on the floor). */
export function setPromptHandler(handler: PromptHandler | null): void {
  promptHandler = handler;
}

/**
 * Track a cypher subscription. Idempotent. The runtime will start polling for
 * events on this cypher and dispatch new `prompt` events to the registered
 * handler under the given agent identity.
 */
export function subscribeCypher(cypherId: string, agentLocalId: string): void {
  if (subscriptions.has(cypherId)) {
    const cur = subscriptions.get(cypherId)!;
    cur.agentLocalId = agentLocalId;
    return;
  }
  subscriptions.set(cypherId, { cypherId, agentLocalId, lastSeenSeq: 0 });
}

export function unsubscribeCypher(cypherId: string): void {
  subscriptions.delete(cypherId);
}

export function listSubscriptions(): CypherSubscription[] {
  return Array.from(subscriptions.values());
}

/** Start the poll loop. Idempotent. */
export function startCypherRuntime(): void {
  if (pollTimer) return;
  stopped = false;
  // Hydrate subscriptions from server: any live cypher I've joined as a non-observer.
  void hydrateSubscriptions();
  pollTimer = setInterval(() => { void tickAll(); }, POLL_INTERVAL_MS);
  console.log("[cypher-runtime] started");
}

export function stopCypherRuntime(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  stopped = true;
  subscriptions.clear();
  console.log("[cypher-runtime] stopped");
}

// ── Internals ───────────────────────────────────────────────

async function hydrateSubscriptions(): Promise<void> {
  if (!isAuthenticated()) return;
  try {
    const r = await serverGetAuthed<{ cyphers: Array<{ id: string; status: string }> }>(`/api/cyphers/mine`);
    for (const c of r.cyphers) {
      if (c.status !== "live") continue;
      // Look up the jammer row to find which agent I joined with.
      try {
        const j = await serverGetAuthed<{ jammers: Array<{ user_id: string; agent_local_id: string; left_at: string | null; role: string }> }>(
          `/api/cyphers/${encodeURIComponent(c.id)}/jammers`,
        );
        // We need our user id; the heartbeat endpoint has it.
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

async function tickAll(): Promise<void> {
  if (stopped || !isAuthenticated()) return;
  const subs = Array.from(subscriptions.values());
  for (const sub of subs) {
    try { await tickOne(sub); }
    catch (err) {
      console.warn(`[cypher-runtime] tick failed for ${sub.cypherId}:`, err instanceof Error ? err.message : err);
    }
  }
}

async function tickOne(sub: CypherSubscription): Promise<void> {
  const r = await serverGetAuthed<{
    events: Array<{ id: string; seq: string; kind: string; jam_id: string | null; by_user_id: string | null; by_agent_id: string | null; payload: Record<string, unknown> }>;
  }>(`/api/cyphers/${encodeURIComponent(sub.cypherId)}/events?since=${sub.lastSeenSeq}&limit=50`);

  for (const ev of r.events) {
    const seqNum = Number(ev.seq);
    if (seqNum > sub.lastSeenSeq) sub.lastSeenSeq = seqNum;

    if (ev.kind !== "prompt") continue;
    if (ev.by_agent_id === sub.agentLocalId) continue;   // skip my own prompts

    if (!promptHandler) continue;   // no brain wired (Phase 3.5)
    const promptText = typeof ev.payload?.text === "string" ? ev.payload.text : "";
    const result = await promptHandler({
      cypherId: sub.cypherId,
      jamId: ev.jam_id,
      seq: seqNum,
      fromUserId: ev.by_user_id,
      fromAgentId: ev.by_agent_id,
      prompt: promptText,
    }, sub.agentLocalId);

    if (!result) continue;

    // Post the agent's text response.
    try {
      await serverPostAuthed(`/api/cyphers/${encodeURIComponent(sub.cypherId)}/events`, {
        kind: "text",
        jam_id: ev.jam_id,
        by_agent_id: sub.agentLocalId,
        payload: { text: result.text, in_response_to: ev.id, ...(result.meta ?? {}) },
      });
    } catch (err) {
      console.warn("[cypher-runtime] failed to post text:", err instanceof Error ? err.message : err);
    }

    // Post the usage event — server atomically debits the kitty + credits this user.
    if (result.yos_used && result.yos_used > 0) {
      try {
        await serverPostAuthed(`/api/cyphers/${encodeURIComponent(sub.cypherId)}/events`, {
          kind: "usage",
          jam_id: ev.jam_id,
          by_agent_id: sub.agentLocalId,
          payload: {
            yos_amount: result.yos_used,
            turn_id: ev.id,
            description: `turn response by ${sub.agentLocalId}`,
            ...(result.meta ?? {}),
          },
        });
      } catch (err) {
        // 409 = kitty under-funded; runtime should pause this cypher until the kitty
        // is topped up. v1: log and keep polling; the prompt will be re-tried in the
        // next agent-turn cycle (server doesn't track a "consumed" cursor for prompts).
        console.warn("[cypher-runtime] usage post rejected (likely kitty empty):", err instanceof Error ? err.message : err);
      }
    }
  }
}
