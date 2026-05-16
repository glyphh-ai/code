/**
 * AgentRunner — manages Claude Agent SDK instances for code workspace agents.
 *
 * Uses V1 query() with session resumption for persistent multi-turn agents.
 * Initial query runs with a string prompt. Follow-up messages (broadcasts,
 * inbox updates) trigger new query() calls with resume: sessionId, continuing
 * the same conversation.
 *
 * Phase 3.5: agents communicate via the cypher bus (CypherBus). When a
 * workspace has a bound cypher, all inter-agent events flow through the SSE
 * stream. File-based inbox (.yo/inbox/<name>.md) is retained as fallback for
 * workspaces without a cypher binding.
 */

import type { WebContents } from "electron";
import { getShellPath } from "./shell-path";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { asarSafeQueryOptions } from "./sdk-llm";
import type { CypherBus } from "./cypher-bus";
import * as threadStore from "./cypher-thread-store";

const dynamicImport = new Function("specifier", "return import(specifier)") as
  (specifier: string) => Promise<any>;

function findNodePath(): string {
  const shellPath = getShellPath();
  try {
    return execSync("which node", {
      env: { ...process.env, PATH: shellPath },
      encoding: "utf-8",
    }).trim();
  } catch {
    return "node";
  }
}

export interface AgentConfig {
  name: string;
  displayName?: string;
  avatarUrl?: string;
  role: string;
  cwd: string;
  prompt?: string;
  startPrompt: string;
  workspace: string;
  model?: string;
  mcpServers?: Record<string, any>;
  permissionMode?: string;
  cypherId?: string;
  /** Resource limits from the jammer's config — enforced at runtime. */
  guardrails?: import("./agent-store").Guardrails;
}

interface AgentInstance {
  name: string;
  status: "starting" | "running" | "waiting" | "error";
  sessionId: string | null;
  pendingMessages: string[];
  baseOptions: Record<string, any>;
  activeQuery: any;
  seenUuids: Set<string>;
  tokens: { input: number; output: number };
  costUsd: number;
  turns: number;
  inboxWatcher: fs.FSWatcher | null;
  busUnsubscribe: (() => void) | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  wcRef: WeakRef<WebContents>;
  config: AgentConfig;
  lastBusKey: string | null;
}

export type UsagePoster = (cypherId: string, agentId: string, inputTokens: number, outputTokens: number) => void;

export class AgentRunner {
  private agents = new Map<string, AgentInstance>();
  private sdk: any = null;
  private bus: CypherBus | null = null;
  private usagePoster: UsagePoster | null = null;

  setBus(bus: CypherBus): void {
    this.bus = bus;
  }

  setUsagePoster(fn: UsagePoster): void {
    this.usagePoster = fn;
  }

  private async ensureSDK(): Promise<any> {
    if (!this.sdk) {
      this.sdk = await dynamicImport("@anthropic-ai/claude-agent-sdk");
    }
    return this.sdk;
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
    if (existing && (existing.status === "running" || existing.status === "starting")) {
      console.log(`[agent-runner] "${config.name}" already running, skipping`);
      return;
    }
    this.stopAgent(wc.id, config.name);

    // Pre-flight CC auth — if creds are missing, pop the in-app OAuth
    // window and surface a clear status to the renderer instead of
    // letting the SDK error out cryptically downstream.
    {
      const { ensureCcAuth } = await import("./cc-bootstrap");
      // ensureCcAuth() pops the gating modal in the renderer if creds
      // are missing; abort this call and let the modal block the user
      // until creds land. No status/error needed here — the modal owns
      // user-facing comms.
      if (!ensureCcAuth()) return;
    }

    let sdk: any;
    try {
      sdk = await this.ensureSDK();
    } catch (err: any) {
      if (!wc.isDestroyed()) {
        wc.send("cw:agent:status", config.name, "error");
        wc.send("cw:agent:message", config.name, {
          type: "error",
          text: `Failed to load Claude Agent SDK: ${err.message}`,
        });
      }
      return;
    }

    const shellPath = getShellPath();
    const agentCwd = config.cwd || os.homedir();

    const baseOptions: Record<string, any> = {
      ...asarSafeQueryOptions(agentCwd),
      executable: "node" as const,
      executableArgs: [],
      model: config.model || "claude-sonnet-4-6",
      maxTurns: config.guardrails?.max_turns ?? 25,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: [
        "Bash", "Read", "Edit", "Write", "Grep", "Glob",
        "WebFetch", "WebSearch", "Agent", "TodoWrite",
      ],
      // Phase 4 of THE-PIVOT-BYOK: SDK uses CC OAuth creds directly,
      // not the proxy. ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY removed so
      // the SDK auto-discovers ~/.claude/.credentials.json (the user's
      // Claude Code subscription).
      env: {
        ...process.env,
        PATH: shellPath,
        YO_AGENT_NAME: config.name,
        YO_AGENT_ROLE: config.role,
        YO_WORKSPACE: config.workspace,
        CLAUDE_AGENT_SDK_CLIENT_APP: "yosup/2.5.0",
      },
    };

    if (config.prompt) {
      baseOptions.systemPrompt = config.prompt;
    }
    if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
      baseOptions.mcpServers = config.mcpServers;
    }

    // Path-gate: in cypher mode, every tool call resolves through the
    // jammer's sandbox. Anything escaping it is reported on the bus and
    // denied. Three strikes ⇒ self-stop; server-side handler revokes the
    // jammer's seat in cypher_jammers.
    if (config.cypherId) {
      const { checkToolCall } = await import("./substrate/path-gate");
      const violationCounts = { count: 0 };
      const cypherId = config.cypherId;
      const agentLocalId = config.name;
      baseOptions.canUseTool = async (toolName: string, input: Record<string, unknown>) => {
        const violation = checkToolCall(input, { cypherSandbox: config.cwd });
        if (!violation) return { behavior: "allow", updatedInput: input };

        violationCounts.count += 1;
        // Best-effort: post path_violation to the cypher bus
        try {
          const { postCypherEvent } = await import("./cypher-runtime");
          await postCypherEvent(cypherId, "path_violation", {
            agent_local_id: agentLocalId,
            tool: toolName,
            attempted: input,
            sandbox: config.cwd,
            details: violation,
            strike: violationCounts.count,
          }, agentLocalId);
        } catch { /* best-effort — never block on reporting */ }

        // Self-stop after three strikes
        if (violationCounts.count >= 3) {
          console.warn(`[agent-runner] ${agentLocalId} hit 3 path-gate strikes in cypher=${cypherId}; stopping`);
          this.stopAgent(wc.id, agentLocalId);
        }
        return { behavior: "deny", message: `Path-gate violation: ${violation}` };
      };
    }

    const instance: AgentInstance = {
      name: config.name,
      status: "starting",
      sessionId: null,
      pendingMessages: [],
      baseOptions,
      activeQuery: null,
      seenUuids: new Set(),
      tokens: { input: 0, output: 0 },
      costUsd: 0,
      turns: 0,
      inboxWatcher: null,
      busUnsubscribe: null,
      idleTimer: null,
      wcRef: new WeakRef(wc),
      config,
      lastBusKey: null,
    };
    this.agents.set(key, instance);

    if (!wc.isDestroyed()) {
      wc.send("cw:agent:status", config.name, "starting");
    }

    // Register on cypher bus if available; fall back to file-based inbox
    if (this.bus && config.cypherId) {
      instance.busUnsubscribe = this.bus.register(config.workspace, config.name, (event) => {
        const msg = event.to
          ? `Message from ${event.from}: ${event.body}`
          : `[broadcast] ${event.from}: ${event.body}`;
        this.queueMessage(instance, msg);
      });
    } else {
      this.watchInbox(wc.id, config);
    }

    console.log(`[agent-runner] starting "${config.name}" cwd=${config.cwd}${config.cypherId ? ` cypher=${config.cypherId}` : ""}`);
    await this.runQuery(instance, config.startPrompt, false);
  }

  private async runFollowUp(instance: AgentInstance, message: string): Promise<void> {
    console.log(`[agent-runner] ${instance.name}: resuming session ${instance.sessionId} with follow-up`);
    await this.runQuery(instance, message, true);
  }

  private async runQuery(instance: AgentInstance, prompt: string, isResume: boolean): Promise<void> {
    const sdk = this.sdk;
    if (!sdk) return;

    const wc = instance.wcRef.deref();
    if (!wc || wc.isDestroyed()) return;

    if (instance.idleTimer) { clearTimeout(instance.idleTimer); instance.idleTimer = null; }
    instance.status = "running";
    wc.send("cw:agent:status", instance.name, "running");

    const options = { ...instance.baseOptions };
    if (isResume && instance.sessionId) {
      options.resume = instance.sessionId;
    }

    try {
      const gen = sdk.query({ prompt, options });
      instance.activeQuery = gen;

      for await (const msg of gen) {
        const wcNow = instance.wcRef.deref();
        if (!wcNow || wcNow.isDestroyed()) break;

        // Skip replayed messages from previous turns (resume dedup)
        if (msg.isReplay) continue;
        if (msg.uuid && msg.type !== "system") {
          if (instance.seenUuids.has(msg.uuid)) continue;
          instance.seenUuids.add(msg.uuid);
        }

        if (msg.type === "system") {
          console.log(`[agent-runner] ${instance.name}: system/${msg.subtype}`);
          if (msg.subtype === "init") {
            instance.sessionId = msg.session_id || null;
          }
        } else if (msg.type === "result") {
          const inTok = msg.usage?.input_tokens || 0;
          const outTok = msg.usage?.output_tokens || 0;
          console.log(`[agent-runner] ${instance.name}: result/${msg.subtype} error=${msg.is_error} in=${inTok} out=${outTok}`);
          instance.tokens.input += inTok;
          instance.tokens.output += outTok;
          instance.costUsd += msg.total_cost_usd || 0;
          instance.turns += msg.num_turns || 0;

          if (instance.config.cypherId && instance.turns > 0) {
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

        const serialized = this.serializeMessage(msg);
        if (serialized) {
          wcNow.send("cw:agent:message", instance.name, serialized);
        }

        // Post visibility events to the cypher bus
        if (this.bus && instance.config.cypherId) {
          this.postToBus(instance, msg);
        }

        // Persist agent thread to local store
        if (instance.config.cypherId && serialized) {
          this.persistAgentEntry(instance.config.cypherId, instance.name, serialized);
        }
      }

      instance.activeQuery = null;
      instance.status = "waiting";
      this.armIdleTimer(instance);

      const wcAfter = instance.wcRef.deref();
      if (wcAfter && !wcAfter.isDestroyed()) {
        wcAfter.send("cw:agent:status", instance.name, "waiting");
      }

      console.log(`[agent-runner] ${instance.name}: query complete, status=waiting`);

      // Drain pending messages
      if (instance.pendingMessages.length > 0 && instance.sessionId) {
        const next = instance.pendingMessages.shift()!;
        instance.pendingMessages = [];
        this.runFollowUp(instance, next);
      }
    } catch (err: any) {
      instance.activeQuery = null;
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
      instance.activeQuery?.close?.();
      instance.inboxWatcher?.close();
      instance.busUnsubscribe?.();
      if (instance.idleTimer) clearTimeout(instance.idleTimer);
      instance.activeQuery = null;
      this.agents.delete(key);
    }
  }

  stopAll(wcId: number): void {
    for (const [key, instance] of this.agents) {
      if (key.startsWith(`${wcId}:`)) {
        instance.activeQuery?.close?.();
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

  private serializeMessage(msg: any): any {
    switch (msg.type) {
      case "assistant": {
        const content = msg.message?.content || [];
        const texts: string[] = [];
        const toolUses: any[] = [];

        for (const block of content) {
          if (block.type === "text") {
            texts.push(block.text);
          } else if (block.type === "tool_use") {
            toolUses.push({
              id: block.id,
              name: block.name,
              input: this.summarizeToolInput(block.name, block.input),
              rawInput: block.input,
            });
          }
        }

        return {
          type: "assistant",
          text: texts.join("\n"),
          toolUses,
          parentToolUseId: msg.parent_tool_use_id || null,
        };
      }

      case "stream_event": {
        const evt = msg.event;
        if (!evt) return null;
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
          return { type: "partial_text", text: evt.delta.text, index: evt.index };
        }
        if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
          return { type: "tool_start", id: evt.content_block.id, name: evt.content_block.name };
        }
        return null;
      }

      case "result":
        return {
          type: "result",
          subtype: msg.subtype,
          result: msg.result || "",
          usage: {
            input: msg.usage?.input_tokens || 0,
            output: msg.usage?.output_tokens || 0,
          },
          costUsd: msg.total_cost_usd || 0,
          numTurns: msg.num_turns || 0,
          durationMs: msg.duration_ms || 0,
          isError: msg.is_error || false,
        };

      case "tool_progress":
        return {
          type: "tool_progress",
          toolUseId: msg.tool_use_id,
          toolName: msg.tool_name,
          elapsed: msg.elapsed_time_seconds,
        };

      case "system":
        if (msg.subtype === "init") {
          return { type: "init", model: msg.model, tools: msg.tools, mcpServers: msg.mcp_servers };
        }
        if (msg.subtype === "status") {
          return { type: "status", status: msg.status };
        }
        if (msg.subtype === "session_state_changed") {
          return { type: "state", state: msg.state };
        }
        return null;

      default:
        return null;
    }
  }

  private summarizeToolInput(toolName: string, input: any): string {
    if (!input) return "";
    switch (toolName) {
      case "Read": return input.file_path || "";
      case "Edit": return input.file_path || "";
      case "Write": return input.file_path || "";
      case "Bash":
        return input.command ? (input.command.length > 80 ? input.command.slice(0, 80) + "…" : input.command) : "";
      case "Grep": case "Glob":
        return input.pattern || input.glob || "";
      case "WebFetch": return input.url || "";
      case "WebSearch": return input.query || "";
      case "Agent": return input.description || input.prompt?.slice(0, 60) || "";
      case "TodoWrite": return `${(input.todos || []).length} tasks`;
      default:
        if (input.body) return input.body.length > 80 ? input.body.slice(0, 80) + "…" : input.body;
        if (input.command) return input.command.slice(0, 80);
        if (input.query) return input.query.slice(0, 80);
        if (input.path || input.file_path) return input.path || input.file_path;
        return "";
    }
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

  /** Post agent events to the cypher bus for visibility + coordination. */
  private postToBus(instance: AgentInstance, msg: any): void {
    if (!this.bus) return;
    const ws = instance.config.workspace;
    const from = instance.name;
    const baseMeta: Record<string, unknown> = {
      agent_id: from,
      display_name: instance.config.displayName || null,
      avatar_url: instance.config.avatarUrl || null,
    };

    if (msg.type === "assistant") {
      const content = msg.message?.content || [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          const key = `thinking:${block.text.slice(0, 500)}`;
          if (key === instance.lastBusKey) continue;
          instance.lastBusKey = key;
          this.bus.post(ws, {
            from,
            kind: "agent_thinking",
            body: block.text.slice(0, 500),
            meta: { ...baseMeta },
          }).catch(() => {});
        } else if (block.type === "tool_use") {
          instance.lastBusKey = null;
          this.bus.post(ws, {
            from,
            kind: "agent_tool_use",
            body: this.summarizeToolInput(block.name, block.input),
            meta: { ...baseMeta, tool_name: block.name, tool_id: block.id },
          }).catch(() => {});
        }
      }
    } else if (msg.type === "result") {
      const displayName = instance.config.displayName || from;
      const body = msg.is_error
        ? `Error: ${(msg.result || "unknown error").slice(0, 300)}`
        : `Completed turn (${msg.num_turns || 0} turns, ${msg.usage?.input_tokens || 0}+${msg.usage?.output_tokens || 0} tok)`;
      this.bus.post(ws, {
        from,
        kind: msg.is_error ? "agent_error" : "agent_result",
        body,
        meta: { ...baseMeta },
      }).catch(() => {});
    } else if (msg.type === "system" && msg.subtype === "status") {
      const displayName = instance.config.displayName || from;
      this.bus.post(ws, {
        from,
        kind: "status",
        body: `${displayName}: ${msg.status || msg.subtype}`,
        meta: { ...baseMeta },
      }).catch(() => {});
    }
  }
}
