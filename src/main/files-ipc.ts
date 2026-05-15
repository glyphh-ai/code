/**
 * files-ipc — backend for the "Files" app (yo://files): a folder explorer +
 * Monaco editor + read-only git diff viewer.
 *
 * All git operations are READ-ONLY (status / diff / show). No staging, commit,
 * merge, or checkout — this surface only ever inspects a repo.
 */

import { ipcMain, dialog, BrowserWindow } from "electron";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { getPreference, setPreference } from "./preferences";

const execFileP = promisify(execFile);

export type GitMode = "working" | "main";
export interface GitChange { path: string; status: string }

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** Run a git command, returning null instead of throwing (missing ref, not a repo, …). */
async function gitSafe(cwd: string, args: string[]): Promise<string | null> {
  try { return await git(cwd, args); } catch { return null; }
}

/** Resolve the repo's default branch (origin/HEAD target, else main/master). */
async function defaultBranch(root: string): Promise<string> {
  const sym = await gitSafe(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (sym && sym.trim()) return sym.trim().replace(/^origin\//, "");
  for (const b of ["main", "master"]) {
    if (await gitSafe(root, ["rev-parse", "--verify", "--quiet", b])) return b;
  }
  return "main";
}

function statusFromPorcelain(code: string): string {
  if (code === "??") return "untracked";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  return "modified";
}

function statusFromNameStatus(code: string): string {
  if (code.startsWith("A")) return "added";
  if (code.startsWith("D")) return "deleted";
  if (code.startsWith("R")) return "renamed";
  return "modified";
}

function parsePorcelain(out: string): GitChange[] {
  const res: GitChange[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    let p = line.slice(3);
    if (p.includes(" -> ")) p = p.split(" -> ")[1]; // rename: take the new path
    p = p.replace(/^"|"$/g, "");
    res.push({ path: p, status: statusFromPorcelain(code) });
  }
  return res;
}

function parseNameStatus(out: string): GitChange[] {
  const res: GitChange[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    res.push({ path: parts[parts.length - 1], status: statusFromNameStatus(parts[0]) });
  }
  return res;
}

export function registerFilesIpc(): void {
  // ── Folder picker ────────────────────────────────────────
  ipcMain.handle("files:pick-folder", async () => {
    const win = BrowserWindow.getFocusedWindow();
    const opts: Electron.OpenDialogOptions = { properties: ["openDirectory"] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0];
  });

  // ── Last opened folder (persisted so the editor restores it) ──
  ipcMain.handle("files:last-folder", () =>
    getPreference<string | null>("filesLastFolder", null));
  ipcMain.on("files:set-last-folder", (_e, p: string | null) =>
    setPreference("filesLastFolder", p || null));

  // ── Filesystem reads ─────────────────────────────────────
  ipcMain.handle("files:list-dir", (_e, dirPath: string) => {
    try {
      return fs.readdirSync(dirPath, { withFileTypes: true })
        .filter((e) => e.name !== ".git" && e.name !== ".DS_Store")
        .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
        .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
    } catch { return []; }
  });

  ipcMain.handle("files:read-file", (_e, filePath: string) => {
    try {
      const buf = fs.readFileSync(filePath);
      if (buf.includes(0)) return { content: "", binary: true };
      return { content: buf.toString("utf-8"), binary: false };
    } catch { return { content: "", binary: false, error: true }; }
  });

  ipcMain.handle("files:save-file", (_e, filePath: string, content: string) => {
    try {
      fs.writeFileSync(filePath, content, "utf-8");
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "save failed" };
    }
  });

  // ── Git (read-only) ──────────────────────────────────────
  ipcMain.handle("files:git-info", async (_e, root: string) => {
    const inside = await gitSafe(root, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside || inside.trim() !== "true") return { isRepo: false };
    const branch = (await gitSafe(root, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() || "HEAD";
    return { isRepo: true, branch, defaultBranch: await defaultBranch(root) };
  });

  // Discover git repos: the opened folder itself, or — if it isn't a repo —
  // its immediate subdirectories that are (a folder of projects / monorepo).
  ipcMain.handle("files:git-repos", async (_e, root: string) => {
    const repoAt = async (p: string) => ({
      name: path.basename(p),
      path: p,
      branch: (await gitSafe(p, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() || "HEAD",
    });
    const rootInside = await gitSafe(root, ["rev-parse", "--is-inside-work-tree"]);
    if (rootInside?.trim() === "true") return [await repoAt(root)];
    let children: fs.Dirent[] = [];
    try { children = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
    const repos = [];
    for (const c of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!c.isDirectory() || c.name.startsWith(".")) continue;
      if (fs.existsSync(path.join(root, c.name, ".git"))) {
        repos.push(await repoAt(path.join(root, c.name)));
      }
    }
    return repos;
  });

  ipcMain.handle("files:git-changes", async (_e, root: string, mode: GitMode) => {
    if (mode === "main") {
      const out = await gitSafe(root, ["diff", "--name-status", "-M", await defaultBranch(root)]);
      return out == null ? [] : parseNameStatus(out);
    }
    const out = await gitSafe(root, ["status", "--porcelain"]);
    return out == null ? [] : parsePorcelain(out);
  });

  ipcMain.handle("files:git-diff", async (_e, root: string, relPath: string, mode: GitMode) => {
    const ref = mode === "main" ? await defaultBranch(root) : "HEAD";
    // Original = the file as of the comparison ref (empty if it didn't exist).
    const original = (await gitSafe(root, ["show", `${ref}:${relPath}`])) ?? "";
    // Modified = the current file on disk (empty if deleted).
    let modified = "";
    try {
      const buf = fs.readFileSync(path.join(root, relPath));
      if (buf.includes(0)) return { original: "", modified: "", binary: true };
      modified = buf.toString("utf-8");
    } catch { modified = ""; }
    if (original.includes("\0")) return { original: "", modified: "", binary: true };
    return { original, modified, binary: false };
  });
}
