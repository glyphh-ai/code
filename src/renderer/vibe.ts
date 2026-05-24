/**
 * Vibe — the vibe-coder surface renderer.
 *
 * Build column (left): SPEC.md editor (the durable source of truth) over a
 *   rendered plan.md checklist (tasks + progress + the current item). Toggling
 *   a task writes back to plan.md; the checklist re-reads on an interval so the
 *   agent's edits show up live.
 * Agent column (right): an xterm.js terminal bound to the Claude Code PTY in
 *   main (reuses terminal:data/write/resize keyed by this panel's wc.id) — the
 *   agent is driving.
 * Preview: an on-demand <webview> overlay (toggled from the top bar) so it eats
 *   no layout space until you open it.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

interface VibeAPI {
  // PTY (Claude Code agent) — reuses terminal:* channels keyed by wc.id.
  termWrite: (data: string) => void;
  termResize: (cols: number, rows: number) => void;
  onTermData: (cb: (data: string) => void) => void;
  ready: () => void;
  // Spec + plan files
  specRead: () => Promise<string>;
  specWrite: (text: string) => void;
  planRead: () => Promise<string>;
  planWrite: (text: string) => void;
  // Theme
  getTheme?: () => Promise<string>;
  onThemeChanged?: (cb: (theme: string) => void) => () => void;
}

const vibe = (window as unknown as { vibe: VibeAPI }).vibe;

// ── Agent terminal ────────────────────────────────────────
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

  term.onData((d) => vibe.termWrite(d));
  vibe.onTermData((d) => term.write(d));

  let spawned = false;
  const fitAndResize = () => {
    try { fitAddon.fit(); } catch { /* container not laid out yet */ }
    vibe.termResize(term.cols, term.rows);
  };

  // First fit reports real cols/rows to main, which waits for that resize
  // before spawning the claude PTY so the TUI sizes correctly.
  requestAnimationFrame(() => {
    fitAndResize();
    if (!spawned) {
      spawned = true;
      vibe.ready();
    }
  });

  window.addEventListener("resize", fitAndResize);
}

// ── SPEC.md editor (durable source of truth) ──────────────
function initSpec(): void {
  const textarea = document.getElementById("vibe-spec") as HTMLTextAreaElement | null;
  const saved = document.getElementById("vibe-spec-saved");
  if (!textarea) return;

  vibe.specRead().then((text) => { textarea.value = text || ""; }).catch(() => {});

  let timer: ReturnType<typeof setTimeout> | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  textarea.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      vibe.specWrite(textarea.value);
      if (saved) {
        saved.classList.add("show");
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => saved.classList.remove("show"), 1200);
      }
    }, 400);
  });
}

// ── Plan checklist (rendered from plan.md, live) ──────────
interface PlanLine { kind: "task" | "heading" | "prose"; text: string; done?: boolean; idx: number; }

function parsePlan(src: string): PlanLine[] {
  const out: PlanLine[] = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const task = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) {
      out.push({ kind: "task", done: task[2].toLowerCase() === "x", text: task[3], idx: i });
    } else if (/^#{1,6}\s+/.test(line)) {
      out.push({ kind: "heading", text: line.replace(/^#{1,6}\s+/, ""), idx: i });
    } else if (line.trim()) {
      out.push({ kind: "prose", text: line.trim(), idx: i });
    }
  }
  return out;
}

function initPlanChecklist(): void {
  const listEl = document.getElementById("vibe-plan-checklist");
  const progressEl = document.getElementById("vibe-plan-progress");
  if (!listEl) return;

  let rawLines: string[] = [];
  let lastRaw = "";

  const toggleTask = (idx: number) => {
    const line = rawLines[idx];
    if (!line) return;
    rawLines[idx] = /\[\s\]/.test(line)
      ? line.replace(/\[\s\]/, "[x]")
      : line.replace(/\[[xX]\]/, "[ ]");
    const next = rawLines.join("\n");
    lastRaw = next;
    vibe.planWrite(next);
    render(next);
  };

  const render = (src: string) => {
    rawLines = src.split("\n");
    const items = parsePlan(src);
    const tasks = items.filter((it) => it.kind === "task");
    const doneCount = tasks.filter((t) => t.done).length;
    const currentIdx = tasks.find((t) => !t.done)?.idx ?? -1;

    if (progressEl) {
      progressEl.textContent = tasks.length ? `${doneCount}/${tasks.length} done` : "";
    }

    listEl.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "plan-empty";
      empty.textContent = "No plan yet — describe what you want and the agent will draft one.";
      listEl.appendChild(empty);
      return;
    }

    for (const it of items) {
      if (it.kind === "task") {
        const row = document.createElement("label");
        row.className = "plan-task" + (it.done ? " done" : "") + (it.idx === currentIdx ? " current" : "");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !!it.done;
        box.addEventListener("change", () => toggleTask(it.idx));
        const text = document.createElement("span");
        text.className = "plan-task-text";
        text.textContent = it.text;
        row.append(box, text);
        listEl.appendChild(row);
      } else {
        const line = document.createElement("div");
        line.className = "plan-line" + (it.kind === "heading" ? " h" : "");
        line.textContent = it.text;
        listEl.appendChild(line);
      }
    }
  };

  const refresh = () => {
    vibe.planRead().then((text) => {
      const next = text || "";
      if (next !== lastRaw) {
        lastRaw = next;
        render(next);
      }
    }).catch(() => {});
  };

  refresh();
  // Live: pick up the agent's edits to plan.md as it checks tasks off.
  setInterval(refresh, 1500);
}

// ── Preview overlay (on-demand) ───────────────────────────
function initPreview(): void {
  const btn = document.getElementById("vibe-preview-btn");
  const overlay = document.getElementById("vibe-preview-overlay");
  const closeBtn = document.getElementById("vibe-preview-close");
  const urlInput = document.getElementById("vibe-url") as HTMLInputElement | null;
  const reloadBtn = document.getElementById("vibe-reload");
  const webview = document.getElementById("vibe-preview") as
    (HTMLElement & { src: string; reload: () => void }) | null;
  if (!btn || !overlay || !urlInput || !webview) return;

  const navigate = () => {
    let url = urlInput.value.trim();
    if (!url) return;
    if (!/^[a-z]+:\/\//i.test(url)) url = `http://${url}`;
    urlInput.value = url;
    webview.src = url;
  };

  btn.addEventListener("click", () => {
    overlay.classList.add("open");
    if (webview.src === "about:blank" || !webview.src) navigate();
  });
  closeBtn?.addEventListener("click", () => overlay.classList.remove("open"));
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); navigate(); }
  });
  reloadBtn?.addEventListener("click", () => {
    try { webview.reload(); } catch { webview.src = webview.src; }
  });
}

function init(): void {
  initTerminal();
  initSpec();
  initPlanChecklist();
  initPreview();
  console.log("[vibe] workspace ready");
}

init();
