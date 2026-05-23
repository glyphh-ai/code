/**
 * Councils IPC — saved council templates, run history, and scheduling.
 * Mirrors the skills/schedules IPC surface.
 */

import { ipcMain } from "electron";
import {
  listCouncils, getCouncilTemplate, saveCouncil, removeCouncil, slugify,
  listRuns, getRun, type CouncilTemplate,
} from "./council-store";
import { runCouncilFromTemplate } from "./council-session";
import { CouncilScheduler } from "./council-scheduler";

export interface CouncilsIpcDeps {
  scheduler: CouncilScheduler;
  /** Open the Council app and run a saved council live so the user can watch. */
  runLive: (tpl: CouncilTemplate) => Promise<string>;
}

export function registerCouncilsIpc(deps: CouncilsIpcDeps): void {
  const { scheduler, runLive } = deps;

  ipcMain.handle("councils-list", () => listCouncils());
  ipcMain.handle("councils-get", (_e, id: string) => getCouncilTemplate(id));

  ipcMain.handle("councils-save", (_e, cfg: CouncilTemplate) => {
    const id = cfg.id && /^[a-z0-9][a-z0-9_-]*$/i.test(cfg.id) ? cfg.id : slugify(cfg.name || "");
    const saved = saveCouncil({ ...cfg, id });
    scheduler.refresh();
    return saved;
  });

  ipcMain.handle("councils-delete", (_e, id: string) => {
    const ok = removeCouncil(id);
    scheduler.refresh();
    return ok;
  });

  // Pause/resume just toggles the template flag (the scheduler reads it at fire time).
  ipcMain.handle("councils-pause-schedule", (_e, id: string) => {
    const tpl = getCouncilTemplate(id);
    if (tpl) { saveCouncil({ ...tpl, paused: true }); scheduler.refresh(); }
  });
  ipcMain.handle("councils-resume-schedule", (_e, id: string) => {
    const tpl = getCouncilTemplate(id);
    if (tpl) { saveCouncil({ ...tpl, paused: false }); scheduler.refresh(); }
  });
  ipcMain.handle("councils-schedule-status", () => scheduler.status());

  // Run history
  ipcMain.handle("councils-runs", (_e, id: string) => listRuns(id));
  ipcMain.handle("councils-run-get", (_e, id: string, runId: string) => getRun(id, runId));

  // Run now: "live" opens the Council app and streams; otherwise headless.
  ipcMain.handle("councils-run", async (_e, id: string, live?: boolean) => {
    const tpl = getCouncilTemplate(id);
    if (!tpl) return { ok: false, error: "council not found" };
    if (live) {
      const msg = await runLive(tpl);
      return { ok: true, message: msg };
    }
    return runCouncilFromTemplate(tpl, "manual");
  });
}
