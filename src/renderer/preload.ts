/**
 * Preload script — exposes IPC to the renderer safely.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("yo", {
  command: (input: string) => ipcRenderer.send("command", input),
  onResult: (callback: (result: string) => void) => {
    ipcRenderer.on("command-result", (_event, result: string) => {
      callback(result);
    });
  },
});
