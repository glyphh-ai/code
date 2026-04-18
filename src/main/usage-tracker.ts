/**
 * UsageTracker — token usage aggregation by agent and day.
 *
 * Persists daily usage stats to ~/yo/.usage (JSON).
 * Tracks input/output tokens per agent per day.
 */

import fs from "fs";
import path from "path";
import os from "os";

const USAGE_FILE = path.join(os.homedir(), "yo", ".usage");

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreation?: number;
  cacheRead?: number;
}

interface AgentUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
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
      day = { date: today, agents: {}, total: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, calls: 0 } };
      this.data.days.push(day);
      // Keep max 90 days
      if (this.data.days.length > 90) {
        this.data.days = this.data.days.slice(-90);
      }
    }

    if (!day.agents[agent]) {
      day.agents[agent] = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, calls: 0 };
    }

    day.agents[agent].input += usage.inputTokens;
    day.agents[agent].output += usage.outputTokens;
    day.agents[agent].cacheCreation += usage.cacheCreation || 0;
    day.agents[agent].cacheRead += usage.cacheRead || 0;
    day.agents[agent].calls += 1;

    day.total.input += usage.inputTokens;
    day.total.output += usage.outputTokens;
    day.total.cacheCreation += usage.cacheCreation || 0;
    day.total.cacheRead += usage.cacheRead || 0;
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
    const total: AgentUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, calls: 0 };

    for (const day of this.data.days) {
      for (const [agent, usage] of Object.entries(day.agents)) {
        if (!agents[agent]) agents[agent] = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, calls: 0 };
        agents[agent].input += usage.input;
        agents[agent].output += usage.output;
        agents[agent].cacheCreation += usage.cacheCreation || 0;
        agents[agent].cacheRead += usage.cacheRead || 0;
        agents[agent].calls += usage.calls;
      }
      total.input += day.total.input;
      total.output += day.total.output;
      total.cacheCreation += day.total.cacheCreation || 0;
      total.cacheRead += day.total.cacheRead || 0;
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
      if (fs.existsSync(USAGE_FILE)) {
        this.data = JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8"));
      }
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

export const usageTracker = new UsageTrackerImpl();
