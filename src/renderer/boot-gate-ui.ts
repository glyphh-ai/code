/**
 * Boot gate — splash screen, CC bootstrap modal, and first-time tutorial.
 *
 * Extracted from renderer.ts. All DOM queries happen internally; the caller
 * supplies callbacks so the module can drive panel visibility, theme changes,
 * and onboarding without importing renderer internals.
 */

type TabInfo = { id: string; name: string; favicon?: string; layoutFavicons?: string[]; pinned?: boolean; url?: string };

export interface BootGateCallbacks {
  /** Called once the splash dismisses and the app is ready to interact. */
  onBootReady: (data: BootData) => void;
  showPanels: () => void;
  hidePanels: () => void;
  applyTheme: (theme: string) => void;
  showOnboarding: (requiresAuth: boolean) => void;
}

export interface BootData {
  authenticated: boolean;
  status: string;
  tier?: string;
  needsOnboarding: boolean;
  hideWelcome?: boolean;
  theme?: string;
}

// ── Internal state ──────────────────────────────────────────────────────────

const splashShownAt = Date.now();
const SPLASH_MIN_MS = 1800;
let booted = false;
let bootData: BootData | null = null;
let tutorialShowing = false;
let ccModalShowing = false;

/** Expose read-only accessors so renderer can check state if needed. */
export function isBooted(): boolean { return booted; }
export function isTutorialShowing(): boolean { return tutorialShowing; }
export function isCcModalShowing(): boolean { return ccModalShowing; }

// ── Tutorial ────────────────────────────────────────────────────────────────

const TUTORIAL_SEQUENCES = [
  ".yo find that reddit thread about pricing",
  ".sup . formalize",
  ".dip split claude gpt",
  "", // Cmd+. step — no typing, shows keyboard shortcut
];

function showTutorial(cb: BootGateCallbacks): void {
  tutorialShowing = true;
  const overlay = document.getElementById("tutorial-overlay")!;
  overlay.classList.remove("hidden");
  // BrowserViews are native — they paint over HTML. Hide them so tutorial is visible.
  cb.hidePanels();
  let step = 0;
  let typeTimer: ReturnType<typeof setTimeout> | null = null;

  function typeText(stepIdx: number) {
    const el = document.getElementById(`tutorial-typed-${stepIdx}`)!;
    if (!el) return;
    const text = TUTORIAL_SEQUENCES[stepIdx];
    let i = 0;
    el.textContent = "";
    function tick() {
      if (i < text.length) {
        el!.textContent = text.slice(0, i + 1);
        i++;
        typeTimer = setTimeout(tick, 40 + Math.random() * 30);
      }
    }
    typeTimer = setTimeout(tick, 400);
  }

  function goToStep(idx: number) {
    if (typeTimer) clearTimeout(typeTimer);
    step = idx;
    overlay.querySelectorAll(".tutorial-step").forEach((s, i) => {
      s.classList.toggle("active", i === idx);
    });
    overlay.querySelectorAll(".tutorial-nav-dot").forEach((d, i) => {
      d.classList.toggle("active", i === idx);
    });

    // Clear previous typed text
    const typed = document.getElementById(`tutorial-typed-${idx}`);
    if (typed) typed.textContent = "";

    const nextBtn = document.getElementById("tutorial-next") as HTMLButtonElement;
    nextBtn.textContent = idx === TUTORIAL_SEQUENCES.length - 1 ? "Get Started" : "Next";

    typeText(idx);
  }

  document.getElementById("tutorial-next")!.addEventListener("click", () => {
    if (step < TUTORIAL_SEQUENCES.length - 1) {
      goToStep(step + 1);
    } else {
      closeTutorial();
    }
  });

  document.getElementById("tutorial-close")!.addEventListener("click", closeTutorial);

  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTutorial();
  });

  function closeTutorial() {
    if (typeTimer) clearTimeout(typeTimer);
    tutorialShowing = false;
    window.yo.setPreference("hasSeenTutorial", true);
    overlay.classList.add("hidden");
    // Restore panels now that tutorial is dismissed
    cb.showPanels();
  }

  // Start first step
  goToStep(0);
}

// ── CC Bootstrap Modal ──────────────────────────────────────────────────────

async function maybeShowCcBootstrapModal(cb: BootGateCallbacks): Promise<void> {
  const modal = document.getElementById("cc-bootstrap-modal");
  if (!modal) return;
  const status = await window.yo.ccStatus();
  if (status.found) return;

  const errEl = document.getElementById("cc-bootstrap-error")!;
  const bodyEl = document.getElementById("cc-bootstrap-body")!;
  if (!status.claudePath) {
    bodyEl.innerHTML = `Yo's agent loop runs on Claude Code. You don't have <code>claude</code> on your PATH yet — install it first via the <a href="https://docs.claude.com/en/docs/claude-code/quickstart" target="_blank">Claude Code installer</a>, then come back.`;
    (document.getElementById("cc-bootstrap-open") as HTMLButtonElement).disabled = true;
  }

  // BrowserView panels are native and paint over HTML. Hide them while
  // the modal is up, then restore them when CC creds land. The flag also
  // tells dismissSplash() to skip its own panelsShow() if it fires later.
  ccModalShowing = true;
  cb.hidePanels();
  modal.style.display = "flex";

  let pollHandle: number | null = null;
  const cleanupPoll = () => { if (pollHandle) { clearInterval(pollHandle); pollHandle = null; } };

  const dismissModal = () => {
    ccModalShowing = false;
    modal.style.display = "none";
    cb.showPanels();
  };

  const startPolling = () => {
    cleanupPoll();
    let ticks = 0;
    pollHandle = window.setInterval(async () => {
      ticks++;
      const ok = await recheckAndClose(false);
      if (ok || ticks > 150) cleanupPoll(); // 150 * 2s = 5 min
    }, 2000);
  };

  const recheckAndClose = async (showErrIfMissing: boolean) => {
    const s = await window.yo.ccStatus();
    if (s.found) {
      cleanupPoll();
      dismissModal();
      return true;
    }
    if (showErrIfMissing) errEl.textContent = "still not signed in — finish in the login window first";
    return false;
  };

  // Auto-trigger the OAuth window so the user doesn't have to click. The
  // modal stays visible behind it as a status surface (recheck / skip).
  if (status.claudePath) {
    const r = await window.yo.ccLoginOpenTerminal();
    if (!r.ok) {
      errEl.textContent = r.error || "couldn't open the login window — try the button or run `claude /login` in any shell";
    } else {
      startPolling();
    }
  }

  document.getElementById("cc-bootstrap-open")!.onclick = async () => {
    errEl.textContent = "";
    const r = await window.yo.ccLoginOpenTerminal();
    if (!r.ok) {
      errEl.textContent = r.error || "couldn't open the login window — run `claude /login` manually in any shell";
      return;
    }
    startPolling();
  };

  document.getElementById("cc-bootstrap-recheck")!.onclick = async () => {
    errEl.textContent = "";
    await recheckAndClose(true);
  };

  document.getElementById("cc-bootstrap-quit")!.onclick = () => {
    window.yo.windowClose();
  };
}

// ── Splash dismiss ──────────────────────────────────────────────────────────

function dismissSplash(cb: BootGateCallbacks): void {
  if (!booted) return;
  const elapsed = Date.now() - splashShownAt;
  const remaining = Math.max(0, SPLASH_MIN_MS - elapsed);
  setTimeout(() => {
    // Show panels first (behind splash z-index:9999) so they're ready when splash fades
    // BUT not if tutorial or CC bootstrap modal is showing — BrowserViews paint over HTML overlays
    if (!tutorialShowing && !ccModalShowing) cb.showPanels();
    const splash = document.getElementById("splash");
    if (splash) {
      splash.classList.add("fade-out");
      setTimeout(() => splash.remove(), 600);
    }
  }, remaining);
  if (bootData?.needsOnboarding) {
    cb.showOnboarding(!bootData.authenticated);
  }
}

// ── Public init ─────────────────────────────────────────────────────────────

/**
 * Wire up all boot-gate IPC listeners and kick off the splash / tutorial /
 * CC-bootstrap flow. Call once from renderer.ts at module scope.
 */
export function initBootGate(cb: BootGateCallbacks): void {
  // Config sync status during boot
  (window as any).yo.onSplashStatus?.((msg: string) => {
    const el = document.getElementById("splash-status");
    if (el) {
      el.textContent = msg;
      if (msg === "ready") el.classList.add("done");
      else el.classList.remove("done");
    }
  });

  window.yo.onBoot((data: BootData) => {
    booted = true;
    bootData = data;
    if (data.theme) {
      cb.applyTheme(data.theme);
    }
    dismissSplash(cb);

    // Show tutorial on first launch (skip if going through onboarding — handled by yo-onboarding-done)
    if (!data.needsOnboarding) {
      window.yo.getPreference("hasSeenTutorial", false).then((seen) => {
        if (!seen) showTutorial(cb);
      });
    }

    // CC bootstrap (Phase 2 of THE-PIVOT-BYOK): nudge the user to log in to
    // Claude Code if they haven't yet. Skip during onboarding — we don't want
    // to layer two modals.
    if (!data.needsOnboarding) {
      setTimeout(() => { void maybeShowCcBootstrapModal(cb); }, 1200);
    }

    cb.onBootReady(data);
  });

  window.yo.onThemeChanged((theme: string) => {
    cb.applyTheme(theme);
  });

  window.yo.onShowOnboarding(() => {
    cb.showOnboarding(true);
  });

  // Triggered by main when an agent call hits ensureCcAuth() with no creds.
  window.yo.onCcShowModal(() => {
    void maybeShowCcBootstrapModal(cb);
  });

  // After onboarding activation, show tutorial (first time only) or restore panels
  window.addEventListener("yo-onboarding-done", async () => {
    const seen = await window.yo.getPreference("hasSeenTutorial", false);
    if (!seen) {
      showTutorial(cb);
    } else {
      cb.showPanels();
    }
    // Prompt for Claude Code login if creds are still missing — onBoot skipped
    // this when needsOnboarding was true, so it has to fire here instead.
    setTimeout(() => { void maybeShowCcBootstrapModal(cb); }, 1200);
  });
}
