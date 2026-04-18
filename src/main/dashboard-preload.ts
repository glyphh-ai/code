import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dashboardAPI", {
  /** Get today's usage summary. */
  getToday: () => ipcRenderer.invoke("dashboard:today"),

  /** Get usage history for last N days. */
  getHistory: (days?: number) => ipcRenderer.invoke("dashboard:history", days),

  /** Get all-time totals. */
  getAllTime: () => ipcRenderer.invoke("dashboard:all-time"),

  /** Get list of apps in ~/yo/apps/. */
  getApps: () => ipcRenderer.invoke("dashboard:apps"),

  /** Open an app in a panel. */
  openApp: (name: string) => ipcRenderer.send("dashboard:open-app", name),

  /** Delete an app from ~/yo/apps/. */
  deleteApp: (name: string) => ipcRenderer.invoke("dashboard:delete-app", name),

  /** Get active reminders. */
  getReminders: () => ipcRenderer.invoke("dashboard:reminders"),

  /** Cancel a reminder by ID. */
  cancelReminder: (id: string) => ipcRenderer.invoke("dashboard:cancel-reminder", id),

  /** Get LLM config info (provider + model). */
  getLLMInfo: () => ipcRenderer.invoke("dashboard:llm-info"),

  /** Listen for real-time usage updates. */
  onUsageUpdate: (cb: () => void) => {
    ipcRenderer.on("dashboard:usage-updated", () => cb());
  },

  /** Listen for panel becoming visible (triggers full refresh). */
  onVisible: (cb: () => void) => {
    ipcRenderer.on("dashboard:visible", () => cb());
  },
});
