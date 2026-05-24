// prompt-preload.ts — contextBridge for the overlay prompt window. Exposes a tiny
// `yoprompt` API: send/insert/dismiss/resize plus streaming listeners. Bundled by
// `npm run build:prompt` -> dist/main/prompt-preload.js.
import { contextBridge, ipcRenderer } from "electron";

interface PromptInit { trigger: string; query: string; app: string }

contextBridge.exposeInMainWorld("yoprompt", {
  send: (text: string) => ipcRenderer.send("prompt-send", text),
  insert: (text: string) => ipcRenderer.send("prompt-insert", text),
  dismiss: () => ipcRenderer.send("prompt-dismiss"),
  resize: (h: number) => ipcRenderer.send("prompt-resize", h),

  onInit: (cb: (init: PromptInit) => void) =>
    ipcRenderer.on("prompt-init", (_e, init: PromptInit) => cb(init)),
  onToken: (cb: (delta: string) => void) =>
    ipcRenderer.on("prompt-token", (_e, delta: string) => cb(delta)),
  onTool: (cb: (info: { name: string }) => void) =>
    ipcRenderer.on("prompt-tool", (_e, info: { name: string }) => cb(info)),
  onDone: (cb: (full: string) => void) =>
    ipcRenderer.on("prompt-done", (_e, full: string) => cb(full)),
  onError: (cb: (err: string) => void) =>
    ipcRenderer.on("prompt-error", (_e, err: string) => cb(err)),
});
