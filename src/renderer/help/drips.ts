/**
 * Drips section — recipe builder, CRUD.
 */

import { paginate, renderPaginationBar, confirmAction, clearInvalid, closeHelp } from "./shared.js";

// ── Drips ─────────────────────────────────────────────────

let dripsPage = 0;
let allDrips: Array<{ name: string; recipe: string }> = [];
let builtinEffects: string[] = [];
const dripsListEl = document.getElementById("drips-list")!;
const dripsToolbar = document.getElementById("drips-toolbar")!;
const dripEditor = document.getElementById("drip-editor")!;
const dripNameInput = document.getElementById("drip-name") as HTMLInputElement;
const dripDeleteBtn = document.getElementById("drip-delete-btn") as HTMLButtonElement;
const dripSearchInput = document.getElementById("drip-search") as HTMLInputElement;
const dripFormError = document.getElementById("drip-form-error")!;
const dripModeSelect = document.getElementById("drip-mode") as HTMLSelectElement;
const dripCountInput = document.getElementById("drip-count") as HTMLInputElement;
const dripEffectsList = document.getElementById("drip-effects-list")!;
const dripRecipePreview = document.getElementById("drip-recipe-preview")!;
let editingDripName: string | null = null;

function buildDripRecipe(): string {
  const mode = dripModeSelect.value;
  const parts: string[] = [];
  if (mode === "persistent") parts.push("-1");
  else if (mode === "counted") parts.push(dripCountInput.value || "3");
  const selects = dripEffectsList.querySelectorAll("select");
  selects.forEach((sel) => { if ((sel as HTMLSelectElement).value) parts.push((sel as HTMLSelectElement).value); });
  return parts.join(" ");
}

function updateDripRecipePreview() {
  const recipe = buildDripRecipe();
  dripRecipePreview.textContent = recipe || "—";
}

function addEffectRow(value?: string) {
  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:6px;align-items:center;";
  const sel = document.createElement("select");
  sel.className = "settings-input";
  sel.style.cssText = "flex:1;";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select effect...";
  sel.appendChild(placeholder);
  for (const eff of builtinEffects) {
    const opt = document.createElement("option");
    opt.value = eff;
    opt.textContent = eff;
    sel.appendChild(opt);
  }
  if (value) sel.value = value;
  sel.addEventListener("change", updateDripRecipePreview);
  row.appendChild(sel);

  const removeBtn = document.createElement("button");
  removeBtn.className = "action-btn danger";
  removeBtn.style.cssText = "padding:4px 8px;font-size:11px;flex-shrink:0;";
  removeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
  removeBtn.addEventListener("click", () => {
    row.remove();
    updateDripRecipePreview();
  });
  row.appendChild(removeBtn);

  dripEffectsList.appendChild(row);
  updateDripRecipePreview();
}

function parseRecipeIntoBuilder(recipe: string) {
  dripEffectsList.innerHTML = "";
  const tokens = recipe.trim().split(/\s+/);
  let mode = "oneshot";
  let idx = 0;

  if (tokens[0] === "-1") { mode = "persistent"; idx = 1; }
  else if (/^\d+$/.test(tokens[0]) && parseInt(tokens[0]) > 1) {
    mode = "counted";
    dripCountInput.value = tokens[0];
    idx = 1;
  }

  dripModeSelect.value = mode;
  dripCountInput.classList.toggle("hidden", mode !== "counted");

  for (; idx < tokens.length; idx++) {
    if (tokens[idx]) addEffectRow(tokens[idx]);
  }
  if (dripEffectsList.children.length === 0) addEffectRow();
  updateDripRecipePreview();
}

async function loadDrips() {
  dripEditor.classList.add("hidden");
  dripFormError.classList.add("hidden");

  document.getElementById("drips-upgrade-gate")!.classList.add("hidden");
  dripsToolbar.classList.remove("hidden");
  dripsListEl.classList.remove("hidden");

  if (builtinEffects.length === 0) {
    builtinEffects = await window.yo.dripsBuiltinEffects();
  }
  allDrips = await window.yo.dripsList();
  renderDripsList();
}

function renderDripsList() {
  const query = dripSearchInput.value.trim().toLowerCase();
  const filtered = query ? allDrips.filter((d) => d.name.toLowerCase().includes(query)) : allDrips;

  if (allDrips.length === 0) {
    dripsListEl.innerHTML = `<div class="crud-empty">No custom drips yet. Click "+ New" to create one.</div>`;
    return;
  }
  if (filtered.length === 0) {
    dripsListEl.innerHTML = `<div class="crud-empty">No drips matching "${query}"</div>`;
    return;
  }

  const { items, state } = paginate(filtered, dripsPage);
  dripsPage = state.page;
  dripsListEl.innerHTML = "";

  for (const drip of items) {
    const card = document.createElement("div");
    card.className = "crud-card";
    card.innerHTML = `
      <div class="crud-card-info">
        <span class="crud-card-name">${drip.name}</span>
        <span class="crud-card-meta">${drip.recipe}</span>
      </div>
      <div class="crud-card-actions">
        <button class="crud-card-btn crud-play-btn" title="Play">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
        <button class="crud-card-btn crud-edit-btn" title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
        </button>
        <button class="crud-card-btn danger crud-delete-btn" title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        </button>
      </div>`;

    card.querySelector(".crud-play-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      window.yo.dripsPreview(drip.recipe);
    });

    card.querySelector(".crud-edit-btn")!.addEventListener("click", (e) => {
      e.stopPropagation();
      openDripEditor(drip.name, drip.recipe);
    });

    card.querySelector(".crud-delete-btn")!.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await confirmAction(`Delete drip "${drip.name}"?`);
      if (!confirmed) return;
      await window.yo.dripsDelete(drip.name);
      loadDrips();
    });

    card.addEventListener("click", () => openDripEditor(drip.name, drip.recipe));

    dripsListEl.appendChild(card);
  }
  dripsListEl.appendChild(renderPaginationBar(state, (p) => { dripsPage = p; renderDripsList(); }));
}

function openDripEditor(name: string, recipe: string) {
  editingDripName = name || null;
  dripNameInput.value = name;
  dripDeleteBtn.style.display = name ? "" : "none";
  dripFormError.classList.add("hidden");

  if (recipe) {
    parseRecipeIntoBuilder(recipe);
  } else {
    dripModeSelect.value = "oneshot";
    dripCountInput.classList.add("hidden");
    dripEffectsList.innerHTML = "";
    addEffectRow();
  }

  dripsListEl.classList.add("hidden");
  dripsToolbar.classList.add("hidden");
  dripEditor.classList.remove("hidden");
  dripNameInput.focus();
}

function closeDripEditor() {
  dripEditor.classList.add("hidden");
  dripsListEl.classList.remove("hidden");
  dripsToolbar.classList.remove("hidden");
  editingDripName = null;
  loadDrips();
}

async function saveDrip() {
  let valid = true;
  const name = dripNameInput.value.trim().toLowerCase();
  const recipe = buildDripRecipe();

  if (!name) { dripNameInput.classList.add("invalid"); clearInvalid(dripNameInput); valid = false; }
  const hasEffects = Array.from(dripEffectsList.querySelectorAll("select")).some((s) => (s as HTMLSelectElement).value);
  if (!hasEffects) {
    dripFormError.textContent = "Select at least one effect.";
    dripFormError.classList.remove("hidden");
    valid = false;
  }
  if (!valid) {
    if (!dripFormError.textContent) {
      dripFormError.textContent = "Please fill in all required fields.";
      dripFormError.classList.remove("hidden");
    }
    return;
  }

  if (editingDripName && editingDripName !== name) {
    await window.yo.dripsDelete(editingDripName);
  }
  await window.yo.dripsSave(name, recipe);
  editingDripName = name;
  closeDripEditor();
}

async function deleteDrip() {
  if (!editingDripName) return;
  const confirmed = await confirmAction(`Delete drip "${editingDripName}"?`);
  if (!confirmed) return;
  await window.yo.dripsDelete(editingDripName);
  closeDripEditor();
}

export { loadDrips };

export function initDripsEvents() {
  document.getElementById("drip-new-btn")!.addEventListener("click", () => openDripEditor("", ""));
  document.getElementById("drip-save-btn")!.addEventListener("click", saveDrip);
  document.getElementById("drip-cancel-btn")!.addEventListener("click", closeDripEditor);
  document.getElementById("drip-back-link")!.addEventListener("click", closeDripEditor);
  document.getElementById("drip-delete-btn")!.addEventListener("click", deleteDrip);
  document.getElementById("drip-preview-btn")!.addEventListener("click", () => {
    const recipe = buildDripRecipe();
    if (recipe) window.yo.dripsPreview(recipe);
  });
  dripModeSelect.addEventListener("change", () => {
    dripCountInput.classList.toggle("hidden", dripModeSelect.value !== "counted");
    updateDripRecipePreview();
  });
  dripCountInput.addEventListener("input", updateDripRecipePreview);
  document.getElementById("drip-add-effect")!.addEventListener("click", () => addEffectRow());
  dripSearchInput.addEventListener("input", () => { dripsPage = 0; renderDripsList(); });
}
