/**
 * Config Sync — hot config updates from yo-server.
 *
 * Periodically checks for updated firewall patterns.
 * Caches in ~/yo/.config-cache/.
 */

import fs from "fs";
import path from "path";
import os from "os";

const CONFIG_CACHE_DIR = path.join(os.homedir(), "yo", ".config-cache");
const MANIFEST_PATH = path.join(CONFIG_CACHE_DIR, "manifest.json");
const SERVER_BASE = process.env.YO_AUTH_SERVER || "https://api.dotyo.dev";
const CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes

interface ConfigVersion {
  version: string;
  updatedAt: string;
}

interface ConfigManifest {
  firewall: ConfigVersion;
}

export class ConfigSync {
  private timer: ReturnType<typeof setInterval> | null = null;
  private onUpdate: (() => void) | null = null;

  constructor() {
    fs.mkdirSync(CONFIG_CACHE_DIR, { recursive: true });
  }

  /** Fetch all configs with a timeout so boot is never blocked. */
  async fetchAll(onProgress?: (msg: string) => void): Promise<boolean> {
    try {
      onProgress?.("syncing...");
      const res = await fetch(`${SERVER_BASE}/api/config/manifest`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return false;
      const remote: ConfigManifest = await res.json() as ConfigManifest;

      let local: ConfigManifest | null = null;
      try { local = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")); } catch { /* first run */ }

      const localVersion = local?.firewall?.version;
      if (localVersion !== remote.firewall.version) {
        onProgress?.("updating firewall...");
        await this.download("firewall");
      }

      fs.writeFileSync(MANIFEST_PATH, JSON.stringify(remote, null, 2), "utf-8");
      onProgress?.("ready");
      return true;
    } catch (err: unknown) {
      console.error("[config-sync] fetchAll failed:", err instanceof Error ? err.message : err);
      return false;
    }
  }

  /** Start periodic checks. Also checks immediately. */
  start(onUpdate?: () => void): void {
    this.onUpdate = onUpdate || null;
    this.check().catch((err) => console.error("[config-sync]", err.message));
    this.timer = setInterval(() => {
      this.check().catch((err) => console.error("[config-sync]", err.message));
    }, CHECK_INTERVAL);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Load a cached config by name, or null if not cached. */
  static load<T>(name: string): T | null {
    const p = path.join(CONFIG_CACHE_DIR, `${name}.json`);
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
  }

  private async check(): Promise<void> {
    const res = await fetch(`${SERVER_BASE}/api/config/manifest`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const remote: ConfigManifest = await res.json() as ConfigManifest;

    // Load local manifest
    let local: ConfigManifest | null = null;
    try {
      local = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
    } catch {
      /* first run */
    }

    const localVersion = local?.firewall?.version;
    const remoteVersion = remote.firewall.version;
    const updated = localVersion !== remoteVersion;

    if (updated) {
      await this.download("firewall");
    }

    // Save manifest
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(remote, null, 2), "utf-8");

    if (updated && this.onUpdate) this.onUpdate();
  }

  private async download(name: string): Promise<void> {
    const res = await fetch(`${SERVER_BASE}/api/config/${name}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const data = await res.json() as Record<string, unknown>;
    fs.writeFileSync(
      path.join(CONFIG_CACHE_DIR, `${name}.json`),
      JSON.stringify(data, null, 2),
      "utf-8",
    );
    console.log(`[config-sync] updated ${name} to v${data.version}`);
  }
}
