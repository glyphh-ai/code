/**
 * CypherBus — in-process message bus for a local agent swarm.
 *
 * Agents post events here; the bus writes them to the local event-log,
 * notifies observers (the swarm-view feed), and dispatches directed /
 * broadcast messages to registered per-agent handlers. Entirely local —
 * no server, no SSE.
 */

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

  getHierarchyContext(): Map<string, HierarchyEntry> | null {
    return this.hierarchyContext;
  }

  onPost(cb: BusObserver): () => void {
    this.observers.push(cb);
    return () => { this.observers = this.observers.filter((o) => o !== cb); };
  }

  /**
   * Register an agent on the bus so it receives directed / broadcast
   * messages. Returns an unsubscribe function.
   */
  register(wsSlug: string, agentName: string, handler: BusMessageHandler): () => void {
    const key = `${wsSlug}:${agentName}`;
    this.registrations.set(key, { wsSlug, agentName, cypherId: null, handler });
    return () => { this.registrations.delete(key); };
  }

  /**
   * Post an event — writes to the local event-log and notifies observers.
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

    // Notify observers (the swarm-view feed)
    for (const obs of this.observers) {
      try { obs(wsSlug, event); } catch {}
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
