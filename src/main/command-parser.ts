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
import { AppConnector } from "./app-connector";
import { setPreference } from "./preferences";

export class CommandParser {
  private onShowWelcome: (() => void) | null = null;

  constructor(
    private panels: PanelManager,
    private library: Library,
    private skillEngine: SkillEngine,
    private layouts: LayoutManager,
    private appConnector: AppConnector,
  ) {}

  /** Register callback for yo help */
  setWelcomeHandler(fn: () => void) {
    this.onShowWelcome = fn;
  }

  /** Parse and execute a command string */
  async execute(input: string): Promise<string> {
    const trimmed = input.trim();
    if (!trimmed) return "";

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case "yo":
        return this.handleYo(args);
      case "sup":
        return this.handleSup(args);
      case "dip":
        return this.handleDip(args);
      case "wassup":
        return `__wassup__:${args.join(" ")}`;
      default:
        return `Unknown command: ${cmd}. Try yo, sup, dip, or wassup.`;
    }
  }

  // ── yo: save context ────────────────────────────────────────

  private async handleYo(args: string[]): Promise<string> {
    if (args.length === 0) {
      return "Usage: yo <name> <content> | yo help | yo skill | yo layout";
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

    // yo <name> [content...] — save content to library
    const name = args[0];
    const inline = args.slice(1).join(" ");
    if (!inline) {
      return `Nothing to capture. Tip: yo ${name} <content>, or use yo from an AI chat via MCP.`;
    }
    const content = await this.skillEngine.process(inline);
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
      return "Usage: dip <panel> | dip split <a> <b> | dip grid <cells> | dip back | dip add <url>";
    }

    const sub = args[0].toLowerCase();
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return "No active window";

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
    //   dip grid claude,gpt / gemini,code             — 2x2 equal
    //   dip grid claude:2,gpt / gemini,code           — claude spans 2 cols
    //   dip grid claude|2,gpt / gemini,code           — claude spans 2 rows
    //   dip grid [70,30] claude,gpt                   — custom col widths (%)
    //   dip grid [70,30] [60,40] claude,gpt / g,code  — custom col + row heights
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
  //
  // Syntax:
  //   dip grid claude,gpt / gemini,code           — 2×2 equal
  //   dip grid claude:2,gpt / gemini,code         — claude colSpan=2
  //   dip grid claude|2,gpt / gemini,code         — claude rowSpan=2
  //   dip grid claude:2|2,gpt / gemini,code       — claude colSpan=2 rowSpan=2
  //   dip grid [70,30] claude,gpt                 — custom column widths (%)
  //   dip grid [70,30] [60,40] claude,gpt / g,c   — custom col + row widths
  //
  // Panels within a row are comma-separated.
  // Rows are separated by "/".
  // Spans:  panel:colSpan  panel|rowSpan  panel:colSpan|rowSpan
  // Widths: [w1,w2,...] before cells = column widths in %
  //         Second [...] = row heights in %

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

    // Compute grid dimensions from cells + spans
    const numRows = parsedRows.length;
    // Each row's effective column count = sum of colSpans
    const rowColCounts = parsedRows.map((r) => r.reduce((s, c) => s + c.colSpan, 0));
    const numCols = Math.max(...rowColCounts);

    // Build cells with grid positions
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

    // Column widths — from brackets[0] or equal
    let colWidths: number[];
    if (brackets.length >= 1 && brackets[0].length === numCols) {
      const total = brackets[0].reduce((s, v) => s + v, 0);
      colWidths = brackets[0].map((v) => v / total);
    } else {
      colWidths = Array(numCols).fill(1 / numCols);
    }

    // Row heights — from brackets[1] or equal
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

    // Build display label
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
}
