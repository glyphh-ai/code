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
  vibeClaudePath,
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

/**
 * Dependencies the vibe-planner flow needs. Wired from main so vibe-ipc
 * stays decoupled from how skills/agents are constructed.
 */
export interface VibePlanDeps {
  /** Run the seeded "vibe-planner" methodology against a goal, single-shot. */
  runPlanner: (goal: string) => Promise<string>;
}

/** Result of a vibe-plan run. */
export interface VibePlanResult {
  ok: boolean;
  error?: string;
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

/**
 * Run the vibe-planner methodology for a vibe and write the two artifacts.
 *
 * The planner returns a JSON object { plan, claudeMd } (it may be wrapped in
 * prose or a code fence — we parse loosely). On success we write plan.md +
 * CLAUDE.md into the vibe dir; the plan pane reads plan.md on next open/reload.
 */
export async function vibePlan(id: string, goal: string, deps: VibePlanDeps): Promise<VibePlanResult> {
  const vibe = getVibe(id);
  if (!vibe) return { ok: false, error: `Vibe "${id}" not found` };
  const trimmedGoal = (goal || vibe.description || vibe.name || "").trim();
  if (!trimmedGoal) return { ok: false, error: "A goal is required to generate a plan." };

  // Hand the planner a structured goal payload so it can use name/description.
  const input = JSON.stringify({ goal: trimmedGoal, name: vibe.name, description: vibe.description });

  let raw: string;
  try {
    raw = await deps.runPlanner(input);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const parsed = parsePlannerOutput(raw);
  if (!parsed) {
    return { ok: false, error: "Planner did not return a usable plan (could not parse plan/CLAUDE markdown)." };
  }

  try {
    if (parsed.plan.trim()) {
      fs.writeFileSync(vibePlanPath(id), parsed.plan.trim() + "\n", "utf-8");
    }
    if (parsed.claudeMd.trim()) {
      fs.writeFileSync(vibeClaudePath(id), parsed.claudeMd.trim() + "\n", "utf-8");
    }
  } catch (err) {
    return { ok: false, error: `Failed writing vibe files: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true };
}

/**
 * Loosely parse the planner's response into { plan, claudeMd }.
 * Accepts: raw JSON, JSON wrapped in a ```json fence or surrounding prose,
 * and (fallback) two delimited markdown sections.
 */
function parsePlannerOutput(raw: string): { plan: string; claudeMd: string } | null {
  if (!raw || !raw.trim()) return null;

  const tryJson = (s: string): { plan: string; claudeMd: string } | null => {
    try {
      const obj = JSON.parse(s) as Record<string, unknown>;
      const plan = typeof obj.plan === "string" ? obj.plan : "";
      const claudeMd =
        typeof obj.claudeMd === "string" ? obj.claudeMd
        : typeof (obj as any).claude_md === "string" ? (obj as any).claude_md
        : typeof (obj as any).claude === "string" ? (obj as any).claude
        : "";
      if (plan || claudeMd) return { plan, claudeMd };
    } catch { /* fall through */ }
    return null;
  };

  // 1) Direct JSON.
  let res = tryJson(raw.trim());
  if (res) return res;

  // 2) JSON inside the first {...} block (handles prose/fences around it).
  const brace = raw.match(/\{[\s\S]*\}/);
  if (brace) {
    res = tryJson(brace[0]);
    if (res) return res;
  }

  // 3) Fallback: split on a CLAUDE.md-ish delimiter heading.
  const splitMatch = raw.match(/^([\s\S]*?)\n#{1,3}\s*(?:CLAUDE\.md|Methodology)\b[^\n]*\n([\s\S]*)$/im);
  if (splitMatch) {
    return { plan: splitMatch[1], claudeMd: `# Methodology\n${splitMatch[2]}` };
  }

  return null;
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
