// grid-ui.ts — Grid drag handles + cell URL bars extracted from renderer.ts

type GridInfo = {
  panelIds: string[];
  cols: number;
  rows: number;
  colWidths: number[];
  rowHeights: number[];
  cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>;
  cellBounds?: Array<{ panelId: string; x: number; y: number; width: number }>;
};

/**
 * Callbacks and accessors that the grid module needs from renderer.ts.
 */
export interface GridDeps {
  isYoPanelOpen: () => boolean;
  getYoPanelWidth: () => number;
  /** Width of the left rail inset — panels start at this x offset. */
  getLeftInset: () => number;
  isUrlBarHidden: () => boolean;
  setUrlBarVisibility: (hidden: boolean) => void;
  showPanelScreenshots: () => Promise<void>;
  clearPanelScreenshots: () => void;
}

export function initGrid(deps: GridDeps): {
  renderGridHandles: () => void;
  renderCellUrlBars: () => void;
} {
  const gridHandles = document.getElementById("grid-handles")!;
  const cellUrlContainer = document.getElementById("cell-url-bars")!;

  let currentGrid: GridInfo | null = null;
  let isDragging = false;
  let dragType: "col" | "row" = "col";
  let dragIndex = 0;

  // Per-panel URL tracking for cell URL bars
  const panelUrlCache: Record<string, string> = {};
  const panelFaviconCache: Record<string, string> = {};

  function getContentTop(): number {
    if (deps.isUrlBarHidden()) return 38;
    // In grid mode, global URL bar is visibility:hidden — grid starts at titlebar
    if (currentGrid && currentGrid.panelIds.length > 1) return 38;
    return 72;
  }

  /** Available width for panels (accounts for the left rail + yo panel insets) */
  function getAvailableWidth(): number {
    const rightInset = deps.isYoPanelOpen() ? deps.getYoPanelWidth() : 0;
    return window.innerWidth - deps.getLeftInset() - rightInset;
  }

  function renderCellUrlBars() {
    cellUrlContainer.innerHTML = "";
    if (!currentGrid || !currentGrid.cellBounds || currentGrid.cellBounds.length < 2) return;
    if (deps.isUrlBarHidden()) return; // only when URL bars enabled

    for (const cb of currentGrid.cellBounds) {
      const bar = document.createElement("div");
      bar.className = "cell-url-bar";
      bar.style.left = `${cb.x}px`;
      bar.style.top = `${cb.y}px`;
      bar.style.width = `${cb.width}px`;

      const pid = cb.panelId;

      // Back button
      const backBtn = document.createElement("button");
      backBtn.className = "cell-nav-btn";
      backBtn.title = "Back";
      backBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M15 18l-6-6 6-6"/></svg>';
      backBtn.addEventListener("click", () => window.yo.panelNavBack(pid));
      bar.appendChild(backBtn);

      // Forward button
      const fwdBtn = document.createElement("button");
      fwdBtn.className = "cell-nav-btn";
      fwdBtn.title = "Forward";
      fwdBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 18l6-6-6-6"/></svg>';
      fwdBtn.addEventListener("click", () => window.yo.panelNavForward(pid));
      bar.appendChild(fwdBtn);

      // Refresh button
      const refreshBtn = document.createElement("button");
      refreshBtn.className = "cell-nav-btn";
      refreshBtn.title = "Refresh";
      refreshBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
      refreshBtn.addEventListener("click", () => window.yo.panelNavRefresh(pid));
      bar.appendChild(refreshBtn);

      const fav = document.createElement("img");
      fav.className = "cell-url-bar-favicon";
      fav.width = 12;
      fav.height = 12;
      fav.src = panelFaviconCache[cb.panelId] || "";
      fav.onerror = () => { fav.src = ""; };
      bar.appendChild(fav);

      const input = document.createElement("input");
      input.className = "cell-url-bar-text";
      input.type = "text";
      input.value = panelUrlCache[cb.panelId] || "";
      input.title = panelUrlCache[cb.panelId] || cb.panelId;
      input.spellcheck = false;
      input.addEventListener("focus", () => input.select());
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const url = input.value.trim();
          if (url) {
            window.yo.panelNavTo(pid, url);
            input.blur();
          }
        }
        if (e.key === "Escape") {
          input.value = panelUrlCache[cb.panelId] || "";
          input.blur();
        }
      });
      bar.appendChild(input);

      cellUrlContainer.appendChild(bar);
    }
  }

  function renderGridHandles() {
    gridHandles.innerHTML = "";
    if (!currentGrid || currentGrid.panelIds.length < 2) return;

    const grid = currentGrid;

    const cells = grid.cells || [];

    // Column border handles — offset by the left rail, sized to available width
    const availW = getAvailableWidth();
    const leftInset = deps.getLeftInset();
    let cumCol = 0;
    for (let i = 0; i < grid.cols - 1; i++) {
      cumCol += grid.colWidths[i];
      const border = i + 1;
      const hasEdge = cells.some((c) => c.col === border || c.col + c.colSpan === border);
      if (!hasEdge) continue;
      const handle = document.createElement("div");
      handle.className = "grid-col-handle";
      handle.style.left = `${leftInset + Math.round(cumCol * availW)}px`;
      handle.dataset.type = "col";
      handle.dataset.index = String(i);
      gridHandles.appendChild(handle);
      handle.addEventListener("mousedown", (e) => startDrag(e, "col", i));
    }

    // Row border handles — span the content area (start after the left rail)
    let cumRow = 0;
    for (let i = 0; i < grid.rows - 1; i++) {
      cumRow += grid.rowHeights[i];
      const border = i + 1;
      const hasEdge = cells.some((c) => c.row === border || c.row + c.rowSpan === border);
      if (!hasEdge) continue;
      const handle = document.createElement("div");
      handle.className = "grid-row-handle";
      handle.style.top = `${getContentTop() + cumRow * (window.innerHeight - getContentTop())}px`;
      handle.style.left = `${leftInset}px`;
      handle.dataset.type = "row";
      handle.dataset.index = String(i);
      gridHandles.appendChild(handle);
      handle.addEventListener("mousedown", (e) => startDrag(e, "row", i));
    }
  }

  // Reposition handles on window resize
  window.addEventListener("resize", () => {
    if (!currentGrid) return;
    const aw = getAvailableWidth();
    const leftInset = deps.getLeftInset();
    gridHandles.querySelectorAll<HTMLElement>(".grid-col-handle").forEach((h) => {
      const idx = parseInt(h.dataset.index!, 10);
      let cc = 0;
      for (let j = 0; j <= idx; j++) cc += currentGrid!.colWidths[j];
      h.style.left = `${leftInset + Math.round(cc * aw)}px`;
    });
    const contentHeight = window.innerHeight - getContentTop();
    gridHandles.querySelectorAll<HTMLElement>(".grid-row-handle").forEach((h) => {
      const idx = parseInt(h.dataset.index!, 10);
      let cr = 0;
      for (let j = 0; j <= idx; j++) cr += currentGrid!.rowHeights[j];
      h.style.top = `${getContentTop() + cr * contentHeight}px`;
      h.style.left = `${leftInset}px`;
    });
  });

  // -- Drag protocol --

  async function startDrag(e: MouseEvent, type: "col" | "row", index: number) {
    e.preventDefault();
    isDragging = true;
    dragType = type;
    dragIndex = index;

    const handle = e.currentTarget as HTMLElement;
    handle.classList.add("dragging");

    // Capture freeze-frame before hiding panels
    await deps.showPanelScreenshots();
    window.yo.panelsHide();

    const overlay = document.getElementById("drag-overlay")!;
    overlay.classList.remove("hidden");
    overlay.className = type === "col" ? "drag-col" : "drag-row";
  }

  document.addEventListener("mousemove", (e) => {
    if (!isDragging || !currentGrid) return;

    if (dragType === "col") {
      const aw = getAvailableWidth();
      const leftInset = deps.getLeftInset();
      const fraction = (e.clientX - leftInset) / aw;
      const clamped = Math.max(0.05, Math.min(0.95, fraction));
      const handle = gridHandles.querySelector<HTMLElement>(`.grid-col-handle[data-index="${dragIndex}"]`);
      if (handle) handle.style.left = `${leftInset + Math.round(clamped * aw)}px`;
    } else {
      const contentHeight = window.innerHeight - getContentTop();
      const fraction = (e.clientY - getContentTop()) / contentHeight;
      const clamped = Math.max(0.05, Math.min(0.95, fraction));
      const handle = gridHandles.querySelector<HTMLElement>(`.grid-row-handle[data-index="${dragIndex}"]`);
      if (handle) handle.style.top = `${getContentTop() + clamped * contentHeight}px`;
    }
  });

  document.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;

    gridHandles.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));

    const overlay = document.getElementById("drag-overlay")!;
    overlay.classList.add("hidden");
    overlay.className = "";

    // Clear screenshots before restoring real panels
    deps.clearPanelScreenshots();

    if (dragType === "col") {
      const handle = gridHandles.querySelector<HTMLElement>(`.grid-col-handle[data-index="${dragIndex}"]`);
      if (handle) {
        const fraction = (parseFloat(handle.style.left) - deps.getLeftInset()) / getAvailableWidth();
        window.yo.gridDragEnd("col", dragIndex, fraction);
      }
    } else {
      const handle = gridHandles.querySelector<HTMLElement>(`.grid-row-handle[data-index="${dragIndex}"]`);
      if (handle) {
        const contentHeight = window.innerHeight - getContentTop();
        const top = parseFloat(handle.style.top) - getContentTop();
        const fraction = top / contentHeight;
        window.yo.gridDragEnd("row", dragIndex, fraction);
      }
    }
  });

  // -- IPC listeners --

  // Listen for per-panel URL + favicon updates (for cell URL bars)
  window.yo.onPanelUrlUpdate((info) => {
    panelUrlCache[info.id] = info.url;
    panelFaviconCache[info.id] = info.favicon;
    renderCellUrlBars();
  });

  window.yo.onSplitState((info) => {
    currentGrid = info;
    renderGridHandles();

    const isGrid = info && info.panelIds.length > 1;
    if (isGrid && !deps.isUrlBarHidden()) {
      // In grid mode: hide global URL bar, show per-cell URL bars
      deps.setUrlBarVisibility(true);
    } else {
      deps.setUrlBarVisibility(false);
    }
    renderCellUrlBars();
  });

  return { renderGridHandles, renderCellUrlBars };
}
