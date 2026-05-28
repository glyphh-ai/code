/**
 * Working directory — the single project folder the app is focused on.
 *
 * One explicit, persisted folder. The .yo agent runs in it, and (todo) a
 * cypher clones the repo into it. Changing it broadcasts `working-dir-changed`
 * to the main window and every panel so they re-point.
 *
 * Recents — a chronological history of folder-bound app / layout instances.
 * Per design §2.1, each entry pairs an app (or layout) with a folder. The
 * Welcome surface and the left-rail bottom pane render the same list.
 */

import { ipcMain, dialog, BrowserWindow } from "electron";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { getPreference, setPreference } from "./preferences";

const execFileP = promisify(execFile);

type Broadcast = (channel: string, ...args: unknown[]) => void;

let getMainWindow: () => BrowserWindow | null = () => null;
let broadcastToPanels: Broadcast = () => {};
let onWorkingDirChange: (dir: string) => void = () => {};
let openRecentEntry: (entry: RecentEntry) => void = () => {};

// Folder-list cap (legacy "workingDirRecents" preference). Kept for back-compat
// during migration only.
const FOLDERS_CAP = 8;
// Recents (new model) — max kept, displayed paginated.
const RECENTS_CAP = 20;

export type RecentEntry = {
  /** "app" = a folder-bound app instance; "layout" = a folder-bound layout. */
  kind: "app" | "layout";
  /** App slug (e.g. "vibe") or layout name. */
  id: string;
  /** Display name shown in the row (e.g. "Vibe", "Layout: fullstack"). */
  name: string;
  /** The folder this mount bound to. */
  folder: string;
  /** When this entry was last touched (ms epoch). Newer entries bubble up. */
  ts: number;
};

/** The fallback working directory — the user's OS home folder. A user can
 *  override the default later (workingDirDefault); until then we land on
 *  ~ rather than prompting on first run. */
export function defaultWorkingDirectory(): string {
  return getPreference<string | null>("workingDirDefault", null) || os.homedir();
}

/** Set the user's default working folder (e.g. from a settings screen).
 *  Also becomes the current dir if none is set yet. */
export function setDefaultWorkingDirectory(dir: string): void {
  setPreference("workingDirDefault", dir);
  if (!getPreference<string | null>("workingDirectory", null)) {
    setWorkingDirectory(dir);
  }
}

/** The current working directory. Defaults to the configured default when
 *  none has been set. This doubles as "last used" — it persists across chats
 *  so a new chat inherits it. */
export function getWorkingDirectory(): string {
  return getPreference<string | null>("workingDirectory", null) || defaultWorkingDirectory();
}

/** Most-recently-used folder paths (legacy back-compat surface). */
export function getWorkingDirRecents(): string[] {
  return getPreference<string[]>("workingDirRecents", []) || [];
}

function pushRecentFolder(dir: string): void {
  const recents = getWorkingDirRecents().filter((d) => d !== dir);
  recents.unshift(dir);
  setPreference("workingDirRecents", recents.slice(0, FOLDERS_CAP));
}

// ── Recents (rich): app/layout + folder pairs ───────────────────────────

/** Read all recent (app|layout, folder) pairs, newest first. Capped at 20. */
export function getRecents(): RecentEntry[] {
  return getPreference<RecentEntry[]>("recents", []) || [];
}

/** Record a (kind, id, name, folder) recent. Deduped on the (kind, id,
 *  folder) triple so the same mount bubbles to the top rather than piling
 *  up. Newest first, capped at 20. */
export function addRecent(entry: Omit<RecentEntry, "ts">): void {
  if (!entry.folder) return;
  const recents = getRecents().filter(
    (r) => !(r.kind === entry.kind && r.id === entry.id && r.folder === entry.folder),
  );
  recents.unshift({ ...entry, ts: Date.now() });
  setPreference("recents", recents.slice(0, RECENTS_CAP));
  broadcastRecentsChanged();
}

/** Drop a single recent entry. */
export function removeRecent(entry: Pick<RecentEntry, "kind" | "id" | "folder">): void {
  const recents = getRecents().filter(
    (r) => !(r.kind === entry.kind && r.id === entry.id && r.folder === entry.folder),
  );
  setPreference("recents", recents);
  broadcastRecentsChanged();
}

/** Drop every recent entry. */
export function clearRecents(): void {
  setPreference("recents", []);
  broadcastRecentsChanged();
}

function broadcastRecentsChanged(): void {
  const list = getRecents();
  getMainWindow()?.webContents.send("recents-changed", list);
  broadcastToPanels("recents-changed", list);
}

/** Set the working directory and notify the renderer + every panel. */
export function setWorkingDirectory(dir: string | null): void {
  const value = dir || null;
  setPreference("workingDirectory", value);
  if (value) pushRecentFolder(value);
  getMainWindow()?.webContents.send("working-dir-changed", value);
  broadcastToPanels("working-dir-changed", value);
  onWorkingDirChange(getWorkingDirectory());
}

export function registerWorkingDirectoryIpc(deps: {
  getMainWindow: () => BrowserWindow | null;
  broadcastToPanels: Broadcast;
  onWorkingDirChange?: (dir: string) => void;
  /** Re-open a recent entry. Wired in main.ts so it can call the same
   *  spawn paths Welcome / +picker / tab-new-app use. */
  openRecent?: (entry: RecentEntry) => void;
}): void {
  getMainWindow = deps.getMainWindow;
  broadcastToPanels = deps.broadcastToPanels;
  if (deps.onWorkingDirChange) onWorkingDirChange = deps.onWorkingDirChange;
  if (deps.openRecent) openRecentEntry = deps.openRecent;

  ipcMain.handle("working-dir:get", () => getWorkingDirectory());
  ipcMain.handle("working-dir:recents", () => getWorkingDirRecents());

  // ── Recents (rich) ──
  ipcMain.handle("recents:list", () => getRecents());
  ipcMain.handle("recents:open", (_e, entry: RecentEntry) => {
    if (!entry?.kind || !entry?.id || !entry?.folder) return false;
    openRecentEntry(entry);
    return true;
  });
  ipcMain.handle("recents:remove", (_e, entry: Pick<RecentEntry, "kind" | "id" | "folder">) => {
    if (!entry?.kind || !entry?.id || !entry?.folder) return false;
    removeRecent(entry);
    return true;
  });
  ipcMain.handle("recents:clear", () => { clearRecents(); return true; });

  // Lightweight git probe used by folder-bound app chrome (Agent app etc.)
  // to surface the current branch when the working folder is a git repo.
  ipcMain.handle("files:git-info", async (_e, root: string) => {
    const result: { isRepo: boolean; branch?: string } = { isRepo: false };
    if (typeof root !== "string" || !root) return result;
    try {
      const inside = await execFileP("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
      if (inside.stdout.trim() !== "true") return result;
      result.isRepo = true;
      try {
        const head = await execFileP("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
        const branch = head.stdout.trim();
        if (branch && branch !== "HEAD") result.branch = branch;
      } catch { /* detached HEAD or other — leave branch undefined */ }
    } catch { /* not a repo or git unavailable */ }
    return result;
  });

  // List local branches in a repo, with the current one. Used by the
  // Agent app's branch picker dropdown.
  ipcMain.handle("files:git-branches", async (_e, root: string) => {
    const result: { branches: string[]; current?: string; error?: string } = { branches: [] };
    if (typeof root !== "string" || !root) return result;
    try {
      const list = await execFileP("git", ["branch", "--format=%(refname:short)"], { cwd: root });
      result.branches = list.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      try {
        const head = await execFileP("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
        const branch = head.stdout.trim();
        if (branch && branch !== "HEAD") result.current = branch;
      } catch { /* detached */ }
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
    }
    return result;
  });

  // Switch branches. Fails if the working tree is dirty — git surfaces a
  // clear error, which the renderer can display.
  ipcMain.handle("files:git-checkout", async (_e, root: string, branch: string) => {
    if (typeof root !== "string" || !root || typeof branch !== "string" || !branch) {
      return { ok: false, error: "Missing root or branch." };
    }
    try {
      await execFileP("git", ["checkout", branch], { cwd: root });
      return { ok: true, branch };
    } catch (err) {
      const msg = err instanceof Error
        ? (err as Error & { stderr?: string }).stderr || err.message
        : String(err);
      return { ok: false, error: msg };
    }
  });

  // Set the current dir to an already-known path (e.g. picked from recents).
  ipcMain.handle("working-dir:set", (_e, dir: string) => {
    if (dir) setWorkingDirectory(dir);
    return getWorkingDirectory();
  });

  // OS folder picker. `opts.startIn` opens the dialog in the current dir;
  // `opts.asDefault` also stores the pick as the first-run default.
  ipcMain.handle("working-dir:pick", async (_e, opts?: { asDefault?: boolean }) => {
    const win = getMainWindow();
    const dialogOpts = {
      properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
      defaultPath: getWorkingDirectory(),
    };
    const result = win
      ? await dialog.showOpenDialog(win, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);
    if (result.canceled || result.filePaths.length === 0) return getWorkingDirectory();
    const picked = result.filePaths[0];
    if (opts?.asDefault) setDefaultWorkingDirectory(picked);
    setWorkingDirectory(picked);
    return picked;
  });

  // Lazy directory listing for the Workbench file tree. Returns immediate
  // children only — the tree fetches deeper levels on expand.
  ipcMain.handle("files:list-dir", async (_e, dir: string) => {
    if (typeof dir !== "string" || !dir) return { entries: [], error: "missing dir" };
    try {
      const items = await fs.readdir(dir, { withFileTypes: true });
      const entries = items
        .filter((d) => !d.name.startsWith("."))
        .map((d) => ({
          name: d.name,
          path: path.join(dir, d.name),
          kind: d.isDirectory() ? "dir" as const : "file" as const,
        }))
        .sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      return { entries };
    } catch (err) {
      return { entries: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Read a file's text contents. Cap to ~1MB to avoid blowing up the renderer
  // on accidental clicks into a giant binary.
  ipcMain.handle("files:read-file", async (_e, filePath: string) => {
    if (typeof filePath !== "string" || !filePath) return { content: "", error: "missing path" };
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 1_000_000) {
        return { content: "", error: `file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB)` };
      }
      const content = await fs.readFile(filePath, "utf8");
      return { content };
    } catch (err) {
      return { content: "", error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Unified git diff of the working tree (staged + unstaged combined). The
  // Workbench Diff slot renders this; returns "" when the tree is clean.
  ipcMain.handle("files:git-diff", async (_e, root: string) => {
    if (typeof root !== "string" || !root) return { text: "", error: "missing root" };
    try {
      const { stdout } = await execFileP("git", ["diff", "HEAD"], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
      return { text: stdout };
    } catch (err) {
      const msg = err instanceof Error
        ? (err as Error & { stderr?: string }).stderr || err.message
        : String(err);
      return { text: "", error: msg };
    }
  });
}
