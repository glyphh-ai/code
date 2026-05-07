/**
 * UsageTracker — local token-usage aggregation by agent and day.
 *
 * Persists to ~/yo/.usage (JSON). After Phase 7 of THE-PIVOT-BYOK,
 * yo-server no longer exposes /api/usage/summary, so the dashboard
 * pulls from this local file.
 *
 * Schema is input/output token counts (no yos). Old records on disk
 * with the legacy yos shape are loaded best-effort and migrated on
 * first read — `yos` is dropped, calls preserved, input/output start
 * at 0 from that point on.
 */

import fs from "fs";
import path from "path";
import os from "os";

const USAGE_FILE = path.join(os.homedir(), "yo", ".usage");

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

interface AgentUsage {
  input: number;
  output: number;
  calls: number;
}

interface DayEntry {
  date: string;
  agents: Record<string, AgentUsage>;
  total: AgentUsage;
}

interface UsageData {
  days: DayEntry[];
}

function emptyAgentUsage(): AgentUsage {
  return { input: 0, output: 0, calls: 0 };
}

/** Singleton usage tracker. */
class UsageTrackerImpl {
  private data: UsageData = { days: [] };
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
  }

  /** Record a completed LLM call for a given agent. */
  record(agent: string, usage: TokenUsage): void {
    const today = this.todayKey();
    let day = this.data.days.find((d) => d.date === today);
    if (!day) {
      day = { date: today, agents: {}, total: emptyAgentUsage() };
      this.data.days.push(day);
      if (this.data.days.length > 90) {
        this.data.days = this.data.days.slice(-90);
      }
    }

    if (!day.agents[agent]) {
      day.agents[agent] = emptyAgentUsage();
    }

    day.agents[agent].input += usage.inputTokens || 0;
    day.agents[agent].output += usage.outputTokens || 0;
    day.agents[agent].calls += 1;

    day.total.input += usage.inputTokens || 0;
    day.total.output += usage.outputTokens || 0;
    day.total.calls += 1;

    this.scheduleSave();
  }

  /** Get today's usage summary. */
  getToday(): DayEntry | null {
    return this.data.days.find((d) => d.date === this.todayKey()) || null;
  }

  /** Get usage for last N days. */
  getHistory(days: number = 30): DayEntry[] {
    return this.data.days.slice(-days);
  }

  /** Get all-time totals. */
  getAllTime(): { agents: Record<string, AgentUsage>; total: AgentUsage } {
    const agents: Record<string, AgentUsage> = {};
    const total = emptyAgentUsage();

    for (const day of this.data.days) {
      for (const [agent, usage] of Object.entries(day.agents)) {
        if (!agents[agent]) agents[agent] = emptyAgentUsage();
        agents[agent].input += usage.input;
        agents[agent].output += usage.output;
        agents[agent].calls += usage.calls;
      }
      total.input += day.total.input;
      total.output += day.total.output;
      total.calls += day.total.calls;
    }

    return { agents, total };
  }

  /** Force-save to disk. */
  flush(): void {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
      fs.writeFileSync(USAGE_FILE, JSON.stringify(this.data), "utf-8");
      this.dirty = false;
    } catch { /* best-effort */ }
  }

  private load(): void {
    try {
      if (!fs.existsSync(USAGE_FILE)) return;
      const raw = JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8")) as { days?: Array<Record<string, unknown>> };
      if (!Array.isArray(raw.days)) return;
      // Migrate any legacy {yos, calls} agent rows to {input, output, calls}.
      // We can't recover the input/output split that wasn't recorded, so
      // legacy rows reset their token totals; calls survive for histograms.
      this.data.days = raw.days.map((d) => migrateDay(d));
    } catch {
      this.data = { days: [] };
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 5000);
  }

  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }
}

function migrateDay(d: Record<string, unknown>): DayEntry {
  const date = String(d.date || "");
  const agentsIn = (d.agents as Record<string, Record<string, number>>) || {};
  const totalIn = (d.total as Record<string, number>) || {};
  const agents: Record<string, AgentUsage> = {};
  for (const [name, u] of Object.entries(agentsIn)) {
    agents[name] = {
      input: typeof u.input === "number" ? u.input : 0,
      output: typeof u.output === "number" ? u.output : 0,
      calls: typeof u.calls === "number" ? u.calls : 0,
    };
  }
  const total: AgentUsage = {
    input: typeof totalIn.input === "number" ? totalIn.input : 0,
    output: typeof totalIn.output === "number" ? totalIn.output : 0,
    calls: typeof totalIn.calls === "number" ? totalIn.calls : 0,
  };
  return { date, agents, total };
}

export const usageTracker = new UsageTrackerImpl();
