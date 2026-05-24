/**
 * Vibe IPC — main-process seam for the Vibe coding workspace (Phase 2).
 *
 * Wires the 3-region workspace and binds it to a persisted Vibe project
 * (~/yo/vibes/<id>/) instead of a single scratch dir:
 *   1. Agent  — spawns a Claude Code PTY in the ACTIVE vibe's code/ dir on
 *               "vibe-ready" (reuses TerminalManager.spawnAgent + terminal:*).
 *   2. Plan   — reads/writes the active vibe's plan.md.
 *   3. Preview— handled entirely in the renderer's <webview>.
 *
 * The active vibe is selected from the Vibes home section (vibe-open / openVibe);
 * the panel is then reloaded so vibe-ready re-fires and the agent re-spawns in
 * the new vibe's code dir. If nothing is active yet, a default "Scratch" vibe
 * is created/used so Phase-1 behavior still works out of the box.
 */

import { ipcMain, type WebContents } from "electron";
import * as fs from "fs";
import { ensureCcAuth, bootstrapStatus } from "./cc-bootstrap";
import type { TerminalManager } from "./terminal";
import {
  listVibes,
  getVibe,
  createVibe,
  deleteVibe,
  vibeCodeDir,
  vibePlanPath,
  type VibeMeta,
} from "./vibe-store";

const STARTER_PLAN = `# Plan

- [ ] Describe what you're building
`;

export interface VibeIpcDeps {
  /** The TerminalManager singleton from main.ts (owns the terminal:* IPC). */
  terminalManager: TerminalManager;
  /** Optional sink the real feature can use to push "vibe-event" frames into the panel. */
  forward?: (event: { kind: string; [key: string]: unknown }) => void;
}

/** Dependencies openVibe needs to switch + reload the vibe panel. */
export interface OpenVibeDeps {
  /** Ensure the "vibe" panel exists, switch to it, and reload its webContents. */
  showVibePanel: () => void;
}

/** The currently-bound vibe. null until a vibe is opened (or a default is made). */
let activeVibeId: string | null = null;
let registered = false;
let terminalManagerRef: TerminalManager | null = null;

/** Bind the workspace to a specific vibe id (used by openVibe / vibe-open). */
export function setActiveVibe(id: string): void {
  activeVibeId = id;
}

/** Resolve the active vibe id, falling back to (creating) a default "Scratch". */
function resolveActiveVibeId(): string {
  if (activeVibeId && getVibe(activeVibeId)) return activeVibeId;
  // Fall back to the most-recent existing vibe, else create a "Scratch" one.
  const existing = listVibes();
  const scratch = existing.find((v) => v.id === "scratch") || existing[0];
  if (scratch) {
    activeVibeId = scratch.id;
    return scratch.id;
  }
  const created = createVibe("Scratch", "Default workspace");
  activeVibeId = created.id;
  return created.id;
}

export function registerVibeIpc(deps: VibeIpcDeps): void {
  // ipcMain handlers are process-global — guard against double registration
  // (two addPanel sites, hot paths) since ipcMain.handle throws on re-register.
  if (registered) return;
  registered = true;

  const { terminalManager } = deps;
  terminalManagerRef = terminalManager;

  // ── Region 1: spawn the Claude Code agent when the renderer is ready ──
  ipcMain.on("vibe-ready", (e) => spawnVibeAgent(e.sender));

  // ── Region 2: plan.md read / write (bound to the active vibe) ──
  ipcMain.handle("vibe-plan-read", () => {
    try {
      return fs.readFileSync(vibePlanPath(resolveActiveVibeId()), "utf-8");
    } catch {
      return "";
    }
  });
  ipcMain.on("vibe-plan-write", (_e, text: string) => {
    try {
      fs.writeFileSync(vibePlanPath(resolveActiveVibeId()), typeof text === "string" ? text : "", "utf-8");
    } catch (err) {
      console.log("[vibe] plan write failed:", (err as Error).message);
    }
  });

  // ── Registry CRUD + open ──────────────────────────────────
  ipcMain.handle("vibe-list", () => listVibes());
  ipcMain.handle("vibe-get", (_e, id: string) => getVibe(id));
  ipcMain.handle("vibe-create", (_e, name: string, description?: string) => createVibe(name, description));
  ipcMain.handle("vibe-delete", (_e, id: string) => {
    const ok = deleteVibe(id);
    // If the active vibe was deleted, drop the binding so the next open/ready
    // re-resolves to a valid vibe instead of a missing dir.
    if (ok && activeVibeId === id) activeVibeId = null;
    return ok;
  });
  // vibe-open just sets the active id and returns the vibe; the panel switch +
  // reload is driven by main via openVibe (see registerVibeOpen / main.ts).
  ipcMain.handle("vibe-open", (_e, id: string) => {
    const vibe = getVibe(id);
    if (vibe) setActiveVibe(id);
    return vibe;
  });
}

/**
 * Set the active vibe and tell main to show + reload the vibe panel, so the
 * renderer re-fires vibe-ready and the agent re-spawns in the new cwd.
 *
 * Returns the opened VibeMeta (or null if the id is unknown).
 */
export function openVibe(id: string, deps: OpenVibeDeps): VibeMeta | null {
  const vibe = getVibe(id);
  if (!vibe) return null;
  setActiveVibe(id);
  deps.showVibePanel();
  return vibe;
}

/** Spawn the single coding agent into the active vibe's code dir (gated on CC auth). */
function spawnVibeAgent(wc: WebContents): void {
  const terminalManager = terminalManagerRef;
  if (!terminalManager) return;

  // Non-blocking: if creds are missing this shows the bootstrap modal and
  // returns false; the agent isn't spawned until the user is authed and the
  // renderer fires vibe-ready again (panel reload).
  if (!ensureCcAuth()) return;

  const id = resolveActiveVibeId();
  const cwd = vibeCodeDir(id);

  // Make sure the cwd + a starter plan.md exist (covers a vibe whose dir was
  // partially removed, or a freshly-resolved default).
  try {
    fs.mkdirSync(cwd, { recursive: true });
    if (!fs.existsSync(vibePlanPath(id))) {
      fs.writeFileSync(vibePlanPath(id), STARTER_PLAN, { mode: 0o600 });
    }
  } catch (err) {
    console.log("[vibe] ensure cwd failed:", (err as Error).message);
  }

  // spawnAgent kills any existing PTY for this wc first (terminal.ts:137), so
  // switching vibes + reloading the panel re-spawns cleanly in the new cwd.
  const claudePath = bootstrapStatus().claudePath || "claude";
  terminalManager.spawnAgent(wc, {
    name: "vibe",
    role: "coding",
    cwd,
    command: claudePath,
    args: [],
    workspace: "vibe",
  });
}

/** Helper to emit a "vibe-event" frame to a given panel's WebContents. */
export function sendVibeEvent(target: WebContents, event: { kind: string; [key: string]: unknown }): void {
  target.send("vibe-event", event);
}
