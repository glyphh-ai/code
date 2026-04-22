/**
 * CommandParser — parses and executes yo/sup/dip/drip commands.
 *
 *   yo [query]      → open agent side panel (optionally with query)
 *   sup             → capture active panel to clipboard + session
 *   sup . <skill>   → capture + skill process → inject result
 *   dip <panel>     → switch/split/grid
 *   drip <effect>   → visual effect
 */

import { BrowserWindow, WebContents } from "electron";
import { PanelManager } from "./panel-manager";
import { SkillEngine } from "./skill-engine";
import { LayoutManager } from "./layout-manager";
import { AppConnector } from "./app-connector";
import { SessionCache } from "./session-cache";
import { executeCommand } from "./dom-bridge";
import { setPreference } from "./preferences";
import type { YoChat } from "./yo-chat";
export class CommandParser {
  private static readonly COMMAND_KEYWORDS = new Set(["sup", "dip", "drip", "waz", "council"]);

  private onShowWelcome: (() => void) | null = null;
  private onDrip: ((effect: string) => void) | null = null;
  private onCouncil: ((participants: string[]) => void) | null = null;

  // Sup conversation state
  private yoHistory: Array<{ role: string; content: string }> = [];
  private yoContext = ""; // assembled context from initial search
  private mainWindow: BrowserWindow | null = null;
  private yoChat: YoChat | null = null;
  private grabber: ((activeOnly?: boolean) => Promise<string | null>) | null = null;
  private wcGetter: ((panelId: string) => WebContents | null) | null = null;
  private tabCloser: ((id: string) => void) | null = null;
  private tabLister: (() => string[]) | null = null;
  constructor(
    private panels: PanelManager,
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

  /** Register callback for drip effects */
  setDripHandler(fn: (effect: string) => void) {
    this.onDrip = fn;
  }

  /** Register callback for council chat */
  setCouncilHandler(fn: (participants: string[]) => void) {
    this.onCouncil = fn;
  }

  /** Set the LLM engine for inline processing. */
  setYoChat(chat: YoChat): void {
    this.yoChat = chat;
  }

  /** Set the grabber callback — grabs content from visible panels. */
  setGrabber(fn: (activeOnly?: boolean) => Promise<string | null>): void {
    this.grabber = fn;
  }

  /** Set the WebContents getter — resolves panel ID to live WebContents. */
  setWebContentsGetter(fn: (panelId: string) => WebContents | null): void {
    this.wcGetter = fn;
  }

  /** Set tab management callbacks for .dip close. */
  setTabManager(closer: (id: string) => void, lister: () => string[]): void {
    this.tabCloser = closer;
    this.tabLister = lister;
  }

  /** Split input at dot-prefixed command keyword boundaries for chaining.
   *  Only .yo / .dip / .drip trigger a split — bare keywords like "yo"
   *  appearing in natural language (e.g. "marketing yo") are left alone. */
  private splitChain(input: string): string[] {
    const tokens = input.split(/\s+/);
    const segments: string[] = [];
    let current: string[] = [];

    for (const token of tokens) {
      const bare = token.replace(/^\./, "").toLowerCase();
      const isDotCommand = token.startsWith(".") && CommandParser.COMMAND_KEYWORDS.has(bare);
      if (isDotCommand && current.length > 0) {
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
      case "sup":
        return this.handleSup(args);
      case "dip":
        return this.handleDip(args, sourcePanelId);
      case "drip":
        return this.handleDrip(args);
      case "waz":
        return this.handleWaz(args);
      case "council":
        return this.handleCouncil(args);
      default:
        return `Unknown command: ${cmd}. Try yo, sup, dip, drip, waz, or council.`;
    }
  }

  /** Parse and execute a command string (supports chaining). */
  async execute(input: string, sourcePanelId?: string): Promise<string> {
    const trimmed = input.trim();
    if (!trimmed) return "";

    const clean = (s: string) => s.replace(/\.(yo|sup|dip|drip|waz)\b/gi, "$1");

    // .yo (search/agent) NEVER chains — entire input is one command.
    const yoMatch = trimmed.match(/^\.?yo\b/i);
    if (yoMatch) {
      return this.executeSingle(clean(trimmed), sourcePanelId);
    }
    // .sup (capture) can chain only when using dot modifier (.sup . .dip gmail).
    // Bare .sup never chains.
    const supMatch = trimmed.match(/^\.?sup\b/i);
    const isSupCapture = supMatch && /^\.?sup\s+\./i.test(trimmed);
    if (supMatch && !isSupCapture) {
      return this.executeSingle(clean(trimmed), sourcePanelId);
    }

    // Split on dot-prefixed keywords for chaining (.dip, .drip)
    const segments = this.splitChain(trimmed);

    // Single command — fast path
    if (segments.length === 1) return this.executeSingle(clean(segments[0]), sourcePanelId);

    // Chain: execute sequentially, return last non-empty result
    let lastResult = "";
    for (const segment of segments) {
      const result = await this.executeSingle(clean(segment), sourcePanelId);
      if (result) lastResult = result;
    }
    return lastResult;
  }

  // ── yo: always opens the agent side panel ────────────────────

  private async handleYo(args: string[]): Promise<string> {
    const query = args.join(" ").trim();
    return `__YO_PANEL__${query ? `:${query}` : ""}`;
  }

  // ── sup: capture screen ─────────────────────────────────

  private async handleSup(args: string[]): Promise<string> {
    if (!this.grabber) return "No panel grabber available.";

    // Parse dot modifier: everything after "." is the instruction
    // Bare .sup or .sup . = just capture
    // .sup . <skill/prompt> = capture + process
    let instruction = "";
    if (args[0] === ".") {
      instruction = args.slice(1).join(" ").trim();
    } else if (args.length === 0) {
      // Bare .sup → capture active panel
      instruction = "";
    } else {
      // .sup without dot modifier — treat as bare capture
      // (all args are ignored unless after a dot)
      instruction = "";
    }

    const content = await this.grabber(true);
    if (!content) return "Could not grab content from panels.";

    // Bare capture — no processing
    if (!instruction) {
      this.session.capture("command-bar", content, `${this.timestamp()}.md`, this.timestamp());
      this.session.copyToClipboard();
      return "";
    }

    // .sup . <skill/prompt> → capture + process → return result for injection
    let finalContent = content;
    const matchedSkill = /^\S+$/.test(instruction)
      ? this.skillEngine.listSkills().find((s) => s.toLowerCase() === instruction.toLowerCase())
      : undefined;

    if (matchedSkill) {
      finalContent = await this.skillEngine.process(content, matchedSkill);
    } else if (this.yoChat) {
      finalContent = await this.yoChat.executeProcess(instruction, content);
    }

    const label = matchedSkill || this.timestamp();
    this.session.capture("command-bar", finalContent, `${label}.md`, label);
    this.session.copyToClipboard();
    return finalContent;
  }

  /** Clear yo conversation state. */
  clearYoHistory(): void {
    this.yoHistory = [];
    this.yoContext = "";
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

  // ── dip: switch panels + execute app commands ───────────────

  private async handleDip(args: string[], sourcePanelId?: string): Promise<string> {
    if (args.length === 0) {
      return "Usage: dip <panel> [cmd1 cmd2 ...] | dip split <a> <b> | dip save <name> | dip back";
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

    if (sub === "close") {
      if (!this.tabCloser || !this.tabLister) return "Tab manager not available.";
      const target = args[1]?.toLowerCase();
      if (target === "all") {
        const tabs = this.tabLister();
        for (const id of tabs) this.tabCloser(id);
        return "Closed all tabs.";
      }
      // Close specific tab or active tab
      const id = target || this.panels.activePanelId;
      if (!id) return "No active tab to close.";
      this.tabCloser(id);
      return `Closed: ${id}`;
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

    if (sub === "save") {
      const name = args[1]?.trim();
      if (!name) return "Usage: dip save <name>";
      const grid = this.layouts.getGridInfo();
      if (!grid) return "No active layout to save. Use .dip split first.";
      this.layouts.saveLayout({
        name,
        version: 2,
        cols: grid.cols,
        rows: grid.rows,
        colWidths: grid.colWidths,
        rowHeights: grid.rowHeights,
        cells: grid.cells.map((c) => ({
          panelId: c.panelId,
          col: c.col,
          row: c.row,
          colSpan: c.colSpan,
          rowSpan: c.rowSpan,
        })),
      });
      return `Layout saved: ${name}`;
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
      if (!ok) return `Failed to apply layout: ${sub}`;
      setPreference("lastView", { type: "layout", name: sub });

      // If extra args, run them as commands on the first matching panel in the layout
      const commands = args.slice(1);
      if (commands.length > 0) {
        const layout = this.layouts.getLayout(sub);
        if (layout) {
          for (const cell of layout.cells) {
            const app = this.appConnector.get(cell.panelId);
            if (!app) continue;
            const firstCmd = commands[0].toLowerCase();
            if (!(firstCmd in app.commands)) continue;

            // Found a panel with the command — switch to it and execute
            const wc = this.wcGetter?.(cell.panelId);
            if (!wc || wc.isDestroyed()) continue;

            const results: string[] = [`Layout: ${sub} → ${cell.panelId}`];
            for (const cmd of commands) {
              const key = cmd.toLowerCase();
              const mapping = app.commands[key];
              if (!mapping) {
                const available = Object.keys(app.commands);
                results.push(`Unknown command "${key}"${available.length > 0 ? `. Available: ${available.join(", ")}` : ""}`);
                break;
              }
              if (results.length > 1) await new Promise((r) => setTimeout(r, 300));
              await executeCommand(wc, mapping);
              results.push(mapping.description || key);
            }
            return results.join(" → ");
          }
          return `Layout: ${sub} (no panel has command "${commands[0]}")`;
        }
      }
      return `Layout: ${sub}`;
    }

    // dip <panel-id> [cmd1 cmd2 ...] — switch + optional app commands
    this.layouts.clearSplit();
    const switched = this.panels.switchTo(sub, win);
    if (!switched) return `Unknown panel: ${sub}. Try: dip list`;
    setPreference("lastView", { type: "panel", id: sub });

    // No commands to run — just a switch
    const commands = args.slice(1);
    if (commands.length === 0) return `Switched to ${sub}`;

    // Execute commands sequentially on this panel
    const app = this.appConnector.get(sub);
    if (!app) return `Switched to ${sub} (no commands mapped)`;

    const wc = this.wcGetter?.(sub);
    if (!wc || wc.isDestroyed()) return `Switched to ${sub} (panel not loaded)`;

    const results: string[] = [`→ ${sub}`];
    for (const cmd of commands) {
      const key = cmd.toLowerCase();
      const mapping = app.commands[key];
      if (!mapping) {
        const available = Object.keys(app.commands);
        results.push(`Unknown command "${key}"${available.length > 0 ? `. Available: ${available.join(", ")}` : ""}`);
        break;
      }
      // Small delay between commands to let UI settle
      if (results.length > 1) await new Promise((r) => setTimeout(r, 300));
      await executeCommand(wc, mapping);
      results.push(mapping.description || key);
    }
    return results.join(" → ");
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

  // ── waz: placeholder ─────────────────────────────────────────

  private async handleWaz(_args: string[]): Promise<string> {
    return "waz is not available.";
  }

  // ── council: multi-model council ─────────────────────────────

  private handleCouncil(args: string[]): string {
    if (args.length === 0) return "Usage: council <model1> <model2> [<model3> ...] — start a council";
    const participants = args.map((a) => a.toLowerCase());
    this.onCouncil?.(participants);
    return `__COUNCIL__:${participants.join(",")}`;
  }

  // ── drip: CSS visual effects ────────────────────────────────

  private handleDrip(args: string[]): string {
    const effect = args[0]?.toLowerCase() || "fireworks";
    this.onDrip?.(effect);
    return "";
  }

}
