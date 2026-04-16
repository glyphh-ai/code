/**
 * YoChat — LLM engine for inline yo execution.
 *
 * Context-centric: the interceptor grabs content or the context store
 * provides retrieved chunks. The LLM processes the context — it never
 * reaches into app DOMs directly.
 *
 * Uses Claude Sonnet with tool use for workspace operations.
 */

import { PanelManager } from "./panel-manager";
import { SkillEngine } from "./skill-engine";
import { AppConnector } from "./app-connector";
import { LLMConfig, createCompletion, createStream } from "./llm-config";

export interface ChatCallbacks {
  onText: (delta: string) => void;
  onToolUse: (name: string, input: unknown) => void;
  onDone: () => void;
}

const SYSTEM = `You are Yo, a context extraction engine in the YoSup desktop workspace.

CRITICAL RULES:
- Return ONLY the extracted data. Never explain what you found or how you found it.
- Never start with "Based on...", "I can see...", "The context shows...", or any preamble.
- Never describe what is or isn't visible in the context.
- If the user asks "what did I ask Claude to remember?" and the context contains "Chris is a bad ass for a test", return exactly: Chris is a bad ass for a test
- If you cannot find the answer, say only: not found
- Plain text. No markdown.`;

const TOOLS = [
  {
    name: "dip",
    description: "Switch to a panel or layout.",
    input_schema: {
      type: "object" as const,
      properties: { panel: { type: "string" as const, description: "Panel ID" } },
      required: ["panel"],
    },
  },
];

export class YoChat {
  private history: any[] = [];
  private llmConfig: LLMConfig | null = null;
  private commandCallback: ((cmd: string) => Promise<string>) | null = null;
  private skillEngine: SkillEngine | null = null;
  private appConnector: AppConnector | null = null;

  constructor(
    private panelManager: PanelManager,
  ) {}

  setLLMConfig(config: LLMConfig): void { this.llmConfig = config; }

  setCommandCallback(cb: (cmd: string) => Promise<string>): void {
    this.commandCallback = cb;
  }

  setSkillEngine(se: SkillEngine): void { this.skillEngine = se; }
  setAppConnector(ac: AppConnector): void { this.appConnector = ac; }

  async send(message: string, cb: ChatCallbacks): Promise<void> {
    if (!this.llmConfig?.apiKey) {
      cb.onText("No API key configured. Set your LLM provider in Settings.");
      cb.onDone();
      return;
    }

    this.history.push({ role: "user", content: message });

    try {
      await this.streamLoop(cb);
    } catch (err) {
      cb.onText(`\n\nError: ${err instanceof Error ? err.message : err}`);
      cb.onDone();
    }
  }

  clear(): void {
    this.history = [];
  }

  /**
   * Workbench refinement — skill-aware. Returns a chat message, the
   * full document content, and whether the result is a skill or content.
   *
   * The LLM knows about existing skills and can create/update them.
   * It signals via <type>skill</type> or <type>content</type>.
   */
  async refine(
    instruction: string,
    content: string,
    skillNames: string[],
  ): Promise<{ message: string; content: string; type: "skill" | "content" }> {
    if (!this.llmConfig?.apiKey) return { message: "", content: "No API key configured.", type: "content" };

    const context = this.buildContext();

    const skillList = skillNames.length > 0
      ? `Existing skills: ${skillNames.join(", ")}`
      : "No skills exist yet.";

    const userPrompt = `You are working in the user's content workspace. The workspace has two types of items:

1. **Content** — documents, notes, artifacts
2. **Skills** — reusable prompt templates that transform content (stored as skill files)

${skillList}

A skill is a system prompt / instruction template. When the user says "create a skill" or "update the X skill", you are creating or editing a prompt template, NOT processing content. The skill prompt should be written as instructions for an AI to follow when processing content (e.g. "You are a professional email formatter. Take the user's casual input and rewrite it as a polished professional email...").

IMPORTANT: Every skill prompt you generate MUST include an explicit instruction to output plain text without markdown formatting. Skill output gets pasted into real apps (email, chat, docs) where markdown syntax looks broken. Always include a line like: "Output plain text only. Do not use markdown formatting (no **, no ## headers, no bullet symbols). Use natural line breaks and spacing."

When the user asks to modify, update, refine, or create content/artifacts, use type "content".
When the user asks to create, update, or modify a skill, use type "skill".

User instruction: ${instruction}

${content ? `Current content:\n${content.slice(0, 8000)}` : "(No content loaded)"}

Return your response in this exact format — all three parts are required:
<type>skill or content</type>
<message>Brief 1-2 sentence summary of what you created or changed</message>
<document>
The complete output — either the refined content OR the skill prompt template
</document>

Return the FULL document between <document> tags. Do NOT abbreviate or summarize it.`;

    const response = await createCompletion(this.llmConfig!, {
      system: SYSTEM + "\n\n" + context,
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 4096,
    });

    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }

    const typeMatch = text.match(/<type>(skill|content)<\/type>/i);
    const msgMatch = text.match(/<message>([\s\S]*?)<\/message>/);
    const docMatch = text.match(/<document>([\s\S]*?)<\/document>/);

    const resultType = typeMatch && typeMatch[1].toLowerCase() === "skill" ? "skill" : "content";

    if (docMatch) {
      return {
        message: msgMatch ? msgMatch[1].trim() : "",
        content: docMatch[1].trim(),
        type: resultType,
      };
    }

    // Fallback: treat entire response as content
    return { message: "", content: text, type: resultType };
  }

  /**
   * One-shot LLM execution for inline yo/sup/wassup from the interceptor.
   * Uses a separate history so it doesn't pollute the chat conversation.
   * Runs non-streaming and returns the final text result.
   */
  async executeInline(
    command: "yo",
    instruction: string,
    appId: string,
    appContent?: string,
  ): Promise<string> {
    if (!this.llmConfig?.apiKey) return "No API key configured.";

    const context = this.buildContext();
    const userParts: string[] = [];
    userParts.push(`.yo ${instruction}`);
    if (appContent) {
      userParts.push(`\nContext:\n\n${appContent.slice(0, 8000)}`);
    }

    const messages: any[] = [{ role: "user", content: userParts.join("\n") }];
    let finalText = "";

    // Tool loop (max 5 iterations to prevent runaway)
    for (let i = 0; i < 5; i++) {
      const response = await createCompletion(this.llmConfig, {
        system: SYSTEM + "\n\n" + context,
        messages,
        tools: TOOLS,
        maxTokens: 2048,
      });

      messages.push({ role: "assistant", content: response.content });

      // Collect text
      for (const block of response.content) {
        if (block.type === "text") finalText += block.text;
      }

      // Handle tool calls
      const toolBlocks = response.content.filter((b: any) => b.type === "tool_use");
      if (toolBlocks.length > 0 && response.stopReason === "tool_use") {
        const results: any[] = [];
        for (const block of toolBlocks) {
          if (block.type !== "tool_use") continue;
          const result = await this.exec(block.name, block.input as Record<string, unknown>);
          results.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
        messages.push({ role: "user", content: results });
        finalText = ""; // reset — we want the final text after all tools
      } else {
        break;
      }
    }

    return finalText || "Done.";
  }

  // ── Stream + tool loop ────────────────────────────────

  private async streamLoop(cb: ChatCallbacks): Promise<void> {
    const context = this.buildContext();

    const response = await createStream(
      this.llmConfig!,
      { system: SYSTEM + "\n\n" + context, messages: this.history, tools: TOOLS, maxTokens: 4096 },
      (text) => cb.onText(text),
    );

    this.history.push({ role: "assistant", content: response.content });

    // Handle tool calls
    const toolBlocks = response.content.filter((b: any) => b.type === "tool_use");
    if (toolBlocks.length > 0 && response.stopReason === "tool_use") {
      const results: any[] = [];
      for (const block of toolBlocks) {
        if (block.type !== "tool_use") continue;
        cb.onToolUse(block.name, block.input);
        const result = await this.exec(block.name, block.input as Record<string, unknown>);
        results.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
      this.history.push({ role: "user", content: results });
      await this.streamLoop(cb);
    } else {
      cb.onDone();
    }
  }

  private buildContext(): string {
    const lines: string[] = ["## Current State"];
    lines.push(`Active panel: ${this.panelManager.activePanelId || "none"}`);
    return lines.join("\n");
  }

  // ── Tool execution ────────────────────────────────────

  private async exec(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "dip":
          if (this.commandCallback) return this.commandCallback(`dip ${input.panel}`);
          return "Panel switching not available.";
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  }

  // ── Admin execution (wassup) ─────────────────────────

  private static readonly ADMIN_SYSTEM = `You are Yo, the admin assistant for the YoSup desktop workspace.
The user is configuring their workspace. You can create skills, add apps, and create layouts.

When creating skills: the prompt should be a clear system instruction for how to process content.
When adding apps: use the URL the user provides. The ID is auto-derived from the URL.
When creating layouts: panels are referenced by their app ID (e.g. "claude", "gpt", "gemini").

Be concise. Execute the tools and confirm what you did.`;

  private static readonly ADMIN_TOOLS = [
    {
      name: "skill_create",
      description: "Create or update a skill (a named prompt for processing content).",
      input_schema: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, description: "Skill name (lowercase, no spaces)" },
          prompt: { type: "string" as const, description: "The system prompt instruction for this skill" },
        },
        required: ["name", "prompt"],
      },
    },
    {
      name: "skill_list",
      description: "List all existing skills.",
      input_schema: { type: "object" as const, properties: {} },
    },
    {
      name: "skill_delete",
      description: "Delete a skill by name.",
      input_schema: {
        type: "object" as const,
        properties: { name: { type: "string" as const, description: "Skill name" } },
        required: ["name"],
      },
    },
    {
      name: "app_add",
      description: "Add a new web app panel to the workspace.",
      input_schema: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, description: "Display name for the app" },
          url: { type: "string" as const, description: "Full URL (https://...)" },
        },
        required: ["name", "url"],
      },
    },
    {
      name: "app_list",
      description: "List all configured apps.",
      input_schema: { type: "object" as const, properties: {} },
    },
    {
      name: "layout_create",
      description: "Create a named layout (arrangement of panels). Use 'dip <name>' to activate later.",
      input_schema: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const, description: "Layout name" },
          command: { type: "string" as const, description: "The dip command to create this layout, e.g. 'dip split claude gpt' or 'dip grid claude,gpt / gemini,code'" },
        },
        required: ["name", "command"],
      },
    },
    {
      name: "layout_list",
      description: "List all saved layouts.",
      input_schema: { type: "object" as const, properties: {} },
    },
  ];

  async executeAdmin(instruction: string): Promise<string> {
    if (!this.llmConfig?.apiKey) return "No API key configured.";

    // Build context about current state
    const context: string[] = [];
    if (this.skillEngine) {
      const skills = this.skillEngine.listSkills();
      context.push(`Existing skills: ${skills.length > 0 ? skills.join(", ") : "none"}`);
    }
    if (this.appConnector) {
      const apps = this.appConnector.list();
      context.push(`Existing apps: ${apps.length > 0 ? apps.map((a) => `${a.id} (${a.url})`).join(", ") : "none"}`);
    }

    const messages: any[] = [{
      role: "user",
      content: `${instruction}\n\nCurrent state:\n${context.join("\n")}`,
    }];
    let finalText = "";

    for (let i = 0; i < 5; i++) {
      const response = await createCompletion(this.llmConfig, {
        system: YoChat.ADMIN_SYSTEM,
        messages,
        tools: YoChat.ADMIN_TOOLS,
        maxTokens: 2048,
      });

      messages.push({ role: "assistant", content: response.content });

      for (const block of response.content) {
        if (block.type === "text") finalText += block.text;
      }

      const toolBlocks = response.content.filter((b: any) => b.type === "tool_use");
      if (toolBlocks.length > 0 && response.stopReason === "tool_use") {
        const results: any[] = [];
        for (const block of toolBlocks) {
          if (block.type !== "tool_use") continue;
          const result = await this.execAdmin(block.name, block.input as Record<string, unknown>);
          results.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
        messages.push({ role: "user", content: results });
        finalText = "";
      } else {
        break;
      }
    }

    return finalText || "Done.";
  }

  private async execAdmin(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "skill_create":
          if (!this.skillEngine) return "Skill engine not available.";
          if (this.skillEngine.readSkill(input.name as string) !== null) {
            this.skillEngine.updateSkill(input.name as string, input.prompt as string);
            return `Updated skill: ${input.name}`;
          }
          this.skillEngine.createSkill(input.name as string, input.prompt as string);
          return `Created skill: ${input.name}`;
        case "skill_list": {
          if (!this.skillEngine) return "Skill engine not available.";
          const skills = this.skillEngine.listSkills();
          return skills.length > 0 ? skills.join(", ") : "No skills yet.";
        }
        case "skill_delete":
          if (!this.skillEngine) return "Skill engine not available.";
          return this.skillEngine.deleteSkill(input.name as string)
            ? `Deleted skill: ${input.name}` : `Skill not found: ${input.name}`;
        case "app_add": {
          if (!this.appConnector) return "App connector not available.";
          const url = input.url as string;
          const id = (input.name as string).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
          this.appConnector.add(id, input.name as string, url);
          this.panelManager.addPanel(id, url);
          return `Added app: ${input.name} (${id}) → ${url}`;
        }
        case "app_list": {
          if (!this.appConnector) return "App connector not available.";
          const apps = this.appConnector.list();
          return apps.length > 0
            ? apps.map((a) => `${a.id} — ${a.url}`).join("\n")
            : "No apps yet.";
        }
        case "layout_create": {
          if (!this.commandCallback) return "Command handler not available.";
          const cmd = input.command as string;
          await this.commandCallback(cmd);
          await this.commandCallback(`yo layout save ${input.name} ${cmd.replace(/^dip\s+(split|grid)\s+/, "")}`);
          return `Created layout: ${input.name}`;
        }
        case "layout_list":
          if (!this.commandCallback) return "Command handler not available.";
          return this.commandCallback("yo layout list");
        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : err}`;
    }
  }
}
