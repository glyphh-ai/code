// @ts-nocheck
/**
 * recents.ts — the left-rail chat history list, driven by window.__yoPanel
 * (the Electron renderer bridge). Row click loads a chat; the 3-dot menu
 * pins / renames / archives / shares / deletes. Registers ctx.renderRecents.
 * Depends on ctx.clearStack, ctx.closeAllChatOverlays, ctx.wsConfirm,
 * ctx.placeView, ctx.viewIsOpen.
 */
export function initRecents(ctx) {
  const $ = (id) => document.getElementById(id);
  const { clearStack, closeAllChatOverlays, wsConfirm, placeView, viewIsOpen } = ctx;

  const recentsListEl = $("recents-list");
  const recentsMenu   = $("recents-menu");
  let recentsActiveId = null;
  let recentsMenuId   = null;

  function relTime(ts) {
    if (!ts) return "";
    const d = new Date(ts), now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return "now";
    if (diff < 3600) return Math.floor(diff / 60) + "m";
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (diff < 7 * 86400) return Math.floor(diff / 86400) + "d";
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  const recentsPinned   = new Set(JSON.parse(localStorage.getItem("ws-recents-pinned")  || "[]"));
  const recentsArchived = new Set(JSON.parse(localStorage.getItem("ws-recents-archived") || "[]"));
  function saveRecentsState() {
    localStorage.setItem("ws-recents-pinned",   JSON.stringify([...recentsPinned]));
    localStorage.setItem("ws-recents-archived", JSON.stringify([...recentsArchived]));
  }

  async function renderRecents() {
    const panel = window.__yoPanel;
    if (!panel || !recentsListEl) return;          // browser preview: keep placeholder
    let chats = [];
    try { chats = await panel.listChats(); } catch { chats = []; }
    // Task runs (type === "run") live in Activity, not Recents.
    chats = chats.filter((c) => c.type !== "run" && !recentsArchived.has(c.id));
    chats.sort((a, b) => (recentsPinned.has(b.id) ? 1 : 0) - (recentsPinned.has(a.id) ? 1 : 0));
    recentsListEl.innerHTML = "";
    if (!chats.length) {
      const empty = document.createElement("div");
      empty.className = "ws-list-empty";
      empty.textContent = "No conversations yet";
      recentsListEl.appendChild(empty);
      return;
    }
    chats.forEach((chat) => {
      const row = document.createElement("div");
      row.className = "ws-list-item" + (chat.id === recentsActiveId ? " active" : "");
      row.dataset.id = chat.id;
      const pinned = recentsPinned.has(chat.id);
      row.innerHTML = `
        ${pinned ? `<svg class="ws-list-pin" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14 4v5l3 3v2h-5v5l-1 1-1-1v-5H5v-2l3-3V4z"/></svg>` : ""}
        <span class="label"></span>
        <span class="hint"></span>
        <button class="ws-list-menu" title="More" aria-label="More">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>
          </svg>
        </button>
      `;
      row.querySelector(".label").textContent = chat.title || "Untitled";
      row.querySelector(".hint").textContent  = relTime(chat.created);
      row.querySelector(".ws-list-menu").addEventListener("click", (e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        recentsMenuId = chat.id;
        const pinBtn = recentsMenu.querySelector('[data-recent="pin"]');
        if (pinBtn) pinBtn.textContent = recentsPinned.has(chat.id) ? "Unpin" : "Pin";
        recentsMenu.style.left = Math.min(window.innerWidth - 160, r.left) + "px";
        recentsMenu.style.top  = (r.bottom + 4) + "px";
        recentsMenu.classList.add("open");
      });
      row.addEventListener("click", (e) => {
        if (e.target.closest(".ws-list-menu")) return;
        recentsActiveId = chat.id;
        clearStack();
        closeAllChatOverlays();
        panel.loadChat(chat.id);
        recentsListEl.querySelectorAll(".ws-list-item").forEach((r) =>
          r.classList.toggle("active", r.dataset.id === chat.id));
      });
      recentsListEl.appendChild(row);
    });
  }

  function startRenameRecent(id) {
    const row = recentsListEl.querySelector(`.ws-list-item[data-id="${id}"]`);
    if (!row) return;
    const label = row.querySelector(".label");
    const current = label.textContent;
    const input = document.createElement("input");
    input.className = "ws-list-rename";
    input.value = current;
    label.replaceWith(input);
    input.focus();
    input.select();
    const commit = async (save) => {
      const next = input.value.trim();
      const span = document.createElement("span");
      span.className = "label";
      span.textContent = save && next ? next : current;
      input.replaceWith(span);
      if (save && next && next !== current) {
        if (window.yo && window.yo.yoChatRename) {
          try { await window.yo.yoChatRename(id, next); } catch (err) { console.warn("[recents] rename failed:", err); }
        }
        renderRecents();
      }
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
    input.addEventListener("blur", () => commit(true));
  }

  if (recentsMenu) {
    recentsMenu.addEventListener("click", async (e) => {
      const btn = e.target.closest(".ws-popover-item");
      if (!btn) return;
      const action = btn.dataset.recent;
      const id = recentsMenuId;
      recentsMenu.classList.remove("open");
      recentsMenuId = null;
      if (!id) return;
      const panel = window.__yoPanel;
      if (action === "pin") {
        if (recentsPinned.has(id)) recentsPinned.delete(id); else recentsPinned.add(id);
        saveRecentsState();
        if (window.yo && window.yo.yoChatPin) { try { window.yo.yoChatPin(id, recentsPinned.has(id)); } catch {} }
        renderRecents();
      } else if (action === "rename") {
        startRenameRecent(id);
      } else if (action === "archive") {
        recentsArchived.add(id);
        saveRecentsState();
        if (window.yo && window.yo.yoChatArchive) { try { window.yo.yoChatArchive(id, true); } catch {} }
        if (recentsActiveId === id) recentsActiveId = null;
        renderRecents();
      } else if (action === "share") {
        if (window.yo && window.yo.yoChatShare) {
          try { await window.yo.yoChatShare(id); } catch (err) { console.warn("[recents] share failed:", err); }
        } else {
          console.log("[recents] share — backend hook TBD for", id);
        }
      } else if (action === "delete") {
        const ok = await wsConfirm("Delete this conversation? This can't be undone.");
        if (!ok) return;
        await panel.deleteChat(id);
        recentsPinned.delete(id); recentsArchived.delete(id); saveRecentsState();
        if (recentsActiveId === id) recentsActiveId = null;
        renderRecents();
      }
    });
  }
  document.addEventListener("click", (e) => {
    if (!recentsMenu || !recentsMenu.classList.contains("open")) return;
    if (recentsMenu.contains(e.target)) return;
    recentsMenu.classList.remove("open");
    recentsMenuId = null;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && recentsMenu && recentsMenu.classList.contains("open")) {
      recentsMenu.classList.remove("open");
      recentsMenuId = null;
    }
  });

  window.addEventListener("yo-panel-ready", renderRecents);
  if (window.__yoPanel) renderRecents();

  // "view output" links inside the Customize / Schedules slide → open
  // the Activity view in the right rail. Event delegation.
  document.addEventListener("click", (e) => {
    const link = e.target.closest("[data-activity='open']");
    if (!link) return;
    e.preventDefault();
    if (!viewIsOpen("activity")) placeView("activity");
  });

  ctx.renderRecents = renderRecents;
}
