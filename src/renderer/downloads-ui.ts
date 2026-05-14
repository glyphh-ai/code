// downloads-ui.ts — Downloads dropdown extracted from renderer.ts

interface DlEntry {
  id: string;
  filename: string;
  savePath: string;
  totalBytes: number;
  receivedBytes: number;
  state: "downloading" | "completed" | "cancelled" | "interrupted";
  startedAt: number;
}

const dlHistory: DlEntry[] = [];

function dlFormatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dlFileIcon(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  const icons: Record<string, string> = {
    pdf: "📄", zip: "📦", gz: "📦", tar: "📦", rar: "📦", "7z": "📦",
    png: "🖼", jpg: "🖼", jpeg: "🖼", gif: "🖼", svg: "🖼", webp: "🖼",
    mp4: "🎬", mov: "🎬", avi: "🎬", mkv: "🎬", webm: "🎬",
    mp3: "🎵", wav: "🎵", flac: "🎵", ogg: "🎵",
    dmg: "💿", exe: "💿", msi: "💿", pkg: "💿",
    doc: "📝", docx: "📝", xls: "📊", xlsx: "📊", csv: "📊",
  };
  return icons[ext] || "📎";
}

function dlUpdateBadge(dlBadgeCount: HTMLElement, dlBtn: HTMLElement): void {
  const active = dlHistory.filter((d) => d.state === "downloading").length;
  if (active > 0) {
    dlBadgeCount.textContent = String(active);
    dlBadgeCount.classList.remove("hidden");
    dlBtn.classList.add("dl-active");
  } else {
    dlBadgeCount.classList.add("hidden");
    dlBtn.classList.remove("dl-active");
  }
}

function dlRenderList(dlList: HTMLElement, dlDropdown: HTMLElement): void {
  if (dlHistory.length === 0) {
    dlList.innerHTML = `<div class="dl-empty">No downloads yet</div>`;
    return;
  }

  dlList.innerHTML = "";
  for (const entry of dlHistory) {
    const item = document.createElement("div");
    item.className = "dl-item";
    item.dataset.id = entry.id;

    const icon = document.createElement("div");
    icon.className = "dl-item-icon" + (entry.state === "interrupted" || entry.state === "cancelled" ? " dl-error" : "");
    icon.textContent = entry.state === "interrupted" || entry.state === "cancelled" ? "✕" : dlFileIcon(entry.filename);

    const info = document.createElement("div");
    info.className = "dl-item-info";

    const name = document.createElement("div");
    name.className = "dl-item-name";
    name.textContent = entry.filename;
    name.title = entry.filename;
    info.appendChild(name);

    const meta = document.createElement("div");
    meta.className = "dl-item-meta";
    if (entry.state === "downloading") {
      const pct = entry.totalBytes > 0 ? Math.round((entry.receivedBytes / entry.totalBytes) * 100) : 0;
      meta.textContent = entry.totalBytes > 0
        ? `${dlFormatBytes(entry.receivedBytes)} / ${dlFormatBytes(entry.totalBytes)} — ${pct}%`
        : `${dlFormatBytes(entry.receivedBytes)}`;
    } else if (entry.state === "completed") {
      meta.textContent = entry.totalBytes > 0 ? dlFormatBytes(entry.totalBytes) : "Done";
    } else {
      meta.textContent = entry.state === "cancelled" ? "Cancelled" : "Failed";
    }
    info.appendChild(meta);

    if (entry.state === "downloading") {
      const prog = document.createElement("div");
      prog.className = "dl-item-progress";
      const fill = document.createElement("div");
      fill.className = "dl-item-progress-fill";
      fill.style.width = entry.totalBytes > 0 ? `${Math.min(100, (entry.receivedBytes / entry.totalBytes) * 100)}%` : "0%";
      prog.appendChild(fill);
      info.appendChild(prog);
    }

    item.appendChild(icon);
    item.appendChild(info);

    if (entry.state === "completed" && entry.savePath) {
      const showBtn = document.createElement("button");
      showBtn.className = "dl-item-action";
      showBtn.title = "Show in folder";
      showBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
      showBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        window.yo.downloadShow(entry.savePath);
      });
      const actions = document.createElement("div");
      actions.className = "dl-item-actions";
      actions.appendChild(showBtn);
      item.appendChild(actions);
    }

    item.addEventListener("click", () => {
      if (entry.state === "completed" && entry.savePath) {
        window.yo.downloadShow(entry.savePath);
      }
    });

    dlList.appendChild(item);
  }
}

function dlToggleDropdown(dlDropdown: HTMLElement, dlList: HTMLElement): void {
  const open = !dlDropdown.classList.contains("hidden");
  if (open) {
    dlDropdown.classList.add("hidden");
  } else {
    dlDropdown.classList.remove("hidden");
    dlRenderList(dlList, dlDropdown);
  }
}

export function initDownloads(): void {
  const dlBtn = document.getElementById("dl-btn")!;
  const dlBadgeCount = document.getElementById("dl-badge-count")!;
  const dlDropdown = document.getElementById("dl-dropdown")!;
  const dlList = document.getElementById("dl-list")!;
  const dlClearAll = document.getElementById("dl-clear-all")!;

  dlBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    dlToggleDropdown(dlDropdown, dlList);
  });

  dlClearAll.addEventListener("click", () => {
    const active = dlHistory.filter((d) => d.state === "downloading");
    dlHistory.length = 0;
    dlHistory.push(...active);
    dlUpdateBadge(dlBadgeCount, dlBtn);
    dlRenderList(dlList, dlDropdown);
  });

  document.addEventListener("click", (e) => {
    if (!dlDropdown.classList.contains("hidden") && !(e.target as Element)?.closest?.("#dl-btn-wrap")) {
      dlDropdown.classList.add("hidden");
    }
  });

  window.yo.onDownloadStart(({ filename, totalBytes, savePath }) => {
    const entry: DlEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      filename,
      savePath: savePath || "",
      totalBytes,
      receivedBytes: 0,
      state: "downloading",
      startedAt: Date.now(),
    };
    dlHistory.unshift(entry);
    if (dlHistory.length > 50) dlHistory.pop();
    dlUpdateBadge(dlBadgeCount, dlBtn);
    if (!dlDropdown.classList.contains("hidden")) dlRenderList(dlList, dlDropdown);
  });

  window.yo.onDownloadProgress(({ filename, receivedBytes, totalBytes }) => {
    const entry = dlHistory.find((d) => d.filename === filename && d.state === "downloading");
    if (!entry) return;
    entry.receivedBytes = receivedBytes;
    if (totalBytes > 0) entry.totalBytes = totalBytes;
    if (!dlDropdown.classList.contains("hidden")) dlRenderList(dlList, dlDropdown);
  });

  window.yo.onDownloadDone(({ filename, savePath, state }) => {
    const entry = dlHistory.find((d) => d.filename === filename && d.state === "downloading");
    if (!entry) return;
    entry.state = state as DlEntry["state"];
    entry.savePath = savePath || entry.savePath;
    if (state === "completed" && entry.totalBytes > 0) entry.receivedBytes = entry.totalBytes;
    dlUpdateBadge(dlBadgeCount, dlBtn);
    if (!dlDropdown.classList.contains("hidden")) dlRenderList(dlList, dlDropdown);
  });
}
