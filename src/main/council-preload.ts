import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("councilAPI", {
  /** Send a message from the user to all participants. */
  send: (text: string) => ipcRenderer.send("council:send", text),

  /** Add a participant to the active council. */
  addParticipant: (id: string) => ipcRenderer.send("council:add", id),

  /** Remove a participant from the active council. */
  removeParticipant: (id: string) => ipcRenderer.send("council:remove", id),

  /** Get the current participant list. */
  getParticipants: () => ipcRenderer.invoke("council:participants") as Promise<string[]>,

  /** Listen for incoming messages (from any participant or system). */
  onMessage: (cb: (msg: { from: string; text: string; type: "user" | "model" | "system" }) => void) => {
    ipcRenderer.on("council:message", (_e, msg) => cb(msg));
  },

  /** Listen for participant list changes. */
  onParticipantsChanged: (cb: (participants: string[]) => void) => {
    ipcRenderer.on("council:participants-changed", (_e, list) => cb(list));
  },

  /** Listen for a model starting to "type" (thinking indicator). */
  onTyping: (cb: (modelId: string, typing: boolean) => void) => {
    ipcRenderer.on("council:typing", (_e, modelId, typing) => cb(modelId, typing));
  },

  /** Listen for panel becoming visible. */
  onVisible: (cb: () => void) => {
    ipcRenderer.on("council:visible", () => cb());
  },
});
