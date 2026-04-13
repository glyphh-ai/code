/**
 * Autocomplete engine for the command bar.
 *
 * Knows the static command tree and fetches dynamic data
 * (panels, library items, skills, layouts) from main process.
 */

interface CompletionCache {
  apps: string[];
  library: string[];
  skills: string[];
  layouts: string[];
}

let cache: CompletionCache = { apps: [], library: [], skills: [], layouts: [] };

async function refreshCache(): Promise<void> {
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
    return filterPrefix(["yo", "sup", "dip", "wassup"], cmd);
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
    return filterPrefix(["help", "skill", "layout", ...cache.library], sub);
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
      ["back", "list", "add", "split", "refresh", "zoom", "clear-session", ...cache.apps, ...cache.layouts],
      sub,
    );
  }
  if (sub === "refresh" && argc === 3) {
    return filterPrefix(cache.apps, parts[2]);
  }
  if (sub === "clear-session" && argc === 3) {
    return filterPrefix(cache.apps, parts[2]);
  }
  if (sub === "zoom" && argc === 3) {
    return filterPrefix(["0.75", "0.9", "1", "1.1", "1.25", "reset"], parts[2]);
  }
  // dip split <panel> [<panel> ...] [/ <panel> ...]
  if (sub === "split" && argc >= 3) {
    const current = parts[argc - 1];
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
let panelsHidden = false;

export function initAutocomplete(onSubmit: (cmd: string) => void): void {
  input.addEventListener("keydown", (e) => handleKey(e, onSubmit));
  input.addEventListener("input", () => {
    selectedIndex = -1;
    showCompletions();
  });
  // Restore panels when input loses focus
  input.addEventListener("blur", () => {
    setTimeout(() => hideDropdown(), 100);
  });
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest("#autocomplete-dropdown") && !target.closest("#command-input")) {
      hideDropdown();
    }
  });
}

async function showCompletions(): Promise<void> {
  const value = input.value;
  if (!value.trim()) {
    closeDropdown();
    return;
  }
  items = await getCompletions(value);
  if (items.length === 0) {
    closeDropdown();
    return;
  }
  // Hide panels so dropdown is visible (BrowserViews render above HTML)
  if (!panelsHidden) {
    // Capture freeze-frame then hide real panels
    window.yo.capturePanels().then((captures) => {
      const container = document.getElementById("panel-screenshots");
      if (container) {
        for (const cap of captures) {
          const div = document.createElement("div");
          div.className = "panel-screenshot";
          div.style.left = `${cap.bounds.x}px`;
          div.style.top = `${cap.bounds.y}px`;
          div.style.width = `${cap.bounds.width}px`;
          div.style.height = `${cap.bounds.height}px`;
          div.style.backgroundImage = `url(${cap.dataUrl})`;
          container.appendChild(div);
        }
      }
      window.yo.panelsHide();
    });
    panelsHidden = true;
  }
  renderDropdown();
}

function renderDropdown(): void {
  dropdown.innerHTML = items
    .map(
      (item, i) =>
        `<div class="ac-item${i === selectedIndex ? " selected" : ""}" data-index="${i}">${item}</div>`,
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

/** Close just the dropdown UI (no panel restore) */
function closeDropdown(): void {
  dropdown.classList.add("hidden");
  items = [];
  selectedIndex = -1;
}

/** Fully dismiss: close dropdown AND restore panels */
export function hideDropdown(): void {
  closeDropdown();
  if (panelsHidden) {
    panelsHidden = false;
    const container = document.getElementById("panel-screenshots");
    if (container) container.innerHTML = "";
    window.yo.panelsShow();
  }
}

function acceptCompletion(index: number): void {
  const item = items[index];
  if (!item) return;
  const parts = input.value.trimStart().split(/\s+/);
  parts[parts.length - 1] = item;
  input.value = parts.join(" ") + " ";
  closeDropdown();
  input.focus();
}

function handleKey(e: KeyboardEvent, onSubmit: (cmd: string) => void): void {
  if (!dropdown.classList.contains("hidden") && items.length > 0) {
    if (e.key === "Tab" || e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % items.length;
      renderDropdown();
      if (e.key === "Tab" && items.length === 1) acceptCompletion(0);
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
      e.stopImmediatePropagation();
      acceptCompletion(selectedIndex);
      return;
    }
  } else if (e.key === "Tab") {
    e.preventDefault();
    showCompletions();
    return;
  }

  // Enter with no selected completion → submit command
  if (e.key === "Enter") {
    e.preventDefault();
    const value = input.value.trim();
    if (value) {
      onSubmit(value);
      input.value = "";
      hideDropdown();
      input.blur();
    }
  }

  // Escape → clear and blur
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopImmediatePropagation();
    input.value = "";
    hideDropdown();
    input.blur();
  }
}
