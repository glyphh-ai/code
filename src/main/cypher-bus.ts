/**
 * CypherBus — canonical message bus bridging local event-log ↔ cypher SSE stream.
 *
 * When a workspace has a bound cypher, posts go to both the server (via REST)
 * and the local event-log. When no cypher is bound, posts go to event-log only.
 * Inbound cypher events (agent_message, post_to) are dispatched to registered
 * per-agent handlers — replacing the file-based inbox as the primary path.
 *
 * ─── THE-PIVOT-GITHUB MIGRATION NOTES (Phases 5 + 6) ──────────────────────
 * This bus is on the deprecation list once GH Projects becomes the cypher
 * backend. Replacement mapping:
 *
 *   postCypherEvent / cypher-events SSE     → /api/projects/:ref/events/stream
 *                                              (webhook-driven, see
 *                                              project-routes.ts SSE stub)
 *   subscribeCypherAgent / per-agent inbox  → /api/me/assignments/stream
 *                                              (matchmaker-driven, see
 *                                              installation-routes.ts SSE stub)
 *   getCypherForWorkspace                   → drop session's bound project_id
 *                                              (resolved from
 *                                              ~/.yo/workspaces/<slug>/.project)
 *   dispatchInbound (in main.ts)            → daemon in agent-runner.ts that
 *                                              consumes /api/me/assignments/
 *                                              stream and routes to local
 *                                              jammer loadouts
 *
 * Plan: keep both running for one Drop release after the new SSE streams
 * land server-side, then delete this file once telemetry shows no traffic
 * on the old path. See Phase 6 in docs/THE-PIVOT-GITHUB.md.
 * ───────────────────────────────────────────────────────────────────────
 */

import { postCypherEvent, subscribeCypherAgent, unsubscribeCypherAgent } from "./cypher-runtime";
import type { EventLog, YoEvent } from "./event-log";
import type { HierarchyEntry } from "./mcp-expose";

export interface BusEvent {
  from: string;
  to?: string;
  kind: string;
  body: string;
  tags?: string[];
  refs?: string[];
  meta?: Record<string, unknown>;
}

export type BusMessageHandler = (event: BusEvent) => void;

interface AgentRegistration {
  wsSlug: string;
  agentName: string;
  cypherId: string | null;
  handler: BusMessageHandler;
}

export type BusObserver = (wsSlug: string, event: BusEvent) => void;

const TASK_KINDS = new Set(["assign_task", "accept_task", "complete_task", "request_review"]);

export class CypherBus {
  private registrations = new Map<string, AgentRegistration>();
  private getCypherForWorkspace: (wsSlug: string) => string | null;
  private eventLog: EventLog;
  private observers: BusObserver[] = [];
  private hierarchyContext: Map<string, HierarchyEntry> | null = null;

  constructor(
    getCypherForWorkspace: (wsSlug: string) => string | null,
    eventLog: EventLog,
  ) {
    this.getCypherForWorkspace = getCypherForWorkspace;
    this.eventLog = eventLog;
  }

  setHierarchyContext(ctx: Map<string, HierarchyEntry> | null): void {
    this.hierarchyContext = ctx;
  }

  onPost(cb: BusObserver): () => void {
    this.observers.push(cb);
    return () => { this.observers = this.observers.filter((o) => o !== cb); };
  }

  /**
   * Register an agent on the bus. If a cypher is bound to the workspace,
   * subscribes the agent on the SSE stream. Returns an unsubscribe function.
   */
  register(wsSlug: string, agentName: string, handler: BusMessageHandler): () => void {
    const key = `${wsSlug}:${agentName}`;
    const cypherId = this.getCypherForWorkspace(wsSlug);

    this.registrations.set(key, { wsSlug, agentName, cypherId, handler });

    if (cypherId) {
      subscribeCypherAgent(cypherId, agentName);
    }

    return () => {
      this.registrations.delete(key);
      if (cypherId) {
        unsubscribeCypherAgent(cypherId, agentName);
      }
    };
  }

  /**
   * Post an event. Routes to the cypher (if bound) and always to local event-log.
   */
  async post(wsSlug: string, event: BusEvent): Promise<void> {
    // Validate task-kind events against hierarchy
    if (TASK_KINDS.has(event.kind) && this.hierarchyContext) {
      const sender = this.hierarchyContext.get(event.from);
      if (!sender) {
        console.warn(`[cypher-bus] rejected ${event.kind} from unregistered agent: ${event.from}`);
        return;
      }
      if (event.kind === "assign_task" && event.to) {
        if (!sender.reports.includes(event.to)) {
          console.warn(`[cypher-bus] rejected assign_task: ${event.from} cannot assign to ${event.to} (not a direct report)`);
          return;
        }
      }
    }

    // Always write to local event-log
    this.eventLog.append(wsSlug, {
      from: event.from,
      to: event.to,
      tags: event.tags ?? [],
      kind: (event.kind as YoEvent["kind"]) || "post",
      body: event.body,
      refs: event.refs,
    });

    // Notify observers (UI feed)
    for (const obs of this.observers) {
      try { obs(wsSlug, event); } catch {}
    }

    // If workspace has a cypher, also post to the server
    const cypherId = this.getCypherForWorkspace(wsSlug);
    if (cypherId) {
      const payload: Record<string, unknown> = { text: event.body };
      if (event.to) payload.to = event.to;
      if (event.tags?.length) payload.tags = event.tags;
      if (event.refs?.length) payload.refs = event.refs;
      if (event.meta) Object.assign(payload, event.meta);

      await postCypherEvent(cypherId, event.kind, payload, event.from).catch((err) => {
        console.warn(`[cypher-bus] failed to post to cypher ${cypherId}:`, err instanceof Error ? err.message : err);
      });
    }
  }

  /**
   * Dispatch an inbound cypher event to the correct agent handler.
   * Called by cypher-runtime when it sees an agent_message or post_to event.
   */
  dispatchInbound(toAgent: string, wsSlug: string, event: BusEvent): void {
    const key = `${wsSlug}:${toAgent}`;
    const reg = this.registrations.get(key);
    if (reg) {
      reg.handler(event);
      return;
    }
    // Fallback: try matching by agent name across all workspaces
    for (const [, r] of this.registrations) {
      if (r.agentName === toAgent) {
        r.handler(event);
        return;
      }
    }
  }

  /**
   * Dispatch a broadcast event to all agents in a workspace (except sender).
   */
  dispatchBroadcast(wsSlug: string, event: BusEvent): void {
    for (const [, reg] of this.registrations) {
      if (reg.wsSlug === wsSlug && reg.agentName !== event.from) {
        reg.handler(event);
      }
    }
  }

  /**
   * Check if any agent is registered for a workspace.
   */
  hasAgentsInWorkspace(wsSlug: string): boolean {
    for (const [, reg] of this.registrations) {
      if (reg.wsSlug === wsSlug) return true;
    }
    return false;
  }
}
