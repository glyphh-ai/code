/**
 * YoAgent — Orchestrator for .yo commands.
 *
 * Streams responses to the UI and delegates to specialist sub-agents:
 *   - NavigatorAgent: panel interaction (grab, click, navigate, type)
 *   - ResearcherAgent: notes and file search
 *   - ManagerAgent: skills, layouts, apps CRUD
 *
 * Direct tools: inject_text, run_command (output actions stay on orchestrator).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { LLMConfig, createStream, createCompletion } from "./llm-config";
import type { NoteStore } from "./note-store";
import type { AppConnector } from "./app-connector";
import type { MemoryStore } from "./memory-store";

import { NavigatorAgent } from "./agents/navigator-agent";
import { ResearcherAgent } from "./agents/researcher-agent";
import { ManagerAgent } from "./agents/manager-agent";
import { SkillRunnerAgent } from "./agents/skill-runner-agent";

export interface YoAgentCallbacks {
  onText: (delta: string) => void;
  onToolUse: (name: string) => void;
  onToolResult?: (label: string, detail: string) => void;
  onDone: (fullText: string) => void;
  onError: (error: string) => void;
}

const SYSTEM_BASE = `You are yo, a workspace orchestrator. You delegate tasks to specialist agents and handle text injection and commands directly. Plain text only, no markdown.

CRITICAL: NEVER ask the user for clarification. Act immediately.

DELEGATION:
- delegate_navigator: for anything involving live app panels — viewing content, clicking, navigating, typing into apps. Use when the user wants to see what's in Gmail, click an email, search in an app, type into a chat, etc.
- delegate_researcher: for finding information in notes or files. Use when the user asks to find, search, recall, or save notes/files. Notes are primary, files are fallback.
- delegate_manager: for managing skills (prompt templates), layouts (panel arrangements), or apps (connected panels). Use for create/list/read/delete operations.
- delegate_skill: run a skill workflow. Skills are reusable agent behaviours — they can navigate apps, search content, type into inputs, and produce output. When the user says /skillname or asks you to apply a skill, use this. Provide the skill name and the user's instruction.

DIRECT TOOLS (don't delegate these):
- inject_text: paste content into the input where the user typed .yo
- run_command: execute .dip or .drip commands
- save_memory: save something you learned about the user (preferences, patterns, facts). Do this proactively when you notice useful information.

MEMORY:
You have persistent memory. Relevant memories from past conversations are provided below (if any). Use them to personalise your responses and actions. When you learn something new about the user — preferences, workflows, how they use apps, facts about their work — use save_memory to remember it for next time. Don't save trivial or one-off things.

WORKFLOW:
1. Check memories for relevant context
2. Delegate to the right specialist(s) — you can call multiple delegates in parallel for independent tasks
3. Use the specialist's response to answer the user or take further action
4. Chain multiple delegate calls for multi-step tasks — each delegate call is one focused action (e.g. "type X into gmail and submit", then separately "grab content from claude"). Don't try to do everything in one delegate call.
5. If the user says "paste it here" or "put it here", use inject_text with the content
6. If you learned something useful about the user, save_memory

RESPONSE RULES:
- Return the ACTUAL content from specialists, not a summary of what you did
- NEVER say "I found...", "Here's...", "Based on...", "Let me search..."
- Use conversation history for context. If the user says "the earlier one" or "that one", look at what you previously found
- Plain text only. No ** no ## no - bullets.`;

const TOOLS = [
  {
    name: "delegate_navigator",
    description: "Delegate a navigation task to the panel specialist. Use for viewing, clicking, navigating, or typing in live app panels (Gmail, Claude, GPT, etc). Provide a clear instruction of what to find or do.",
    input_schema: {
      type: "object" as const,
      properties: {
        instruction: { type: "string" as const, description: "Clear instruction for the navigator, e.g. 'List panels and grab the content from gmail' or 'Click the first email in gmail and grab its content'" },
      },
      required: ["instruction"],
    },
  },
  {
    name: "delegate_researcher",
    description: "Delegate a research task to the notes/files specialist. Use for searching notes, reading files, saving notes. Provide a clear instruction of what to find or save.",
    input_schema: {
      type: "object" as const,
      properties: {
        instruction: { type: "string" as const, description: "Clear instruction for the researcher, e.g. 'Search notes for pricing information' or 'Save a note titled X with content Y'" },
      },
      required: ["instruction"],
    },
  },
  {
    name: "delegate_manager",
    description: "Delegate a management task to the skills/layouts/apps specialist. Use for creating, listing, reading, or deleting skills, layouts, or apps.",
    input_schema: {
      type: "object" as const,
      properties: {
        instruction: { type: "string" as const, description: "Clear instruction for the manager, e.g. 'List all skills' or 'Create a skill named summarize with prompt: Summarize the following text concisely'" },
      },
      required: ["instruction"],
    },
  },
  {
    name: "delegate_skill",
    description: "Run a skill workflow. Skills are reusable agent behaviours with full tool access — they can navigate apps, search content, type into inputs, and produce output. Use when the user invokes /skillname or when a skill fits the request.",
    input_schema: {
      type: "object" as const,
      properties: {
        skill_name: { type: "string" as const, description: "Name of the skill to run (must exist in the skill engine)" },
        instruction: { type: "string" as const, description: "Additional instruction or context for the skill, e.g. 'summarize the email from John' or 'draft a reply to the last message'" },
      },
      required: ["skill_name", "instruction"],
    },
  },
  {
    name: "inject_text",
    description: "Paste text into the input field where the user typed .yo. Use when the user says 'paste it here', 'put it here', 'type it in', or similar.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: { type: "string" as const, description: "The text to inject into the source input" },
      },
      required: ["text"],
    },
  },
  {
    name: "run_command",
    description: "Run a .dip or .drip command. Examples: 'dip claude', 'dip split claude gpt', 'drip fireworks'.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string" as const, description: "The command to run" },
      },
      required: ["command"],
    },
  },
  {
    name: "save_memory",
    description: "Save something you learned about the user to persistent memory. Use for preferences, workflow patterns, app usage, facts about their work. Don't save trivial or one-off things.",
    input_schema: {
      type: "object" as const,
      properties: {
        content: { type: "string" as const, description: "What to remember, e.g. 'User prefers Gmail over Outlook' or 'User's project Acme uses React + TypeScript'" },
        category: {
          type: "string" as const,
          enum: ["preference", "fact", "workflow", "app_pattern", "context"],
          description: "Category: preference (likes/dislikes), fact (about their work/projects), workflow (how they do things), app_pattern (app-specific behaviour), context (situational)",
        },
      },
      required: ["content", "category"],
    },
  },
];

const CHATS_DIR = path.join(os.homedir(), "yo", "chats");

export interface ChatSummary {
  id: string;
  title: string;
  created: string;
  messageCount: number;
}

export class YoAgent {
  private history: any[] = [];
  private chatId: string | null = null;
  private chatTitle: string = "";
  private maxMessages = 40;
  private llmConfig: LLMConfig | null = null;
  private memoryStore: MemoryStore | null = null;
  private injector: ((text: string) => Promise<boolean>) | null = null;
  private commandRunner: ((cmd: string) => Promise<string>) | null = null;
  private aborted = false;
  private activeMemories: string = "";  // recalled memories for current turn

  // Sub-agents
  private navigator = new NavigatorAgent();
  private researcher = new ResearcherAgent();
  private manager = new ManagerAgent();
  private skillRunner = new SkillRunnerAgent();

  // Skill engine access (for listing + reading skill prompts)
  private skillList: (() => string[]) | null = null;
  private skillRead: ((name: string) => string | null) | null = null;

  // ── Setters (forward to sub-agents) ──────────────────

  setLLMConfig(config: LLMConfig): void {
    this.llmConfig = config;
    this.navigator.setLLMConfig(config);
    this.researcher.setLLMConfig(config);
    this.manager.setLLMConfig(config);
    this.skillRunner.setLLMConfig(config);
  }

  setMemoryStore(store: MemoryStore): void { this.memoryStore = store; }

  setNoteStore(store: NoteStore): void {
    this.researcher.setNoteStore(store);
    this.skillRunner.setNoteStore(store);
  }

  setAppConnector(ac: AppConnector): void {
    this.manager.setAppConnector(ac);
    this.skillRunner.setAppConnector(ac);
    // Navigator + SkillRunner need panel listing from the app connector
    const lister = () => {
      const apps = ac.list();
      if (apps.length === 0) return "No panels configured.";
      return apps.map((a) => `${a.id} — ${a.name} (${a.url})`).join("\n");
    };
    this.navigator.setPanelLister(lister);
    this.skillRunner.setPanelLister(lister);
  }

  setPanelGrabber(fn: (panelId: string) => Promise<string | null>): void {
    this.navigator.setPanelGrabber(fn);
    this.skillRunner.setPanelGrabber(fn);
  }

  setPanelScanner(fn: (panelId: string) => Promise<string | null>): void {
    this.navigator.setPanelScanner(fn);
    this.skillRunner.setPanelScanner(fn);
  }

  setPanelClicker(fn: (panelId: string, text?: string, selector?: string) => Promise<string>): void {
    this.navigator.setPanelClicker(fn);
    this.skillRunner.setPanelClicker(fn);
  }

  setPanelNavigator(fn: (panelId: string, url: string) => Promise<string>): void {
    this.navigator.setPanelNavigator(fn);
    this.skillRunner.setPanelNavigator(fn);
  }

  setPanelTyper(fn: (panelId: string, text: string, opts: { label?: string; placeholder?: string; selector?: string; clear?: boolean; submit?: boolean }) => Promise<string>): void {
    this.navigator.setPanelTyper(fn);
    this.skillRunner.setPanelTyper(fn);
  }

  setPanelOpener(fn: (url: string, panelId?: string) => Promise<string>): void {
    this.navigator.setPanelOpener(fn);
    this.skillRunner.setPanelOpener(fn);
  }

  setBackgroundOpener(fn: (url: string, panelId?: string) => Promise<string>): void {
    this.navigator.setBackgroundOpener(fn);
    this.skillRunner.setBackgroundOpener(fn);
  }

  setMaxMessages(n: number): void { this.maxMessages = n; }
  setCommandRunner(fn: (cmd: string) => Promise<string>): void {
    this.commandRunner = fn;
    this.skillRunner.setCommandRunner(fn);
  }
  setInjector(fn: (text: string) => Promise<boolean>): void {
    this.injector = fn;
    this.skillRunner.setInjector(fn);
  }

  setSkillCallbacks(cbs: {
    list: () => string[];
    read: (name: string) => string | null;
    create: (name: string, prompt: string) => void;
    remove: (name: string) => boolean;
  }): void {
    this.manager.setSkillCallbacks(cbs);
    this.skillRunner.setSkillCallbacks(cbs);
    // Keep references for orchestrator skill awareness
    this.skillList = cbs.list;
    this.skillRead = cbs.read;
  }

  setLayoutCallbacks(cbs: {
    list: () => Array<{ name: string; cols: number; rows: number; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }>;
    save: (name: string, panels: string) => boolean;
    delete: (name: string) => boolean;
  }): void {
    this.manager.setLayoutCallbacks(cbs);
    this.skillRunner.setLayoutCallbacks(cbs);
  }

  abort(): void {
    this.aborted = true;
    this.navigator.abort();
    this.researcher.abort();
    this.manager.abort();
    this.skillRunner.abort();
  }

  // ── Chat management (unchanged) ──────────────────────

  clear(): void {
    this.saveChat();
    this.history = [];
    this.chatId = null;
    this.chatTitle = "";
  }

  loadChat(id: string): Array<{ role: string; text: string }> | null {
    const filepath = path.join(CHATS_DIR, `${id}.md`);
    if (!fs.existsSync(filepath)) return null;
    try {
      const raw = fs.readFileSync(filepath, "utf-8");
      const parsed = this.parseChatFile(raw);
      this.chatId = id;
      this.chatTitle = parsed.title;
      this.history = parsed.history;

      const display: Array<{ role: string; text: string }> = [];
      for (const msg of parsed.history) {
        if (msg.role === "user" && typeof msg.content === "string") {
          display.push({ role: "user", text: msg.content });
        } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const text = msg.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join("");
          if (text) display.push({ role: "assistant", text });
        }
      }
      return display;
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

  // ── Send (public API — unchanged) ────────────────────

  async send(message: string, cb: YoAgentCallbacks): Promise<void> {
    if (!this.llmConfig?.apiKey) {
      cb.onError("No API key configured. Set your LLM provider in Settings.");
      return;
    }

    this.aborted = false;

    // If the last message is a user message with tool_results (from a prior abort),
    // merge the new text into it rather than creating consecutive user messages
    // (the API requires alternating user/assistant).
    const lastMsg = this.history[this.history.length - 1];
    if (lastMsg?.role === "user" && Array.isArray(lastMsg.content)) {
      lastMsg.content.push({ type: "text", text: message });
    } else {
      this.history.push({ role: "user", content: message });
    }

    if (!this.chatTitle) {
      this.chatTitle = message.slice(0, 80).replace(/\n/g, " ").trim();
    }
    if (!this.chatId) {
      this.chatId = `${Date.now()}`;
    }

    if (this.history.length > this.maxMessages) {
      await this.compact();
    }

    // ── Memory recall: search for relevant memories ──
    await this.recallMemories(message);

    try {
      await this.agentLoop(cb);
      this.saveChat();
      // ── Memory extract: background pass to learn from this turn ──
      this.extractMemories().catch(() => {});  // fire-and-forget
    } catch (err) {
      cb.onError(err instanceof Error ? err.message : String(err));
    }
  }

  getLastResponse(): string {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const msg = this.history[i];
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const text = msg.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        if (text) return text;
      }
    }
    return "";
  }

  getChatId(): string | null { return this.chatId; }
  getChatTitle(): string { return this.chatTitle; }

  // ── System prompt builder ────────────────────────────

  private buildSystemPrompt(): string {
    let prompt = SYSTEM_BASE;

    // Self-awareness: don't use your own app panel to answer questions
    if (this.llmConfig) {
      const model = this.llmConfig.model.toLowerCase();
      const provider = this.llmConfig.provider;
      // Map provider/model to app panel IDs the agent should avoid
      const selfPanels: string[] = [];
      if (provider === "anthropic" || model.includes("claude")) selfPanels.push("claude");
      if (provider === "openai" || model.includes("gpt") || model.includes("o3") || model.includes("o4")) selfPanels.push("gpt", "chatgpt");
      if (provider === "google" || model.includes("gemini")) selfPanels.push("gemini");

      if (selfPanels.length > 0) {
        prompt += `\n\nSELF-AWARENESS:\nYou are running on ${provider} (${this.llmConfig.model}). The panels [${selfPanels.join(", ")}] are YOUR OWN web interface. Do NOT navigate to or grab from these panels to answer questions — you already have that knowledge. Only interact with these panels if the user explicitly asks you to (e.g. "type this into Claude", "check my Claude chat history", "click send in GPT").`;
      }
    }

    // Inject available skills so orchestrator knows what's available
    if (this.skillList) {
      const skills = this.skillList();
      if (skills.length > 0) {
        prompt += `\n\nAVAILABLE SKILLS:\n${skills.map((s) => `- /${s}`).join("\n")}\nWhen the user says /<skillname> or asks to apply a skill, use delegate_skill with that skill name.`;
      }
    }

    if (this.activeMemories) {
      prompt += `\n\nYOUR MEMORIES:\n${this.activeMemories}`;
    }

    return prompt;
  }

  // ── Agent loop (orchestrator) ───���─────────���──────────

  private static readonly MAX_TOOL_ITERATIONS = 20;

  private async agentLoop(cb: YoAgentCallbacks, iteration = 0): Promise<void> {
    // Fix any structural issues before hitting the API
    if (iteration === 0) this.sanitizeHistory();

    let fullText = "";

    const systemPrompt = this.buildSystemPrompt();

    const response = await createStream(
      this.llmConfig!,
      {
        system: systemPrompt,
        messages: this.history,
        tools: TOOLS,
        maxTokens: 4096,
      },
      (delta) => {
        fullText += delta;
        cb.onText(delta);
      },
    );

    this.history.push({ role: "assistant", content: response.content });
    if (this.aborted) { this.patchDanglingToolUse(); return; }

    const toolBlocks = response.content.filter((b: any) => b.type === "tool_use");
    if (toolBlocks.length > 0 && response.stopReason === "tool_use") {
      if (iteration >= YoAgent.MAX_TOOL_ITERATIONS) {
        const results = toolBlocks.map((b: any) => ({
          type: "tool_result",
          tool_use_id: b.id,
          content: "[tool limit reached — respond with what you have]",
        }));
        this.history.push({ role: "user", content: results });
        await this.agentLoop(cb, iteration + 1);
        return;
      }

      // Partition into delegate and direct tools
      const delegateBlocks = toolBlocks.filter((b: any) =>
        b.name.startsWith("delegate_"));
      const directBlocks = toolBlocks.filter((b: any) =>
        !b.name.startsWith("delegate_"));

      const results: any[] = [];

      // Run all delegate calls in parallel (sub-agent tools are silent — no onToolUse forwarding)
      if (delegateBlocks.length > 0 && !this.aborted) {
        const context = this.buildSubAgentContext();
        const delegatePromises = delegateBlocks.map(async (block: any) => {
          if (this.aborted) return { type: "tool_result", tool_use_id: block.id, content: "[interrupted by user]" };
          cb.onToolUse(block.name);
          const result = await this.execDelegation(
            block.name,
            block.input as Record<string, unknown>,
            context,
          );
          // Emit compact result for the renderer
          cb.onToolResult?.(block.name, result.slice(0, 500));
          return { type: "tool_result", tool_use_id: block.id, content: result };
        });
        const delegateResults = await Promise.all(delegatePromises);
        results.push(...delegateResults);
      }

      // Run direct tools sequentially
      for (const block of directBlocks) {
        if (this.aborted) break;
        cb.onToolUse(block.name);
        const result = await this.execDirectTool(block.name, block.input as Record<string, unknown>);
        results.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }

      if (this.aborted) {
        if (results.length > 0) this.history.push({ role: "user", content: results });
        this.patchDanglingToolUse();
        return;
      }

      this.history.push({ role: "user", content: results });
      fullText = "";
      await this.agentLoop(cb, iteration + 1);
    } else {
      cb.onDone(fullText);
    }
  }

  // ── Sub-agent context ────────────────────────────────

  private buildSubAgentContext() {
    // Extract last 3-4 user/assistant text exchanges
    const exchanges: string[] = [];
    for (let i = Math.max(0, this.history.length - 8); i < this.history.length; i++) {
      const msg = this.history[i];
      if (msg.role === "user" && typeof msg.content === "string") {
        exchanges.push(`User: ${msg.content.slice(0, 150)}`);
      } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const text = msg.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        if (text) exchanges.push(`Assistant: ${text.slice(0, 150)}`);
      }
    }

    const userMessage = typeof this.history[this.history.length - 2]?.content === "string"
      ? this.history[this.history.length - 2].content
      : exchanges[exchanges.length - 1] || "";

    return {
      conversationSummary: exchanges.length > 1 ? exchanges.slice(0, -1).join("\n") : undefined,
      userMessage,
    };
  }

  // ── Delegation execution ─────────────────────────────

  private async execDelegation(
    name: string,
    input: Record<string, unknown>,
    context: { conversationSummary?: string; userMessage: string },
  ): Promise<string> {
    const instruction = input.instruction as string;
    if (!instruction) return "No instruction provided.";

    try {
      let result;
      switch (name) {
        case "delegate_navigator":
          result = await this.navigator.execute(instruction, context);
          break;
        case "delegate_researcher":
          result = await this.researcher.execute(instruction, context);
          break;
        case "delegate_manager":
          result = await this.manager.execute(instruction, context);
          break;
        case "delegate_skill": {
          const skillName = input.skill_name as string;
          if (!skillName) return "No skill name provided.";
          if (!this.skillRead) return "Skill engine not available.";
          const prompt = this.skillRead(skillName);
          if (!prompt) return `Skill "${skillName}" not found. Use delegate_manager to list available skills.`;
          this.skillRunner.setSkillPrompt(prompt);
          result = await this.skillRunner.execute(instruction, context);
          break;
        }
        default:
          return `Unknown delegation: ${name}`;
      }
      return result.summary;
    } catch (err) {
      return `Delegation error: ${err instanceof Error ? err.message : err}`;
    }
  }

  // ── Direct tool execution ────────────────────────────

  private async execDirectTool(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "inject_text": return await this.toolInjectText(input);
        case "run_command": return await this.toolRunCommand(input);
        case "save_memory": return await this.toolSaveMemory(input);
        default: return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  }

  private async toolInjectText(input: Record<string, unknown>): Promise<string> {
    const text = input.text as string;
    if (!text) return "No text provided.";
    if (!this.injector) return "No source input available — the user may not have typed .yo from an app panel.";
    const ok = await this.injector(text);
    return ok ? "Text injected into the input field." : "Could not inject — the source input is no longer available.";
  }

  private async toolRunCommand(input: Record<string, unknown>): Promise<string> {
    const cmd = (input.command as string || "").trim();
    if (!cmd) return "No command provided.";
    const first = cmd.split(/\s+/)[0].toLowerCase().replace(/^\./, "");
    if (first !== "dip" && first !== "drip") return `Only dip and drip commands are allowed. Got: ${first}`;
    if (!this.commandRunner) return "Command runner not available.";
    return this.commandRunner(cmd);
  }

  private async toolSaveMemory(input: Record<string, unknown>): Promise<string> {
    const content = input.content as string;
    const category = input.category as "preference" | "fact" | "workflow" | "app_pattern" | "context";
    if (!content) return "No content provided.";
    if (!this.memoryStore) return "Memory not available.";
    const id = await this.memoryStore.save(content, category || "context");
    return `Memory saved (${id}).`;
  }

  // ── Memory loop ──────────────────────────────────────

  /**
   * Recall: search memories relevant to the user's message.
   * Injects them into activeMemories for the system prompt.
   */
  private async recallMemories(message: string): Promise<void> {
    if (!this.memoryStore || this.memoryStore.count === 0) {
      this.activeMemories = "";
      return;
    }
    try {
      const memories = await this.memoryStore.search(message, 5);
      if (memories.length === 0) {
        this.activeMemories = "";
        return;
      }
      this.activeMemories = memories
        .map((m) => `- [${m.category}] ${m.content}`)
        .join("\n");
    } catch {
      this.activeMemories = "";
    }
  }

  /**
   * Extract: after each turn, run a cheap background LLM call to
   * pull out any new memories from the conversation. Fire-and-forget.
   */
  private async extractMemories(): Promise<void> {
    if (!this.memoryStore || !this.llmConfig?.apiKey) return;

    // Get last user message + assistant response
    const lastUser = this.getLastUserMessage();
    const lastAssistant = this.getLastResponse();
    if (!lastUser || !lastAssistant) return;

    // Skip trivial exchanges (very short responses)
    if (lastAssistant.length < 50 && lastUser.length < 30) return;

    try {
      const response = await createCompletion(this.llmConfig, {
        system: `You extract useful memories from conversations. A memory is something worth remembering about the user for future conversations: their preferences, how they work, what apps they use, facts about their projects, patterns in their behaviour.

Rules:
- Only extract genuinely useful, reusable information
- Skip trivial or one-off things (greetings, simple commands)
- Skip things that are just about the current task with no future value
- Each memory should be a single clear sentence
- Return a JSON array of objects: [{"content": "...", "category": "preference|fact|workflow|app_pattern|context"}]
- Return [] if nothing worth remembering`,
        messages: [{
          role: "user",
          content: `User said: ${lastUser.slice(0, 500)}\n\nAssistant responded: ${lastAssistant.slice(0, 1000)}\n\nExtract memories (JSON array):`,
        }],
        maxTokens: 500,
        model: this.getCheapModel(),
      });

      const text = response.content[0]?.type === "text" ? response.content[0].text : "";
      // Parse JSON from response (may be wrapped in markdown code block)
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return;

      const memories: Array<{ content: string; category: string }> = JSON.parse(jsonMatch[0]);
      for (const mem of memories) {
        if (mem.content && mem.content.length > 10) {
          await this.memoryStore.save(
            mem.content,
            (mem.category as any) || "context",
          );
        }
      }
    } catch {
      // Non-fatal — extraction is best-effort
    }
  }

  private getLastUserMessage(): string {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === "user" && typeof this.history[i].content === "string") {
        return this.history[i].content;
      }
    }
    return "";
  }

  private getCheapModel(): string {
    if (!this.llmConfig) return "";
    const cheap: Record<string, string> = {
      anthropic: "claude-haiku-4-5-20251001",
      openai: "gpt-4o-mini",
      google: "gemini-2.0-flash",
    };
    return cheap[this.llmConfig.provider] || this.llmConfig.model;
  }

  // ── History safety ────────────────────────────────────

  /**
   * Sanitize history before API calls. Fixes structural issues that
   * can accumulate from aborts, compaction edge cases, or loaded chats.
   */
  private sanitizeHistory(): void {
    // 1. Ensure history starts with a user message (not tool_results)
    while (this.history.length > 0) {
      const first = this.history[0];
      if (first.role === "user") {
        // If it's a user message with only tool_results (no text), remove it
        if (Array.isArray(first.content) &&
            first.content.every((b: any) => b.type === "tool_result")) {
          this.history.shift();
          // Also remove the next message if it's the orphaned assistant response
          if (this.history[0]?.role === "assistant") this.history.shift();
          continue;
        }
        break;
      }
      // History shouldn't start with assistant — remove it
      if (first.role === "assistant") {
        this.history.shift();
        continue;
      }
      break;
    }

    // 2. Ensure alternating user/assistant (merge consecutive same-role messages)
    for (let i = 1; i < this.history.length; i++) {
      if (this.history[i].role === this.history[i - 1].role) {
        const prev = this.history[i - 1];
        const curr = this.history[i];
        if (prev.role === "user") {
          // Merge user messages: combine content into array form
          const prevContent = Array.isArray(prev.content)
            ? prev.content
            : [{ type: "text", text: prev.content }];
          const currContent = Array.isArray(curr.content)
            ? curr.content
            : [{ type: "text", text: curr.content }];
          this.history[i - 1] = { role: "user", content: [...prevContent, ...currContent] };
        } else {
          // Merge assistant messages: combine content arrays
          const prevContent = Array.isArray(prev.content) ? prev.content : [{ type: "text", text: prev.content }];
          const currContent = Array.isArray(curr.content) ? curr.content : [{ type: "text", text: curr.content }];
          this.history[i - 1] = { role: "assistant", content: [...prevContent, ...currContent] };
        }
        this.history.splice(i, 1);
        i--; // re-check same index
      }
    }

    // 3. Ensure every tool_result references a tool_use in the preceding assistant message
    for (let i = 0; i < this.history.length; i++) {
      const msg = this.history[i];
      if (msg.role !== "user" || !Array.isArray(msg.content)) continue;

      const toolResults = msg.content.filter((b: any) => b.type === "tool_result");
      if (toolResults.length === 0) continue;

      // Find preceding assistant message
      const prevAssistant = i > 0 && this.history[i - 1].role === "assistant"
        ? this.history[i - 1]
        : null;

      if (!prevAssistant || !Array.isArray(prevAssistant.content)) {
        // No preceding assistant — strip tool_results, keep text
        msg.content = msg.content.filter((b: any) => b.type !== "tool_result");
        if (msg.content.length === 0) {
          this.history.splice(i, 1);
          i--;
        }
        continue;
      }

      // Get valid tool_use IDs from preceding assistant
      const validIds = new Set(
        prevAssistant.content
          .filter((b: any) => b.type === "tool_use")
          .map((b: any) => b.id)
      );

      // Remove tool_results that reference non-existent tool_use IDs
      msg.content = msg.content.filter((b: any) =>
        b.type !== "tool_result" || validIds.has(b.tool_use_id)
      );

      if (msg.content.length === 0) {
        this.history.splice(i, 1);
        i--;
      }
    }
  }

  private patchDanglingToolUse(): void {
    let lastAssistantIdx = -1;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === "assistant") { lastAssistantIdx = i; break; }
    }
    if (lastAssistantIdx < 0) return;

    const assistantContent = this.history[lastAssistantIdx].content;
    if (!Array.isArray(assistantContent)) return;

    const toolUseIds = assistantContent
      .filter((b: any) => b.type === "tool_use")
      .map((b: any) => b.id);
    if (toolUseIds.length === 0) return;

    const nextMsg = this.history[lastAssistantIdx + 1];
    const existingIds = new Set<string>();
    if (nextMsg?.role === "user" && Array.isArray(nextMsg.content)) {
      for (const b of nextMsg.content) {
        if ((b as any).type === "tool_result") existingIds.add((b as any).tool_use_id);
      }
    }

    const missing = toolUseIds.filter((id: string) => !existingIds.has(id));
    if (missing.length === 0) return;

    const patchResults = missing.map((id: string) => ({
      type: "tool_result" as const,
      tool_use_id: id,
      content: "[interrupted by user]",
    }));

    if (nextMsg?.role === "user" && Array.isArray(nextMsg.content)) {
      nextMsg.content.push(...patchResults);
    } else {
      this.history.splice(lastAssistantIdx + 1, 0, { role: "user", content: patchResults });
    }
  }

  // ── Chat persistence (unchanged) ─────────────────────

  private saveChat(): void {
    if (!this.chatId || this.history.length === 0) return;
    fs.mkdirSync(CHATS_DIR, { recursive: true });

    const userMsgs = this.history.filter((m) => m.role === "user" && typeof m.content === "string").length;

    const lines = [
      "---",
      `title: ${this.chatTitle}`,
      `created: ${new Date(parseInt(this.chatId, 10)).toISOString()}`,
      `messages: ${userMsgs}`,
      "---",
      "",
    ];

    lines.push("```json");
    lines.push(JSON.stringify(this.history, null, 2));
    lines.push("```");

    fs.writeFileSync(path.join(CHATS_DIR, `${this.chatId}.md`), lines.join("\n"), "utf-8");
  }

  private parseChatFile(raw: string): { title: string; history: any[] } {
    let title = "";
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const t = fmMatch[1].match(/^title:\s*(.+)$/m);
      if (t) title = t[1].trim();
    }

    const jsonMatch = raw.match(/```json\n([\s\S]*?)\n```/);
    let history: any[] = [];
    if (jsonMatch) {
      try { history = JSON.parse(jsonMatch[1]); } catch {}
    }

    return { title, history };
  }

  private async compact(): Promise<void> {
    if (!this.llmConfig?.apiKey) return;
    if (this.history.length <= 6) return;

    const keepCount = Math.min(6, Math.floor(this.history.length / 3));
    const oldMessages = this.history.slice(0, -keepCount);
    const recentMessages = this.history.slice(-keepCount);

    const summaryParts: string[] = [];
    for (const msg of oldMessages) {
      if (msg.role === "user" && typeof msg.content === "string") {
        summaryParts.push(`User: ${msg.content.slice(0, 200)}`);
      } else if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const text = msg.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        if (text) summaryParts.push(`Assistant: ${text.slice(0, 200)}`);
        const tools = msg.content
          .filter((b: any) => b.type === "tool_use")
          .map((b: any) => b.name);
        if (tools.length) summaryParts.push(`  [used tools: ${tools.join(", ")}]`);
      }
    }

    try {
      const response = await createCompletion(this.llmConfig, {
        system: "Summarize this conversation history in 2-3 sentences. Focus on what was discussed, what was found, and any actions taken. Be concise.",
        messages: [{ role: "user", content: summaryParts.join("\n") }],
        maxTokens: 300,
      });

      const block = response.content[0];
      const summaryText = block.type === "text" ? block.text : "";

      this.history = [
        { role: "user", content: `[Earlier conversation summary: ${summaryText}]` },
        { role: "assistant", content: [{ type: "text", text: "Understood, I have the context from our earlier conversation." }] },
        ...recentMessages,
      ];
    } catch {
      this.history = recentMessages;
    }
  }
}
