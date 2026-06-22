// command-center-ui.ts — "Command Center": a zoom-out view of every open app +
// saved layouts. Opened with Cmd+Shift+. (or the titlebar icon).
//
// App panels are native BrowserViews painted above the DOM, so a DOM overlay is
// invisible while any view is attached. We therefore detach the views
// (panelsHide) while the overlay is up and restore them (panelsShow) on close —
// the same freeze trick modals use. Hovering a card magnifies it; clicking opens
// or brings that app to the front (in canvas mode it focuses the window).

type Tab = { id: string; name: string; favicon?: string };
type Layout = { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> };

interface CcYo {
  onTabState: (cb: (s: { tabs: Tab[]; activeId: string }) => void) => void;
  layoutsList: () => Promise<Layout[]>;
  panelsHide: () => void;
  panelsShow: () => void;
  tabSwitch: (id: string) => void;
  canvasFocus: (id: string) => void;
  execCommand: (cmd: string) => Promise<string>;
}

export function initCommandCenter(): { toggle: () => void; isOpen: () => boolean } {
  const yo = window.yo as unknown as CcYo;
  const overlay = document.getElementById("command-center");
  if (!overlay) return { toggle: () => {}, isOpen: () => false };
  const appsGrid = overlay.querySelector("#cc-apps") as HTMLElement;
  const layoutsRow = overlay.querySelector("#cc-layouts") as HTMLElement;

  let open = false;
  let tabs: Tab[] = [];
  let activeId = "";

  yo.onTabState((s) => { tabs = (s.tabs || []).filter((t) => t.id !== "__layout__"); activeId = s.activeId; });

  function inCanvas(): boolean { return document.body.classList.contains("canvas-mode"); }

  function miniGrid(l: Layout): string {
    const cells = l.splits.map((c) => {
      const left = (l.colWidths.slice(0, c.col).reduce((a, b) => a + b, 0)) * 100;
      const top = (l.rowHeights.slice(0, c.row).reduce((a, b) => a + b, 0)) * 100;
      const w = l.colWidths.slice(c.col, c.col + c.colSpan).reduce((a, b) => a + b, 0) * 100;
      const h = l.rowHeights.slice(c.row, c.row + c.rowSpan).reduce((a, b) => a + b, 0) * 100;
      return `<div class="cc-mini-cell" style="left:${left}%;top:${top}%;width:${w}%;height:${h}%"></div>`;
    }).join("");
    return `<div class="cc-mini">${cells}</div>`;
  }

  async function build(): Promise<void> {
    appsGrid.innerHTML = "";
    if (tabs.length === 0) {
      appsGrid.innerHTML = `<div class="cc-empty">No apps open</div>`;
    }
    for (const tab of tabs) {
      const card = document.createElement("button");
      card.className = "cc-card" + (tab.id === activeId ? " cc-card--active" : "");
      const initial = (tab.name || tab.id).charAt(0).toUpperCase();
      card.innerHTML = `
        <div class="cc-card-shot">
          ${tab.favicon ? `<img class="cc-card-fav" src="${tab.favicon}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" /><span class="cc-card-initial" style="display:none">${initial}</span>` : `<span class="cc-card-initial" style="display:flex">${initial}</span>`}
        </div>
        <span class="cc-card-name">${escapeHtml(tab.name || tab.id)}</span>`;
      card.addEventListener("click", () => select(tab.id));
      appsGrid.appendChild(card);
    }

    layoutsRow.innerHTML = "";
    try {
      const layouts = await yo.layoutsList();
      if (layouts.length === 0) {
        layoutsRow.innerHTML = `<div class="cc-empty">No saved layouts</div>`;
      }
      for (const l of layouts) {
        const card = document.createElement("button");
        card.className = "cc-layout-card";
        card.innerHTML = `${miniGrid(l)}<span class="cc-card-name">${escapeHtml(l.name)}</span>`;
        card.addEventListener("click", () => applyLayout(l.name));
        layoutsRow.appendChild(card);
      }
    } catch { /* */ }
  }

  function select(id: string): void {
    close();
    if (inCanvas()) yo.canvasFocus(id);
    else yo.tabSwitch(id);
  }

  function applyLayout(name: string): void {
    close();
    void yo.execCommand(`dip ${name}`);
  }

  function doOpen(): void {
    if (open) return;
    open = true;
    overlay!.classList.remove("hidden");
    document.body.classList.add("cc-open");
    yo.panelsHide(); // detach BrowserViews so the overlay is visible
    void build();
  }

  function close(): void {
    if (!open) return;
    open = false;
    overlay!.classList.add("hidden");
    document.body.classList.remove("cc-open");
    yo.panelsShow();
  }

  function toggle(): void { open ? close() : doOpen(); }

  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); close(); } }, true);

  const closeBtn = overlay.querySelector("#cc-close") as HTMLElement | null;
  closeBtn?.addEventListener("click", () => close());

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  }

  return { toggle, isOpen: () => open };
}
