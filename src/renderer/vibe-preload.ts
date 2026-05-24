import { contextBridge, ipcRenderer } from "electron";

interface VibeAPI {
  // ── PTY (Claude Code agent) ───────────────────────────────
  // Reuses the terminal:* channels so terminal.ts's existing handlers work,
  // keyed by this panel's wc.id.
  termWrite: (data: string) => void;
  termResize: (cols: number, rows: number) => void;
  onTermData: (cb: (data: string) => void) => void;
  /** Tell main the renderer is ready (after first fit) → triggers agent spawn. */
  ready: () => void;

  // ── Spec file (~/yo/vibes/<id>/SPEC.md) — durable source of truth ──
  specRead: () => Promise<string>;
  specWrite: (text: string) => void;

  // ── Plan file (~/yo/vibes/<id>/plan.md) ───────────────────
  planRead: () => Promise<string>;
  planWrite: (text: string) => void;

  // ── Theme ─────────────────────────────────────────────────
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}

const api: VibeAPI = {
  termWrite: (data) => ipcRenderer.send("terminal:write", data),
  termResize: (cols, rows) => ipcRenderer.send("terminal:resize", cols, rows),
  onTermData: (cb) => {
    ipcRenderer.on("terminal:data", (_e, data: string) => cb(data));
  },
  ready: () => ipcRenderer.send("vibe-ready"),

  specRead: () => ipcRenderer.invoke("vibe-spec-read") as Promise<string>,
  specWrite: (text) => ipcRenderer.send("vibe-spec-write", text),

  planRead: () => ipcRenderer.invoke("vibe-plan-read") as Promise<string>,
  planWrite: (text) => ipcRenderer.send("vibe-plan-write", text),

  getTheme: () => ipcRenderer.invoke("get-theme") as Promise<string>,
  onThemeChanged: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, theme: string) => cb(theme);
    ipcRenderer.on("theme-changed", handler);
    return () => { ipcRenderer.removeListener("theme-changed", handler); };
  },
};

contextBridge.exposeInMainWorld("vibe", api);
