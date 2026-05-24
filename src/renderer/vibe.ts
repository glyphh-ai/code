/**
 * Vibe — 3-region coding workspace renderer (Phase 1).
 *
 * Region 1 "Agent": an xterm.js terminal bound to a Claude Code PTY in main
 *   (reuses the terminal:data/write/resize IPC, keyed by this panel's wc.id).
 * Region 2 "Plan": a textarea editing ~/yo/vibes/scratch/plan.md (debounced save).
 * Region 3 "Preview": a <webview> pointed at the vibe's dev server.
 *
 * Single agent, single scratch working dir — the per-project registry is a
 * later phase.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

interface VibeAPI {
  // PTY (Claude Code agent) — reuses terminal:* channels keyed by wc.id.
  termWrite: (data: string) => void;
  termResize: (cols: number, rows: number) => void;
  onTermData: (cb: (data: string) => void) => void;
  ready: () => void;
  // Plan file
  planRead: () => Promise<string>;
  planWrite: (text: string) => void;
  // Theme
  getTheme?: () => Promise<string>;
  onThemeChanged?: (cb: (theme: string) => void) => () => void;
}

const vibe = (window as unknown as { vibe: VibeAPI }).vibe;

// ── Region 1: Agent terminal ──────────────────────────────
function initTerminal(): void {
  const container = document.getElementById("vibe-term");
  if (!container) return;

  const term = new Terminal({
    fontSize: 13,
    fontFamily: '"SF Mono", "Menlo", "Monaco", "Courier New", monospace',
    theme: {
      background: "#0d0d14",
      foreground: "#e0e0e0",
      cursor: "#25C75E",
      cursorAccent: "#0d0d14",
      selectionBackground: "rgba(37, 199, 94, 0.3)",
      black: "#121f16",
      red: "#ff6b6b",
      green: "#51cf66",
      yellow: "#ffd43b",
      blue: "#74c0fc",
      magenta: "#cc5de8",
      cyan: "#66d9e8",
      white: "#e0e0e0",
      brightBlack: "#4a4a6a",
      brightRed: "#ff8787",
      brightGreen: "#69db7c",
      brightYellow: "#ffe066",
      brightBlue: "#91d5ff",
      brightMagenta: "#da77f2",
      brightCyan: "#99e9f2",
      brightWhite: "#ffffff",
    },
    cursorBlink: true,
    cursorStyle: "bar",
    scrollback: 10000,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  // Forward user input to the PTY; render PTY output back.
  term.onData((d) => vibe.termWrite(d));
  vibe.onTermData((d) => term.write(d));

  let spawned = false;
  const fitAndResize = () => {
    try { fitAddon.fit(); } catch { /* container not laid out yet */ }
    vibe.termResize(term.cols, term.rows);
  };

  // First fit reports real cols/rows to main; main waits for that resize
  // before spawning the claude PTY (so the TUI sizes correctly). We signal
  // ready() right after the first resize so the agent spawns at the right size.
  requestAnimationFrame(() => {
    fitAndResize();
    if (!spawned) {
      spawned = true;
      vibe.ready();
    }
  });

  window.addEventListener("resize", fitAndResize);
}

// ── Region 2: Plan editor ─────────────────────────────────
function initPlan(): void {
  const textarea = document.getElementById("vibe-plan") as HTMLTextAreaElement | null;
  const saved = document.getElementById("vibe-plan-saved");
  if (!textarea) return;

  vibe.planRead().then((text) => { textarea.value = text || ""; }).catch(() => {});

  let timer: ReturnType<typeof setTimeout> | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  textarea.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      vibe.planWrite(textarea.value);
      if (saved) {
        saved.classList.add("show");
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => saved.classList.remove("show"), 1200);
      }
    }, 400);
  });
}

// ── Region 3: Preview webview ─────────────────────────────
function initPreview(): void {
  const urlInput = document.getElementById("vibe-url") as HTMLInputElement | null;
  const reloadBtn = document.getElementById("vibe-reload");
  const webview = document.getElementById("vibe-preview") as
    (HTMLElement & { src: string; reload: () => void; loadURL: (u: string) => void }) | null;
  if (!urlInput || !webview) return;

  const navigate = () => {
    let url = urlInput.value.trim();
    if (!url) return;
    if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
    urlInput.value = url;
    webview.src = url;
  };

  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); navigate(); }
  });
  reloadBtn?.addEventListener("click", () => {
    try { webview.reload(); } catch { webview.src = webview.src; }
  });
}

function init(): void {
  initTerminal();
  initPlan();
  initPreview();
  console.log("[vibe] workspace ready");
}

init();
