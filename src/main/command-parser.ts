/**
 * CommandParser — parses and executes yo/sup/dip commands.
 *
 * Three commands. That's the whole product.
 */

import { BrowserWindow } from "electron";
import { PanelManager } from "./panel-manager";
import { Library } from "./library";
import { SkillEngine } from "./skill-engine";
import { LayoutManager } from "./layout-manager";
import { setPreference } from "./preferences";

export class CommandParser {
  private onShowWelcome: (() => void) | null = null;

  constructor(
    private panels: PanelManager,
    private library: Library,
    private skillEngine: SkillEngine,
    private layouts: LayoutManager,
  ) {}

  /** Register callback for yo help */
  setWelcomeHandler(fn: () => void) {
    this.onShowWelcome = fn;
  }

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
      return "Usage: yo <name> | yo help | yo skill | yo layout";
    }

    if (args[0] === "help") {
      this.onShowWelcome?.();
      return "";
    }

    // yo skill create/list
    if (args[0] === "skill") {
      return this.handleYoSkill(args.slice(1));
    }

    // yo layout save/list/delete
    if (args[0] === "layout") {
      return this.handleYoLayout(args.slice(1));
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

  private handleYoLayout(args: string[]): string {
    if (args.length === 0 || args[0] === "list") {
      const layouts = this.layouts.listLayouts();
      if (layouts.length === 0) return "No layouts saved. Create one: yo layout save <name> <panel1> <panel2> ...";
      return layouts
        .map((l) => `  ${l.name} — ${l.splits.map((s) => s.panelId).join(" | ")}`)
        .join("\n");
    }

    if (args[0] === "save" && args.length >= 4) {
      const name = args[1];
      const panelIds = args.slice(2);
      const count = panelIds.length;
      // Auto-generate even splits
      const splits = panelIds.map((id, i) => ({
        panelId: id,
        x: i / count,
        y: 0,
        width: 1 / count,
        height: 1,
      }));
      this.layouts.saveLayout(name, splits);
      return `Layout saved: ${name} → dip ${name}`;
    }

    if (args[0] === "delete" && args.length >= 2) {
      return this.layouts.deleteLayout(args[1])
        ? `Deleted layout: ${args[1]}`
        : `Layout not found: ${args[1]}`;
    }

    return "Usage: yo layout save <name> <panel1> <panel2> ... | yo layout list | yo layout delete <name>";
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
      return "Usage: dip <panel> | dip split <a> <b> | dip back | dip add <url>";
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
      const panels = this.panels
        .listPanels()
        .map((p) => `  ${p.id} — ${p.url}`)
        .join("\n");
      const layouts = this.layouts.listLayouts();
      if (layouts.length > 0) {
        const layoutList = layouts
          .map((l) => `  ${l.name} — ${l.splits.map((s) => s.panelId).join(" | ")}`)
          .join("\n");
        return `Panels:\n${panels}\n\nLayouts:\n${layoutList}`;
      }
      return panels;
    }

    if (sub === "add" && args.length >= 2) {
      const url = args[1];
      const id = url.replace(/https?:\/\//, "").split(/[./]/)[0];
      this.panels.addPanel(id, url);
      return `Added: ${id} → ${url}`;
    }

    // dip split <panel1> <panel2>
    if (sub === "split" && args.length >= 3) {
      const left = args[1].toLowerCase();
      const right = args[2].toLowerCase();
      const ok = this.layouts.splitTwo(left, right, win);
      if (ok) setPreference("lastView", { type: "split", panels: [left, right] });
      return ok ? `Split: ${left} | ${right}` : `Unknown panel(s). Try: dip list`;
    }

    // Check for saved layout
    if (this.layouts.isLayout(sub)) {
      const ok = this.layouts.apply(sub, win);
      if (ok) setPreference("lastView", { type: "layout", name: sub });
      return ok ? `Layout: ${sub}` : `Failed to apply layout: ${sub}`;
    }

    // dip <panel-id> — single panel, clear any split
    this.layouts.clearSplit();
    const switched = this.panels.switchTo(sub, win);
    if (switched) setPreference("lastView", { type: "panel", id: sub });
    return switched
      ? `Switched to ${sub}`
      : `Unknown panel: ${sub}. Try: dip list`;
  }
}
