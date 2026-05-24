/**
 * Vibe IPC — main-process seam for the Vibe panel app (shell).
 *
 * Placeholder registration mirroring registerCouncilsIpc's export shape.
 * Registers a no-op `vibe-ping` handler and provides an example
 * event-forward helper. The real feature plumbing gets built in here later.
 */

import { ipcMain, type WebContents } from "electron";

export interface VibeIpcDeps {
  /** Optional sink the real feature can use to push "vibe-event" frames into the panel. */
  forward?: (event: { kind: string; [key: string]: unknown }) => void;
}

export function registerVibeIpc(deps: VibeIpcDeps = {}): void {
  // Placeholder round-trip — confirms the panel ↔ main bridge is live.
  ipcMain.handle("vibe-ping", () => ({ ok: true, ts: Date.now() }));

  // Example event-forward pattern: the real feature would call this to stream
  // frames into the panel via the "vibe-event" channel (see vibe-preload.onEvent).
  // Kept here as the seam; unused until the feature lands.
  void deps;
}

/** Helper to emit a "vibe-event" frame to a given panel's WebContents. */
export function sendVibeEvent(target: WebContents, event: { kind: string; [key: string]: unknown }): void {
  target.send("vibe-event", event);
}
