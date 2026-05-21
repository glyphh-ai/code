// @ts-nocheck
/**
 * confirm.ts — themed promise-based confirm dialog (#ws-confirm-modal).
 * Mirrors home.html's confirmAction. Registers ctx.wsConfirm.
 */
export function initConfirm(ctx) {
  const $ = (id) => document.getElementById(id);

  function wsConfirm(message, opts) {
    const yesLabel = (opts && opts.yes) || "Delete";
    const noLabel  = (opts && opts.no)  || "Cancel";
    return new Promise((resolve) => {
      const overlay = $("ws-confirm-modal");
      const msgEl   = $("ws-confirm-message");
      const yesBtn  = $("ws-confirm-yes");
      const noBtn   = $("ws-confirm-no");
      msgEl.textContent = message;
      yesBtn.textContent = yesLabel;
      noBtn.textContent  = noLabel;
      overlay.classList.add("open");
      overlay.setAttribute("aria-hidden", "false");
      function cleanup(v) {
        overlay.classList.remove("open");
        overlay.setAttribute("aria-hidden", "true");
        yesBtn.removeEventListener("click", onYes);
        noBtn.removeEventListener("click", onNo);
        overlay.removeEventListener("click", onBackdrop);
        document.removeEventListener("keydown", onKey);
        resolve(v);
      }
      function onYes() { cleanup(true); }
      function onNo()  { cleanup(false); }
      function onBackdrop(e) { if (e.target === overlay) cleanup(false); }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); cleanup(false); }
        else if (e.key === "Enter") { e.preventDefault(); cleanup(true); }
      }
      yesBtn.addEventListener("click", onYes);
      noBtn.addEventListener("click", onNo);
      overlay.addEventListener("click", onBackdrop);
      document.addEventListener("keydown", onKey);
      setTimeout(() => yesBtn.focus(), 30);
    });
  }

  ctx.wsConfirm = wsConfirm;
}
