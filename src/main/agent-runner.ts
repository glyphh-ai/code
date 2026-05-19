/**
 * AgentRunner — runs jammers and code-workspace agents through a pluggable
 * agent-loop backend.
 *
 * AgentRunner owns everything provider-agnostic: instance lifecycle, session
 * resumption, follow-up message queueing, idle auto-stop, guardrail
 * enforcement, cypher-bus visibility events, and thread persistence. The agent
 * loop itself — the SDK/CLI that drives a turn — lives behind a JammerBackend
 * (see ./jammer-backends). Phase 0 ships only ClaudeBackend; the seam lets
 * later phases run a jammer on Codex or Gemini with no change here.
 *
 * Initial query runs with a string prompt. Follow-up messages (broadcasts,
 * inbox updates) resume the same session, continuing the conversation.
 *
 * Phase 3.5: agents communicate via the cypher bus (CypherBus). When a
 * workspace has a bound cypher, all inter-agent events flow through the SSE
 * stream. File-based inbox (.yo/inbox/<name>.md) is retained as fallback for
 * workspaces without a cypher binding.
 */

import type { WebContents } from "electron";
import fs from "fs";
import path from "path";
import type { CypherBus } from "./cypher-bus";
import * as threadStore from "./cypher-thread-store";
import { usageTracker } from "./usage-tracker";
import { probeJammerCapabilities, capabilityBriefing, type JammerCapabilities } from "./jammer-capabilities";
import { redactSecrets, summarizeToolInput } from "./feed-sanitize";
import { selectBackend } from "./jammer-backends";
import type { AgentConfig, JammerBackend, JammerEvent } from "./jammer-backends";

// AgentConfig moved to ./jammer-backends/types so backends can import it
// without a cycle; re-exported here for existing importers.
export type { AgentConfig } from "./jammer-backends";

interface AgentInstance {
  name: string;
  status: "starting" | "running" | "waiting" | "error";
  sessionId: string | null;
  pendingMessages: string[];
  /** The agent-loop backend driving this jammer's turns. */
  backend: JammerBackend;
  tokens: { input: number; output: number };
  costUsd: number;
  turns: number;
  inboxWatcher: fs.FSWatcher | null;
  busUnsubscribe: (() => void) | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  wcRef: WeakRef<WebContents>;
  config: AgentConfig;
  lastBusKey: string | null;
  /** VCS capability of this jammer's machine, probed at start. */
  capabilities: JammerCapabilities | null;
}

export type UsagePoster = (cypherId: string, agentId: string, inputTokens: number, outputTokens: number) => void;

export class AgentRunner {
  private agents = new Map<string, AgentInstance>();
  private bus: CypherBus | null = null;
  private usagePoster: UsagePoster | null = null;

  setBus(bus: CypherBus): void {
    this.bus = bus;
  }

  setUsagePoster(fn: UsagePoster): void {
    this.usagePoster = fn;
  }

  private key(wcId: number, agent: string): string {
    return `${wcId}:${agent}`;
  }

  /** Send a follow-up message to a running or waiting agent. */
  sendMessage(wcId: number, agentName: string, message: string): boolean {
    const instance = this.agents.get(this.key(wcId, agentName));
    if (!instance) return false;
    this.queueMessage(instance, message);
    return true;
  }

  /** Send a message to ALL agents for a given webContents. */
  broadcastToAll(wcId: number, message: string): void {
    for (const [key, instance] of this.agents) {
      if (key.startsWith(`${wcId}:`)) {
        this.queueMessage(instance, message);
      }
    }
  }

  private queueMessage(instance: AgentInstance, message: string): void {
    if (instance.status === "running") {
      instance.pendingMessages.push(message);
    } else if (instance.status === "waiting" && instance.sessionId) {
      this.runFollowUp(instance, message);
    }
  }

  async startAgent(wc: WebContents, config: AgentConfig): Promise<void> {
    const key = this.key(wc.id, config.name);
    const existing = this.agents.get(key);
    // Skip if the agent is already live in ANY active state — including
    // "waiting" (a finished turn, still alive for follow-ups). Restarting a
    // live agent re-runs the capability probe and re-posts its status event,
    // which reads as a duplicate in the feed.
    if (existing && (existing.status === "running" || existing.status === "starting" || existing.status === "waiting")) {
      console.log(`[agent-runner] "${config.name}" already live (${existing.status}), skipping start`);
      return;
    }
    this.stopAgent(wc.id, config.name);

    const backend = selectBackend(config);

    // Pre-flight (e.g. Claude Code OAuth). ok:false aborts the start silently
    // — the backend owns any user-facing prompt (the gating modal).
    if (backend.preflight) {
      try {
        const pre = await backend.preflight();
        if (!pre.ok) return;
      } catch (err: any) {
        if (!wc.isDestroyed()) {
          wc.send("cw:agent:status", config.name, "error");
          wc.send("cw:agent:message", config.name, {
            type: "error",
            text: `Agent pre-flight failed: ${err?.message || err}`,
          });
        }
        return;
      }
    }

    // Initialize the backend (load SDK/CLI, build run options).
    try {
      await backend.init(config, { requestStop: () => this.stopAgent(wc.id, config.name) });
    } catch (err: any) {
      if (!wc.isDestroyed()) {
        wc.send("cw:agent:status", config.name, "error");
        wc.send("cw:agent:message", config.name, {
          type: "error",
          text: `Failed to initialize agent backend: ${err?.message || err}`,
        });
      }
      return;
    }

    const instance: AgentInstance = {
      name: config.name,
      status: "starting",
      sessionId: null,
      pendingMessages: [],
      backend,
      tokens: { input: 0, output: 0 },
      costUsd: 0,
      turns: 0,
      inboxWatcher: null,
      busUnsubscribe: null,
      idleTimer: null,
      wcRef: new WeakRef(wc),
      config,
      lastBusKey: null,
      capabilities: null,
    };
    this.agents.set(key, instance);

    if (!wc.isDestroyed()) {
      wc.send("cw:agent:status", config.name, "starting");
    }

    // Register on the bus so directed / broadcast messages are pushed into
    // this agent's loop as follow-ups. Swarm + cypher agents both qualify;
    // standalone agents fall back to the file-based inbox.
    if (this.bus && (config.cypherId || config.swarm)) {
      instance.busUnsubscribe = this.bus.register(config.workspace, config.name, (event) => {
        let msg: string;
        if (event.kind === "assign_task") {
          // A (re-)assignment from the leader is authoritative — it overrides
          // whatever the worker was doing or assumed its task was.
          msg = `[ASSIGNMENT from ${event.from}] ${event.body}\n\n`
            + `This is your task. If it differs from what you are currently doing, `
            + `STOP and switch to this — it overrides any earlier interpretation. `
            + `Acknowledge with accept_task, then execute it exactly as written.`;
        } else if (event.to) {
          msg = `Message from ${event.from}: ${event.body}`;
        } else {
          msg = `[broadcast] ${event.from}: ${event.body}`;
        }
        this.queueMessage(instance, msg);
      });
    } else {
      this.watchInbox(wc.id, config);
    }

    console.log(`[agent-runner] starting "${config.name}" cwd=${config.cwd}${config.cypherId ? ` cypher=${config.cypherId}` : ""}`);

    // Probe the jammer's machine for VCS capability before its first turn,
    // so the agent knows up front whether it can push or must hand work off
    // via submit_work — instead of discovering it the hard way mid-run.
    let startPrompt = config.startPrompt;
    if (config.cypherId) {
      try {
        const caps = await probeJammerCapabilities(config.cwd);
        instance.capabilities = caps;
        startPrompt = `${capabilityBriefing(caps)}\n\n${startPrompt}`;
        console.log(`[agent-runner] ${config.name} capabilities: git=${caps.hasGit} gh=${caps.ghAuthed} canPush=${caps.canPush}`);
        // Surface capability to the cypher feed so the maestro sees it.
        if (this.bus) {
          void this.bus.post(config.workspace, {
            from: config.name,
            kind: "status",
            body: caps.canPush
              ? "git ready — can push to the repo directly"
              : `cannot push from this machine (${!caps.hasGit ? "git missing" : "GitHub not authed"}) — will hand off via submit_work`,
            tags: ["broadcast"],
          });
        }
      } catch (err) {
        console.warn(`[agent-runner] capability probe failed for "${config.name}":`, err instanceof Error ? err.message : err);
      }
    }
    await this.runQuery(instance, startPrompt, false);
  }

  private async runFollowUp(instance: AgentInstance, message: string): Promise<void> {
    console.log(`[agent-runner] ${instance.name}: resuming session ${instance.sessionId} with follow-up`);
    await this.runQuery(instance, message, true);
  }

  private async runQuery(instance: AgentInstance, prompt: string, isResume: boolean): Promise<void> {
    const wc = instance.wcRef.deref();
    if (!wc || wc.isDestroyed()) return;

    if (instance.idleTimer) { clearTimeout(instance.idleTimer); instance.idleTimer = null; }
    instance.status = "running";
    wc.send("cw:agent:status", instance.name, "running");

    try {
      const turn = instance.backend.runTurn({
        prompt,
        resumeSessionId: isResume ? instance.sessionId : null,
      });

      for await (const event of turn) {
        const wcNow = instance.wcRef.deref();
        if (!wcNow || wcNow.isDestroyed()) break;

        if (event.kind === "init") {
          instance.sessionId = event.sessionId;
        } else if (event.kind === "result") {
          const inTok = event.inputTokens;
          const outTok = event.outputTokens;
          console.log(`[agent-runner] ${instance.name}: result/${event.subtype} error=${event.isError} in=${inTok} out=${outTok}`);
          instance.tokens.input += inTok;
          instance.tokens.output += outTok;
          instance.costUsd += event.costUsd;
          instance.turns += event.numTurns;

          if ((instance.config.cypherId || instance.config.swarm) && instance.turns > 0) {
            const t = instance.turns;
            const flags = instance as any;
            if (t >= 10 && !flags._nudge1) {
              flags._nudge1 = true;
              this.queueMessage(instance,
                `[SYSTEM] You have used ${t} turns. Start wrapping up — finish what you're working on, ` +
                `commit, and call complete_task. Do not start new files or refactor.`
              );
            } else if (t >= 15 && !flags._nudge2) {
              flags._nudge2 = true;
              this.queueMessage(instance,
                `[SYSTEM] ${t} turns used — budget almost gone. Stop iterating. Commit what you have ` +
                `RIGHT NOW and call complete_task. No more edits.`
              );
            } else if (t >= 20 && !flags._nudge3) {
              flags._nudge3 = true;
              this.queueMessage(instance,
                `[SYSTEM] FINAL WARNING: ${t} turns. You will be shut down in 5 turns. ` +
                `Commit immediately and call complete_task or your work may be lost.`
              );
            }
          }

          if (instance.config.cypherId && (inTok || outTok) && this.usagePoster) {
            this.usagePoster(instance.config.cypherId, instance.name, inTok, outTok);
          }

          // Record to the local usage tracker too — the dashboard token count
          // reads usageTracker, and the cypher usagePoster path only writes to
          // the server's cypher_events. Without this, jammer token/prompt
          // usage never showed up on the user's dashboard.
          if (inTok || outTok) {
            usageTracker.record(instance.name, { inputTokens: inTok, outputTokens: outTok });
          }

          // Hard-enforce the jammer's resource guardrails (the prompt-level
          // "Max turns / token budget" lines are advisory; this is the wall).
          const gr = instance.config.guardrails;
          if (gr) {
            const totalTok = instance.tokens.input + instance.tokens.output;
            let stopReason: string | null = null;
            if (gr.max_turns && instance.turns >= gr.max_turns) {
              stopReason = `max_turns (${gr.max_turns}) reached`;
            } else if (gr.max_tokens_per_session && totalTok >= gr.max_tokens_per_session) {
              stopReason = `token budget (${gr.max_tokens_per_session}) exhausted`;
            }
            if (stopReason) {
              console.warn(`[agent-runner] ${instance.name}: ${stopReason} — stopping agent`);
              const wcId = instance.wcRef.deref()?.id;
              if (wcId != null) this.stopAgent(wcId, instance.name);
              return;
            }
          }
        }

        const serialized = serializeEvent(event);
        if (serialized) {
          wcNow.send("cw:agent:message", instance.name, serialized);
        }

        // Post visibility events to the cypher bus
        if (this.bus && instance.config.cypherId) {
          this.postEventToBus(instance, event);
        }

        // Persist agent thread to local store
        if (instance.config.cypherId && serialized) {
          this.persistAgentEntry(instance.config.cypherId, instance.name, serialized);
        }
      }

      instance.status = "waiting";
      this.armIdleTimer(instance);

      const wcAfter = instance.wcRef.deref();
      if (wcAfter && !wcAfter.isDestroyed()) {
        wcAfter.send("cw:agent:status", instance.name, "waiting");
      }

      console.log(`[agent-runner] ${instance.name}: turn complete, status=waiting`);

      // Drain pending messages
      if (instance.pendingMessages.length > 0 && instance.sessionId) {
        const next = instance.pendingMessages.shift()!;
        instance.pendingMessages = [];
        this.runFollowUp(instance, next);
      }
    } catch (err: any) {
      console.error(`[agent-runner] ${instance.name}: error:`, err.message || err);

      const wcErr = instance.wcRef.deref();
      if (err.name === "AbortError") {
        instance.status = "waiting";
        if (wcErr && !wcErr.isDestroyed()) {
          wcErr.send("cw:agent:status", instance.name, "waiting");
          wcErr.send("cw:agent:message", instance.name, {
            type: "stopped",
            text: "Agent stopped.",
          });
        }
      } else {
        instance.status = "error";
        if (wcErr && !wcErr.isDestroyed()) {
          wcErr.send("cw:agent:status", instance.name, "error");
          wcErr.send("cw:agent:message", instance.name, {
            type: "error",
            text: err.message || String(err),
          });
        }
      }
    }
  }

  private watchInbox(wcId: number, config: AgentConfig): void {
    const key = this.key(wcId, config.name);
    const instance = this.agents.get(key);
    if (!instance) return;

    const inboxFile = path.join(config.cwd, ".yo", "inbox", `${config.name}.md`);
    const inboxDir = path.dirname(inboxFile);

    try { fs.mkdirSync(inboxDir, { recursive: true }); } catch { /* */ }

    let debounce: ReturnType<typeof setTimeout> | null = null;

    try {
      instance.inboxWatcher = fs.watch(inboxDir, (eventType, filename) => {
        if (filename !== `${config.name}.md`) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = null;
          console.log(`[agent-runner] ${config.name}: inbox updated, queuing follow-up`);
          this.queueMessage(
            instance,
            `Your inbox has been updated. Read .yo/inbox/${config.name}.md for new messages and respond accordingly.`
          );
        }, 300);
      });
    } catch {
      console.warn(`[agent-runner] ${config.name}: could not watch inbox at ${inboxDir}`);
    }
  }

  /**
   * Arm the jammer's idle auto-stop. Called when the agent finishes a turn
   * and goes to "waiting"; cleared when the next turn starts. If no input
   * arrives within `auto_stop_idle_seconds`, the agent is stopped.
   */
  private armIdleTimer(instance: AgentInstance): void {
    if (instance.idleTimer) { clearTimeout(instance.idleTimer); instance.idleTimer = null; }
    const secs = instance.config.guardrails?.auto_stop_idle_seconds;
    if (!secs || secs <= 0) return;
    const wcId = instance.wcRef.deref()?.id;
    if (wcId == null) return;
    instance.idleTimer = setTimeout(() => {
      console.warn(`[agent-runner] ${instance.name}: idle ${secs}s — auto-stopping`);
      this.stopAgent(wcId, instance.name);
    }, secs * 1000);
  }

  stopAgent(wcId: number, agentName: string): void {
    const key = this.key(wcId, agentName);
    const instance = this.agents.get(key);
    if (instance) {
      instance.backend.abort();
      instance.inboxWatcher?.close();
      instance.busUnsubscribe?.();
      if (instance.idleTimer) clearTimeout(instance.idleTimer);
      this.agents.delete(key);
    }
  }

  stopAll(wcId: number): void {
    for (const [key, instance] of this.agents) {
      if (key.startsWith(`${wcId}:`)) {
        instance.backend.abort();
        instance.inboxWatcher?.close();
        instance.busUnsubscribe?.();
        if (instance.idleTimer) clearTimeout(instance.idleTimer);
        this.agents.delete(key);
      }
    }
  }

  /** Re-bind all agents from any destroyed webContents to a new one. */
  rebindWebContents(newWc: WebContents): number {
    let rebound = 0;
    const toMove: Array<[string, AgentInstance]> = [];

    for (const [key, instance] of this.agents) {
      const wc = instance.wcRef.deref();
      if (!wc || wc.isDestroyed()) {
        toMove.push([key, instance]);
      }
    }

    for (const [oldKey, instance] of toMove) {
      this.agents.delete(oldKey);
      const newKey = this.key(newWc.id, instance.name);
      instance.wcRef = new WeakRef(newWc);
      this.agents.set(newKey, instance);
      rebound++;
      // Send current status to new webContents
      newWc.send("cw:agent:status", instance.name, instance.status);
    }

    if (rebound > 0) {
      console.log(`[agent-runner] rebound ${rebound} agents to wcId=${newWc.id}`);
    }
    return rebound;
  }

  getStatus(wcId: number, agentName: string): string {
    return this.agents.get(this.key(wcId, agentName))?.status || "idle";
  }

  getTokens(wcId: number, agentName: string): { input: number; output: number } {
    return this.agents.get(this.key(wcId, agentName))?.tokens || { input: 0, output: 0 };
  }

  private persistAgentEntry(cypherId: string, agentName: string, serialized: any): void {
    try {
      if (serialized.type === "assistant" && serialized.text) {
        threadStore.appendAgent(cypherId, agentName, { ts: Date.now(), kind: "text", content: serialized.text });
      }
      if (serialized.type === "assistant" && serialized.toolUses?.length) {
        for (const tu of serialized.toolUses) {
          threadStore.appendAgent(cypherId, agentName, { ts: Date.now(), kind: "tool", content: `${tu.name}(${tu.input})` });
        }
      }
      if (serialized.type === "result" && serialized.result) {
        threadStore.appendAgent(cypherId, agentName, { ts: Date.now(), kind: "text", content: serialized.result });
      }
      if (serialized.type === "error" || (serialized.type === "result" && serialized.isError)) {
        threadStore.appendAgent(cypherId, agentName, { ts: Date.now(), kind: "error", content: serialized.text || serialized.result || "error" });
      }
    } catch { /* best effort */ }
  }

  /** Post a normalized agent event to the cypher bus for visibility. */
  private postEventToBus(instance: AgentInstance, event: JammerEvent): void {
    if (!this.bus) return;
    const ws = instance.config.workspace;
    const from = instance.name;
    const baseMeta: Record<string, unknown> = {
      agent_id: from,
      display_name: instance.config.displayName || null,
      avatar_url: instance.config.avatarUrl || null,
    };

    if (event.kind === "assistant") {
      for (const block of event.blocks) {
        if (block.type === "text" && block.text) {
          const key = `thinking:${block.text.slice(0, 500)}`;
          if (key === instance.lastBusKey) continue;
          instance.lastBusKey = key;
          this.bus.post(ws, {
            from,
            kind: "agent_thinking",
            body: redactSecrets(block.text.slice(0, 500)),
            meta: { ...baseMeta },
          }).catch(() => {});
        } else if (block.type === "tool_use") {
          instance.lastBusKey = null;
          this.bus.post(ws, {
            from,
            kind: "agent_tool_use",
            // summarizeToolInput returns a short label (path / truncated
            // command) and redacts secrets — never file contents or output.
            body: summarizeToolInput(block.name, block.input),
            meta: { ...baseMeta, tool_name: block.name, tool_id: block.id },
          }).catch(() => {});
        }
      }
    } else if (event.kind === "result") {
      const body = event.isError
        ? `Error: ${redactSecrets(String(event.text || "unknown error").slice(0, 300))}`
        : `Completed turn (${event.numTurns} turns, ${event.inputTokens}+${event.outputTokens} tok)`;
      this.bus.post(ws, {
        from,
        kind: event.isError ? "agent_error" : "agent_result",
        body,
        meta: { ...baseMeta },
      }).catch(() => {});
    } else if (event.kind === "status") {
      const displayName = instance.config.displayName || from;
      this.bus.post(ws, {
        from,
        kind: "status",
        body: redactSecrets(`${displayName}: ${event.status}`),
        meta: { ...baseMeta },
      }).catch(() => {});
    }
  }
}

/** Translate a normalized JammerEvent into the `cw:agent:message` payload the
 *  code-workspace renderer consumes. Returns null for events with no UI. */
function serializeEvent(event: JammerEvent): any {
  switch (event.kind) {
    case "assistant": {
      const texts: string[] = [];
      const toolUses: any[] = [];
      for (const block of event.blocks) {
        if (block.type === "text") {
          texts.push(block.text);
        } else {
          toolUses.push({
            id: block.id,
            name: block.name,
            input: summarizeToolInput(block.name, block.input),
            rawInput: block.input,
          });
        }
      }
      return {
        type: "assistant",
        text: texts.join("\n"),
        toolUses,
        parentToolUseId: event.parentToolUseId,
      };
    }

    case "partial_text":
      return { type: "partial_text", text: event.text, index: event.index };

    case "tool_start":
      return { type: "tool_start", id: event.id, name: event.name };

    case "result":
      return {
        type: "result",
        subtype: event.subtype,
        result: event.text,
        usage: { input: event.inputTokens, output: event.outputTokens },
        costUsd: event.costUsd,
        numTurns: event.numTurns,
        durationMs: event.durationMs,
        isError: event.isError,
      };

    case "tool_progress":
      return {
        type: "tool_progress",
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        elapsed: event.elapsed,
      };

    case "init":
      return { type: "init", model: event.model, tools: event.tools, mcpServers: event.mcpServers };

    case "status":
      return { type: "status", status: event.status };

    case "state":
      return { type: "state", state: event.state };

    default:
      return null;
  }
}
