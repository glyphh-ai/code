/**
 * yo-modal.ts — theme-aware in-app dialogs.
 *
 * Replaces the browser's native `confirm()` / `alert()` (which render as raw OS
 * chrome that ignores the app theme) with a themed modal built from the same
 * CSS variables the rest of the shell uses. Returns a Promise so async click
 * handlers can `await yoConfirm(...)` exactly where they used to call confirm().
 */

export interface YoConfirmOpts {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** Style the confirm button as destructive (red) instead of accent. */
  danger?: boolean;
}

/** Themed replacement for window.confirm — resolves true on confirm, false on
 *  cancel / Escape / backdrop click. Only one dialog shows at a time. */
export function yoConfirm(opts: YoConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    // Guard against stacking — if a dialog is already up, dismiss it first.
    document.querySelectorAll(".yo-modal").forEach((el) => el.remove());

    const overlay = document.createElement("div");
    overlay.className = "yo-modal";

    const backdrop = document.createElement("div");
    backdrop.className = "yo-modal-backdrop";

    const panel = document.createElement("div");
    panel.className = "yo-modal-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");

    if (opts.title) {
      const title = document.createElement("div");
      title.className = "yo-modal-title";
      title.textContent = opts.title;
      panel.appendChild(title);
    }

    const body = document.createElement("div");
    body.className = "yo-modal-message";
    body.textContent = opts.message;
    panel.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "yo-modal-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "yo-modal-btn yo-modal-btn-cancel";
    cancelBtn.textContent = opts.cancelText ?? "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "yo-modal-btn yo-modal-btn-confirm" + (opts.danger ? " yo-modal-btn-danger" : "");
    confirmBtn.textContent = opts.confirmText ?? "Continue";

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    panel.appendChild(actions);

    overlay.appendChild(backdrop);
    overlay.appendChild(panel);

    function close(result: boolean): void {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(result);
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(false); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); close(true); }
    }

    cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
    backdrop.addEventListener("click", () => close(false));
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(overlay);
    // Defer focus a tick so the dialog is painted before it grabs focus.
    requestAnimationFrame(() => confirmBtn.focus());
  });
}
