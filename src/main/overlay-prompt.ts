// overlay-prompt.ts — the RIGHT-EDGE SLIDE-OUT agent panel. This is now opened ONLY
// when an inline `.yo` can't be answered without more information (the agent replied
// NEEDS_INPUT:). It seeds the original query, auto-sends it so the agent re-asks its
// question, and streams a real back-and-forth. On Insert it asks the keytap helper to
// re-activate the origin app and paste the answer.
//
// Unlike the old at-caret prompt, this window is pinned to the right edge of the
// display under the cursor (width ~400, full height).
import { BrowserWindow, ipcMain, screen } from "electron";
import * as path from "path";
import type { YoAgent } from "./yo-agent";
import { sendToHelper } from "./overlay-bridge";

const WIDTH = 400;

interface PromptState {
  win: BrowserWindow;
  app: string;       // origin app bundle id — where Insert pastes back
  query: string;     // the original inline query, seeded + auto-sent on open
}

let state: PromptState | null = null;
let ipcWired = false;

// Open the slide-out agent panel seeded with the original query. The keytap helper
// captured the origin app; we still receive it via the most recent paste target, but
// since the panel is opened from the bridge we look it up from the last run. For
// simplicity the bridge passes the app through openAgentPanel's optional arg.
export function openAgentPanel(query: string, originApp?: string): void {
  // Close any prior panel first.
  if (state && !state.win.isDestroyed()) {
    state.win.close();
  }
  state = null;

  const preload = path.join(__dirname, "prompt-preload.js");
  const win = new BrowserWindow({
    width: WIDTH,
    height: 600,
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

  // Pin to the right edge of the display under the cursor, full work-area height.
  const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  win.setBounds({ x: d.x + d.width - WIDTH, y: d.y, width: WIDTH, height: d.height });

  state = { win, app: originApp || "", query };

  const htmlPath = path.join(__dirname, "..", "renderer", "prompt.html");
  void win.loadFile(htmlPath);

  win.webContents.on("did-finish-load", () => {
    if (win.isDestroyed()) return;
    win.webContents.send("prompt-init", {
      trigger: ".yo",
      query,
      app: state?.app || "",
    });
    win.showInactive();
    win.show();
    win.focus();
    // The renderer auto-sends the seeded query on prompt-init (see
    // prompt-renderer.ts), which flows back through ipcMain "prompt-send" →
    // sendMessage. That drives the disambiguation back-and-forth, so we don't
    // send it again here.
  });

  win.on("closed", () => {
    if (state && state.win === win) state = null;
  });
}

let agentRef: YoAgent | null = null;

/** Stream one message through the agent into the panel. */
function sendMessage(text: string): void {
  if (!state || state.win.isDestroyed() || !agentRef) return;
  const win = state.win;
  const message = (text || "").trim();
  if (!message) return;
  agentRef.send(message, {
    onText: (delta) => { if (!win.isDestroyed()) win.webContents.send("prompt-token", delta); },
    onToolUse: (_id, name) => { if (!win.isDestroyed()) win.webContents.send("prompt-tool", { name }); },
    onDone: (full) => { if (!win.isDestroyed()) win.webContents.send("prompt-done", full); },
    onError: (err) => { if (!win.isDestroyed()) win.webContents.send("prompt-error", err); },
  });
}

export function wireAgentPanel(yoAgent: YoAgent): void {
  agentRef = yoAgent;
  if (ipcWired) return;
  ipcWired = true;

  ipcMain.on("prompt-send", (_e, text: string) => {
    sendMessage(text);
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
    sendToHelper({ type: "done" });
  });

  ipcMain.on("prompt-resize", () => {
    // Panel is fixed full-height on the right edge; ignore content-resize requests.
  });
}
