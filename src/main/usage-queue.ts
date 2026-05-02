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
const API_URL = process.env.YO_AUTH_SERVER || "https://api.yosup.dev";

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

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

    try {
      if (!fs.existsSync(QUEUE_FILE)) return;
      const raw = fs.readFileSync(QUEUE_FILE, "utf-8").trim();
      if (!raw) return;

      const lines = raw.split("\n");
      const records: UsageRecord[] = [];
      for (const line of lines) {
        try {
          records.push(JSON.parse(line));
        } catch {
          // Skip malformed lines (e.g. partial write from crash)
        }
      }

      if (records.length === 0) {
        // All lines were malformed — clear the file
        fs.writeFileSync(QUEUE_FILE, "", "utf-8");
        return;
      }

      const token = this.getToken?.();
      if (!token) return; // Can't push without auth — leave in queue

      const ok = await this.pushBatch(records, token);
      if (ok) {
        // Atomic clear: write empty to temp, rename over original
        const tmp = QUEUE_FILE + ".tmp";
        fs.writeFileSync(tmp, "", "utf-8");
        fs.renameSync(tmp, QUEUE_FILE);
      }
    } catch {
      // Network/disk error — records stay in queue for next cycle
    } finally {
      this.flushing = false;
    }
  }

  private async pushBatch(records: UsageRecord[], token: string): Promise<boolean> {
    try {
      const { net } = await import("electron");

      return new Promise<boolean>((resolve) => {
        const req = net.request({
          method: "POST",
          url: `${API_URL}/api/usage/batch`,
        });
        req.setHeader("Content-Type", "application/json");
        req.setHeader("Authorization", `Bearer ${token}`);

        let body = "";
        req.on("response", (res) => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          res.on("data", (chunk) => { body += chunk.toString(); });
          res.on("end", () => {
            if (ok) {
              try {
                const parsed = JSON.parse(body);
                if (typeof parsed.balance === "number") {
                  this._lastBalance = parsed.balance;
                }
              } catch { /* ignore parse errors */ }
            }
            resolve(ok);
          });
        });

        req.on("error", () => resolve(false));
        req.write(JSON.stringify({ records }));
        req.end();
      });
    } catch {
      return false;
    }
  }
}

export const usageQueue = new UsageQueueImpl();
