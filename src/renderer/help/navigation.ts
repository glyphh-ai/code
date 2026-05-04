/**
 * Help overlay — open/close, section switching, nav wiring.
 */

import { closeHelp, getHelpOverlay, getHelpTransitioning, setHelpTransitioning } from "./shared.js";
import { loadDashboard, initDashboardEvents, closeDashPromptDetail } from "./dashboard.js";
import { closeDataDetail } from "./data-store.js";
import { loadLayouts, initLayoutsEvents } from "./layouts.js";
import { loadSkills, initSkillsEvents } from "./skills.js";
import { loadApps, initApps } from "./apps.js";
import { loadSettings, initSettings } from "./settings.js";
import { loadDrips, initDripsEvents } from "./drips.js";
import { loadDocs, loadSupport, loadAbout } from "./docs.js";

const overlay = getHelpOverlay();
const navItems = document.querySelectorAll<HTMLButtonElement>(".help-nav-item");
const sections = document.querySelectorAll<HTMLDivElement>(".help-section");
const navSubItems = document.querySelectorAll<HTMLButtonElement>(".help-nav-sub-item");

// ── Open / close ─────────────────────────────────────────

export function openHelp() {
  if (getHelpTransitioning()) return;
  setHelpTransitioning(true);
  setTimeout(() => { setHelpTransitioning(false); }, 300);
  window.yo.panelsHide();
  overlay.classList.remove("hidden");
  window.yo.refreshAuth().catch(() => {});
  loadActiveSection();
}

export function openSettings(sub?: string) {
  switchToSection("settings");
  if (sub) {
    const settingsNavItems = document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='settings'] .settings-nav-item");
    const settingsPanels = document.querySelectorAll<HTMLDivElement>(".help-section[data-section='settings'] .settings-panel");
    settingsNavItems.forEach((n) => n.classList.toggle("active", n.dataset.sub === sub));
    settingsPanels.forEach((p) => p.classList.toggle("active", p.dataset.sub === sub));
    navSubItems.forEach((s) => s.classList.toggle("active", s.dataset.section === "settings" && s.dataset.sub === sub));
  }
  openHelp();
}

export function isHelpOpen(): boolean {
  return !overlay.classList.contains("hidden");
}

// ── Navigation ───────────────────────────────────────────

export function resetEditors() {
  const pd = document.getElementById("dash-prompt-detail");
  if (pd && !pd.classList.contains("hidden")) {
    closeDashPromptDetail();
  }
  const sd = document.getElementById("data-detail");
  if (sd && !sd.classList.contains("hidden")) {
    closeDataDetail();
  }
  const se = document.getElementById("skill-editor");
  if (se && !se.classList.contains("hidden")) {
    se.classList.add("hidden");
    document.getElementById("skills-list")?.classList.remove("hidden");
    document.getElementById("skills-toolbar")?.classList.remove("hidden");
  }
  const le = document.getElementById("layout-editor");
  if (le && !le.classList.contains("hidden")) {
    le.classList.add("hidden");
    document.getElementById("layouts-list")?.classList.remove("hidden");
    document.getElementById("layouts-toolbar")?.classList.remove("hidden");
  }
  const re = document.getElementById("rip-editor");
  if (re && !re.classList.contains("hidden")) {
    re.classList.add("hidden");
    document.getElementById("rips-list")?.classList.remove("hidden");
    document.getElementById("rips-toolbar")?.classList.remove("hidden");
  }
  const de = document.getElementById("drip-editor");
  if (de && !de.classList.contains("hidden")) {
    de.classList.add("hidden");
    document.getElementById("drips-list")?.classList.remove("hidden");
    document.getElementById("drips-toolbar")?.classList.remove("hidden");
  }
  const ad = document.getElementById("app-detail");
  if (ad && !ad.classList.contains("hidden")) {
    ad.classList.add("hidden");
    document.getElementById("apps-list")?.classList.remove("hidden");
    document.getElementById("apps-toolbar")?.classList.remove("hidden");
    const preview = document.getElementById("app-preview") as HTMLElement & { src: string } | null;
    if (preview) preview.src = "about:blank";
  }
  const af = document.getElementById("app-add-form");
  if (af && !af.classList.contains("hidden")) {
    af.classList.add("hidden");
    document.getElementById("apps-list")?.classList.remove("hidden");
    document.getElementById("apps-toolbar")?.classList.remove("hidden");
  }
  document.getElementById("mcp-add-form")?.classList.add("hidden");
}

function switchToSection(sectionId: string) {
  resetEditors();
  navItems.forEach((n) => n.classList.remove("active"));
  sections.forEach((s) => s.classList.remove("active"));
  const navItem = document.querySelector(`.help-nav-item[data-section="${sectionId}"]`) as HTMLElement;
  const section = document.querySelector(`.help-section[data-section="${sectionId}"]`) as HTMLElement;
  if (navItem) navItem.classList.add("active");
  if (section) section.classList.add("active");
}

function collapseAllDropdowns() {
  navItems.forEach((n) => n.classList.remove("expanded"));
}

function activeSection(): string {
  return (document.querySelector(".help-nav-item.active") as HTMLElement)?.dataset.section || "guide";
}

export function loadActiveSection() {
  const sec = activeSection();
  if (sec === "dashboard") loadDashboard();
  else if (sec === "skills") loadSkills();
  else if (sec === "drips") loadDrips();
  else if (sec === "layouts") loadLayouts();
  else if (sec === "apps") loadApps();
  else if (sec === "settings") loadSettings();
  else if (sec === "docs") loadDocs();
  else if (sec === "support") loadSupport();
  else if (sec === "about") loadAbout();
}

// ── Docs inner sub-navigation ────────────────────────────

const docsSubNav = document.querySelectorAll<HTMLButtonElement>(".docs-nav .settings-nav-item");
const docsPanels = document.querySelectorAll<HTMLDivElement>(".docs-panel");

function showDocPanel(docId: string) {
  docsSubNav.forEach((n) => n.classList.toggle("active", n.dataset.doc === docId));
  docsPanels.forEach((p) => p.classList.toggle("active", p.dataset.doc === docId));
  navSubItems.forEach((s) => s.classList.toggle("active", s.dataset.section === "docs" && s.dataset.sub === docId));
  const container = document.querySelector(".docs-panels");
  if (container) container.scrollTop = 0;
}

// ── Init ─────────────────────────────────────────────────

export function initHelp() {
  document.getElementById("help-close")?.addEventListener("click", closeHelp);

  document.getElementById("user-menu-platform")!.addEventListener("click", () => {
    closeHelp();
    window.yo.execCommand(`dip ${window.yo.platformUrl}`);
  });
  document.getElementById("user-menu-logout")!.addEventListener("click", async () => {
    overlay.classList.add("hidden");
    await window.yo.logout();
  });

  navItems.forEach((item) => {
    item.addEventListener("click", () => {
      if (item.classList.contains("has-sub")) {
        item.classList.toggle("expanded");
      } else {
        collapseAllDropdowns();
        navSubItems.forEach((s) => s.classList.remove("active"));
        switchToSection(item.dataset.section!);
        loadActiveSection();
      }
    });
  });

  navSubItems.forEach((sub) => {
    sub.addEventListener("click", () => {
      const sectionId = sub.dataset.section!;
      const subId = sub.dataset.sub!;
      collapseAllDropdowns();
      switchToSection(sectionId);
      navSubItems.forEach((s) => s.classList.remove("active"));
      sub.classList.add("active");

      if (sectionId === "docs") {
        loadDocs();
        showDocPanel(subId);
      } else if (sectionId === "settings") {
        loadActiveSection();
        const settingsNavItems = document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='settings'] .settings-nav-item");
        const settingsPanels = document.querySelectorAll<HTMLDivElement>(".help-section[data-section='settings'] .settings-panel");
        settingsNavItems.forEach((n) => n.classList.toggle("active", n.dataset.sub === subId));
        settingsPanels.forEach((p) => p.classList.toggle("active", p.dataset.sub === subId));
      }
    });
  });

  const settingsSubNav = document.querySelectorAll<HTMLButtonElement>(".help-section[data-section='settings'] .settings-nav-item");
  const settingsSubPanels = document.querySelectorAll<HTMLDivElement>(".help-section[data-section='settings'] .settings-panel");
  settingsSubNav.forEach((btn) => {
    btn.addEventListener("click", () => {
      settingsSubNav.forEach((n) => n.classList.remove("active"));
      settingsSubPanels.forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      const target = document.querySelector(`.help-section[data-section='settings'] .settings-panel[data-sub="${btn.dataset.sub}"]`);
      if (target) target.classList.add("active");
      navSubItems.forEach((s) => s.classList.toggle("active", s.dataset.section === "settings" && s.dataset.sub === btn.dataset.sub));
    });
  });

  docsSubNav.forEach((btn) => {
    btn.addEventListener("click", () => { showDocPanel(btn.dataset.doc!); });
  });

  // Initialize all section event handlers
  initSettings();
  initApps();
  initDashboardEvents();
  initLayoutsEvents();
  initDripsEvents();
  initSkillsEvents();
}
