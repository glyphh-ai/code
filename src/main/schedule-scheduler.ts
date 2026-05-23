/**
 * ScheduleScheduler — cron-runs standalone prompt schedules (schedule-store).
 * Mirrors SkillScheduler but executes a prompt through the agent rather than a
 * skill. v1: only runs while the app is open.
 */

import cron, { ScheduledTask } from "node-cron";
import { listSchedules, getSchedule } from "./schedule-store";

const SHORTHAND: Record<string, string> = {
  "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *",
};
const expand = (e: string) => SHORTHAND[e.trim()] || e.trim();

export interface ScheduleRunner {
  /** Run a schedule's prompt now (and persist a run). */
  run: (scheduleId: string, trigger: "schedule" | "manual") => Promise<void>;
}

export class ScheduleScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  constructor(private runner: ScheduleRunner) {}

  refresh(): void {
    const seen = new Set<string>();
    for (const s of listSchedules()) {
      if (!s.cron) continue;
      const expr = expand(s.cron);
      if (!cron.validate(expr)) { console.warn(`[schedule] invalid cron "${s.id}": ${expr}`); continue; }
      seen.add(s.id);
      this.tasks.get(s.id)?.stop();
      const task = cron.schedule(expr, () => {
        const cur = getSchedule(s.id);
        if (!cur || cur.paused || !cur.cron) return;
        this.runner.run(s.id, "schedule").catch((err) => console.error(`[schedule] "${s.id}" failed:`, err));
      });
      this.tasks.set(s.id, task);
    }
    for (const [id, task] of this.tasks) {
      if (!seen.has(id)) { task.stop(); this.tasks.delete(id); }
    }
  }

  start(): void { this.refresh(); }
  stop(): void { for (const t of this.tasks.values()) t.stop(); this.tasks.clear(); }

  status(): Array<{ id: string; cron: string; paused: boolean }> {
    return listSchedules().filter((s) => s.cron).map((s) => ({ id: s.id, cron: s.cron, paused: !!s.paused }));
  }
}
