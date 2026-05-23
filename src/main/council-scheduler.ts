/**
 * CouncilScheduler — registers saved councils that carry a cron `schedule`.
 *
 * Walks ~/yo/councils/<id>.json for templates with a `schedule:` set and runs
 * them headlessly via runCouncilFromTemplate, persisting each run to history.
 * Mirrors SkillScheduler. v1: only runs while the app is open.
 */

import cron, { ScheduledTask } from "node-cron";
import { listCouncils } from "./council-store";
import { runCouncilFromTemplate } from "./council-session";

const SHORTHAND: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

function expandShorthand(expr: string): string {
  return SHORTHAND[expr.trim()] || expr.trim();
}

export class CouncilScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();

  /** (Re)register every saved council that has a schedule. */
  refresh(): void {
    const councils = listCouncils();
    const seen = new Set<string>();
    for (const c of councils) {
      if (!c.schedule) continue;
      const cronExpr = expandShorthand(c.schedule);
      if (!cron.validate(cronExpr)) {
        console.warn(`[council-scheduler] invalid cron for "${c.id}": ${cronExpr}`);
        continue;
      }
      seen.add(c.id);
      const existing = this.tasks.get(c.id);
      if (existing) { existing.stop(); this.tasks.delete(c.id); }

      const task = cron.schedule(cronExpr, () => {
        // Re-read the template at fire time so edits/pause are respected.
        const tpl = listCouncils().find((t) => t.id === c.id);
        if (!tpl || tpl.paused || !tpl.schedule) return;
        runCouncilFromTemplate(tpl, "schedule").catch((err) => {
          console.error(`[council-scheduler] council "${c.id}" failed:`, err);
        });
      });
      this.tasks.set(c.id, task);
    }
    // Drop councils that no longer have a schedule.
    for (const [id, task] of this.tasks) {
      if (!seen.has(id)) { task.stop(); this.tasks.delete(id); }
    }
  }

  start(): void { this.refresh(); }

  stop(): void {
    for (const task of this.tasks.values()) task.stop();
    this.tasks.clear();
  }

  /** Registered councils + paused state (paused lives on the template). */
  status(): Array<{ id: string; schedule: string; paused: boolean }> {
    const councils = listCouncils();
    const out: Array<{ id: string; schedule: string; paused: boolean }> = [];
    for (const id of this.tasks.keys()) {
      const c = councils.find((t) => t.id === id);
      out.push({ id, schedule: c?.schedule || "", paused: !!c?.paused });
    }
    return out;
  }
}
