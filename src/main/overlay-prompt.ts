// overlay-prompt.ts — the interactive "agent prompt window" that opens EXACTLY at
// the text caret. The keytap helper (protocol v2) reports the caret screen coords
// (Quartz top-left) and the frontmost app's bundle id on a dot-command; we open a
// small frameless, always-on-top BrowserWindow there, stream the agent into it, and
// (on Insert) ask the helper to re-activate the origin app and paste the answer.
import { BrowserWindow, ipcMain } from "electron";
import * as path from "path";
import type { YoAgent } from "./yo-agent";
import { sendToHelper } from "./overlay-bridge";

// Per-trigger intent prefix applied to the FIRST message only, so the agent knows
// the DSL verb. ".yo" is the plain ask; the others nudge intent.
const INTENT: Record<string, string> = {
  ".yo": "",
  ".sup": "Remember this for later: ",
  ".dip": "Use os_context to see open apps/tabs, then activate (or open_url) to navigate to: ",
  ".drip": "",
  ".peace": "",
};

const WIDTH = 440;
const HEIGHT = 300;

interface PromptState {
  win: BrowserWindow;
  app: string;       // origin app bundle id — where Insert pastes back
  trigger: string;
  firstSent: boolean; // whether the INTENT prefix has already been applied
}

let state: PromptState | null = null;
let ipcWired = false;

export interface OpenPromptArgs {
  trigger: string;
  query: string;
  x: number;
  y: number;
  app: string;
}

export function openPromptWindow(yoAgent: YoAgent, args: OpenPromptArgs): void {
  // Close any prior prompt window first.
  if (state && !state.win.isDestroyed()) {
    state.win.close();
  }
  state = null;

  const preload = path.join(__dirname, "prompt-preload.js");
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: true,
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
    },
  });

  // Position EXACTLY at the caret: the helper sends Quartz top-left screen coords
  // (x = caret minX, y = caret maxY). Electron screen coords are also top-left from
  // the primary display, so we pass them UNTRANSFORMED — just nudge 6px below the
  // caret line so the window drops just under it.
  win.setBounds({ x: args.x, y: args.y + 6, width: WIDTH, height: HEIGHT });

  state = { win, app: args.app, trigger: args.trigger, firstSent: false };

  const htmlPath = path.join(__dirname, "..", "renderer", "prompt.html");
  void win.loadFile(htmlPath);

  win.webContents.on("did-finish-load", () => {
    if (win.isDestroyed()) return;
    win.webContents.send("prompt-init", {
      trigger: args.trigger,
      query: args.query,
      app: args.app,
    });
    win.showInactive();
    win.show();
    win.focus();
  });

  win.on("closed", () => {
    if (state && state.win === win) state = null;
  });

  wireIpc(yoAgent);
}

function wireIpc(yoAgent: YoAgent): void {
  if (ipcWired) return;
  ipcWired = true;

  ipcMain.on("prompt-send", (_e, text: string) => {
    if (!state || state.win.isDestroyed()) return;
    const win = state.win;
    // Apply the per-trigger INTENT prefix to the FIRST message only.
    let message = (text || "").trim();
    if (!state.firstSent) {
      message = (INTENT[state.trigger] ?? "") + message;
      state.firstSent = true;
    }
    yoAgent.send(message, {
      onText: (delta) => { if (!win.isDestroyed()) win.webContents.send("prompt-token", delta); },
      onToolUse: (_id, name) => { if (!win.isDestroyed()) win.webContents.send("prompt-tool", { name }); },
      onDone: (full) => { if (!win.isDestroyed()) win.webContents.send("prompt-done", full); },
      onError: (err) => { if (!win.isDestroyed()) win.webContents.send("prompt-error", err); },
    });
  });

  ipcMain.on("prompt-insert", (_e, text: string) => {
    if (!state) return;
    const app = state.app;
    const win = state.win;
    // Hand the chosen text to the helper, which re-activates the origin app and
    // pastes it into the field. Close our window first so focus returns cleanly.
    if (!win.isDestroyed()) win.close();
    sendToHelper({ type: "paste", text: text ?? "", app });
  });

  ipcMain.on("prompt-dismiss", () => {
    if (state && !state.win.isDestroyed()) state.win.close();
    sendToHelper({ type: "dismiss" });
  });

  ipcMain.on("prompt-resize", (_e, h: number) => {
    if (!state || state.win.isDestroyed()) return;
    const b = state.win.getBounds();
    const height = Math.max(HEIGHT, Math.min(Math.round(h) || HEIGHT, 600));
    state.win.setBounds({ x: b.x, y: b.y, width: b.width, height });
  });
}
