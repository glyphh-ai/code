// overlay-bridge.ts — supervises the native keytap helper (protocol v2) and routes
// the dot-commands it intercepts (anywhere in the OS) into the right destination.
//
// The helper (src/main/overlay/keytap.swift, compiled to dist/main/overlay/keytap)
// talks newline-delimited JSON over stdio:
//   helper -> us (stdout):  {"type":"open","trigger","query","x","y","app"}
//   us -> helper (stdin):   {"type":"paste","text","app"} | {"type":"dismiss"}
// On "open":
//   .yo                       → pop the at-caret prompt window (overlay-prompt.ts),
//                               which streams the agent and can paste back.
//   .dip/.drip/.sup/.peace    → focus the main window and run the command through the
//                               app's command parser (no prompt window).
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import type { YoAgent } from "./yo-agent";
import { openPromptWindow } from "./overlay-prompt";

let proc: ChildProcess | null = null;
let stopped = false;
let restarts = 0;
let runCommandFn: ((cmd: string) => Promise<string> | void) | null = null;
let focusMainFn: (() => void) | null = null;

export function startOverlay(
  yoAgent: YoAgent,
  runCommand: (cmd: string) => Promise<string> | void,
  focusMain: () => void,
  binPath: string,
): void {
  if (process.platform !== "darwin") return;
  if (!fs.existsSync(binPath)) {
    console.error("[overlay] helper binary missing (run npm run build:overlay):", binPath);
    return;
  }
  stopped = false;
  runCommandFn = runCommand;
  focusMainFn = focusMain;
  spawnHelper(yoAgent, binPath);
}

function spawnHelper(yoAgent: YoAgent, binPath: string): void {
  proc = spawn(binPath, [], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  proc.stdout!.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) void handleLine(line, yoAgent);
    }
  });
  proc.on("exit", (code) => {
    proc = null;
    if (stopped) return;
    // Crash-loop guard: back off and cap restarts.
    if (restarts++ < 5) {
      console.error(`[overlay] helper exited (${code}); restarting (${restarts})`);
      setTimeout(() => { if (!stopped) spawnHelper(yoAgent, binPath); }, 1000);
    } else {
      console.error("[overlay] helper keeps exiting; giving up.");
    }
  });
  proc.on("error", (err) => console.error("[overlay] helper spawn error:", err));
}

async function handleLine(line: string, yoAgent: YoAgent): Promise<void> {
  let msg: { type?: string; trigger?: string; query?: string; x?: number; y?: number; app?: string };
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== "open") return;
  const trigger = msg.trigger || ".yo";
  const query = (msg.query || "").trim();

  // .yo → the interactive at-caret agent prompt window.
  if (trigger === ".yo") {
    openPromptWindow(yoAgent, {
      trigger,
      query,
      x: typeof msg.x === "number" ? msg.x : 0,
      y: typeof msg.y === "number" ? msg.y : 0,
      app: msg.app || "",
    });
    return;
  }

  // .dip / .drip / .sup / .peace → focus the app and run through the command parser.
  // e.g. ".dip gmail" → runCommand("dip gmail").
  focusMainFn?.();
  const cmd = `${trigger.slice(1)}${query ? " " + query : ""}`;
  try { void runCommandFn?.(cmd); }
  catch (e) { console.error("[overlay] command failed:", e); }
}

// Send a control message to the helper's stdin (used by the prompt window to paste
// the chosen answer back into the origin app, or to dismiss).
export function sendToHelper(obj: Record<string, unknown>): void {
  if (!proc?.stdin?.writable) return;
  proc.stdin.write(JSON.stringify(obj) + "\n");
}

export function stopOverlay(): void {
  stopped = true;
  proc?.kill();
  proc = null;
}
