/**
 * ManagerAgent — skills, layouts, and apps CRUD specialist.
 *
 * Handles: manage_skill, manage_layout, manage_app.
 * Simple routing — mostly one-shot CRUD operations.
 */

import { BaseSubAgent } from "./base-agent";
import type { ToolDef } from "./types";
import type { AppConnector } from "../app-connector";

export class ManagerAgent extends BaseSubAgent {
  protected agentName = "manager";
  private skillCallbacks: {
    list: () => string[];
    read: (name: string) => string | null;
    create: (name: string, prompt: string) => void;
    remove: (name: string) => boolean;
  } | null = null;
  private layoutCallbacks: {
    list: () => Array<{ name: string; cols: number; rows: number; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }>;
    save: (name: string, panels: string) => boolean;
    delete: (name: string) => boolean;
  } | null = null;
  private appConnector: AppConnector | null = null;

  setSkillCallbacks(cbs: typeof this.skillCallbacks): void { this.skillCallbacks = cbs; }
  setLayoutCallbacks(cbs: typeof this.layoutCallbacks): void { this.layoutCallbacks = cbs; }
  setAppConnector(ac: AppConnector): void { this.appConnector = ac; }

  get systemPrompt(): string {
    return `You are a workspace manager specialist. You handle CRUD operations for skills (prompt templates), layouts (panel arrangements), and apps (connected web panels).

RESPONSE:
- Confirm the action taken with a brief result
- For list operations, return the full list
- Plain text only, no markdown.`;
  }

  get tools(): ToolDef[] {
    return [
      {
        name: "manage_skill",
        description: "Create, list, read, or delete prompt skills.",
        input_schema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "list", "read", "delete"], description: "Action to perform" },
            name: { type: "string", description: "Skill name (for create/read/delete)" },
            prompt: { type: "string", description: "System prompt (for create)" },
          },
          required: ["action"],
        },
      },
      {
        name: "manage_layout",
        description: "Save, list, or delete panel layouts.",
        input_schema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["save", "list", "delete"], description: "Action to perform" },
            name: { type: "string", description: "Layout name (for save/delete)" },
            panels: { type: "string", description: "Panel IDs, use / for rows. E.g. 'claude gpt / gemini code' (for save)" },
          },
          required: ["action"],
        },
      },
      {
        name: "manage_app",
        description: "Add, list, or remove connected apps (web panels).",
        input_schema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["add", "list", "remove"], description: "Action to perform" },
            id: { type: "string", description: "App ID (for add/remove)" },
            name: { type: "string", description: "Display name (for add, defaults to id)" },
            url: { type: "string", description: "URL (for add)" },
          },
          required: ["action"],
        },
      },
    ];
  }

  async execTool(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "manage_skill": return this.toolManageSkill(input);
      case "manage_layout": return this.toolManageLayout(input);
      case "manage_app": return this.toolManageApp(input);
      default: return `Unknown tool: ${name}`;
    }
  }

  // ── Tool implementations (lifted from yo-agent.ts) ──────

  private toolManageSkill(input: Record<string, unknown>): string {
    const action = input.action as string;
    if (!this.skillCallbacks) return "Skill engine not available.";
    switch (action) {
      case "list": {
        const names = this.skillCallbacks.list();
        return names.length ? names.join("\n") : "No skills found.";
      }
      case "read": {
        const name = input.name as string;
        if (!name) return "Skill name required.";
        const prompt = this.skillCallbacks.read(name);
        return prompt ?? `Skill "${name}" not found.`;
      }
      case "create": {
        const name = input.name as string;
        const prompt = input.prompt as string;
        if (!name || !prompt) return "Both name and prompt required.";
        this.skillCallbacks.create(name, prompt);
        return `Skill "${name}" created.`;
      }
      case "delete": {
        const name = input.name as string;
        if (!name) return "Skill name required.";
        return this.skillCallbacks.remove(name) ? `Skill "${name}" deleted.` : `Skill "${name}" not found.`;
      }
      default: return `Unknown skill action: ${action}`;
    }
  }

  private toolManageLayout(input: Record<string, unknown>): string {
    const action = input.action as string;
    if (!this.layoutCallbacks) return "Layout manager not available.";
    switch (action) {
      case "list": {
        const layouts = this.layoutCallbacks.list();
        if (!layouts.length) return "No saved layouts.";
        return layouts.map((l) => {
          const panels = l.cells.map((c) => c.panelId).join(", ");
          return `${l.name} (${l.cols}x${l.rows}: ${panels})`;
        }).join("\n");
      }
      case "save": {
        const name = input.name as string;
        const panels = input.panels as string;
        if (!name || !panels) return "Both name and panels required.";
        return this.layoutCallbacks.save(name, panels) ? `Layout "${name}" saved.` : `Failed to save layout "${name}".`;
      }
      case "delete": {
        const name = input.name as string;
        if (!name) return "Layout name required.";
        return this.layoutCallbacks.delete(name) ? `Layout "${name}" deleted.` : `Layout "${name}" not found.`;
      }
      default: return `Unknown layout action: ${action}`;
    }
  }

  private toolManageApp(input: Record<string, unknown>): string {
    const action = input.action as string;
    if (!this.appConnector) return "App connector not available.";
    switch (action) {
      case "list": {
        const apps = this.appConnector.list();
        if (!apps.length) return "No apps configured.";
        return apps.map((a) => `${a.id} — ${a.name} (${a.url})`).join("\n");
      }
      case "add": {
        const id = input.id as string;
        const url = input.url as string;
        if (!id || !url) return "Both id and url required.";
        const name = (input.name as string) || id;
        this.appConnector.add(id, name, url);
        return `App "${id}" added (${url}).`;
      }
      case "remove": {
        const id = input.id as string;
        if (!id) return "App id required.";
        return this.appConnector.remove(id) ? `App "${id}" removed.` : `App "${id}" not found.`;
      }
      default: return `Unknown app action: ${action}`;
    }
  }
}
