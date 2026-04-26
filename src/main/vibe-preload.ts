import { contextBridge, ipcRenderer } from "electron";

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
