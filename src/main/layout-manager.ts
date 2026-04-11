/**
 * LayoutManager — user-defined panel layouts with custom commands.
 *
 * Layouts are stored as JSON in ~/yo/.layouts
 * Each layout has a name (used as the command) and a list of panel splits.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { BrowserWindow } from "electron";
import { PanelManager } from "./panel-manager";

export interface LayoutSplit {
  panelId: string;
  x: number;      // fraction 0-1
  y: number;      // fraction 0-1
  width: number;   // fraction 0-1
  height: number;  // fraction 0-1
}

export interface Layout {
  name: string;
  splits: LayoutSplit[];
}

const LAYOUTS_FILE = path.join(os.homedir(), "yo", ".layouts");

const CONTENT_TOP = 48; // command bar height
const SPLIT_GAP = 6;    // px gap between split panels for drag handle

export class LayoutManager {
  private layouts: Map<string, Layout> = new Map();
  private activeSplits: LayoutSplit[] = [];
  private boundWindow: BrowserWindow | null = null;

  constructor(private panelManager: PanelManager) {
    this.load();
  }

  /** Apply a split of two panels side by side */
  splitTwo(leftId: string, rightId: string, win: BrowserWindow, ratio = 0.5): boolean {
    const leftView = this.panelManager.getOrCreateView(leftId, win);
    const rightView = this.panelManager.getOrCreateView(rightId, win);
    if (!leftView || !rightView) return false;

    this.activeSplits = [
      { panelId: leftId, x: 0, y: 0, width: ratio, height: 1 },
      { panelId: rightId, x: ratio, y: 0, width: 1 - ratio, height: 1 },
    ];
    this.applyActiveSplits(win);
    this.bindResize(win);
    return true;
  }

  /** Update the split ratio for a two-panel split (drag resize) */
  updateSplitRatio(ratio: number, win: BrowserWindow): void {
    if (this.activeSplits.length !== 2) return;
    const clamped = Math.max(0.15, Math.min(0.85, ratio));
    this.activeSplits[0].width = clamped;
    this.activeSplits[0].x = 0;
    this.activeSplits[1].width = 1 - clamped;
    this.activeSplits[1].x = clamped;
    this.applyActiveSplits(win);
  }

  /** Apply a named layout */
  apply(name: string, win: BrowserWindow): boolean {
    const layout = this.layouts.get(name);
    if (!layout) return false;

    this.activeSplits = layout.splits;
    this.applyActiveSplits(win);
    this.bindResize(win);
    return true;
  }

  /** Clear split state (called when switching to a single panel) */
  clearSplit() {
    this.activeSplits = [];
  }

  /** Whether a split layout is active */
  get hasSplit(): boolean {
    return this.activeSplits.length > 0;
  }

  /** Restore the active split layout (after overlay) */
  restoreSplit(win: BrowserWindow): void {
    if (this.activeSplits.length > 0) {
      this.applyActiveSplits(win);
    }
  }

  /** Swap one panel in the active split */
  swapPanel(index: number, newPanelId: string, win: BrowserWindow): void {
    if (index < 0 || index >= this.activeSplits.length) return;
    this.activeSplits[index].panelId = newPanelId;
    this.applyActiveSplits(win);
  }

  /** Get active split info for renderer (drag handle positioning) */
  getSplitInfo(): { panelIds: string[]; ratio: number } | null {
    if (this.activeSplits.length < 2) return null;
    return {
      panelIds: this.activeSplits.map((s) => s.panelId),
      ratio: this.activeSplits[0].width,
    };
  }

  private applyActiveSplits(win: BrowserWindow) {
    const [w, h] = win.getContentSize();
    const contentHeight = h - CONTENT_TOP;

    for (const bv of win.getBrowserViews()) {
      win.removeBrowserView(bv);
    }

    const halfGap = this.activeSplits.length > 1 ? Math.floor(SPLIT_GAP / 2) : 0;

    for (let i = 0; i < this.activeSplits.length; i++) {
      const split = this.activeSplits[i];
      const view = this.panelManager.getOrCreateView(split.panelId, win);
      if (!view) continue;

      win.addBrowserView(view);

      // Inset panels to leave a gap for the drag handle
      const rawX = Math.floor(split.x * w);
      const rawW = Math.floor(split.width * w);
      const x = i > 0 ? rawX + halfGap : rawX;
      const width = i === 0 && this.activeSplits.length > 1
        ? rawW - halfGap
        : i > 0 && i < this.activeSplits.length - 1
          ? rawW - SPLIT_GAP
          : i > 0
            ? rawW - halfGap
            : rawW;

      view.setBounds({
        x,
        y: CONTENT_TOP + Math.floor(split.y * contentHeight),
        width: Math.max(width, 1),
        height: Math.floor(split.height * contentHeight),
      });
      view.setAutoResize({ width: false, height: false });
    }
  }

  private bindResize(win: BrowserWindow) {
    if (this.boundWindow === win) return;
    this.boundWindow = win;
    win.on("resize", () => {
      if (this.activeSplits.length > 0) {
        this.applyActiveSplits(win);
      }
    });
  }

  /** Save a new layout */
  saveLayout(name: string, splits: LayoutSplit[]): void {
    this.layouts.set(name, { name, splits });
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
  listLayouts(): Layout[] {
    return Array.from(this.layouts.values());
  }

  /** Get a layout by name */
  getLayout(name: string): Layout | undefined {
    return this.layouts.get(name);
  }

  /** Check if a name is a layout command */
  isLayout(name: string): boolean {
    return this.layouts.has(name);
  }

  private load() {
    try {
      const data = JSON.parse(fs.readFileSync(LAYOUTS_FILE, "utf-8")) as Layout[];
      for (const l of data) this.layouts.set(l.name, l);
    } catch {
      // No layouts yet
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(LAYOUTS_FILE), { recursive: true });
    fs.writeFileSync(
      LAYOUTS_FILE,
      JSON.stringify(Array.from(this.layouts.values()), null, 2),
      "utf-8"
    );
  }
}
