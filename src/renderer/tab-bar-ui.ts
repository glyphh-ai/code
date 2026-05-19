// tab-bar-ui.ts — Tab bar system extracted from renderer.ts

type TabInfo = { id: string; name: string; favicon?: string; layoutFavicons?: string[]; pinned?: boolean; url?: string };

// The .Yo brand badge (from yo-web/public/favicon.svg) — used as the app icon
// for the .Yo Editor (yo://files) in the tab bar and the "+" new-tab menu.
const YO_BADGE = `<svg viewBox="0 0 32 32" width="14" height="14" style="border-radius:3px;display:block;"><rect width="32" height="32" rx="6" fill="#0a0a0a"/><text x="1" y="25" font-family="system-ui,-apple-system,sans-serif" font-weight="700" font-size="18" fill="#25C75E">.</text><text x="7" y="25" font-family="system-ui,-apple-system,sans-serif" font-weight="700" font-size="18" fill="#ffffff">Yo</text></svg>`;
const isFilesApp = (id: string) => id === "files" || id.startsWith("files-");

/**
 * Callbacks that the tab bar needs from the rest of renderer.ts
 * to implement auto mode switching when the active tab changes.
 */
export interface TabBarDeps {
  isYoControlsInited: () => boolean;
  getCurrentMode: () => string;
  setModeValue: (mode: string) => void;
  syncAgentMode: () => void;
}

export function initTabBar(deps: TabBarDeps): {
  renderTabs: (tabs: TabInfo[], activeId: string) => void;
  autoSwitchModeForActiveTab: (tabs: TabInfo[], activeId: string) => void;
} {
  const tabBar = document.getElementById("tab-bar")!;
  const tabNewBtn = document.getElementById("tab-new-btn")!;
  const emptyState = document.getElementById("empty-state")!;

  let tabNewMenu: HTMLElement | null = null;
  let tabCtxMenu: HTMLElement | null = null;
  let lastActiveTabId = "";

  function closeTabNewMenu() {
    if (tabNewMenu) {
      tabNewMenu.remove();
      tabNewMenu = null;
      window.yo.panelsShow();
    }
  }

  function closeTabCtxMenu() {
    if (tabCtxMenu) {
      tabCtxMenu.remove();
      tabCtxMenu = null;
      window.yo.panelsShow();
    }
  }

  function openTabContextMenu(x: number, y: number, tabId: string, url: string, tabName: string) {
    closeTabCtxMenu();
    closeTabNewMenu();
    window.yo.panelsHide();

    const menu = document.createElement("div");
    menu.className = "tab-new-menu tab-ctx-menu";

    let host = "";
    try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* noop */ }
    const baseName = (tabName && tabName.trim()) || host || "App";

    // "Create App" — opens Home → Apps → New App with the URL prefilled so
    // the user can review/edit before adding. On save, this tab converts to it.
    const createBtn = document.createElement("button");
    createBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg><span>Create App</span>`;
    createBtn.addEventListener("click", () => {
      closeTabCtxMenu();
      window.yo.createAppFromTab(tabId, url, baseName);
    });
    menu.appendChild(createBtn);

    const addBtn = document.createElement("button");
    addBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M17.5 14v7M14 17.5h7"/></svg><span>Add as app</span>`;
    addBtn.addEventListener("click", async () => {
      closeTabCtxMenu();
      const id = baseName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `app-${Date.now()}`;
      const result = await window.yo.appsAdd(id, baseName, url);
      if (result && typeof result === "object" && "error" in result) {
        alert((result as { error: string }).error);
      }
    });
    menu.appendChild(addBtn);

    // Position; clamp to viewport
    menu.style.top = `${y}px`;
    menu.style.left = `${x}px`;
    menu.style.visibility = "hidden";
    document.body.appendChild(menu);
    tabCtxMenu = menu;

    const margin = 8;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    if (x + w + margin > window.innerWidth) menu.style.left = `${Math.max(margin, window.innerWidth - w - margin)}px`;
    if (y + h + margin > window.innerHeight) menu.style.top = `${Math.max(margin, window.innerHeight - h - margin)}px`;
    menu.style.visibility = "";

    const onClickOutside = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) {
        closeTabCtxMenu();
        document.removeEventListener("click", onClickOutside);
        document.removeEventListener("contextmenu", onClickOutside);
      }
    };
    setTimeout(() => {
      document.addEventListener("click", onClickOutside);
      document.addEventListener("contextmenu", onClickOutside);
    }, 0);
  }

  function renderTabs(tabs: TabInfo[], activeId: string) {
    tabBar.innerHTML = "";
    for (const tab of tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (tab.id === activeId ? " tab-active" : "") + (tab.pinned ? " tab-pinned" : "");
      el.dataset.id = tab.id;

      // The Settings tab gets a gear icon.
      if (tab.id === "home") {
        const icon = document.createElement("span");
        icon.className = "tab-home-icon";
        icon.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
        el.appendChild(icon);
      } else if (tab.layoutFavicons && tab.layoutFavicons.length > 0) {
        const stack = document.createElement("span");
        stack.className = "tab-favicon-stack";
        for (let i = 0; i < Math.min(tab.layoutFavicons.length, 4); i++) {
          const img = document.createElement("img");
          img.className = "tab-favicon-stacked";
          img.width = 12;
          img.height = 12;
          img.src = tab.layoutFavicons[i];
          img.onerror = () => { img.style.display = "none"; };
          img.style.marginLeft = i > 0 ? "-6px" : "0";
          img.style.zIndex = String(10 - i);
          stack.appendChild(img);
        }
        el.appendChild(stack);
      } else if (isFilesApp(tab.id)) {
        const icon = document.createElement("span");
        icon.className = "tab-home-icon";
        icon.innerHTML = YO_BADGE;
        el.appendChild(icon);
      } else {
        const favicon = document.createElement("img");
        favicon.className = "tab-favicon";
        favicon.width = 14;
        favicon.height = 14;
        favicon.src = tab.favicon || "";
        favicon.onerror = () => { favicon.src = ""; };
        el.appendChild(favicon);
      }

      // Label
      {
        const label = document.createElement("span");
        label.className = "tab-label";
        label.textContent = tab.name;
        el.appendChild(label);
      }

      // Click to switch
      el.addEventListener("click", () => {
        window.yo.tabSwitch(tab.id);
      });

      // Close button — not shown on pinned (home) tabs
      if (!tab.pinned) {
        const close = document.createElement("button");
        close.className = "tab-close";
        close.title = "Close tab";
        close.innerHTML = "&times;";
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          window.yo.tabClose(tab.id);
        });
        el.appendChild(close);
      }

      // Right-click "Add as app" — only for browser tabs with a real URL
      const isBrowserTab = tab.id === "browser" || tab.id.startsWith("browse-");
      if (isBrowserTab && tab.url && /^https?:\/\//i.test(tab.url)) {
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openTabContextMenu(e.clientX, e.clientY, tab.id, tab.url!, tab.name);
        });
      }

      // Drag-and-drop reordering (not for pinned or layout tabs)
      if (!tab.pinned && tab.id !== "__layout__") {
        el.draggable = true;
        el.addEventListener("dragstart", (e) => {
          el.classList.add("tab-dragging");
          e.dataTransfer?.setData("text/plain", tab.id);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        });
        el.addEventListener("dragend", () => {
          el.classList.remove("tab-dragging");
          tabBar.querySelectorAll(".tab-drop-before,.tab-drop-after")
            .forEach((n) => n.classList.remove("tab-drop-before", "tab-drop-after"));
        });
      }
      el.addEventListener("dragover", (e) => {
        if (tab.pinned) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const rect = el.getBoundingClientRect();
        const midpoint = rect.left + rect.width / 2;
        el.classList.toggle("tab-drop-before", e.clientX < midpoint);
        el.classList.toggle("tab-drop-after", e.clientX >= midpoint);
      });
      el.addEventListener("dragleave", () => {
        el.classList.remove("tab-drop-before", "tab-drop-after");
      });
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        const draggedId = e.dataTransfer?.getData("text/plain");
        if (!draggedId || draggedId === tab.id) return;
        // Can't drop on pinned tab
        if (tab.pinned) return;
        const rect = el.getBoundingClientRect();
        const dropBefore = e.clientX < rect.left + rect.width / 2;
        // Compute new order from current DOM
        const currentOrder = Array.from(tabBar.querySelectorAll<HTMLElement>(".tab"))
          .map((n) => n.dataset.id!)
          .filter((id) => id && id !== "__layout__");
        const filtered = currentOrder.filter((id) => id !== draggedId);
        const targetIdx = filtered.indexOf(tab.id);
        filtered.splice(dropBefore ? targetIdx : targetIdx + 1, 0, draggedId);
        window.yo.tabReorder(filtered);
        el.classList.remove("tab-drop-before", "tab-drop-after");
      });

      tabBar.appendChild(el);
    }
    // Re-append the + button so it stays after the last tab
    tabBar.appendChild(tabNewBtn);
  }

  function updateEmptyState(tabs: TabInfo[]) {
    if (tabs.length === 0) {
      emptyState.classList.remove("hidden");
    } else {
      emptyState.classList.add("hidden");
    }
  }

  // When the active tab toggles between the swarm panel and anything else,
  // flip the .yo mode dropdown so messages route correctly: swarm mode
  // delegates to a local swarm; standard mode runs the normal agent.
  // Only fires on tab *change*, so a manual override (user picks standard
  // while the swarm tab is active) is preserved within that tab.
  function autoSwitchModeForActiveTab(tabs: TabInfo[], activeId: string) {
    if (!deps.isYoControlsInited()) return;
    void tabs;
    const target = activeId === "cypher" ? "swarm" : "standard";
    if (deps.getCurrentMode() === target) return;
    deps.setModeValue(target);
    deps.syncAgentMode();
  }

  // -- + button click handler --

  tabNewBtn.addEventListener("click", async (e) => {
    e.stopPropagation();

    if (tabNewMenu) { closeTabNewMenu(); return; }

    const apps = await window.yo.appsList();
    const appsWithUrl = apps.filter((a) => a.url);

    if (appsWithUrl.length === 0) {
      window.yo.tabNew();
      return;
    }

    window.yo.panelsHide();

    const menu = document.createElement("div");
    menu.className = "tab-new-menu";

    // Search input
    const searchInput = document.createElement("input");
    searchInput.className = "tab-new-menu-search";
    searchInput.type = "text";
    searchInput.placeholder = "Search apps...";
    searchInput.spellcheck = false;
    menu.appendChild(searchInput);

    // Scrollable list
    const list = document.createElement("div");
    list.className = "tab-new-menu-list";

    const browserBtn = document.createElement("button");
    browserBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg><span>Browser</span>`;
    browserBtn.addEventListener("click", () => { closeTabNewMenu(); window.yo.tabNew(); });
    list.appendChild(browserBtn);

    const divider = document.createElement("div");
    divider.className = "tab-new-menu-divider";
    list.appendChild(divider);

    for (const app of appsWithUrl) {
      const btn = document.createElement("button");
      btn.dataset.name = app.name.toLowerCase();
      let iconHtml = "";
      if (isFilesApp(app.id)) {
        iconHtml = YO_BADGE;
      } else if (app.url!.startsWith("yo://")) {
        iconHtml = `<span class="tab-new-menu-initial">${app.name.charAt(0).toUpperCase()}</span>`;
      } else {
        try {
          const domain = new URL(app.url!).hostname;
          iconHtml = `<img src="https://www.google.com/s2/favicons?domain=${domain}&sz=32" width="14" height="14" style="border-radius:2px;" onerror="this.style.display='none'" />`;
        } catch {
          iconHtml = `<span class="tab-new-menu-initial">${app.name.charAt(0).toUpperCase()}</span>`;
        }
      }
      btn.innerHTML = `${iconHtml}<span>${app.name}</span>`;
      btn.addEventListener("click", () => { closeTabNewMenu(); window.yo.tabNewApp(app.id); });
      list.appendChild(btn);
    }

    menu.appendChild(list);

    // Filter on search input
    searchInput.addEventListener("input", () => {
      const q = searchInput.value.toLowerCase();
      list.querySelectorAll<HTMLButtonElement>("button[data-name]").forEach((btn) => {
        btn.style.display = btn.dataset.name!.includes(q) ? "" : "none";
      });
    });

    const rect = tabNewBtn.getBoundingClientRect();
    // Pre-position off-screen so we can measure without flashing in the wrong spot.
    menu.style.top = "0px";
    menu.style.left = "-9999px";
    menu.style.visibility = "hidden";

    document.body.appendChild(menu);
    tabNewMenu = menu;

    // Measure now that the menu is in the DOM with its real content.
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Horizontal: prefer left-anchored to button. Flip to right-anchored
    // when the menu would overflow the right edge.
    let left = rect.left;
    if (left + menuWidth + margin > vw) {
      left = rect.right - menuWidth;
    }
    // Final viewport clamp on both sides.
    left = Math.min(Math.max(margin, left), vw - menuWidth - margin);

    // Vertical: prefer below button. Flip above if it would overflow the bottom
    // and there's more room above.
    let top = rect.bottom + 4;
    if (top + menuHeight + margin > vh && rect.top - menuHeight - 4 >= margin) {
      top = rect.top - menuHeight - 4;
    }
    top = Math.min(Math.max(margin, top), vh - menuHeight - margin);

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "";

    searchInput.focus();

    const onClickOutside = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node) && ev.target !== tabNewBtn) {
        closeTabNewMenu();
        document.removeEventListener("click", onClickOutside);
      }
    };
    setTimeout(() => document.addEventListener("click", onClickOutside), 0);
  });

  // -- IPC listener: tab state updates --

  window.yo.onTabState((state: { tabs: TabInfo[]; activeId: string; visible: boolean }) => {
    renderTabs(state.tabs, state.activeId);
    tabBar.style.display = state.visible ? "flex" : "none";
    tabNewBtn.style.display = state.visible ? "" : "none";
    updateEmptyState(state.tabs);
    if (state.activeId !== lastActiveTabId) {
      autoSwitchModeForActiveTab(state.tabs, state.activeId);
    }
    lastActiveTabId = state.activeId;
  });

  // Load initial tab state
  window.yo.tabList().then((state) => {
    renderTabs(state.tabs, state.activeId);
    tabBar.style.display = state.visible ? "flex" : "none";
    tabNewBtn.style.display = state.visible ? "" : "none";
    updateEmptyState(state.tabs);
  });

  return { renderTabs, autoSwitchModeForActiveTab };
}
