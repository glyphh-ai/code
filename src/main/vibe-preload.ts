/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from "electron";
import { VIBE_BASE_CSS as BASE_CSS } from "./vibe-base-css";

// ── Inject CSS + theme on DOM ready ─────────────────────────

function injectBaseStyles() {
  const style = document.createElement("style");
  style.id = "__yo_vibe_base__";
  style.textContent = BASE_CSS;
  (document.head || document.documentElement).appendChild(style);
}

function setTheme(theme: string) {
  document.documentElement.setAttribute("data-theme", theme);
}

// Inject as early as possible
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    injectBaseStyles();
    ipcRenderer.invoke("vibe:get-theme").then(setTheme);
  }, { once: true });
} else {
  injectBaseStyles();
  ipcRenderer.invoke("vibe:get-theme").then(setTheme);
}

// Listen for theme changes from the main process
ipcRenderer.on("theme-changed", (_e, theme: string) => setTheme(theme));

// ── Vibe API ────────────────────────────────────────────────

contextBridge.exposeInMainWorld("vibe", {
  runSkill: (name: string, input: unknown) =>
    ipcRenderer.invoke("vibe:run-skill", name, input) as Promise<{ ok: true; output: unknown } | { ok: false; error: string }>,

  ask: (prompt: string) =>
    ipcRenderer.invoke("vibe:ask", prompt) as Promise<string>,

  searchCaptures: (query: string, limit?: number) =>
    ipcRenderer.invoke("vibe:search-captures", query, limit) as Promise<Array<{ source: string; content: string; score: number }>>,

  readFile: (relPath: string) =>
    ipcRenderer.invoke("vibe:read-file", relPath) as Promise<string | null>,

  getName: () =>
    ipcRenderer.invoke("vibe:get-name") as Promise<string>,

  copyToClipboard: (text: string) =>
    ipcRenderer.invoke("vibe:copy", text),

  onData: (cb: (data: unknown) => void) => {
    ipcRenderer.on("vibe:data", (_e, data) => cb(data));
  },

  store: {
    get: (key: string) =>
      ipcRenderer.invoke("vibe:store-get", key) as Promise<unknown | null>,
    set: (key: string, value: unknown) =>
      ipcRenderer.invoke("vibe:store-set", key, value) as Promise<void>,
    delete: (key: string) =>
      ipcRenderer.invoke("vibe:store-delete", key) as Promise<boolean>,
    list: (prefix?: string, limit?: number) =>
      ipcRenderer.invoke("vibe:store-list", prefix, limit) as Promise<Array<{ key: string; value: unknown }>>,
    query: (filter: Record<string, unknown>, limit?: number) =>
      ipcRenderer.invoke("vibe:store-query", filter, limit) as Promise<Array<{ key: string; value: unknown }>>,
    keys: () =>
      ipcRenderer.invoke("vibe:store-keys") as Promise<string[]>,
    count: () =>
      ipcRenderer.invoke("vibe:store-count") as Promise<number>,
    clear: () =>
      ipcRenderer.invoke("vibe:store-clear") as Promise<number>,
  },
});
