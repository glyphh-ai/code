import { ipcMain } from "electron";
import os from "os";
import type { CaptureStore } from "./capture-store";
import type { WorkspaceManager } from "./workspace-manager";
import type { PanelManager } from "./panel-manager";

interface CapturesIpcDeps {
  captureStore: CaptureStore;
  workspaceManager: WorkspaceManager;
  panelManager: PanelManager;
  resolveAppId: (id: string) => string;
}

export function registerCapturesIpc({
  captureStore,
  workspaceManager,
  panelManager,
  resolveAppId,
}: CapturesIpcDeps): void {
  // IPC: Capture store
  ipcMain.handle("captures-stats", () => captureStore.stats());
  ipcMain.handle("captures-list", (_e, offset: number, limit: number) => captureStore.listEntries(offset, limit));
  ipcMain.handle("captures-read", (_e, id: string) => captureStore.readContent(id));
  ipcMain.handle("captures-delete", (_e, id: string) => captureStore.deleteEntry(id));
  ipcMain.handle("captures-delete-source", (_e, source: string) => captureStore.deleteBySource(source));
  ipcMain.handle("captures-clear", () => captureStore.clear());
  ipcMain.handle("captures-search", async (_e, query: string, limit: number) => captureStore.search(query, limit));
  ipcMain.handle("captures-daily-history", (_e, days: number) => captureStore.dailyHistory(days));
  ipcMain.handle("captures-entry-size", (_e, id: string) => captureStore.entrySize(id));
  ipcMain.handle("captures-stats-source", (_e, source: string) => captureStore.statsForSource(source));
  ipcMain.handle("captures-list-source", (_e, source: string, offset: number, limit: number) => captureStore.listEntriesForSource(source, offset, limit));
  ipcMain.handle("captures-daily-history-source", (_e, source: string, days: number) => captureStore.dailyHistoryForSource(source, days));

  // IPC: Context panel — workspace management
  ipcMain.handle("workspace-get", () => workspaceManager.getActiveSlug());
  ipcMain.handle("workspace-set", (_e, name: string) => {
    // Backward-compat with the legacy context-panel UX: any name becomes a
    // workspace. If it doesn't exist yet, auto-create it bound to ~ before
    // switching. Explicit creation from the Workspaces page lets the user
    // pick a real rootDir.
    const slug = String(name || "").trim().toLowerCase();
    if (!slug) return;
    if (!workspaceManager.get(slug)) {
      workspaceManager.create(slug, slug, os.homedir());
    }
    workspaceManager.switch(slug);
  });
  ipcMain.handle("workspace-list", () => captureStore.listWorkspaces());
  // New: full workspace registry with rootDir (for upcoming UI in Phase 6)
  ipcMain.handle("workspaces-registry", () => workspaceManager.list());

  // IPC: Context panel — live feed
  ipcMain.handle("context-recent", (_e, workspace: string, limit: number) => {
    return captureStore.recentByWorkspace(workspace, limit || 50).map(c => ({
      id: c.meta.id,
      source: c.meta.source,
      created: c.meta.created,
      workspace: c.meta.workspace,
      snippet: c.content.slice(0, 500),
    }));
  });

  ipcMain.handle("context-search", async (_e, workspace: string, query: string, limit: number) => {
    const results = await captureStore.searchWorkspace(workspace, query, limit || 20);
    return results.map(r => ({
      id: r.meta.id,
      source: r.meta.source,
      created: r.meta.created,
      workspace: r.meta.workspace,
      snippet: r.content.slice(0, 500),
      score: r.score,
    }));
  });

  ipcMain.handle("context-read", (_e, id: string) => {
    return captureStore.readContent(id) || "";
  });

  // Push live capture updates to any context panel
  captureStore.onCapture((meta) => {
    for (const id of panelManager.getLoadedPanelIds()) {
      if (resolveAppId(id) !== "context") continue;
      const wc = panelManager.getGuestOrWebContents(id);
      if (wc && !wc.isDestroyed()) {
        wc.send("context-update", {
          id: meta.id,
          source: meta.source,
          created: meta.created,
          workspace: meta.workspace,
        });
      }
    }
  });
}
