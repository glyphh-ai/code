/**
 * InboxRouter — orchestrator-mediated push from events.jsonl to agent inboxes.
 *
 * Per MULTI-AGENT-PLAN §3.3 + Phase 4: when an event lands that matches an
 * agent's subscription, append it to `${rootDir}/.yo/inbox/<agent>.md` so the
 * agent sees it at the start of their next turn (their CLAUDE.md briefing
 * tells them to read this file on every turn).
 *
 * Mechanics:
 *   - One fs.watch per workspace's events.jsonl. On change → replay tail.
 *   - Per-agent lastDeliveredTs tracked in `~/yo/workspaces/<slug>/inbox-state.json`
 *     so app restarts don't re-deliver every event ever logged.
 *   - Self-posts are skipped (an agent doesn't see its own broadcasts).
 *   - Inbox file is rolling — capped at last 50 events to avoid unbounded growth.
 *
 * Fast-path note: `to: <agent>` and `blocking` tag are delivered in the same
 * write loop as everything else. Because fs.watch fires within ~1s, this is
 * already the "fast-path" promised in §3.3. PTY injection (true sub-second
 * push) is deferred to v3.1 if file-watch latency feels high.
 */
import * as fs from "fs";
import * as path from "path";
import type { EventLog, YoEvent } from "./event-log";
import type { WorkspaceManager, CodeAgent, Workspace } from "./workspace-manager";

const MAX_INBOX_EVENTS = 50;

interface InboxState {
  // agentName → lastDeliveredTs
  [agentName: string]: number;
}

export class InboxRouter {
  private watchers = new Map<string, fs.FSWatcher>();
  private debounce = new Map<string, NodeJS.Timeout>();

  constructor(
    private workspaceManager: WorkspaceManager,
    private eventLog: EventLog,
  ) {}

  /** Start watching a workspace's events.jsonl. Idempotent. Drains any
   *  backlog (events newer than lastDeliveredTs per agent) immediately. */
  watch(slug: string): void {
    if (this.watchers.has(slug)) return;
    const ws = this.workspaceManager.get(slug);
    if (!ws) return;

    const wsDir = this.workspaceManager.workspaceDir(slug);
    fs.mkdirSync(wsDir, { recursive: true });
    const eventsFile = path.join(wsDir, "events.jsonl");
    // Touch the file so fs.watch has something to bind to.
    if (!fs.existsSync(eventsFile)) fs.writeFileSync(eventsFile, "");

    // Drain backlog now (covers app-restart case where events landed while
    // we weren't running).
    this.deliverNew(slug);

    const watcher = fs.watch(eventsFile, { persistent: false }, (eventType) => {
      if (eventType !== "change") return;
      // Debounce — fs.watch fires multiple times for a single append on
      // some platforms.
      const existing = this.debounce.get(slug);
      if (existing) clearTimeout(existing);
      this.debounce.set(slug, setTimeout(() => {
        this.debounce.delete(slug);
        this.deliverNew(slug);
      }, 50));
    });
    watcher.on("error", (err) => {
      console.warn(`[inbox-router] watcher error for "${slug}":`, err.message);
    });
    this.watchers.set(slug, watcher);
    console.log(`[inbox-router] watching workspace "${slug}"`);
  }

  unwatch(slug: string): void {
    const w = this.watchers.get(slug);
    if (w) {
      try { w.close(); } catch {}
      this.watchers.delete(slug);
    }
    const t = this.debounce.get(slug);
    if (t) {
      clearTimeout(t);
      this.debounce.delete(slug);
    }
  }

  stop(): void {
    for (const slug of Array.from(this.watchers.keys())) this.unwatch(slug);
  }

  /** Read all events with ts > each agent's lastDeliveredTs and deliver
   *  matches to per-agent inbox files. Atomic per workspace. */
  private deliverNew(slug: string): void {
    const ws = this.workspaceManager.get(slug);
    if (!ws) return;
    const agents = this.workspaceManager.listAgents(slug);
    if (agents.length === 0) return;

    const state = this.loadState(slug);
    // readAll returns latest-first; reverse for chronological delivery.
    const events = this.eventLog.readAll(slug).slice().reverse();

    let dirty = false;
    for (const evt of events) {
      for (const agent of agents) {
        const last = state[agent.name] ?? 0;
        if (evt.ts <= last) continue;
        if (!subscriptionMatches(evt, agent)) continue;
        try {
          this.appendToInbox(ws, agent.name, evt);
        } catch (err) {
          console.warn(`[inbox-router] failed to write inbox for ${agent.name}:`, (err as Error).message);
          continue;
        }
        state[agent.name] = evt.ts;
        dirty = true;
      }
    }
    if (dirty) this.saveState(slug, state);
  }

  /** Append an event entry to the agent's inbox file, then trim to last
   *  MAX_INBOX_EVENTS so the file stays bounded. */
  private appendToInbox(ws: Workspace, agentName: string, evt: YoEvent): void {
    const dir = path.join(ws.rootDir, ".yo", "inbox");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${agentName}.md`);

    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : `# Inbox for ${agentName}\n`;
    const entry = renderEvent(evt);

    const sections = existing.split(/^## /m);
    // sections[0] is the header (everything before the first "## ").
    const header = sections[0];
    const events = sections.slice(1);
    events.push(entry.replace(/^## /, ""));
    const trimmed = events.slice(-MAX_INBOX_EVENTS).map((e) => `## ${e}`);
    fs.writeFileSync(file, header.trimEnd() + "\n\n" + trimmed.join("\n\n").trimEnd() + "\n");
  }

  private stateFile(slug: string): string {
    return path.join(this.workspaceManager.workspaceDir(slug), "inbox-state.json");
  }

  private loadState(slug: string): InboxState {
    const file = this.stateFile(slug);
    if (!fs.existsSync(file)) return {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (raw && typeof raw === "object") return raw as InboxState;
    } catch (err) {
      console.warn(`[inbox-router] inbox-state.json unparseable for "${slug}", resetting:`, (err as Error).message);
    }
    return {};
  }

  private saveState(slug: string, state: InboxState): void {
    fs.writeFileSync(this.stateFile(slug), JSON.stringify(state, null, 2));
  }
}

/** True iff this event should be delivered to this agent. Self-posts and
 *  unsubscribed events are excluded. */
export function subscriptionMatches(evt: YoEvent, agent: CodeAgent): boolean {
  if (evt.from === agent.name) return false;
  const subs = agent.subscriptions ?? [];
  for (const sub of subs) {
    if (sub.mentions_me && evt.to === agent.name) return true;
    if (sub.tags && sub.tags.length > 0 && sub.tags.some((t) => evt.tags.includes(t))) return true;
    if (sub.from && sub.from.length > 0 && sub.from.includes(evt.from)) return true;
  }
  return false;
}

/** Render a single event as a markdown ## section. Compact but greppable. */
function renderEvent(evt: YoEvent): string {
  const time = new Date(evt.ts).toISOString().replace("T", " ").slice(0, 19);
  const arrow = evt.to ? ` → ${evt.to}` : "";
  const flags = evt.tags.includes("blocking") ? " **[BLOCKING]**" : "";
  const tags = evt.tags.length > 0 ? ` _[${evt.tags.join(", ")}]_` : "";
  const refs = evt.refs && evt.refs.length > 0 ? `\nrefs: ${evt.refs.join(", ")}` : "";
  return `## ${time} — ${evt.from}${arrow} (${evt.kind})${flags}${tags}\n\n${evt.body}${refs}\n`;
}
