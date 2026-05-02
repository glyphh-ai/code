/**
 * YoAgent — Claude Agent SDK powered orchestrator.
 *
 * Uses sdk.query() with in-process MCP tools via createSdkMcpServer.
 * All substrate tools (search, skills, navigation, layout, etc.) are
 * registered as MCP tools. The SDK handles the agent loop, tool calling,
 * and streaming.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { z } from "zod/v4";
import { getShellPath } from "./shell-path";
import { execSync } from "child_process";
import { LLMConfig } from "./llm-config";
import { getAgentToolSpec, executeTool } from "./substrate/tools";
import { usageTracker } from "./usage-tracker";
import { usageQueue } from "./usage-queue";
import type { MemoryStore } from "./memory-store";
import type { CaptureStore } from "./capture-store";
import type { SessionCache } from "./session-cache";
import type { SkillEngine } from "./skill-engine";
import type { NoteStore } from "./note-store";
import { getAgentMode } from "./action-gate";
import type { AgentMode } from "./action-gate";
import type { Council } from "./council";

const dynamicImport = new Function("specifier", "return import(specifier)") as
  (specifier: string) => Promise<any>;

export type ApprovalCallback = (toolName: string, input: Record<string, unknown>) => Promise<boolean>;

export interface YoAgentCallbacks {
  onText: (delta: string) => void;
  onToolUse: (id: string, name: string, input: unknown) => void;
  onToolResult?: (id: string, detail: string) => void;
  onToolProgress?: (id: string, status: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
}

const SYSTEM_PROMPT = `You are yo — a fast, concise assistant backed by a capture store and connected tools.

RULES:
- NEVER narrate. No "Let me...", "I'll start by...", "I found...", "Here's what I can do...". Just act and respond.
- Call tools immediately. Zero preamble.
- Responses: 1-3 sentences max unless the user asks for detail. Return actual content, not descriptions of it.
- No bullet-point alternatives. No follow-up questions unless truly stuck with zero options.
- If a tool fails or doesn't exist, say so in one sentence and stop.
- Plain text only. No markdown formatting — no headers, no bold, no bullets, no italic. Just plain sentences. Only exception: use code fences (\`\`\`) when returning actual code. Bare URLs are fine — they will be auto-linked.
- search_captures uses vector search — descriptive phrases, not keywords.
- search_notes uses keyword search — specific terms.
- web_search + web_read for live web content. Search first, then read specific URLs.
- scan_panel FIRST for element discovery. Use click_element/type_text with those selectors.
- grab_panel is EXPENSIVE (~10K tokens). Only when you need full page text.
- For workspace arrangement use split_view, grid_layout, switch_panel.
- For skills use create_skill, update_skill, read_skill.
- For data stores use store_get, store_set, store_list, store_query.`;

const CHATS_DIR = path.join(os.homedir(), "yo", "chats");

export interface ChatSummary {
  id: string;
  title: string;
  created: string;
  messageCount: number;
}

export class YoAgent {
  private chatId: string | null = null;
  private chatTitle: string = "";
  private llmConfig: LLMConfig | null = null;
  private memoryStore: MemoryStore | null = null;
  private captureStore: CaptureStore | null = null;
  private sessionCache: SessionCache | null = null;
  private skillEngine: SkillEngine | null = null;
  private noteStore: NoteStore | null = null;
  private council: Council | null = null;
  private abortController: AbortController | null = null;
  private _mode: AgentMode = getAgentMode();
  private _approvalCallback: ApprovalCallback | null = null;
  private sessionId: string | null = null;
  private sdk: any = null;
  private mcpServer: any = null;

  // ── Setters ──────────────────────────────────────────────

  setLLMConfig(config: LLMConfig): void { this.llmConfig = config; }
  setMemoryStore(store: MemoryStore): void { this.memoryStore = store; }
  setCaptureStore(store: CaptureStore): void { this.captureStore = store; }
  private workspaceGetter: (() => string) | null = null;
  setWorkspaceGetter(fn: () => string): void { this.workspaceGetter = fn; }
  setSessionCache(cache: SessionCache): void { this.sessionCache = cache; }
  setSkillEngine(engine: SkillEngine): void { this.skillEngine = engine; }
  setNoteStore(store: NoteStore): void { this.noteStore = store; }
  getMode(): AgentMode { return this._mode; }
  setMode(mode: AgentMode): void { this._mode = mode; }
  setApprovalCallback(cb: ApprovalCallback | null): void { this._approvalCallback = cb; }
  setCouncil(council: Council): void { this.council = council; }

  abort(): void {
    this.abortController?.abort();
  }

  // ── SDK initialization ─────────────────────────────────

  private async ensureSDK(): Promise<any> {
    if (!this.sdk) {
      this.sdk = await dynamicImport("@anthropic-ai/claude-agent-sdk");
    }
    return this.sdk;
  }

  private async ensureMcpServer(): Promise<any> {
    if (this.mcpServer) return this.mcpServer;
    const sdk = await this.ensureSDK();

    const tools = this.buildSdkMcpTools(sdk);
    this.mcpServer = sdk.createSdkMcpServer({
      name: "yo",
      version: "1.0.0",
      tools,
      alwaysLoad: true,
    });
    return this.mcpServer;
  }

  private buildSdkMcpTools(sdk: any): any[] {
    const toolSpecs = getAgentToolSpec();
    return toolSpecs.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: this.jsonSchemaToZod(spec.input_schema),
      handler: async (args: Record<string, unknown>) => {
        try {
          const result = await executeTool(spec.name, args);
          return { content: [{ type: "text" as const, text: result }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      },
    }));
  }

  private jsonSchemaToZod(schema: Record<string, unknown>): Record<string, any> {
    const props = (schema.properties || {}) as Record<string, any>;
    const required = new Set((schema.required || []) as string[]);
    const shape: Record<string, any> = {};

    for (const [key, prop] of Object.entries(props)) {
      let field: any;
      switch (prop.type) {
        case "string":
          field = z.string();
          if (prop.enum) field = z.enum(prop.enum);
          break;
        case "number":
          field = z.number();
          break;
        case "boolean":
          field = z.boolean();
          break;
        case "array":
          field = z.array(z.any());
          break;
        case "object":
          field = z.record(z.string(), z.any());
          break;
        default:
          field = z.any();
      }
      if (!required.has(key)) {
        field = field.optional();
      }
      shape[key] = field;
    }

    return shape;
  }

  // ── Send (public API) ──────────────────────────────────

  async send(message: string, cb: YoAgentCallbacks): Promise<void> {
    const balance = usageQueue.lastBalance;
    if (balance !== null && balance <= 0) {
      cb.onError("You're out of yos. Top up your balance to continue using the agent.");
      return;
    }

    if (!this.chatTitle) {
      this.chatTitle = message.slice(0, 80).replace(/\n/g, " ").trim();
    }
    if (!this.chatId) {
      this.chatId = `${Date.now()}`;
    }

    let sdk: any;
    try {
      sdk = await this.ensureSDK();
    } catch (err: any) {
      cb.onError(`Failed to load .Yo agent SDK: ${err.message}`);
      return;
    }

    let mcpServer: any;
    try {
      mcpServer = await this.ensureMcpServer();
    } catch (err: any) {
      cb.onError(`Failed to initialize MCP tools: ${err.message}`);
      return;
    }

    this.abortController = new AbortController();
    const shellPath = getShellPath();

    const model = this.llmConfig?.model || "claude-sonnet-4-6";
    const options: Record<string, any> = {
      model,
      maxTurns: 25,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      tools: [],
      mcpServers: { "yo": mcpServer },
      systemPrompt: this.buildSystemPrompt(),
      abortController: this.abortController,
      includePartialMessages: true,
      persistSession: true,
      env: {
        ...process.env,
        PATH: shellPath,
        CLAUDE_AGENT_SDK_CLIENT_APP: "yosup/3.0.0",
      },
    };

    if (this.sessionId) {
      options.resume = this.sessionId;
    }

    let fullText = "";
    const startTs = Date.now();

    try {
      const gen = sdk.query({ prompt: message, options });

      for await (const msg of gen) {
        if (this.abortController.signal.aborted) break;

        switch (msg.type) {
          case "system":
            if (msg.subtype === "init" && msg.session_id) {
              this.sessionId = msg.session_id;
            }
            break;

          case "assistant": {
            const content = msg.message?.content;
            if (!Array.isArray(content)) break;
            for (const block of content) {
              if (block.type === "tool_use") {
                cb.onToolUse(block.id, block.name, block.input);
              }
            }
            break;
          }

          case "stream_event": {
            const event = msg.event;
            if (!event) break;
            if (event.type === "content_block_delta") {
              const delta = (event as any).delta;
              if (delta?.type === "text_delta" && delta.text) {
                fullText += delta.text;
                cb.onText(delta.text);
              }
            }
            break;
          }

          case "user": {
            const content = msg.message?.content;
            if (!Array.isArray(content)) break;
            for (const block of content as any[]) {
              if (block.type === "tool_result" && block.tool_use_id) {
                const text = typeof block.content === "string"
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content.map((c: any) => c.text || "").join("")
                    : "";
                cb.onToolResult?.(block.tool_use_id, text.slice(0, 500));
              }
            }
            break;
          }

          case "tool_progress": {
            cb.onToolProgress?.(msg.tool_use_id, msg.tool_name?.replace(/_/g, " ") || "working");
            break;
          }

          case "result": {
            const usage = msg.usage;
            if (usage) {
              usageTracker.record("orchestrator", {
                inputTokens: usage.input_tokens || 0,
                outputTokens: usage.output_tokens || 0,
                yosConsumed: 0,
                yosRemaining: 0,
              });
              this.reportUsage(usage.input_tokens || 0, usage.output_tokens || 0, model);
            }
            if (msg.is_error && msg.result) {
              cb.onError(msg.result);
              return;
            }
            break;
          }
        }
      }

      // Save chat record
      this.saveChatRecord(message, fullText, startTs);

      // Ingest turn into capture store
      if (this.captureStore && fullText.trim()) {
        const turnContent = `[user]\n${message}\n\n[assistant]\n${fullText}`;
        this.captureStore.ingest("yo-agent", turnContent, this.workspaceGetter?.()).catch(() => {});
      }

      cb.onDone(fullText);
    } catch (err: any) {
      if (err.name === "AbortError") {
        cb.onDone(fullText || "(stopped)");
      } else {
        cb.onError(err.message || String(err));
      }
    }
  }

  getLastResponse(): string {
    return "";
  }

  getChatId(): string | null { return this.chatId; }
  getChatTitle(): string { return this.chatTitle; }

  // ── System prompt builder ──────────────────────────────

  private buildSystemPrompt(): string {
    let prompt = SYSTEM_PROMPT;

    if (this.captureStore) {
      const count = this.captureStore.count ?? 0;
      if (count > 0) {
        prompt += `\n\nCAPTURE STORE: ${count} entries indexed.`;
      } else {
        prompt += `\n\nCAPTURE STORE: empty — no captures yet.`;
      }
    }

    if (this.skillEngine) {
      const skills = this.skillEngine.listSkills();
      if (skills.length > 0) {
        prompt += `\n\nAVAILABLE SKILLS:\n${skills.map((s) => `- ${s}`).join("\n")}`;
      }
    }

    if (this._mode === "plan") {
      prompt += `\n\nMODE: PLAN\nYou are in plan mode. DO NOT call any tools. Instead, outline your plan as a concise numbered list.`;
    }

    if (this._mode === "code") {
      prompt += `\n\nMODE: CODE\nYou are in code mode — you are the orchestrator of a team of coding agents. Use ws_team_status, ws_read_log, ws_post_to, ws_broadcast, and ws_read_agent to coordinate.`;
    }

    return prompt;
  }

  // ── Usage reporting ────────────────────────────────────

  private reportUsage(inputTokens: number, outputTokens: number, model: string): void {
    const multipliers: Record<string, number> = {
      "claude-haiku-4-5-20251001": 1,
      "claude-sonnet-4-6": 3,
      "claude-opus-4-7": 5,
    };
    const mult = multipliers[model] || 3;
    const yos = Math.ceil((inputTokens / 500 + outputTokens / 100) * mult);

    usageQueue.enqueue({
      inputTokens,
      outputTokens,
      model,
      yosConsumed: yos,
      agent: "orchestrator",
    });
  }

  // ── Chat management ────────────────────────────────────

  clear(): void {
    this.sessionId = null;
    this.chatId = null;
    this.chatTitle = "";
    this.mcpServer = null;
  }

  loadChat(id: string): Array<{ role: string; text: string; tools?: Array<{ name: string; input?: unknown }> }> | null {
    const filepath = path.join(CHATS_DIR, `${id}.md`);
    if (!fs.existsSync(filepath)) return null;
    try {
      const raw = fs.readFileSync(filepath, "utf-8");
      const parsed = this.parseChatFile(raw);
      this.chatId = id;
      this.chatTitle = parsed.title;
      this.sessionId = null;
      return parsed.display;
    } catch {
      return null;
    }
  }

  listChats(): ChatSummary[] {
    fs.mkdirSync(CHATS_DIR, { recursive: true });
    try {
      const files = fs.readdirSync(CHATS_DIR)
        .filter((f) => f.endsWith(".md"))
        .sort().reverse();

      return files.map((f) => {
        try {
          const raw = fs.readFileSync(path.join(CHATS_DIR, f), "utf-8");
          const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
          let title = f.replace(/\.md$/, "");
          let created = "";
          let messageCount = 0;
          if (fmMatch) {
            const fm = fmMatch[1];
            const t = fm.match(/^title:\s*(.+)$/m);
            if (t) title = t[1].trim();
            const c = fm.match(/^created:\s*(.+)$/m);
            if (c) created = c[1].trim();
            const m = fm.match(/^messages:\s*(\d+)$/m);
            if (m) messageCount = parseInt(m[1], 10);
          }
          return { id: f.replace(/\.md$/, ""), title, created, messageCount };
        } catch {
          return { id: f.replace(/\.md$/, ""), title: f, created: "", messageCount: 0 };
        }
      });
    } catch {
      return [];
    }
  }

  deleteChat(id: string): boolean {
    try {
      fs.unlinkSync(path.join(CHATS_DIR, `${id}.md`));
      return true;
    } catch { return false; }
  }

  // ── Persistence ────────────────────────────────────────

  private saveChatRecord(userMessage: string, assistantText: string, startTs: number): void {
    if (!this.chatId) return;
    fs.mkdirSync(CHATS_DIR, { recursive: true });

    const filepath = path.join(CHATS_DIR, `${this.chatId}.md`);
    let existing: Array<{ role: string; content: string }> = [];
    if (fs.existsSync(filepath)) {
      try {
        const raw = fs.readFileSync(filepath, "utf-8");
        const jsonMatch = raw.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch) existing = JSON.parse(jsonMatch[1]);
      } catch {}
    }

    existing.push({ role: "user", content: userMessage });
    if (assistantText) {
      existing.push({ role: "assistant", content: assistantText });
    }

    const userMsgs = existing.filter((m) => m.role === "user").length;
    const lines = [
      "---",
      `title: ${this.chatTitle}`,
      `created: ${new Date(parseInt(this.chatId, 10)).toISOString()}`,
      `messages: ${userMsgs}`,
      "---",
      "",
      "```json",
      JSON.stringify(existing, null, 2),
      "```",
    ];

    fs.writeFileSync(filepath, lines.join("\n"), "utf-8");
  }

  private parseChatFile(raw: string): { title: string; display: Array<{ role: string; text: string }> } {
    let title = "";
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const t = fmMatch[1].match(/^title:\s*(.+)$/m);
      if (t) title = t[1].trim();
    }

    const jsonMatch = raw.match(/```json\n([\s\S]*?)\n```/);
    let messages: Array<{ role: string; content: string }> = [];
    if (jsonMatch) {
      try { messages = JSON.parse(jsonMatch[1]); } catch {}
    }

    const display = messages.map((m) => ({
      role: m.role,
      text: m.content || "",
    }));

    return { title, display };
  }
}
