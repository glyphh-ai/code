/**
 * Auth bootstrap — BYOK Anthropic API key only.
 *
 * The earlier Claude Code OAuth path (spawning `claude /login` and reading
 * the resulting credentials from disk or the OS keychain) was removed
 * because hosting that flow in our own app violates Anthropic's Terms of
 * Service. Users now bring their own Anthropic API key, pasted into the
 * boot-gate modal and stored encrypted under ~/yo/.providers.json via the
 * provider-keys module.
 *
 * Surface (kept for back-compat with existing call sites):
 *   • bootstrapStatus() — { found, byokAnthropic } reflecting BYOK key
 *   • ensureCcAuth()    — true iff a BYOK Anthropic key is set; else
 *                         the renderer's `cc-show-modal` IPC fires and
 *                         the modal prompts the user to paste a key
 */

import { BrowserWindow } from "electron";
import { hasKey as hasProviderKey } from "./provider-keys";

export interface BootstrapStatus {
  /** True when an Anthropic API key is configured. The renderer treats
   *  this as "logged in"; the agent passes the key as ANTHROPIC_API_KEY
   *  to the SDK so api.anthropic.com calls succeed. */
  found: boolean;
  /** Always true here — semantic marker preserved for the renderer modal
   *  which now exists solely to collect a BYOK key. */
  byokAnthropic: boolean;
}

export function bootstrapStatus(): BootstrapStatus {
  let byok = false;
  try { byok = hasProviderKey("anthropic"); } catch { /* */ }
  return { found: byok, byokAnthropic: byok };
}

/** Returns true when an Anthropic API key is configured. Otherwise tells
 *  the renderer to show the gating modal and returns false. */
export function ensureCcAuth(): boolean {
  if (bootstrapStatus().found) return true;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("cc-show-modal");
  }
  return false;
}
