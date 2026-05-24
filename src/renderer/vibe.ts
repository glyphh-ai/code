/**
 * Vibe — standalone panel app (shell).
 *
 * Placeholder renderer entry. Mirrors the council panel's structure but
 * carries no real logic yet: it just wires the exposed `window.vibe` API
 * and renders the static "Coming soon" shell defined in vibe.html.
 * Real UI + behavior get built in here later.
 */

interface VibeEvent {
  kind: string;
  [key: string]: unknown;
}

interface VibeAPI {
  ping: () => Promise<unknown>;
  onEvent: (cb: (event: VibeEvent) => void) => () => void;
  getTheme: () => Promise<string>;
  onThemeChanged: (cb: (theme: string) => void) => () => void;
}

const vibe = (window as unknown as { vibe: VibeAPI }).vibe;

function init(): void {
  // Subscribe to forwarded events from main (placeholder — no UI reaction yet).
  if (vibe && vibe.onEvent) {
    vibe.onEvent((event) => {
      console.log("[vibe] event", event);
    });
  }
  console.log("[vibe] ready");
}

init();
