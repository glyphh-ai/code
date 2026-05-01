/**
 * EventLog — the workspace's append-only events.jsonl + agent scratchpads.
 *
 * Storage layout (per workspace):
 *   ~/yo/workspaces/<slug>/events.jsonl   — one JSON event per line
 *   ~/yo/workspaces/<slug>/agents/<name>.md — per-agent scratchpad (free-form)
 *
 * The event shape and tag conventions are locked in MULTI-AGENT-PLAN §3.3.
 * This module is the single canonical writer/reader; the workspace MCP
 * server delegates to it. Plain filesystem so events are durable, greppable,
 * and easy to inspect with `tail -f` + `jq`.
 */
import * as fs from "fs";
import * as path from "path";

export interface YoEvent {
  ts: number;
  from: string;          // agent name (panel name); ".yo" for orchestrator; "user" for human
  to?: string;           // optional direct mention — fast-path delivery
  tags: string[];        // ["role:ui", "broadcast", "blocking", "t:auth"]
  kind: "post" | "status" | "question" | "answer" | "artifact";
  body: string;
  refs?: string[];       // file paths, commit shas, ts of replied-to event
}

export interface EventFilter {
  tags?: string[];       // event must contain at least one of these tags
  from?: string[];       // event must be from one of these agents
  to?: string;           // event's `to` field must equal this
  since?: number;        // events with ts > since
  until?: number;        // events with ts <= until
  kinds?: YoEvent["kind"][];
  limit?: number;        // max events returned (default 50, latest-first)
}

export interface TeamMember {
  name: string;
  role: string;
  lastPostTs: number | null;
  postCount: number;
}

export class EventLog {
  constructor(private workspaceDir: (slug: string) => string) {}

  private eventsFile(slug: string): string {
    return path.join(this.workspaceDir(slug), "events.jsonl");
  }

  private agentsDir(slug: string): string {
    return path.join(this.workspaceDir(slug), "agents");
  }

  private scratchpadFile(slug: string, agentName: string): string {
    return path.join(this.agentsDir(slug), `${agentName}.md`);
  }

  /** Append an event. Caller-supplied fields are honored; ts defaults to now. */
  append(slug: string, partial: Omit<YoEvent, "ts"> & { ts?: number }): YoEvent {
    const evt: YoEvent = {
      ts: partial.ts ?? Date.now(),
      from: partial.from,
      to: partial.to,
      tags: partial.tags ?? [],
      kind: partial.kind ?? "post",
      body: partial.body,
      refs: partial.refs,
    };
    fs.mkdirSync(this.workspaceDir(slug), { recursive: true });
    fs.appendFileSync(this.eventsFile(slug), JSON.stringify(evt) + "\n");
    return evt;
  }

  /** Read events matching the filter. Returns latest-first by default. */
  read(slug: string, filter: EventFilter = {}): YoEvent[] {
    const file = this.eventsFile(slug);
    if (!fs.existsSync(file)) return [];

    const raw = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim().length > 0);
    const events: YoEvent[] = [];
    for (const line of raw) {
      try {
        const evt = JSON.parse(line) as YoEvent;
        if (!matchesFilter(evt, filter)) continue;
        events.push(evt);
      } catch {
        // Skip malformed lines — log corruption shouldn't break callers.
      }
    }

    // Latest-first
    events.sort((a, b) => b.ts - a.ts);
    const limit = filter.limit ?? 50;
    return limit > 0 ? events.slice(0, limit) : events;
  }

  /** Read the entire log without filtering — used by team_status. */
  readAll(slug: string): YoEvent[] {
    return this.read(slug, { limit: 0 });
  }

  /** Read an agent's scratchpad markdown. Returns empty string if missing. */
  readScratchpad(slug: string, agentName: string): string {
    const file = this.scratchpadFile(slug, agentName);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  }

  /** Overwrite an agent's scratchpad. */
  writeScratchpad(slug: string, agentName: string, content: string): void {
    fs.mkdirSync(this.agentsDir(slug), { recursive: true });
    fs.writeFileSync(this.scratchpadFile(slug, agentName), content);
  }

  /** Compute team status: per-agent post counts + last activity timestamps. */
  teamStatus(slug: string, agents: { name: string; role: string }[]): TeamMember[] {
    const all = this.readAll(slug);
    const byAgent = new Map<string, { last: number; count: number }>();
    for (const evt of all) {
      const cur = byAgent.get(evt.from) ?? { last: 0, count: 0 };
      cur.count += 1;
      if (evt.ts > cur.last) cur.last = evt.ts;
      byAgent.set(evt.from, cur);
    }
    return agents.map((a) => {
      const stat = byAgent.get(a.name);
      return {
        name: a.name,
        role: a.role,
        lastPostTs: stat?.last ?? null,
        postCount: stat?.count ?? 0,
      };
    });
  }
}

function matchesFilter(evt: YoEvent, filter: EventFilter): boolean {
  if (filter.tags && filter.tags.length > 0) {
    if (!filter.tags.some((t) => evt.tags.includes(t))) return false;
  }
  if (filter.from && filter.from.length > 0) {
    if (!filter.from.includes(evt.from)) return false;
  }
  if (filter.to && evt.to !== filter.to) return false;
  if (filter.since != null && evt.ts <= filter.since) return false;
  if (filter.until != null && evt.ts > filter.until) return false;
  if (filter.kinds && filter.kinds.length > 0) {
    if (!filter.kinds.includes(evt.kind)) return false;
  }
  return true;
}
