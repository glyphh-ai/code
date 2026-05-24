// overlay-bridge.ts — supervises the native keytap helper (protocol v3) and routes
// the dot-commands it intercepts (anywhere in the OS) into the right destination.
// The UX is now mostly INLINE: the helper shows a braille spinner at the caret while
// we work, and we reply telling it what to do. The slide-out agent panel
// (overlay-prompt.ts) is opened ONLY when an inline `.yo` needs more information.
//
// The helper (src/main/overlay/keytap.swift, compiled to dist/main/overlay/keytap)
// talks newline-delimited JSON over stdio:
//   helper -> us (stdout):  {"type":"run","trigger","query","x","y","app"}
//   us -> helper (stdin):   {"type":"result"|"ephemeral"|"done"|"panel"|"paste", …}
//
// Routing by trigger:
//   .dip / .drip  → focus main window, run through the command parser, then {done}.
//   .sup          → run through the command parser, paste a short confirmation that
//                   auto-deletes after ~2s ({ephemeral}).
//   .yo / .peace  → run ONE-SHOT via yoAgent.runForResult with a disambiguation
//                   directive. Normal answer → {result} pasted inline. If the answer
//                   begins with NEEDS_INPUT: → open the slide-out panel seeded with
//                   the query and reply {panel}.
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import type { YoAgent } from "./yo-agent";
import { openAgentPanel, wireAgentPanel } from "./overlay-prompt";

// Prepended to the query for inline `.yo` one-shot runs. The agent either returns
// only the text to insert, or exactly "NEEDS_INPUT: <question>" if it truly can't proceed.
const DIRECTIVE =
  "You are invoked inline from anywhere in the OS; your answer is pasted straight into the user's text field. " +
  "If you can answer or perform the request, reply with ONLY the text to insert — concise, plain text, no preamble. " +
  "ONLY if you genuinely cannot proceed without more information, reply with exactly: NEEDS_INPUT: <one short question>.\n\n" +
  "Request: ";

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
  wireAgentPanel(yoAgent);
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
  if (msg.type !== "run") return;
  const trigger = msg.trigger || ".yo";
  const query = (msg.query || "").trim();
  const app = msg.app || "";

  try {
    // .dip → switch apps: bring yo to the front, run through the parser, clear spinner.
    if (trigger === ".dip") {
      focusMainFn?.();
      const cmd = `dip${query ? " " + query : ""}`;
      try { await runCommandFn?.(cmd); }
      catch (e) { console.error("[overlay] command failed:", e); }
      sendToHelper({ type: "done" });
      return;
    }
    // .drip → full-screen OS overlay over whatever app you're in: do NOT focus
    // yo (the effect floats over everything). The drip-manager plays full-screen
    // unless the in-app ".drip ." variant is used.
    if (trigger === ".drip") {
      const cmd = `drip${query ? " " + query : ""}`;
      try { await runCommandFn?.(cmd); }
      catch (e) { console.error("[overlay] command failed:", e); }
      sendToHelper({ type: "done" });
      return;
    }

    // .sup → capture, then paste a short inline confirmation that auto-deletes.
    if (trigger === ".sup") {
      let out = "";
      try { out = ((await runCommandFn?.(`sup${query ? " " + query : ""}`)) as string) || ""; }
      catch (e) { console.error("[overlay] sup failed:", e); }
      const text = (out && out.trim()) || "captured ✓";
      sendToHelper({ type: "ephemeral", text, ms: 2000 });
      return;
    }

    // .yo (and .peace → treat as .yo) → one-shot agent run with disambiguation.
    const r = await yoAgent.runForResult(DIRECTIVE + query);
    const text = (r.error ? "" : r.text).trim();
    if (text.startsWith("NEEDS_INPUT:")) {
      openAgentPanel(query, app);
      sendToHelper({ type: "panel" });
    } else {
      sendToHelper({ type: "result", text });
    }
  } catch (e) {
    console.error("[overlay] run handling failed:", e);
    sendToHelper({ type: "done" });
  }
}

// Send a control message to the helper's stdin (used inline + by the panel's Insert).
export function sendToHelper(obj: Record<string, unknown>): void {
  if (!proc?.stdin?.writable) return;
  proc.stdin.write(JSON.stringify(obj) + "\n");
}

export function stopOverlay(): void {
  stopped = true;
  proc?.kill();
  proc = null;
}
