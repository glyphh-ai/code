/**
 * Autocomplete engine for the command bar.
 *
 * Knows the static command tree and fetches dynamic data
 * (panels, library items, skills, layouts) from main process.
 */

interface CompletionData {
  apps: string[];
  library: string[];
  skills: string[];
  layouts: string[];
}

let cache: CompletionData = { apps: [], library: [], skills: [], layouts: [] };

async function refreshCache() {
  cache = await window.yo.getCompletions();
}

/** Get completions for the current input string */
export async function getCompletions(input: string): Promise<string[]> {
  await refreshCache();

  const parts = input.trimStart().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? "";
  const argc = parts.length;

  // Still typing the first word — complete command names
  if (argc === 1) {
    return filterPrefix(["yo", "sup", "dip"], cmd);
  }

  const sub = parts[1]?.toLowerCase() ?? "";

  switch (cmd) {
    case "yo":
      return completeYo(parts, sub, argc);
    case "sup":
      return completeSup(parts, sub, argc);
    case "dip":
      return completeDip(parts, sub, argc);
    default:
      return [];
  }
}

function completeYo(parts: string[], sub: string, argc: number): string[] {
  if (argc === 2) {
    return filterPrefix(
      ["help", "skill", "layout", ...cache.library],
      sub,
    );
  }

  if (sub === "skill" && argc === 3) {
    return filterPrefix(["create", "list"], parts[2]);
  }

  if (sub === "layout") {
    if (argc === 3) {
      return filterPrefix(["save", "list", "delete"], parts[2]);
    }
    if (parts[2] === "delete" && argc === 4) {
      return filterPrefix(cache.layouts, parts[3]);
    }
    // yo layout save <name> <panels...> [/ <panels...>]
    if (parts[2] === "save" && argc >= 5) {
      const current = parts[argc - 1];
      if (current === "/") return cache.apps;
      return filterPrefix([...cache.apps, "/"], current);
    }
  }

  return [];
}

function completeSup(parts: string[], sub: string, argc: number): string[] {
  if (argc === 2) {
    return filterPrefix(["list", "search", "forget", ...cache.library], sub);
  }
  if (sub === "forget" && argc === 3) {
    return filterPrefix(cache.library, parts[2]);
  }
  return [];
}

function completeDip(parts: string[], sub: string, argc: number): string[] {
  if (argc === 2) {
    return filterPrefix(
      ["back", "list", "add", "split", "refresh", "zoom", ...cache.apps, ...cache.layouts],
      sub,
    );
  }
  if (sub === "refresh" && argc === 3) {
    return filterPrefix(cache.apps, parts[2]);
  }
  if (sub === "zoom" && argc === 3) {
    return filterPrefix(["0.75", "0.9", "1", "1.1", "1.25", "reset"], parts[2]);
  }
  // dip split <panel> [<panel> ...] [/ <panel> ...]
  if (sub === "split" && argc >= 3) {
    const current = parts[argc - 1];
    // After "/" suggest panel names for next row
    if (current === "/") return cache.apps;
    return filterPrefix([...cache.apps, "/"], current);
  }
  return [];
}

function filterPrefix(candidates: string[], prefix: string): string[] {
  const p = prefix.toLowerCase();
  if (!p) return candidates;
  return candidates.filter((c) => c.toLowerCase().startsWith(p) && c.toLowerCase() !== p);
}

// ── Dropdown UI ─────────────────────────────────────────────

const input = document.getElementById("command-input") as HTMLInputElement;
const dropdown = document.getElementById("autocomplete-dropdown")!;
let items: string[] = [];
let selectedIndex = -1;

export function initAutocomplete() {
  input.addEventListener("keydown", handleKey);
  input.addEventListener("input", () => { selectedIndex = -1; showCompletions(); });
  document.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).closest("#autocomplete-dropdown")) {
      hideDropdown();
    }
  });
}

let panelsHidden = false;

async function showCompletions() {
  const value = input.value;
  if (!value.trim()) {
    hideDropdown();
    return;
  }
  items = await getCompletions(value);
  if (items.length === 0) {
    hideDropdown();
    return;
  }
  if (!panelsHidden) {
    window.yo.panelsHide();
    panelsHidden = true;
  }
  renderDropdown();
}

function renderDropdown() {
  dropdown.innerHTML = items
    .map((item, i) =>
      `<div class="ac-item${i === selectedIndex ? " selected" : ""}" data-index="${i}">${item}</div>`
    )
    .join("");
  dropdown.classList.remove("hidden");

  dropdown.querySelectorAll(".ac-item").forEach((el) => {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      acceptCompletion(parseInt((el as HTMLElement).dataset.index!, 10));
    });
  });
}

function hideDropdown() {
  dropdown.classList.add("hidden");
  items = [];
  selectedIndex = -1;
  if (panelsHidden) {
    window.yo.panelsShow();
    panelsHidden = false;
  }
}

function acceptCompletion(index: number) {
  const item = items[index];
  if (!item) return;

  const parts = input.value.trimStart().split(/\s+/);
  parts[parts.length - 1] = item;
  input.value = parts.join(" ") + " ";
  hideDropdown();
  input.focus();
}

function handleKey(e: KeyboardEvent) {
  if (!dropdown.classList.contains("hidden") && items.length > 0) {
    if (e.key === "Tab" || e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % items.length;
      renderDropdown();
      if (e.key === "Tab" && items.length === 1) {
        acceptCompletion(0);
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = selectedIndex <= 0 ? items.length - 1 : selectedIndex - 1;
      renderDropdown();
      return;
    }
    if (e.key === "Enter" && selectedIndex >= 0) {
      e.preventDefault();
      e.stopPropagation();
      acceptCompletion(selectedIndex);
      return;
    }
  } else if (e.key === "Tab") {
    e.preventDefault();
    showCompletions();
    return;
  }
}
