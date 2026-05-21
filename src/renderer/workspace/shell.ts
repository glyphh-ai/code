// @ts-nocheck
/**
 * shell.ts — workspace UI shell orchestrator.
 *
 * Creates the shared `ctx` object and boots the feature modules in
 * dependency order, then wires the cross-cutting "chrome": browser-preview
 * modal hiding, empty-state observer, left-rail toggle, user-card menu,
 * accordion toggle, the composer .dip command parser, the new-session
 * flow, and the left-rail resizers.
 *
 * Runs in BOTH browser preview (no window.yo — degrades gracefully) and
 * Electron. The agent panel, boot gate, and working-dir bar are wired
 * separately by workspace.ts (Electron-only). Bundled to
 * workspace-shell.js by esbuild.
 */

import { initConfirm } from "./confirm.js";
import { initSlides } from "./slides.js";
import { initRails } from "./rails.js";
import { initModes } from "./modes.js";
import { initLauncher } from "./launcher.js";
import { initRecents } from "./recents.js";
import { initCustomize } from "./customize.js";

(function () {
  const $ = (id) => document.getElementById(id);
  const body = $("ws-body");

  // Browser-preview helper: if there's no Electron bridge, hide the
  // splash / onboarding / lockout / bootstrap overlays so the shell is
  // visible. In Electron the real boot flow controls those modals.
  if (typeof window !== "undefined" && !window.yo) {
    ["splash", "onboarding-overlay", "lockout-overlay", "cc-bootstrap-modal", "update-bar"]
      .forEach((id) => { const el = $(id); if (el) el.style.display = "none"; });
  }

  // Empty → active transition for the agent panel.
  const yoPanel = $("yo-panel");
  const yoMessages = $("yo-panel-messages");
  if (yoPanel && yoMessages) {
    const sync = () => yoPanel.classList.toggle("empty", yoMessages.children.length === 0);
    sync();
    new MutationObserver(sync).observe(yoMessages, { childList: true });
  }

  // Left-rail collapse toggle.
  const leftToggle = $("left-rail-toggle");
  if (leftToggle) leftToggle.addEventListener("click", () => body.classList.toggle("left-collapsed"));

  // User-card menu (bottom-left).
  const userCard = $("user-card");
  const userMenu = $("user-menu");
  let userMenuOpen = false;
  if (userCard && userMenu) {
    userCard.addEventListener("click", (e) => {
      e.stopPropagation();
      userMenuOpen = !userMenuOpen;
      userMenu.classList.toggle("open", userMenuOpen);
      userCard.classList.toggle("open", userMenuOpen);
    });
    document.addEventListener("click", (e) => {
      if (!userMenuOpen) return;
      if (userMenu.contains(e.target) || userCard.contains(e.target)) return;
      userMenuOpen = false;
      userMenu.classList.remove("open");
      userCard.classList.remove("open");
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && userMenuOpen) {
        userMenuOpen = false;
        userMenu.classList.remove("open");
        userCard.classList.remove("open");
      }
    });
  }

  // ── Shared context + feature modules (dependency order) ──
  const ctx = {};
  initConfirm(ctx);    // → wsConfirm
  initSlides(ctx);     // → slideStack, pushSlide, popSlide, popTo, clearStack, renderStackDots
  initRails(ctx);      // → placeView, viewIsOpen
  initModes(ctx);      // needs slideStack → openChatOverlay, closeAllChatOverlays, …
  initLauncher(ctx);   // needs pushSlide, wsConfirm → APPS
  initRecents(ctx);    // needs clearStack, closeAllChatOverlays, wsConfirm, placeView, viewIsOpen → renderRecents
  initCustomize(ctx);  // needs pushSlide, popSlide, slideStack

  const { pushSlide, popSlide, clearStack, closeAllChatOverlays, renderRecents, APPS } = ctx;

  // ── Accordion toggle (Apps / Agents / Layouts headers) ──
  // Mutually exclusive: opening one closes its siblings.
  document.querySelectorAll(".ws-accordion-head").forEach((head) => {
    head.addEventListener("click", (e) => {
      if (e.target.closest(".ws-accordion-add")) return;
      const acc = head.parentElement;
      const parent = acc.parentElement;
      const wasOpen = acc.classList.contains("open");
      parent.querySelectorAll(":scope > .ws-accordion").forEach((other) => other.classList.remove("open"));
      if (!wasOpen) acc.classList.add("open");
    });
  });

  // ── Composer .dip command parser (browser preview) ──────
  // In Electron, yo-panel-ui owns Enter. Browser preview parses dot
  // commands here: .dip <app>, .dip back [N], .dip home.
  const composerInput = $("yo-panel-input");
  function handleDotCommand(text) {
    const m = text.trim().match(/^\.(dip|drip)\s+(.+)$/);
    if (!m) return false;
    const args = m[2].trim().split(/\s+/);
    if (args[0] === "back") {
      const n = parseInt(args[1] || "1", 10) || 1;
      for (let i = 0; i < n; i++) popSlide();
      return true;
    }
    if (args[0] === "home" || args[0] === ".") { clearStack(); return true; }
    const matches = args
      .map((a) => APPS.find((x) => x.id === a.toLowerCase() || x.name.toLowerCase() === a.toLowerCase()))
      .filter(Boolean);
    if (matches.length === 0) return false;
    matches.forEach(pushSlide);
    return true;
  }
  if (composerInput && !window.yo) {
    composerInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault();
      const text = composerInput.value;
      if (handleDotCommand(text)) { composerInput.value = ""; return; }
      if (!text.trim()) return;
      console.log("[composer] submit (stub):", text);
      composerInput.value = "";
    });
  }

  // ── New-session flow ────────────────────────────────────
  function newSession() {
    clearStack();
    closeAllChatOverlays();
    const panel = window.__yoPanel;
    if (panel) {
      panel.newChat();
      renderRecents();
    } else {
      const messages = $("yo-panel-messages");
      if (messages) messages.innerHTML = "";
    }
    if (composerInput) {
      composerInput.value = "";
      setTimeout(() => composerInput.focus(), 30);
    }
  }
  const newSessionBtn = $("new-session");
  if (newSessionBtn) newSessionBtn.addEventListener("click", newSession);
  // Any "+ New X" inside a Customize / Schedules slide → new session.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-add]");
    if (!btn) return;
    e.preventDefault();
    newSession();
  });

  // ── Left-rail resizers ──────────────────────────────────
  function wireRailResize(handle, varName, opts) {
    if (!handle) return;
    const { min, max, edge } = opts;
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      handle.classList.add("dragging");
      const startX = e.clientX;
      const startW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(varName)) || 0;
      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const delta = edge === "right" ? dx : -dx;
        const w = Math.max(min, Math.min(max, startW + delta));
        document.documentElement.style.setProperty(varName, w + "px");
      };
      const onUp = () => {
        handle.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
  wireRailResize($("left-rail-resize"), "--ws-rail-w", { min: 220, max: 340, edge: "right" });

  // Left-rail vertical split — drag the divider between Recents (top)
  // and the Apps/Agents/Layouts accordions (mid).
  const railHsep = $("rail-hsep");
  if (railHsep) {
    railHsep.addEventListener("mousedown", (e) => {
      e.preventDefault();
      railHsep.classList.add("dragging");
      const railEl = railHsep.parentElement;
      const topEl  = railEl.querySelector(".ws-rail-top");
      const midEl  = railEl.querySelector(".ws-rail-mid");
      const rect   = railEl.getBoundingClientRect();
      const onMove = (ev) => {
        const h = Math.max(80, Math.min(rect.height - 160, ev.clientY - rect.top));
        topEl.style.flex = `0 0 ${h}px`;
        midEl.style.flex = `1`;
      };
      const onUp = () => {
        railHsep.classList.remove("dragging");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  // Working-directory bar is wired by workspace/workdir.ts (Electron).
})();
