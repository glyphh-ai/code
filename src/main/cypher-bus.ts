/**
 * CypherBus — canonical message bus bridging local event-log ↔ cypher SSE stream.
 *
 * When a workspace has a bound cypher, posts go to both the server (via REST)
 * and the local event-log. When no cypher is bound, posts go to event-log only.
 * Inbound cypher events (agent_message, post_to) are dispatched to registered
 * per-agent handlers — replacing the file-based inbox as the primary path.
 */

import { postCypherEvent, subscribeCypherAgent, unsubscribeCypherAgent } from "./cypher-runtime";
import type { EventLog, YoEvent } from "./event-log";

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

export class CypherBus {
  private registrations = new Map<string, AgentRegistration>();
  private getCypherForWorkspace: (wsSlug: string) => string | null;
  private eventLog: EventLog;

  constructor(
    getCypherForWorkspace: (wsSlug: string) => string | null,
    eventLog: EventLog,
  ) {
    this.getCypherForWorkspace = getCypherForWorkspace;
    this.eventLog = eventLog;
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
    // Always write to local event-log
    this.eventLog.append(wsSlug, {
      from: event.from,
      to: event.to,
      tags: event.tags ?? [],
      kind: (event.kind as YoEvent["kind"]) || "post",
      body: event.body,
      refs: event.refs,
    });

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
