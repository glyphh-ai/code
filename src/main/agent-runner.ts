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
import { AUTH_SERVER, getAuthToken } from "./auth";

function resolveAgentSdkBinary(): string | undefined {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  const arch = process.arch;
  const pkgName = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`;
  const binaryName = platform === "win32" ? "claude.exe" : "claude";

  let realFs: typeof fs;
  try { realFs = require("original-fs"); } catch { realFs = fs; }

  const asarIdx = __dirname.indexOf("app.asar");
  if (asarIdx !== -1) {
    const resourcesDir = __dirname.slice(0, asarIdx);
    const unpackedBase = path.join(resourcesDir, "app.asar.unpacked", "node_modules");
    const candidates = [
      path.join(unpackedBase, pkgName, binaryName),
      path.join(unpackedBase, "@anthropic-ai", "claude-agent-sdk", "node_modules", pkgName, binaryName),
    ];
    for (const candidate of candidates) {
      if (realFs.existsSync(candidate)) return candidate;
    }
  }

  try {
    const dir = path.dirname(require.resolve(`${pkgName}/package.json`));
    const bin = path.join(dir, binaryName);
    if (!bin.includes(".asar") && realFs.existsSync(bin)) return bin;
  } catch {}
  return undefined;
}
import type { CypherBus } from "./cypher-bus";

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
  role: string;
  cwd: string;
  prompt?: string;
  startPrompt: string;
  workspace: string;
  model?: string;
  mcpServers?: Record<string, any>;
  permissionMode?: string;
  cypherId?: string;
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
  wcRef: WeakRef<WebContents>;
  config: AgentConfig;
}

export class AgentRunner {
  private agents = new Map<string, AgentInstance>();
  private sdk: any = null;
  private bus: CypherBus | null = null;

  setBus(bus: CypherBus): void {
    this.bus = bus;
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
    const sdkBinary = resolveAgentSdkBinary();
    const agentCwd = config.cwd || os.homedir();

    const baseOptions: Record<string, any> = {
      cwd: agentCwd,
      ...(sdkBinary ? { pathToClaudeCodeExecutable: sdkBinary } : {}),
      spawnClaudeCodeProcess: (opts: { command: string; args: string[]; cwd: string; env: Record<string, string>; signal: AbortSignal }) => {
        const { spawn } = require("child_process");
        let cmd = sdkBinary || opts.command;
        if (cmd.includes("app.asar" + path.sep) && !cmd.includes("app.asar.unpacked")) {
          cmd = cmd.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
        }
        const spawnCwd = opts.cwd?.includes?.(".asar") ? agentCwd : opts.cwd;
        console.log(`[agent-runner] spawnClaudeCodeProcess: cmd=${cmd} cwd=${spawnCwd}`);
        const child = spawn(cmd, opts.args, {
          cwd: spawnCwd,
          stdio: ["pipe", "pipe", "pipe"],
          signal: opts.signal,
          env: opts.env,
          windowsHide: true,
        });
        return { stdin: child.stdin, stdout: child.stdout, get killed() { return child.killed; }, get exitCode() { return child.exitCode; }, kill: child.kill.bind(child), on: child.on.bind(child), once: child.once.bind(child), off: child.off.bind(child) };
      },
      executable: "node" as const,
      executableArgs: [],
      model: config.model || "claude-sonnet-4-6",
      maxTurns: 200,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      allowedTools: [
        "Bash", "Read", "Edit", "Write", "Grep", "Glob",
        "WebFetch", "WebSearch", "Agent", "TodoWrite",
      ],
      env: {
        ...process.env,
        PATH: shellPath,
        YO_AGENT_NAME: config.name,
        YO_AGENT_ROLE: config.role,
        YO_WORKSPACE: config.workspace,
        CLAUDE_AGENT_SDK_CLIENT_APP: "yosup/2.5.0",
        ANTHROPIC_BASE_URL: `${AUTH_SERVER}/api/llm/anthropic`,
        ANTHROPIC_API_KEY: getAuthToken() || "not-authenticated",
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
      wcRef: new WeakRef(wc),
      config,
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
          console.log(`[agent-runner] ${instance.name}: result/${msg.subtype} error=${msg.is_error} result="${(msg.result || "").slice(0, 100)}"`);
          instance.tokens.input += msg.usage?.input_tokens || 0;
          instance.tokens.output += msg.usage?.output_tokens || 0;
          instance.costUsd += msg.total_cost_usd || 0;
          instance.turns += msg.num_turns || 0;
        }

        const serialized = this.serializeMessage(msg);
        if (serialized) {
          wcNow.send("cw:agent:message", instance.name, serialized);
        }

        // Post visibility events to the cypher bus
        if (this.bus && instance.config.cypherId) {
          this.postToBus(instance, msg);
        }
      }

      instance.activeQuery = null;
      instance.status = "waiting";

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

  stopAgent(wcId: number, agentName: string): void {
    const key = this.key(wcId, agentName);
    const instance = this.agents.get(key);
    if (instance) {
      instance.activeQuery?.close?.();
      instance.inboxWatcher?.close();
      instance.busUnsubscribe?.();
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
        this.agents.delete(key);
      }
    }
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

  /** Post agent events to the cypher bus for visibility + coordination. */
  private postToBus(instance: AgentInstance, msg: any): void {
    if (!this.bus) return;
    const ws = instance.config.workspace;
    const from = instance.name;

    if (msg.type === "assistant") {
      const content = msg.message?.content || [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          this.bus.post(ws, {
            from,
            kind: "agent_thinking",
            body: block.text.slice(0, 200),
            meta: { agent_id: from },
          }).catch(() => {});
        } else if (block.type === "tool_use") {
          this.bus.post(ws, {
            from,
            kind: "agent_tool_use",
            body: this.summarizeToolInput(block.name, block.input),
            meta: { agent_id: from, tool_name: block.name, tool_id: block.id },
          }).catch(() => {});
        }
      }
    }
  }
}
