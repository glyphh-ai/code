/**
 * UsageQueue — durable write-ahead queue for usage reporting.
 *
 * Every usage event is written to disk synchronously BEFORE the LLM
 * response is delivered to the UI. A background loop flushes queued
 * records to the server. Survives shutdowns, reboots, network failures.
 *
 * File format: newline-delimited JSON (~/.yo/.usage-queue)
 */

import fs from "fs";
import path from "path";
import os from "os";

const QUEUE_FILE = path.join(os.homedir(), "yo", ".usage-queue");
const QUEUE_DIR = path.dirname(QUEUE_FILE);
const FLUSH_INTERVAL_MS = 30_000;

interface UsageRecord {
  inputTokens: number;
  outputTokens: number;
  model: string;
  yosConsumed: number;
  agent: string;
  ts: number;
}

class UsageQueueImpl {
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private getToken: (() => string | null) | null = null;
  private _lastBalance: number | null = null;

  get lastBalance(): number | null { return this._lastBalance; }

  updateBalance(balance: number): void {
    this._lastBalance = balance;
  }

  setTokenGetter(fn: () => string | null): void {
    this.getToken = fn;
  }

  /**
   * Append a usage record to disk. Synchronous — guarantees durability
   * before returning. Call this BEFORE delivering the response to the UI.
   */
  enqueue(record: Omit<UsageRecord, "ts">): void {
    const entry: UsageRecord = { ...record, ts: Date.now() };
    const line = JSON.stringify(entry) + "\n";

    try {
      fs.mkdirSync(QUEUE_DIR, { recursive: true });
      // Atomic-ish append: O_APPEND ensures no corruption from concurrent writes
      fs.appendFileSync(QUEUE_FILE, line, "utf-8");
    } catch {
      // Last resort: log it so at least there's a trace
      console.error("[usage-queue] failed to write to disk:", entry);
    }
  }

  /** Start the background flush loop. Call once on app startup. */
  start(): void {
    if (this.flushTimer) return;
    // Drain any backlog from previous session immediately
    this.flush();
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  /** Stop the flush loop. Call on app quit. Attempt one final flush. */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  /** How many records are pending delivery. */
  pending(): number {
    try {
      if (!fs.existsSync(QUEUE_FILE)) return 0;
      const raw = fs.readFileSync(QUEUE_FILE, "utf-8").trim();
      if (!raw) return 0;
      return raw.split("\n").length;
    } catch {
      return 0;
    }
  }

  /**
   * Phase 7 of THE-PIVOT-BYOK: yo-server's /api/usage/batch is gone.
   * Drain the local queue without posting — users see their real usage on
   * the provider's own dashboard (Anthropic / OpenAI / etc.).
   */
  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      if (fs.existsSync(QUEUE_FILE)) fs.writeFileSync(QUEUE_FILE, "", "utf-8");
    } catch { /* ignore */ }
    this.flushing = false;
  }
}

export const usageQueue = new UsageQueueImpl();
