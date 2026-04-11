/**
 * Help overlay — combined docs + settings (library, skills, layouts, panels).
 */

const overlay = document.getElementById("help-overlay")!;
const navItems = document.querySelectorAll<HTMLButtonElement>(".help-nav-item");
const sections = document.querySelectorAll<HTMLDivElement>(".help-section");

// ── Open / close ─────────────────────────────────────────

export function openHelp() {
  window.yo.panelsHide();
  overlay.classList.remove("hidden");
  loadActiveSection();
}

export function closeHelp() {
  overlay.classList.add("hidden");
  window.yo.panelsShow();
}

export function isHelpOpen(): boolean {
  return !overlay.classList.contains("hidden");
}

// ── Navigation ───────────────────────────────────────────

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    navItems.forEach((n) => n.classList.remove("active"));
    sections.forEach((s) => s.classList.remove("active"));
    item.classList.add("active");
    document.querySelector(`.help-section[data-section="${item.dataset.section}"]`)!.classList.add("active");
    loadActiveSection();
  });
});

function activeSection(): string {
  return (document.querySelector(".help-nav-item.active") as HTMLElement).dataset.section!;
}

function loadActiveSection() {
  const sec = activeSection();
  if (sec === "library") loadLibrary();
  else if (sec === "skills") loadSkills();
  else if (sec === "layouts") loadLayouts();
  else if (sec === "panels") loadPanels();
}

// ── Init ─────────────────────────────────────────────────

export function initHelp() {
  document.getElementById("help-close")!.addEventListener("click", closeHelp);

  document.getElementById("dismiss-check")!.addEventListener("change", (e) => {
    window.yo.setPreference("hideWelcome", (e.target as HTMLInputElement).checked);
  });

  // Library
  document.getElementById("library-save-btn")!.addEventListener("click", saveLibraryItem);
  document.getElementById("library-new-btn")!.addEventListener("click", newLibraryItem);

  // Skills
  document.getElementById("skills-save-btn")!.addEventListener("click", saveSkillItem);
  document.getElementById("skills-new-btn")!.addEventListener("click", newSkillItem);

  // Layouts
  document.getElementById("layout-new-btn")!.addEventListener("click", newLayout);
  document.getElementById("layout-save-btn")!.addEventListener("click", saveLayout);

  // Panels
  document.getElementById("panel-add-btn")!.addEventListener("click", addPanel);
}

// ── Library ──────────────────────────────────────────────

const libraryList = document.getElementById("library-list")!;
const libraryEditor = document.getElementById("library-editor")!;
const libraryEditName = document.getElementById("library-edit-name")!;
const libraryEditContent = document.getElementById("library-edit-content") as HTMLTextAreaElement;

async function loadLibrary() {
  libraryEditor.classList.add("hidden");
  const items = await window.yo.libraryList();
  if (items.length === 0) {
    libraryList.innerHTML = `<div class="empty-state">No files yet. Use <strong>yo &lt;name&gt;</strong> to save context.</div>`;
    return;
  }
  libraryList.innerHTML = items.map((name) => `
    <div class="item-row" data-name="${name}">
      <span class="item-name">${name}.md</span>
      <div class="item-actions">
        <button class="edit-btn">edit</button>
        <button class="danger delete-btn">delete</button>
      </div>
    </div>`).join("");

  libraryList.querySelectorAll(".item-row").forEach((row) => {
    row.addEventListener("click", () => editLibraryItem((row as HTMLElement).dataset.name!));
  });
  libraryList.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      editLibraryItem((btn.closest(".item-row") as HTMLElement).dataset.name!);
    });
  });
  libraryList.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.yo.libraryRemove((btn.closest(".item-row") as HTMLElement).dataset.name!);
      loadLibrary();
    });
  });
}

async function editLibraryItem(name: string) {
  const content = await window.yo.libraryRead(name);
  libraryEditName.textContent = name + ".md";
  libraryEditContent.value = content || "";
  libraryEditor.classList.remove("hidden");
  libraryEditor.dataset.name = name;
  libraryEditContent.focus();
}

async function saveLibraryItem() {
  const name = libraryEditor.dataset.name!;
  await window.yo.libraryWrite(name, libraryEditContent.value);
  libraryEditor.classList.add("hidden");
  loadLibrary();
}

async function newLibraryItem() {
  const input = document.getElementById("library-new-name") as HTMLInputElement;
  const name = input.value.trim();
  if (!name) return;
  await window.yo.libraryWrite(name, "");
  input.value = "";
  loadLibrary();
  editLibraryItem(name);
}

// ── Skills ───────────────────────────────────────────────

const skillsList = document.getElementById("skills-list")!;
const skillsEditor = document.getElementById("skills-editor")!;
const skillsEditName = document.getElementById("skills-edit-name")!;
const skillsEditContent = document.getElementById("skills-edit-content") as HTMLTextAreaElement;

async function loadSkills() {
  skillsEditor.classList.add("hidden");
  const items = await window.yo.skillsList();
  if (items.length === 0) {
    skillsList.innerHTML = `<div class="empty-state">No skills yet. Create one to process captured sessions.</div>`;
    return;
  }
  skillsList.innerHTML = items.map((name) => `
    <div class="item-row" data-name="${name}">
      <span class="item-name">${name}</span>
      <div class="item-actions">
        <button class="edit-btn">edit</button>
        <button class="danger delete-btn">delete</button>
      </div>
    </div>`).join("");

  skillsList.querySelectorAll(".item-row").forEach((row) => {
    row.addEventListener("click", () => editSkillItem((row as HTMLElement).dataset.name!));
  });
  skillsList.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      editSkillItem((btn.closest(".item-row") as HTMLElement).dataset.name!);
    });
  });
  skillsList.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.yo.skillsRemove((btn.closest(".item-row") as HTMLElement).dataset.name!);
      loadSkills();
    });
  });
}

async function editSkillItem(name: string) {
  const content = await window.yo.skillsRead(name);
  skillsEditName.textContent = name;
  skillsEditContent.value = content || "";
  skillsEditor.classList.remove("hidden");
  skillsEditor.dataset.name = name;
  skillsEditContent.focus();
}

async function saveSkillItem() {
  const name = skillsEditor.dataset.name!;
  await window.yo.skillsWrite(name, skillsEditContent.value);
  skillsEditor.classList.add("hidden");
  loadSkills();
}

async function newSkillItem() {
  const input = document.getElementById("skills-new-name") as HTMLInputElement;
  const name = input.value.trim();
  if (!name) return;
  await window.yo.skillsWrite(name, "");
  input.value = "";
  loadSkills();
  editSkillItem(name);
}

// ── Layouts ──────────────────────────────────────────────

const layoutsList = document.getElementById("layouts-list")!;
const layoutEditor = document.getElementById("layout-editor")!;
const layoutEditName = document.getElementById("layout-edit-name")!;
const panelPicker = document.getElementById("layout-panel-picker")!;
let selectedPanels: string[] = [];

async function loadLayouts() {
  layoutEditor.classList.add("hidden");
  const items = await window.yo.layoutsList();
  if (items.length === 0) {
    layoutsList.innerHTML = `<div class="empty-state">No layouts yet. Create one to arrange panels your way.</div>`;
    return;
  }
  layoutsList.innerHTML = items.map((layout) => `
    <div class="item-row" data-name="${layout.name}">
      <span class="item-name">${layout.name}</span>
      <span class="item-meta">${layout.splits.map((s) => s.panelId).join(" | ")}</span>
      <div class="item-actions">
        <button class="edit-btn">edit</button>
        <button class="danger delete-btn">delete</button>
      </div>
    </div>`).join("");

  layoutsList.querySelectorAll(".item-row").forEach((row) => {
    row.addEventListener("click", () => editLayout((row as HTMLElement).dataset.name!));
  });
  layoutsList.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      editLayout((btn.closest(".item-row") as HTMLElement).dataset.name!);
    });
  });
  layoutsList.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await window.yo.layoutsDelete((btn.closest(".item-row") as HTMLElement).dataset.name!);
      loadLayouts();
    });
  });
}

async function editLayout(name: string) {
  const layouts = await window.yo.layoutsList();
  const layout = layouts.find((l) => l.name === name);
  selectedPanels = layout ? layout.splits.map((s) => s.panelId) : [];
  layoutEditName.textContent = name;
  layoutEditor.classList.remove("hidden");
  layoutEditor.dataset.name = name;
  renderPanelPicker();
}

async function newLayout() {
  const input = document.getElementById("layout-new-name") as HTMLInputElement;
  const name = input.value.trim();
  if (!name) return;
  selectedPanels = [];
  layoutEditName.textContent = name;
  layoutEditor.classList.remove("hidden");
  layoutEditor.dataset.name = name;
  input.value = "";
  renderPanelPicker();
}

async function renderPanelPicker() {
  const panels = await window.yo.panelsList();
  panelPicker.innerHTML = panels.map((p) => {
    const idx = selectedPanels.indexOf(p.id);
    const isSelected = idx >= 0;
    return `<div class="panel-pick${isSelected ? " selected" : ""}" data-id="${p.id}">
      ${isSelected ? `<span class="pick-order">${idx + 1}</span>` : ""}${p.id}
    </div>`;
  }).join("");

  panelPicker.querySelectorAll(".panel-pick").forEach((el) => {
    el.addEventListener("click", () => {
      const id = (el as HTMLElement).dataset.id!;
      const idx = selectedPanels.indexOf(id);
      if (idx >= 0) {
        selectedPanels.splice(idx, 1);
      } else {
        selectedPanels.push(id);
      }
      renderPanelPicker();
    });
  });
}

async function saveLayout() {
  const name = layoutEditor.dataset.name!;
  if (selectedPanels.length < 2) return;
  await window.yo.layoutsSave(name, selectedPanels);
  layoutEditor.classList.add("hidden");
  loadLayouts();
}

// ── Panels ───────────────────────────────────────────────

const panelsList = document.getElementById("panels-list")!;

async function loadPanels() {
  const panels = await window.yo.panelsList();
  panelsList.innerHTML = panels.map((p) => `
    <div class="item-row">
      <span class="item-name">${p.id}</span>
      <span class="item-meta">${p.url}</span>
    </div>`).join("");
}

async function addPanel() {
  const input = document.getElementById("panel-new-url") as HTMLInputElement;
  const url = input.value.trim();
  if (!url) return;
  const id = url.replace(/https?:\/\//, "").split(/[./]/)[0];
  await window.yo.panelsAdd(id, url);
  input.value = "";
  loadPanels();
}
