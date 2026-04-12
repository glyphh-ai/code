/**
 * LayoutManager — grid-based panel layout engine.
 *
 * Supports N×M grids with column/row spans.
 * Layouts stored as JSON in ~/yo/.layouts
 */

import fs from "fs";
import path from "path";
import os from "os";
import { BrowserWindow } from "electron";
import { PanelManager } from "./panel-manager";

// ── Grid model ──────────────────────────────────────────────

export interface GridCell {
  panelId: string;
  col: number;      // 0-based column
  row: number;      // 0-based row
  colSpan: number;
  rowSpan: number;
}

export interface GridLayout {
  name: string;
  version: 2;
  cols: number;           // 1–4
  rows: number;           // 1–4
  colWidths: number[];    // fractions summing to ~1
  rowHeights: number[];   // fractions summing to ~1
  cells: GridCell[];
}

/** Full grid state sent to renderer for handles + chips */
export interface GridSplitInfo {
  panelIds: string[];
  cols: number;
  rows: number;
  colWidths: number[];
  rowHeights: number[];
  cells: GridCell[];
}

// ── Legacy types (migration only) ───────────────────────────

interface LegacySplit {
  panelId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LegacyLayout {
  name: string;
  splits: LegacySplit[];
}

// ── Constants ───────────────────────────────────────────────

const LAYOUTS_FILE = path.join(os.homedir(), "yo", ".layouts");
const CONTENT_TOP = 38;
const SPLIT_GAP = 6;

// ── LayoutManager ───────────────────────────────────────────

export class LayoutManager {
  private layouts: Map<string, GridLayout> = new Map();
  private activeGrid: GridLayout | null = null;
  private boundWindow: BrowserWindow | null = null;

  constructor(private panelManager: PanelManager) {
    this.load();
  }

  // ── Split commands ──────────────────────────────────────

  /** Two panels side by side */
  splitTwo(leftId: string, rightId: string, win: BrowserWindow, ratio = 0.5): boolean {
    if (!this.panelManager.getOrCreateView(leftId, win)) return false;
    if (!this.panelManager.getOrCreateView(rightId, win)) return false;

    this.activeGrid = {
      name: "",
      version: 2,
      cols: 2,
      rows: 1,
      colWidths: [ratio, 1 - ratio],
      rowHeights: [1],
      cells: [
        { panelId: leftId, col: 0, row: 0, colSpan: 1, rowSpan: 1 },
        { panelId: rightId, col: 1, row: 0, colSpan: 1, rowSpan: 1 },
      ],
    };
    this.applyGrid(win, true);
    this.bindResize(win);
    return true;
  }

  /** N panels in a single row */
  splitN(panelIds: string[], win: BrowserWindow): boolean {
    for (const id of panelIds) {
      if (!this.panelManager.getOrCreateView(id, win)) return false;
    }
    const n = panelIds.length;
    this.activeGrid = {
      name: "",
      version: 2,
      cols: n,
      rows: 1,
      colWidths: Array(n).fill(1 / n),
      rowHeights: [1],
      cells: panelIds.map((id, i) => ({
        panelId: id, col: i, row: 0, colSpan: 1, rowSpan: 1,
      })),
    };
    this.applyGrid(win, true);
    this.bindResize(win);
    return true;
  }

  /** Multi-row grid from row arrays, e.g. [["claude","gpt"],["gemini","code"]] */
  splitGrid(rows: string[][], win: BrowserWindow): boolean {
    const numRows = rows.length;
    const numCols = Math.max(...rows.map((r) => r.length));

    const cells: GridCell[] = [];
    for (let r = 0; r < numRows; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        if (!this.panelManager.getOrCreateView(rows[r][c], win)) return false;
        // Last panel in a row spans remaining columns
        const colSpan = c === rows[r].length - 1 ? numCols - c : 1;
        cells.push({
          panelId: rows[r][c], col: c, row: r, colSpan, rowSpan: 1,
        });
      }
    }

    this.activeGrid = {
      name: "",
      version: 2,
      cols: numCols,
      rows: numRows,
      colWidths: Array(numCols).fill(1 / numCols),
      rowHeights: Array(numRows).fill(1 / numRows),
      cells,
    };
    this.applyGrid(win, true);
    this.bindResize(win);
    return true;
  }

  /** Apply a full GridLayout directly (from visual builder or IPC) */
  applyGridLayout(grid: GridLayout, win: BrowserWindow): boolean {
    for (const cell of grid.cells) {
      if (!this.panelManager.getOrCreateView(cell.panelId, win)) return false;
    }
    this.activeGrid = JSON.parse(JSON.stringify(grid));
    this.applyGrid(win, true);
    this.bindResize(win);
    return true;
  }

  // ── Resize ────────────────────────────────────────────────

  /** Update column border position (fraction = cumulative x position of border) */
  updateColWidth(index: number, fraction: number, win: BrowserWindow): void {
    const grid = this.activeGrid;
    if (!grid || index < 0 || index >= grid.cols - 1) return;

    let leftEdge = 0;
    for (let i = 0; i < index; i++) leftEdge += grid.colWidths[i];
    const rightEdge = leftEdge + grid.colWidths[index] + grid.colWidths[index + 1];

    const minW = 0.1;
    const clamped = Math.max(leftEdge + minW, Math.min(rightEdge - minW, fraction));
    grid.colWidths[index] = clamped - leftEdge;
    grid.colWidths[index + 1] = rightEdge - clamped;

    this.applyGrid(win);
  }

  /** Update row border position (fraction = cumulative y position of border) */
  updateRowHeight(index: number, fraction: number, win: BrowserWindow): void {
    const grid = this.activeGrid;
    if (!grid || index < 0 || index >= grid.rows - 1) return;

    let topEdge = 0;
    for (let i = 0; i < index; i++) topEdge += grid.rowHeights[i];
    const bottomEdge = topEdge + grid.rowHeights[index] + grid.rowHeights[index + 1];

    const minH = 0.1;
    const clamped = Math.max(topEdge + minH, Math.min(bottomEdge - minH, fraction));
    grid.rowHeights[index] = clamped - topEdge;
    grid.rowHeights[index + 1] = bottomEdge - clamped;

    this.applyGrid(win);
  }

  /** Backward-compat: update ratio for a 2-column split */
  updateSplitRatio(ratio: number, win: BrowserWindow): void {
    this.updateColWidth(0, ratio, win);
  }

  // ── Layout CRUD ───────────────────────────────────────────

  /** Apply a named layout */
  apply(name: string, win: BrowserWindow): boolean {
    const layout = this.layouts.get(name);
    if (!layout) return false;
    this.activeGrid = JSON.parse(JSON.stringify(layout));
    this.applyGrid(win, true);
    this.bindResize(win);
    return true;
  }

  /** Save a grid layout */
  saveLayout(grid: GridLayout): void {
    this.layouts.set(grid.name, grid);
    this.persist();
  }

  /** Delete a layout */
  deleteLayout(name: string): boolean {
    if (!this.layouts.has(name)) return false;
    this.layouts.delete(name);
    this.persist();
    return true;
  }

  /** List all layouts */
  listLayouts(): GridLayout[] {
    return Array.from(this.layouts.values());
  }

  /** Get a layout by name */
  getLayout(name: string): GridLayout | undefined {
    return this.layouts.get(name);
  }

  /** Check if a name is a layout command */
  isLayout(name: string): boolean {
    return this.layouts.has(name);
  }

  // ── State queries ─────────────────────────────────────────

  clearSplit(): void {
    this.activeGrid = null;
  }

  get hasSplit(): boolean {
    return this.activeGrid !== null;
  }

  restoreSplit(win: BrowserWindow): void {
    if (this.activeGrid) this.applyGrid(win);
  }

  /** Swap one cell's panel by cell index */
  swapPanel(index: number, newPanelId: string, win: BrowserWindow): void {
    if (!this.activeGrid || index < 0 || index >= this.activeGrid.cells.length) return;
    this.activeGrid.cells[index].panelId = newPanelId;
    this.applyGrid(win);
  }

  /** Legacy-compatible split info (panelIds + first col ratio for old renderer) */
  getSplitInfo(): { panelIds: string[]; ratio: number } | null {
    if (!this.activeGrid) return null;
    return {
      panelIds: this.activeGrid.cells.map((c) => c.panelId),
      ratio: this.activeGrid.cols >= 2 ? this.activeGrid.colWidths[0] : 0.5,
    };
  }

  /** Full grid info for the renderer (handles, chips, builder) */
  getGridInfo(): GridSplitInfo | null {
    if (!this.activeGrid) return null;
    return {
      panelIds: this.activeGrid.cells.map((c) => c.panelId),
      cols: this.activeGrid.cols,
      rows: this.activeGrid.rows,
      colWidths: [...this.activeGrid.colWidths],
      rowHeights: [...this.activeGrid.rowHeights],
      cells: this.activeGrid.cells.map((c) => ({ ...c })),
    };
  }

  // ── Grid rendering ────────────────────────────────────────

  private applyGrid(win: BrowserWindow, animate = false) {
    const grid = this.activeGrid;
    if (!grid) return;

    const [w, h] = win.getContentSize();
    const contentHeight = h - CONTENT_TOP;

    // Capture old views for animation
    const oldViews = animate && !this.panelManager.isAnimating
      ? win.getBrowserViews().map((v) => ({ view: v, bounds: { ...v.getBounds() } }))
      : [];

    // Remove old views (unless animating — slideViews handles cleanup)
    if (!animate || oldViews.length === 0) {
      for (const bv of win.getBrowserViews()) {
        win.removeBrowserView(bv);
      }
    }

    // Cumulative column positions (fractions)
    const cumCol = [0];
    for (const cw of grid.colWidths) cumCol.push(cumCol[cumCol.length - 1] + cw);

    // Cumulative row positions (fractions)
    const cumRow = [0];
    for (const rh of grid.rowHeights) cumRow.push(cumRow[cumRow.length - 1] + rh);

    const halfGap = Math.floor(SPLIT_GAP / 2);

    // Compute final bounds for each cell
    const newViews: Array<{ view: import("electron").BrowserView; finalBounds: Electron.Rectangle }> = [];

    for (const cell of grid.cells) {
      const view = this.panelManager.getOrCreateView(cell.panelId, win);
      if (!view) continue;

      // Raw pixel bounds from grid fractions
      let x = Math.floor(cumCol[cell.col] * w);
      let cellW = Math.floor(cumCol[cell.col + cell.colSpan] * w) - x;
      let y = Math.floor(cumRow[cell.row] * contentHeight);
      let cellH = Math.floor(cumRow[cell.row + cell.rowSpan] * contentHeight) - y;

      // Inset at internal borders for drag handles
      if (cell.col > 0) { x += halfGap; cellW -= halfGap; }
      if (cell.col + cell.colSpan < grid.cols) { cellW -= halfGap; }
      if (cell.row > 0) { y += halfGap; cellH -= halfGap; }
      if (cell.row + cell.rowSpan < grid.rows) { cellH -= halfGap; }

      const finalBounds = {
        x,
        y: CONTENT_TOP + y,
        width: Math.max(cellW, 1),
        height: Math.max(cellH, 1),
      };

      if (animate && oldViews.length > 0) {
        // Position off-screen; slideViews will animate in
        view.setBounds({ ...finalBounds, x: finalBounds.x + w });
        view.setAutoResize({ width: false, height: false });
        win.addBrowserView(view);
        newViews.push({ view, finalBounds });
      } else {
        win.addBrowserView(view);
        view.setBounds(finalBounds);
        view.setAutoResize({ width: false, height: false });
      }
    }

    // Animate if we have old views to slide out
    if (animate && oldViews.length > 0 && newViews.length > 0) {
      this.panelManager.slideViews(win, oldViews, newViews, w);
    }
  }

  private bindResize(win: BrowserWindow) {
    if (this.boundWindow === win) return;
    this.boundWindow = win;
    win.on("resize", () => {
      if (this.activeGrid && !this.panelManager.isHidden && !this.panelManager.isAnimating) this.applyGrid(win);
    });
  }

  // ── Persistence ───────────────────────────────────────────

  private load() {
    try {
      const raw = JSON.parse(fs.readFileSync(LAYOUTS_FILE, "utf-8")) as unknown[];
      let needsMigration = false;
      for (const item of raw) {
        const obj = item as Record<string, unknown>;
        if (obj.version === 2) {
          const grid = obj as unknown as GridLayout;
          this.layouts.set(grid.name, grid);
        } else {
          const legacy = obj as unknown as LegacyLayout;
          const migrated = this.migrateLayout(legacy);
          this.layouts.set(migrated.name, migrated);
          needsMigration = true;
        }
      }
      if (needsMigration) this.persist();
    } catch {
      // No layouts yet
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(LAYOUTS_FILE), { recursive: true });
    fs.writeFileSync(
      LAYOUTS_FILE,
      JSON.stringify(Array.from(this.layouts.values()), null, 2),
      "utf-8",
    );
  }

  private migrateLayout(legacy: LegacyLayout): GridLayout {
    const n = legacy.splits.length;
    return {
      name: legacy.name,
      version: 2,
      cols: n,
      rows: 1,
      colWidths: legacy.splits.map((s) => s.width),
      rowHeights: [1],
      cells: legacy.splits.map((s, i) => ({
        panelId: s.panelId,
        col: i,
        row: 0,
        colSpan: 1,
        rowSpan: 1,
      })),
    };
  }
}
