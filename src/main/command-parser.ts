/**
 * CommandParser — parses and executes yo/sup/dip/wassup commands.
 *
 * Four commands, all from the command bar or interceptor.
 *   yo          → grab panels → session + clipboard
 *   yo <skill>  → grab → skill process → session + clipboard
 *   sup         → paste session content (clipboard)
 *   sup <skill> → session → skill/LLM → clipboard
 *   dip <panel> → switch/split/grid
 *   wassup <name> <instructions> → LLM writes a skill
 */

import { BrowserWindow } from "electron";
import { PanelManager } from "./panel-manager";
import { Library } from "./library";
import { SkillEngine } from "./skill-engine";
import { LayoutManager } from "./layout-manager";
import { AppConnector } from "./app-connector";
import { SessionCache } from "./session-cache";
import { setPreference } from "./preferences";
import type { YoChat } from "./yo-chat";

export class CommandParser {
  private static readonly COMMAND_KEYWORDS = new Set(["yo", "sup", "dip", "drip", "wassup"]);

  private onShowWelcome: (() => void) | null = null;
  private mainWindow: BrowserWindow | null = null;
  private yoChat: YoChat | null = null;
  private grabber: (() => Promise<string | null>) | null = null;
  private workbenchOpener: ((content: string, label: string) => void) | null = null;

  constructor(
    private panels: PanelManager,
    private library: Library,
    private skillEngine: SkillEngine,
    private layouts: LayoutManager,
    private appConnector: AppConnector,
    private session: SessionCache,
  ) {}

  /** Set the main window reference (used by dip commands). */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  /** Register callback for yo help */
  setWelcomeHandler(fn: () => void) {
    this.onShowWelcome = fn;
  }

  /** Set the LLM engine for inline processing. */
  setYoChat(chat: YoChat): void {
    this.yoChat = chat;
  }

  /** Set the grabber callback — grabs content from visible panels. */
  setGrabber(fn: () => Promise<string | null>): void {
    this.grabber = fn;
  }

  /** Set the workbench opener — opens the context workbench modal. */
  setWorkbenchOpener(fn: (content: string, label: string) => void): void {
    this.workbenchOpener = fn;
  }

  /** Split input at command keyword boundaries for chaining. */
  private splitChain(input: string): string[] {
    const tokens = input.split(/\s+/);
    const segments: string[] = [];
    let current: string[] = [];

    for (const token of tokens) {
      if (CommandParser.COMMAND_KEYWORDS.has(token.toLowerCase()) && current.length > 0) {
        segments.push(current.join(" "));
        current = [token];
      } else {
        current.push(token);
      }
    }
    if (current.length > 0) segments.push(current.join(" "));
    return segments;
  }

  /** Execute a single command segment. */
  private async executeSingle(segment: string): Promise<string> {
    const parts = segment.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case "yo":
        return this.handleYo(args);
      case "sup":
        return this.handleSup(args);
      case "dip":
        return this.handleDip(args);
      case "drip":
        return this.handleDrip(args);
      case "wassup":
        return this.handleWassup(args);
      default:
        return `Unknown command: ${cmd}. Try yo, sup, dip, drip, or wassup.`;
    }
  }

  /** Parse and execute a command string (supports chaining). */
  async execute(input: string): Promise<string> {
    const trimmed = input.trim();
    if (!trimmed) return "";

    const segments = this.splitChain(trimmed);

    // Single command — fast path
    if (segments.length === 1) return this.executeSingle(segments[0]);

    // Chain: execute sequentially, return last non-empty result
    let lastResult = "";
    for (const segment of segments) {
      const result = await this.executeSingle(segment);
      if (result) lastResult = result;
    }
    return lastResult;
  }

  // ── yo: capture → session + clipboard ──────────────────────

  private async handleYo(args: string[]): Promise<string> {
    // Check for * bypass (trust mode — skip workbench)
    const bypass = args.length > 0 && args[args.length - 1] === "*";
    if (bypass) args = args.slice(0, -1);

    // Strip "." shorthand (current panel — default grab behavior)
    if (args[0] === ".") args = args.slice(1);

    // yo help
    if (args[0]?.toLowerCase() === "help") {
      this.onShowWelcome?.();
      return "";
    }

    // yo skill create/list
    if (args[0]?.toLowerCase() === "skill") {
      return this.handleYoSkill(args.slice(1));
    }

    // yo layout save/list/delete
    if (args[0]?.toLowerCase() === "layout") {
      return this.handleYoLayout(args.slice(1));
    }

    // Grab content from visible panels
    if (!this.grabber) return "No panel grabber available.";
    const content = await this.grabber();
    if (!content) return "Could not grab content from panels.";

    // Optional skill/LLM processing
    const instruction = args.join(" ").trim();
    let finalContent = content;

    if (instruction) {
      // Check for known skill
      const knownSkill = /^\S+$/.test(instruction)
        ? this.skillEngine.listSkills().find((s) => s.toLowerCase() === instruction.toLowerCase())
        : undefined;

      if (knownSkill) {
        finalContent = await this.skillEngine.process(content, knownSkill);
      } else if (this.yoChat) {
        finalContent = await this.yoChat.executeInline("yo", instruction, "command-bar", content);
      }
    }

    // Store in session
    const skillLabel = instruction?.split(/\s+/)[0] || undefined;
    this.session.capture("command-bar", finalContent, skillLabel ? `${skillLabel}.md` : "captured", skillLabel || "");

    const label = instruction ? `yo ${instruction}` : "yo";

    // If bypass (*), skip workbench — content is trusted
    if (bypass) {
      this.session.copyToClipboard();
      return `${label} \u2014 captured`;
    }

    if (!instruction && this.workbenchOpener) {
      // Bare yo — open the workbench for interactive refinement
      this.workbenchOpener(finalContent, label);
      return "";
    }
    // yo <skill/prompt> — content is processed, just set context + notify
    this.session.copyToClipboard();
    return `${label} \u2014 captured`;
  }

  private handleYoSkill(args: string[]): string {
    if (args.length === 0 || args[0] === "list") {
      const skills = this.skillEngine.listSkills();
      if (skills.length === 0) return "No skills yet. Create one: yo skill create <name>";
      return skills.map((s) => `  ${s}`).join("\n");
    }

    if (args[0] === "create" && args.length >= 2) {
      const name = args[1];
      if (CommandParser.COMMAND_KEYWORDS.has(name.toLowerCase())) {
        return `Cannot use "${name}" as a skill name \u2014 it\u2019s a reserved command.`;
      }
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
        .map((l) => `  ${l.name} — ${l.cells.map((c) => c.panelId).join(" | ")}`)
        .join("\n");
    }

    if (args[0] === "save" && args.length >= 4) {
      const name = args[1];
      const allArgs = args.slice(2);

      // Parse rows: panels separated by "/" for multi-row grids
      const rows: string[][] = [];
      let current: string[] = [];
      for (const a of allArgs) {
        if (a === "/") {
          if (current.length > 0) rows.push(current);
          current = [];
        } else {
          current.push(a);
        }
      }
      if (current.length > 0) rows.push(current);

      const numRows = rows.length;
      const numCols = Math.max(...rows.map((r) => r.length));

      const cells = rows.flatMap((row, r) =>
        row.map((id, c) => ({
          panelId: id,
          col: c,
          row: r,
          colSpan: c === row.length - 1 ? numCols - c : 1,
          rowSpan: 1,
        })),
      );

      this.layouts.saveLayout({
        name,
        version: 2,
        cols: numCols,
        rows: numRows,
        colWidths: Array(numCols).fill(1 / numCols),
        rowHeights: Array(numRows).fill(1 / numRows),
        cells,
      });
      return `Layout saved: ${name} → dip ${name}`;
    }

    if (args[0] === "delete" && args.length >= 2) {
      return this.layouts.deleteLayout(args[1])
        ? `Deleted layout: ${args[1]}`
        : `Layout not found: ${args[1]}`;
    }

    return "Usage: yo layout save <name> <panel1> <panel2> ... | yo layout list | yo layout delete <name>";
  }

  // ── sup: session → process → clipboard ─────────────────────

  private async handleSup(args: string[]): Promise<string> {
    // Library management subcommands
    const sub = args[0]?.toLowerCase();

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

    // Bare "sup" → always show library browser
    if (args.length === 0) {
      return "__SUP_BROWSE__";
    }

    // sup . → paste session content directly to clipboard, no LLM
    if (args.length === 1 && args[0] === ".") {
      if (!this.session.hasContent()) return "No context loaded. Use yo to capture first.";
      const content = this.session.get();
      const { clipboard } = await import("electron");
      clipboard.writeText(content);
      return "Context copied to clipboard";
    }

    // sup <instruction> → process session with skill/LLM
    if (!this.session.hasContent()) return "__SUP_BROWSE__";

    const instruction = args.join(" ").trim();
    const sessionContent = this.session.get();

    // Check for known skill
    const knownSkill = /^\S+$/.test(instruction)
      ? this.skillEngine.listSkills().find((s) => s.toLowerCase() === instruction.toLowerCase())
      : undefined;

    let result: string;
    if (knownSkill) {
      result = await this.skillEngine.process(sessionContent, knownSkill);
    } else if (this.yoChat) {
      result = await this.yoChat.executeInline("sup", instruction, "command-bar", sessionContent);
    } else {
      return "No AI engine available.";
    }

    // Copy result to clipboard
    const { clipboard } = await import("electron");
    clipboard.writeText(result);
    return `sup ${instruction} \u2014 result copied to clipboard`;
  }

  // ── dip: switch panels ──────────────────────────────────────

  private handleDip(args: string[]): string {
    if (args.length === 0) {
      return "Usage: dip <panel> | dip split <a> <b> | dip grid <cells> | dip back | dip add <url>";
    }

    const sub = args[0].toLowerCase();
    const win = this.mainWindow ?? BrowserWindow.getFocusedWindow();
    if (!win || win.isDestroyed()) return "No active window";

    if (sub === "back") {
      return this.panels.switchBack(win)
        ? "Switched back"
        : "No previous panel";
    }

    if (sub === "refresh") {
      const target = args[1]?.toLowerCase();
      return this.panels.refresh(target)
        ? `Refreshed ${target || this.panels.activePanelId || "panel"}`
        : "Nothing to refresh";
    }

    if (sub === "clear-session") {
      const target = args[1]?.toLowerCase();
      this.panels.clearSession(target);
      return `Cleared session for ${target || this.panels.activePanelId || "panel"}`;
    }

    if (sub === "zoom") {
      if (!args[1]) return `Zoom: ${Math.round(this.panels.getZoom() * 100)}%`;
      const val = args[1] === "reset" ? 1.0 : parseFloat(args[1]);
      if (isNaN(val)) return "Usage: dip zoom <0.5-2.0 | reset>";
      this.panels.setZoom(val);
      setPreference("zoom", val);
      return `Zoom: ${Math.round(this.panels.getZoom() * 100)}%`;
    }

    if (sub === "list") {
      const apps = this.appConnector
        .list()
        .map((a) => `  ${a.id} — ${a.url}`)
        .join("\n");
      const layouts = this.layouts.listLayouts();
      if (layouts.length > 0) {
        const layoutList = layouts
          .map((l) => `  ${l.name} — ${l.cells.map((c) => c.panelId).join(" | ")}`)
          .join("\n");
        return `Apps:\n${apps}\n\nLayouts:\n${layoutList}`;
      }
      return apps;
    }

    if (sub === "add" && args.length >= 2) {
      const url = args[1];
      const id = url.replace(/https?:\/\//, "").split(/[./]/)[0];
      this.appConnector.add(id, id, url);
      this.panels.addPanel(id, url);
      return `Added: ${id} → ${url}`;
    }

    // dip split <panel1> <panel2> [<panel3> ...] [/ <row2panels> ...]
    if (sub === "split" && args.length >= 3) {
      return this.handleDipSplit(args.slice(1), win);
    }

    // dip grid — full grid with spans, custom widths/heights
    if (sub === "grid" && args.length >= 2) {
      return this.handleDipGrid(args.slice(1), win);
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

  // ── dip split ────────────────────────────────────────────────

  private handleDipSplit(splitArgs: string[], win: BrowserWindow): string {
    const ids = splitArgs.map((a) => a.toLowerCase());

    // Check for "/" row separator → multi-row grid
    if (ids.includes("/")) {
      const rows: string[][] = [];
      let current: string[] = [];
      for (const a of ids) {
        if (a === "/") {
          if (current.length > 0) rows.push(current);
          current = [];
        } else {
          current.push(a);
        }
      }
      if (current.length > 0) rows.push(current);
      const ok = this.layouts.splitGrid(rows, win);
      if (ok) setPreference("lastView", { type: "grid", rows });
      const label = rows.map((r) => r.join(" ")).join(" / ");
      return ok ? `Grid: ${label}` : "Unknown panel(s). Try: dip list";
    }

    // N panels in a single row
    if (ids.length === 2) {
      const ok = this.layouts.splitTwo(ids[0], ids[1], win);
      if (ok) setPreference("lastView", { type: "split", panels: ids });
      return ok ? `Split: ${ids.join(" | ")}` : "Unknown panel(s). Try: dip list";
    }
    const ok = this.layouts.splitN(ids, win);
    if (ok) setPreference("lastView", { type: "split", panels: ids });
    return ok ? `Split: ${ids.join(" | ")}` : "Unknown panel(s). Try: dip list";
  }

  // ── dip grid ─────────────────────────────────────────────────

  private handleDipGrid(args: string[], win: BrowserWindow): string {
    // Extract bracket groups [n,n,...] for custom widths/heights
    const bracketRe = /^\[([0-9,. ]+)\]$/;
    const brackets: number[][] = [];
    let cellStart = 0;

    for (let i = 0; i < args.length; i++) {
      const m = args[i].match(bracketRe);
      if (m) {
        brackets.push(m[1].split(",").map((v) => parseFloat(v.trim())));
        cellStart = i + 1;
      } else {
        break;
      }
    }

    // Remaining args are the cell definitions, joined and split by "/"
    const cellStr = args.slice(cellStart).join(" ");
    const rowStrs = cellStr.split(/\s*\/\s*/);

    if (rowStrs.length === 0 || (rowStrs.length === 1 && !rowStrs[0].trim())) {
      return "Usage: dip grid panel1,panel2 / panel3,panel4";
    }

    // Parse each row into cells with optional spans
    interface ParsedCell { id: string; colSpan: number; rowSpan: number }
    const parsedRows: ParsedCell[][] = [];
    const cellRe = /^([a-z0-9_-]+)(?::(\d+))?(?:\|(\d+))?$/i;

    for (const rowStr of rowStrs) {
      const items = rowStr.trim().split(/[, ]+/);
      const row: ParsedCell[] = [];
      for (const item of items) {
        if (!item) continue;
        const cm = item.match(cellRe);
        if (!cm) return `Invalid cell: "${item}". Format: panel or panel:colSpan|rowSpan`;
        row.push({
          id: cm[1].toLowerCase(),
          colSpan: cm[2] ? parseInt(cm[2], 10) : 1,
          rowSpan: cm[3] ? parseInt(cm[3], 10) : 1,
        });
      }
      if (row.length > 0) parsedRows.push(row);
    }

    if (parsedRows.length === 0) return "No panels specified.";

    const numRows = parsedRows.length;
    const rowColCounts = parsedRows.map((r) => r.reduce((s, c) => s + c.colSpan, 0));
    const numCols = Math.max(...rowColCounts);

    const cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> = [];
    for (let r = 0; r < parsedRows.length; r++) {
      let col = 0;
      for (const pc of parsedRows[r]) {
        cells.push({
          panelId: pc.id,
          col,
          row: r,
          colSpan: pc.colSpan,
          rowSpan: pc.rowSpan,
        });
        col += pc.colSpan;
      }
    }

    let colWidths: number[];
    if (brackets.length >= 1 && brackets[0].length === numCols) {
      const total = brackets[0].reduce((s, v) => s + v, 0);
      colWidths = brackets[0].map((v) => v / total);
    } else {
      colWidths = Array(numCols).fill(1 / numCols);
    }

    let rowHeights: number[];
    if (brackets.length >= 2 && brackets[1].length === numRows) {
      const total = brackets[1].reduce((s, v) => s + v, 0);
      rowHeights = brackets[1].map((v) => v / total);
    } else {
      rowHeights = Array(numRows).fill(1 / numRows);
    }

    const grid = {
      name: "",
      version: 2 as const,
      cols: numCols,
      rows: numRows,
      colWidths,
      rowHeights,
      cells,
    };

    const ok = this.layouts.applyGridLayout(grid, win);
    if (!ok) return "Unknown panel(s). Try: dip list";

    setPreference("lastView", { type: "grid-full", grid });

    const label = parsedRows.map((r) =>
      r.map((c) => {
        let s = c.id;
        if (c.colSpan > 1) s += `:${c.colSpan}`;
        if (c.rowSpan > 1) s += `|${c.rowSpan}`;
        return s;
      }).join(","),
    ).join(" / ");
    return `Grid: ${label}`;
  }

  // ── drip: CSS visual effects ────────────────────────────────

  private handleDrip(args: string[]): string {
    const effect = args[0]?.toLowerCase() || "fireworks";
    this.mainWindow?.webContents.send("drip-effect", effect);
    return "";
  }

  // ── wassup: create skills via LLM ───────────────────────────

  private async handleWassup(args: string[]): Promise<string> {
    if (args.length === 0) {
      const skills = this.skillEngine.listSkills();
      if (skills.length === 0) return "No skills yet. Create one: wassup <name> <instructions>";
      return "Skills:\n" + skills.map((s) => `  ${s}`).join("\n");
    }

    if (args.length === 1) {
      // Check if it's an existing skill — show its prompt
      const name = args[0];
      const prompt = this.skillEngine.readSkill(name);
      if (prompt !== null) return `Skill "${name}":\n${prompt}`;
      return `Skill "${name}" not found. Create it: wassup ${name} <instructions>`;
    }

    // wassup <name> <instructions...> → LLM writes the skill prompt
    const name = args[0];
    if (CommandParser.COMMAND_KEYWORDS.has(name.toLowerCase())) {
      return `Cannot use "${name}" as a skill name \u2014 it\u2019s a reserved command.`;
    }
    const instructions = args.slice(1).join(" ");

    if (!this.yoChat) return "No AI engine available.";

    const result = await this.yoChat.executeInline(
      "wassup",
      `Write a skill prompt (system prompt) for a skill called "${name}". The user's instructions for what this skill should do: ${instructions}\n\nRespond with ONLY the skill prompt text, nothing else. No markdown fencing, no explanation.`,
      "command-bar",
    );

    this.skillEngine.createSkill(name, result.trim());
    return `Skill created: ${name}`;
  }
}
