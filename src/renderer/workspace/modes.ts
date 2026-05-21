// @ts-nocheck
/**
 * modes.ts — chat display modes (transcript / overlay / split) + ghost
 * chat panel, the top-right modes dropdown, agent-mode color, and the
 * composer-height CSS var. Registers openChatOverlay / closeAllChatOverlays
 * / isChatOverlayOpen / toggleChatOverlay. Depends on ctx.slideStack.
 */
export function initModes(ctx) {
  const $ = (id) => document.getElementById(id);
  const { slideStack } = ctx;

  const ghostEl       = $("yo-ghost");
  const ghostClose    = $("yo-ghost-close");
  const transcriptEl  = $("yo-transcript");
  const transcriptClose = $("yo-transcript-close");
  const wsCenter      = $("ws-center");
  const slidesLayer   = $("slides-layer");
  const composerInput = $("yo-panel-input");

  let displayMode  = localStorage.getItem("ws-display-mode")  || "overlay";   // transcript | overlay | split
  let overlayMode  = localStorage.getItem("ws-overlay-mode")  || "slide";     // slide | ghost
  let fontSize     = localStorage.getItem("ws-font-size")     || "md";        // sm | md | lg

  function paintModesMenu() {
    document.querySelectorAll("#modes-menu [data-display]").forEach((el) => {
      el.classList.toggle("visible", el.dataset.display === displayMode);
    });
    document.querySelectorAll("#modes-menu [data-overlay]").forEach((el) => {
      el.classList.toggle("active", el.dataset.overlay === overlayMode);
    });
    document.querySelectorAll("#modes-menu [data-font]").forEach((el) => {
      el.classList.toggle("active", el.dataset.font === fontSize);
    });
  }
  function applyOverlayMode(mode) {
    overlayMode = mode;
    if (ghostEl) {
      ghostEl.classList.toggle("mode-slide", mode === "slide");
      ghostEl.classList.toggle("mode-ghost", mode === "ghost");
    }
    localStorage.setItem("ws-overlay-mode", mode);
    paintModesMenu();
  }
  function applyFontSize(sz) {
    fontSize = sz;
    if (transcriptEl) {
      transcriptEl.classList.remove("fs-sm", "fs-md", "fs-lg");
      transcriptEl.classList.add("fs-" + sz);
    }
    localStorage.setItem("ws-font-size", sz);
    paintModesMenu();
  }
  function applyDisplayMode(mode) {
    displayMode = mode;
    localStorage.setItem("ws-display-mode", mode);
    closeAllChatOverlays();
    paintModesMenu();
  }
  applyOverlayMode(overlayMode);
  applyFontSize(fontSize);
  paintModesMenu();

  function isChatOverlayOpen() {
    return (ghostEl && ghostEl.classList.contains("open")) ||
           (transcriptEl && transcriptEl.classList.contains("open")) ||
           (wsCenter && wsCenter.classList.contains("split-active"));
  }
  function openChatOverlay() {
    if (slideStack.length === 0) return;
    closeAllChatOverlays();
    if (displayMode === "transcript")     transcriptEl.classList.add("open");
    else if (displayMode === "split")     wsCenter.classList.add("split-active");
    else                                  ghostEl.classList.add("open");
  }
  function closeAllChatOverlays() {
    if (ghostEl)      ghostEl.classList.remove("open");
    if (transcriptEl) transcriptEl.classList.remove("open");
    if (wsCenter)     wsCenter.classList.remove("split-active");
  }
  function toggleChatOverlay() {
    if (isChatOverlayOpen()) closeAllChatOverlays();
    else openChatOverlay();
  }

  if (composerInput) {
    composerInput.addEventListener("focus", () => {
      if (slideStack.length > 0) openChatOverlay();
    });
  }
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === ".") {
      e.preventDefault();
      if (slideStack.length === 0 && !isChatOverlayOpen()) return;
      toggleChatOverlay();
      return;
    }
    if (e.key === "Escape" && isChatOverlayOpen()) {
      e.preventDefault();
      closeAllChatOverlays();
    }
  });
  if (ghostClose)      ghostClose.addEventListener("click", closeAllChatOverlays);
  if (transcriptClose) transcriptClose.addEventListener("click", closeAllChatOverlays);

  if (slidesLayer) {
    new MutationObserver(() => {
      if (slidesLayer.children.length === 0) closeAllChatOverlays();
    }).observe(slidesLayer, { childList: true });
  }

  // ── Modes dropdown wiring (top-right header) ───────────
  const modesBtn  = $("modes-btn");
  const modesMenu = $("modes-menu");
  function isModesMenuOpen() { return modesMenu && modesMenu.classList.contains("open"); }
  function openModesMenu()   { if (modesMenu) modesMenu.classList.add("open"); }
  function closeModesMenu()  { if (modesMenu) modesMenu.classList.remove("open"); }
  if (modesBtn) {
    modesBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      isModesMenuOpen() ? closeModesMenu() : openModesMenu();
    });
  }
  if (modesMenu) {
    modesMenu.addEventListener("click", (e) => {
      const displayItem = e.target.closest("[data-display]");
      if (displayItem) { applyDisplayMode(displayItem.dataset.display); return; }
      const overlayPill = e.target.closest("[data-overlay]");
      if (overlayPill) { applyOverlayMode(overlayPill.dataset.overlay); return; }
      const fontPill = e.target.closest("[data-font]");
      if (fontPill)   { applyFontSize(fontPill.dataset.font); return; }
    });
  }
  document.addEventListener("click", (e) => {
    if (!isModesMenuOpen()) return;
    if (modesMenu.contains(e.target)) return;
    if (modesBtn && modesBtn.contains(e.target)) return;
    closeModesMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isModesMenuOpen()) closeModesMenu();
  });

  // ── Agent-mode color (browser-preview fallback) ────────
  const MODE_COLORS = { standard: "#25C75E", swarm: "#A855F7" };
  function setModeColor(mode) {
    const color = MODE_COLORS[mode] || MODE_COLORS.standard;
    document.documentElement.style.setProperty("--yo-mode-color", color);
  }
  setModeColor("standard");
  document.querySelectorAll(".yo-mode-option").forEach((opt) => {
    opt.addEventListener("click", () => setModeColor(opt.dataset.value || "standard"));
  });

  // Keep --ws-composer-h in sync so slides clear the input bar.
  function syncComposerHeightVar() {
    const center = $("ws-center");
    const workdirBar = document.querySelector(".ws-workdir-bar");
    if (!center || !workdirBar) return;
    const cBottom = center.getBoundingClientRect().bottom;
    const wTop    = workdirBar.getBoundingClientRect().top;
    const h = Math.max(80, cBottom - wTop + 8);
    document.documentElement.style.setProperty("--ws-composer-h", h + "px");
  }
  syncComposerHeightVar();
  window.addEventListener("resize", syncComposerHeightVar);

  ctx.openChatOverlay = openChatOverlay;
  ctx.closeAllChatOverlays = closeAllChatOverlays;
  ctx.isChatOverlayOpen = isChatOverlayOpen;
  ctx.toggleChatOverlay = toggleChatOverlay;
}
