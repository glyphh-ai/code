/**
 * Schedules IPC — standalone prompt schedules (schedule-store + scheduler).
 * Decoupled from skills: a schedule runs a prompt through the agent.
 */

import { ipcMain } from "electron";
import { listSchedules, getSchedule, saveSchedule, removeSchedule, type Schedule } from "./schedule-store";
import { ScheduleScheduler, type ScheduleRunner } from "./schedule-scheduler";

export interface SchedulesIpcDeps {
  runForResult: (prompt: string) => Promise<{ text: string; error?: string }>;
  saveRunChat: (opts: { skillName: string; trigger: string; output?: unknown; error?: string; startedAt: number; instructions?: string }) => string;
  deleteRunsForSkill: (name: string) => number;
}

export function registerSchedulesIpc(deps: SchedulesIpcDeps): ScheduleScheduler {
  const runner: ScheduleRunner = {
    run: async (id, trigger) => {
      const s = getSchedule(id);
      if (!s) return;
      const startedAt = Date.now();
      const r = await deps.runForResult(s.prompt).catch((e) => ({ text: "", error: e?.message || String(e) }));
      deps.saveRunChat({ skillName: s.name, trigger, output: r.text, error: r.error, startedAt, instructions: s.prompt });
    },
  };
  const scheduler = new ScheduleScheduler(runner);

  ipcMain.handle("schedules-list", () => listSchedules());
  ipcMain.handle("schedules-get", (_e, id: string) => getSchedule(id));
  ipcMain.handle("schedules-save", (_e, cfg: Schedule) => {
    const saved = saveSchedule(cfg);
    scheduler.refresh();
    return saved;
  });
  ipcMain.handle("schedules-delete", (_e, id: string) => {
    const s = getSchedule(id);
    const ok = removeSchedule(id);
    if (s) deps.deleteRunsForSkill(s.name);   // also clears its run history
    scheduler.refresh();
    return ok;
  });
  ipcMain.handle("schedules-run", (_e, id: string) => runner.run(id, "manual"));
  ipcMain.handle("schedules-pause", (_e, id: string) => {
    const s = getSchedule(id);
    if (s) { saveSchedule({ ...s, paused: true }); scheduler.refresh(); }
  });
  ipcMain.handle("schedules-resume", (_e, id: string) => {
    const s = getSchedule(id);
    if (s) { saveSchedule({ ...s, paused: false }); scheduler.refresh(); }
  });
  // Remove an orphaned/legacy task that only exists as run history (by name).
  ipcMain.handle("schedules-delete-runs", (_e, name: string) => deps.deleteRunsForSkill(name));

  scheduler.start();
  return scheduler;
}
