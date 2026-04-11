/**
 * CommandParser — parses and executes yo/sup/dip commands.
 *
 * Three commands. That's the whole product.
 */

import { BrowserWindow } from "electron";
import { PanelManager } from "./panel-manager";
import { Library } from "./library";
import { SkillEngine } from "./skill-engine";

export class CommandParser {
  constructor(
    private panels: PanelManager,
    private library: Library,
    private skillEngine: SkillEngine,
  ) {}

  /** Parse and execute a command string */
  async execute(input: string, sessionBuffer: string): Promise<string> {
    const trimmed = input.trim();
    if (!trimmed) return "";

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case "yo":
        return this.handleYo(args, sessionBuffer);
      case "sup":
        return this.handleSup(args);
      case "dip":
        return this.handleDip(args);
      default:
        return `Unknown command: ${cmd}. Try yo, sup, or dip.`;
    }
  }

  // ── yo: save context ────────────────────────────────────────

  private async handleYo(args: string[], buffer: string): Promise<string> {
    if (args.length === 0) {
      return "Usage: yo <name> or yo skill create <prompt>";
    }

    // yo skill create/list
    if (args[0] === "skill") {
      return this.handleYoSkill(args.slice(1));
    }

    // yo <name> — capture session, process with default skill, save
    const name = args[0];
    const content = await this.skillEngine.process(buffer);
    this.library.write(name, content);
    return `Saved: ${name}.md`;
  }

  private handleYoSkill(args: string[]): string {
    if (args.length === 0 || args[0] === "list") {
      const skills = this.skillEngine.listSkills();
      if (skills.length === 0) return "No skills yet. Create one: yo skill create <name>";
      return skills.map((s) => `  ${s}`).join("\n");
    }

    if (args[0] === "create" && args.length >= 2) {
      const name = args[1];
      const prompt = args.slice(2).join(" ");
      this.skillEngine.createSkill(name, prompt);
      return `Skill created: ${name}`;
    }

    return "Usage: yo skill create <name> <prompt> | yo skill list";
  }

  // ── sup: recall context ─────────────────────────────────────

  private handleSup(args: string[]): string {
    if (args.length === 0) {
      return "Usage: sup <name> | sup list | sup search <term> | sup forget <name>";
    }

    const sub = args[0].toLowerCase();

    if (sub === "list") {
      const files = this.library.list();
      if (files.length === 0) return "Library is empty. Save something first: yo <name>";
      return files.map((f) => `  ${f}`).join("\n");
    }

    if (sub === "search" && args.length >= 2) {
      const term = args.slice(1).join(" ");
      const results = this.library.search(term);
      if (results.length === 0) return `No results for "${term}"`;
      return results.map((r) => `  ${r}`).join("\n");
    }

    if (sub === "forget" && args.length >= 2) {
      const name = args[1];
      const deleted = this.library.remove(name);
      return deleted ? `Forgot: ${name}` : `Not found: ${name}`;
    }

    // sup <name> — read and return content
    const content = this.library.read(args[0]);
    if (!content) return `Not found: ${args[0]}`;
    return content;
  }

  // ── dip: switch panels ──────────────────────────────────────

  private handleDip(args: string[]): string {
    if (args.length === 0) {
      return "Usage: dip <panel> | dip split | dip back | dip add <url>";
    }

    const sub = args[0].toLowerCase();
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return "No active window";

    if (sub === "back") {
      return this.panels.switchBack(win)
        ? "Switched back"
        : "No previous panel";
    }

    if (sub === "list") {
      return this.panels
        .listPanels()
        .map((p) => `  ${p.id} — ${p.url}`)
        .join("\n");
    }

    if (sub === "add" && args.length >= 2) {
      const url = args[1];
      const id = url.replace(/https?:\/\//, "").split(/[./]/)[0];
      this.panels.addPanel(id, url);
      return `Added: ${id} → ${url}`;
    }

    // dip <panel-id>
    const switched = this.panels.switchTo(sub, win);
    return switched
      ? `Switched to ${sub}`
      : `Unknown panel: ${sub}. Try: dip list`;
  }
}
