/**
 * SkillScheduler — registers skills with cron schedules.
 *
 * Walks ~/yo/skills/<name>/SKILL.md for any with frontmatter `schedule:` set,
 * registers them with node-cron. On file changes, re-registers.
 *
 * v1: only runs while the app is open (no persistent daemon).
 */

import cron, { ScheduledTask } from "node-cron";
import fs from "fs";
import path from "path";
import { SkillEngine } from "./skill-engine";

// Cron shorthand mappings (node-cron supports these but not consistently)
const SHORTHAND: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

function expandShorthand(expr: string): string {
  return SHORTHAND[expr.trim()] || expr.trim();
}

export class SkillScheduler {
  private tasks: Map<string, ScheduledTask> = new Map();
  private paused: Set<string> = new Set();
  private watcher: fs.FSWatcher | null = null;

  constructor(private engine: SkillEngine) {}

  /** Register all skills with `schedule:` set. Called on boot and after file changes. */
  start(): void {
    this.refresh();
    // Watch the skills directory for changes (adds/edits/deletes)
    try {
      this.watcher = fs.watch(this.engine.getSkillsDir(), { recursive: true }, () => {
        // Debounce via setTimeout
        setTimeout(() => this.refresh(), 500);
      });
    } catch {
      // Some platforms don't support recursive watch — fall back to polling
    }
  }

  stop(): void {
    for (const task of this.tasks.values()) task.stop();
    this.tasks.clear();
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  refresh(): void {
    const skills = this.engine.listSkills();
    const seen = new Set<string>();
    for (const name of skills) {
      const skill = this.engine.getSkill(name);
      if (!skill?.manifest.schedule) continue;
      seen.add(name);

      const expr = expandShorthand(skill.manifest.schedule);
      // If already scheduled with same expression, skip
      const existing = this.tasks.get(name);
      if (existing) {
        // Re-registration: stop old and re-create (handles expression changes)
        existing.stop();
        this.tasks.delete(name);
      }

      if (!cron.validate(expr)) {
        console.warn(`[scheduler] invalid cron for skill "${name}": ${expr}`);
        continue;
      }

      const task = cron.schedule(expr, () => {
        if (this.paused.has(name)) return;
        this.engine.process("", name).catch((err) => {
          console.error(`[scheduler] skill "${name}" failed:`, err);
        });
      });
      this.tasks.set(name, task);
    }

    // Remove schedules for skills that no longer have `schedule:`
    for (const [name, task] of this.tasks) {
      if (!seen.has(name)) {
        task.stop();
        this.tasks.delete(name);
      }
    }
  }

  pause(name: string): void { this.paused.add(name); }
  resume(name: string): void { this.paused.delete(name); }
  isPaused(name: string): boolean { return this.paused.has(name); }

  /** Return which skills are currently registered + paused state. */
  status(): Array<{ name: string; schedule: string; paused: boolean }> {
    const out: Array<{ name: string; schedule: string; paused: boolean }> = [];
    for (const name of this.tasks.keys()) {
      const skill = this.engine.getSkill(name);
      out.push({
        name,
        schedule: skill?.manifest.schedule ?? "",
        paused: this.paused.has(name),
      });
    }
    return out;
  }
}
