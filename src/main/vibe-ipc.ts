/**
 * Vibe IPC — main-process seam for the Vibe coding workspace (Phase 1).
 *
 * Wires the 3-region workspace:
 *   1. Agent  — spawns a Claude Code PTY in a scratch dir on "vibe-ready"
 *               (reuses TerminalManager.spawnAgent + the terminal:* channels).
 *   2. Plan   — reads/writes ~/yo/vibes/scratch/plan.md.
 *   3. Preview— handled entirely in the renderer's <webview>.
 *
 * Single agent, single scratch working dir. The per-project vibe registry
 * (~/yo/vibes/<id>/) and the left-rail Vibes list come in a later phase.
 */

import { ipcMain, type WebContents } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ensureCcAuth, bootstrapStatus } from "./cc-bootstrap";
import type { TerminalManager } from "./terminal";

/** Scratch project the agent builds in (Phase 1: one shared dir, no registry). */
const VIBE_ROOT = path.join(os.homedir(), "yo", "vibes", "scratch");
const SCRATCH_DIR = path.join(VIBE_ROOT, "code");
const PLAN_PATH = path.join(VIBE_ROOT, "plan.md");

const STARTER_PLAN = `# Plan

> The living task list for this vibe. The agent reads + checks this off;
> you can edit it freely.

## Goal
- [ ] Describe what you're building

## Tasks
- [ ]

`;

export interface VibeIpcDeps {
  /** The TerminalManager singleton from main.ts (owns the terminal:* IPC). */
  terminalManager: TerminalManager;
  /** Optional sink the real feature can use to push "vibe-event" frames into the panel. */
  forward?: (event: { kind: string; [key: string]: unknown }) => void;
}

let registered = false;

export function registerVibeIpc(deps: VibeIpcDeps): void {
  // ipcMain handlers are process-global — guard against double registration
  // (two addPanel sites, hot paths) since ipcMain.handle throws on re-register.
  if (registered) return;
  registered = true;

  const { terminalManager } = deps;

  ensureDirs();

  // ── Region 1: spawn the Claude Code agent when the renderer is ready ──
  ipcMain.on("vibe-ready", (e) => spawnVibeAgent(terminalManager, e.sender));

  // ── Region 2: plan.md read / write ──
  ipcMain.handle("vibe-plan-read", () => {
    try {
      return fs.readFileSync(PLAN_PATH, "utf-8");
    } catch {
      return "";
    }
  });
  ipcMain.on("vibe-plan-write", (_e, text: string) => {
    try {
      ensureDirs();
      fs.writeFileSync(PLAN_PATH, typeof text === "string" ? text : "", "utf-8");
    } catch (err) {
      console.log("[vibe] plan write failed:", (err as Error).message);
    }
  });
}

/** Spawn the single coding agent into the scratch dir (gated on CC auth). */
function spawnVibeAgent(terminalManager: TerminalManager, wc: WebContents): void {
  // Non-blocking: if creds are missing this shows the bootstrap modal and
  // returns false; the agent isn't spawned until the user is authed and the
  // renderer fires vibe-ready again (panel reload).
  if (!ensureCcAuth()) return;

  ensureDirs();
  const claudePath = bootstrapStatus().claudePath || "claude";
  terminalManager.spawnAgent(wc, {
    name: "vibe",
    role: "coding",
    cwd: SCRATCH_DIR,
    command: claudePath,
    args: [],
    workspace: "vibe",
  });
}

/** Ensure the scratch dirs + a starter plan.md exist. */
function ensureDirs(): void {
  try {
    fs.mkdirSync(SCRATCH_DIR, { recursive: true });
    if (!fs.existsSync(PLAN_PATH)) {
      fs.writeFileSync(PLAN_PATH, STARTER_PLAN, "utf-8");
    }
  } catch (err) {
    console.log("[vibe] ensureDirs failed:", (err as Error).message);
  }
}

/** Helper to emit a "vibe-event" frame to a given panel's WebContents. */
export function sendVibeEvent(target: WebContents, event: { kind: string; [key: string]: unknown }): void {
  target.send("vibe-event", event);
}
