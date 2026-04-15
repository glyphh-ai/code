/**
 * CommandParser — parses and executes yo/dip/drip commands.
 *
 *   yo              → help
 *   yo .            → force capture active panel into context store
 *   yo . <skill>    → capture active + skill process → clipboard
 *   yo <skill>      → capture all + skill process → clipboard
 *   yo <query>      → search context store → LLM answer → clipboard
 *   dip <panel>     → switch/split/grid
 *   drip <effect>   → visual effect
 */

import { BrowserWindow } from "electron";
import { PanelManager } from "./panel-manager";
import { SkillEngine } from "./skill-engine";
import { LayoutManager } from "./layout-manager";
import { AppConnector } from "./app-connector";
import { SessionCache } from "./session-cache";
import { ContextStore } from "./context-store";
import { setPreference } from "./preferences";
import type { YoChat } from "./yo-chat";

export class CommandParser {
  private static readonly COMMAND_KEYWORDS = new Set(["yo", "dip", "drip"]);

  private onShowWelcome: (() => void) | null = null;
  private onDrip: ((effect: string) => void) | null = null;
  private mainWindow: BrowserWindow | null = null;
  private yoChat: YoChat | null = null;
  private grabber: ((activeOnly?: boolean) => Promise<string | null>) | null = null;

  constructor(
    private panels: PanelManager,
    private skillEngine: SkillEngine,
    private layouts: LayoutManager,
    private appConnector: AppConnector,
    private session: SessionCache,
    private contextStore: ContextStore,
  ) {}

  /** Set the main window reference (used by dip commands). */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  /** Register callback for yo help */
  setWelcomeHandler(fn: () => void) {
    this.onShowWelcome = fn;
  }

  /** Register callback for drip effects */
  setDripHandler(fn: (effect: string) => void) {
    this.onDrip = fn;
  }

  /** Set the LLM engine for inline processing. */
  setYoChat(chat: YoChat): void {
    this.yoChat = chat;
  }

  /** Set the grabber callback — grabs content from visible panels. */
  setGrabber(fn: (activeOnly?: boolean) => Promise<string | null>): void {
    this.grabber = fn;
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
  private async executeSingle(segment: string, sourcePanelId?: string): Promise<string> {
    const parts = segment.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case "yo":
        return this.handleYo(args);
      case "dip":
        return this.handleDip(args, sourcePanelId);
      case "drip":
        return this.handleDrip(args);
      default:
        return `Unknown command: ${cmd}. Try yo, dip, or drip.`;
    }
  }

  /** Parse and execute a command string (supports chaining). */
  async execute(input: string, sourcePanelId?: string): Promise<string> {
    // Strip dot prefix from command keywords (.yo → yo, .dip → dip)
    const trimmed = input.trim().replace(/\.(yo|dip|drip)\b/gi, "$1");
    if (!trimmed) return "";

    const segments = this.splitChain(trimmed);

    // Single command — fast path
    if (segments.length === 1) return this.executeSingle(segments[0], sourcePanelId);

    // Chain: execute sequentially, return last non-empty result
    let lastResult = "";
    for (const segment of segments) {
      const result = await this.executeSingle(segment, sourcePanelId);
      if (result) lastResult = result;
    }
    return lastResult;
  }

  // ── yo: capture, query, or help ─────────────────────────────

  private async handleYo(args: string[]): Promise<string> {
    // yo help
    if (args.length === 0 || args[0]?.toLowerCase() === "help") {
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

    // yo - → open command palette
    if (args.length === 1 && args[0] === "-") {
      return "";
    }

    // yo . → force capture active panel into context store
    if (args[0] === ".") {
      args = args.slice(1);
      if (!this.grabber) return "No panel grabber available.";
      const content = await this.grabber(true);
      if (!content) return "Could not grab content from panels.";

      const instruction = args.join(" ").trim();
      let finalContent = content;
      let matchedSkill: string | undefined;

      if (instruction) {
        matchedSkill = /^\S+$/.test(instruction)
          ? this.skillEngine.listSkills().find((s) => s.toLowerCase() === instruction.toLowerCase())
          : undefined;

        if (matchedSkill) {
          finalContent = await this.skillEngine.process(content, matchedSkill);
        } else if (this.yoChat) {
          finalContent = await this.yoChat.executeInline("yo", instruction, "command-bar", content);
        }
      }

      const label = matchedSkill || this.timestamp();
      this.session.capture("command-bar", finalContent, `${label}.md`, label);
      this.session.copyToClipboard();
      return `yo .${instruction ? " " + instruction : ""} \u2014 captured`;
    }

    // yo <query> → search context store + LLM answer
    const query = args.join(" ").trim();
    return this.handleYoQuery(query);
  }

  /** Search ambient context and answer with LLM. */
  private async handleYoQuery(query: string): Promise<string> {
    // Check if single-word query matches a skill → use existing capture + skill flow
    const matchedSkill = /^\S+$/.test(query)
      ? this.skillEngine.listSkills().find((s) => s.toLowerCase() === query.toLowerCase())
      : undefined;

    if (matchedSkill) {
      if (!this.grabber) return "No panel grabber available.";
      const content = await this.grabber(false);
      if (!content) return "Could not grab content from panels.";

      const result = await this.skillEngine.process(content, matchedSkill);
      const label = matchedSkill;
      this.session.capture("command-bar", result, `${label}.md`, label);
      this.session.copyToClipboard();
      return `yo ${matchedSkill} \u2014 captured`;
    }

    // Search context store for relevant chunks
    const chunks = this.contextStore.search(query, 15);

    // If no ambient context, fall back to grabbing current visible panels
    if (chunks.length === 0) {
      if (!this.grabber) return "No context available.";
      const content = await this.grabber(false);
      if (!content) return "No context available. Ambient capture may still be loading.";

      if (this.yoChat) {
        return this.yoChat.executeInline("yo", query, "command-bar", content);
      }
      return "No AI engine available.";
    }

    // Assemble retrieved context with metadata
    const contextParts = chunks.map((c) => {
      const age = this.formatAge(c.timestamp);
      return `[${c.panel_id} | ${c.title} | ${age}]\n${c.content}`;
    });
    const assembledContext = contextParts.join("\n\n---\n\n");

    // Send to LLM with retrieval-augmented prompt
    if (!this.yoChat) return assembledContext;

    return this.yoChat.executeInline("yo", query, "command-bar", assembledContext);
  }

  private timestamp(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
  }

  private formatAge(timestamp: number): string {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
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

  // ── dip: switch panels ──────────────────────────────────────

  private handleDip(args: string[], sourcePanelId?: string): string {
    if (args.length === 0) {
      return "Usage: dip <panel> | dip . <panel> | dip split <a> <b> | dip grid <cells> | dip back | dip add <url>";
    }

    const sub = args[0].toLowerCase();
    const win = this.mainWindow ?? BrowserWindow.getFocusedWindow();
    if (!win || win.isDestroyed()) return "No active window";

    // dip . <panel-id> — swap just the calling panel within the current layout
    if (sub === "." && args.length >= 2) {
      const targetId = args[1].toLowerCase();
      const fromId = sourcePanelId ?? this.panels.activePanelId ?? "";
      if (fromId && this.layouts.swapCellAnimated(fromId, targetId, win)) {
        return `→ ${targetId}`;
      }
      // No active grid — fall through to a normal full switch
      this.layouts.clearSplit();
      const switched = this.panels.switchTo(targetId, win);
      if (switched) setPreference("lastView", { type: "panel", id: targetId });
      return switched ? `Switched to ${targetId}` : `Unknown panel: ${targetId}. Try: dip list`;
    }

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
    this.onDrip?.(effect);
    return "";
  }

}
