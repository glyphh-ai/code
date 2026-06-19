/**
 * Onboarding — inline email auth gate styled to match the yo-platform
 * web register/login page (auth-shell). Clean centered card on a black
 * background; no animation. All IPC wiring is preserved.
 */

// ── Onboarding UI logic ──────────────────────────────────
// The onboarding HTML only exists in index.html (main renderer) — NOT in home.html.
// Guard the top-level bindings so this module is safely importable from home.ts.

const overlay = document.getElementById("onboarding-overlay");
const stepAuth = document.getElementById("onboarding-step-auth");
const statusEl = document.getElementById("onboarding-status");

const ONBOARDING_AVAILABLE = !!overlay;

const TERMS_URL = "https://dotyo.dev/terms";
const PRIVACY_URL = "https://dotyo.dev/privacy";
const REFUND_URL = "https://dotyo.dev/refund";

const closeBtn = document.getElementById("onboarding-close");
if (closeBtn) {
  closeBtn.addEventListener("click", () => {
    window.yo.windowClose();
  });
}

export function showOnboarding(_needsAuth?: boolean) {
  if (!overlay || !stepAuth) return;
  overlay.classList.remove("hidden");
  renderAuthStep("login");
}

export function hideOnboarding() {
  if (!overlay) return;
  overlay.classList.add("hidden");
}

function setStatus(msg: string, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = isError ? "onboarding-error" : "onboarding-success";
}

function completeOnboarding() {
  setStatus("All set!");
  setTimeout(() => {
    hideOnboarding();
    window.yo.onboardingComplete();
    window.dispatchEvent(new Event("yo-onboarding-done"));
  }, 600);
}

// ── Inline email auth (no popup, no device-code handoff) ─────
type AuthMode = "login" | "register-email" | "register-code" | "register-profile";
let regEmail = "";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ── DOM builders that emit the platform auth-shell structure ──

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function title(text: string): HTMLHeadingElement {
  return el("h1", "auth-shell-title", text);
}

function lede(text: string): HTMLParagraphElement {
  return el("p", "auth-shell-lede", text);
}

function ledeEmail(prefix: string, email: string, suffix: string): HTMLParagraphElement {
  const p = el("p", "auth-shell-lede");
  p.append(document.createTextNode(prefix));
  const strong = el("strong");
  strong.style.color = "var(--white)";
  strong.textContent = email;
  p.append(strong, document.createTextNode(suffix));
  return p;
}

interface FieldOpts {
  id: string;
  label: string;
  type: string;
  placeholder?: string;
  autofocus?: boolean;
  optional?: boolean;
}

interface Field {
  wrap: HTMLDivElement;
  input: HTMLInputElement;
  setError: (msg: string | null) => void;
}

function field(opts: FieldOpts): Field {
  const wrap = el("div", "auth-shell-field");
  const label = el("label", "auth-shell-label", opts.label);
  label.htmlFor = opts.id;
  if (opts.optional) {
    label.append(el("span", "auth-shell-label-aside", "optional"));
  }
  const input = el("input", "auth-shell-input");
  input.id = opts.id;
  input.type = opts.type;
  if (opts.placeholder) input.placeholder = opts.placeholder;
  input.autocomplete = "off";
  input.autocapitalize = "off";
  if (opts.autofocus) setTimeout(() => input.focus(), 60);

  const errEl = el("p", "auth-shell-field-error");
  errEl.style.display = "none";

  const setError = (msg: string | null) => {
    if (msg) {
      input.classList.add("has-error");
      input.setAttribute("aria-invalid", "true");
      errEl.textContent = msg;
      errEl.style.display = "";
    } else {
      input.classList.remove("has-error");
      input.removeAttribute("aria-invalid");
      errEl.textContent = "";
      errEl.style.display = "none";
    }
  };

  input.addEventListener("input", () => {
    if (input.classList.contains("has-error")) setError(null);
  });

  wrap.append(label, input, errEl);
  return { wrap, input, setError };
}

function primaryButton(label: string): HTMLButtonElement {
  const b = el("button", "btn btn-primary btn-lg btn-full", label);
  b.type = "submit";
  return b;
}

function secondaryButton(label: string): HTMLButtonElement {
  const b = el("button", "btn btn-secondary btn-lg btn-full", label);
  b.type = "button";
  return b;
}

function actions(...children: HTMLElement[]): HTMLDivElement {
  const wrap = el("div", "auth-shell-actions");
  wrap.append(...children);
  return wrap;
}

function formError(): { el: HTMLParagraphElement; show: (msg: string) => void; clear: () => void } {
  const p = el("p", "auth-shell-error");
  p.style.display = "none";
  return {
    el: p,
    show: (msg: string) => { p.textContent = msg; p.style.display = ""; },
    clear: () => { p.textContent = ""; p.style.display = "none"; },
  };
}

function metaLink(prefix: string, linkText: string, onClick: () => void): HTMLParagraphElement {
  const p = el("p", "auth-shell-meta");
  p.append(document.createTextNode(prefix + " "));
  const a = el("a", undefined, linkText);
  a.href = "#";
  a.addEventListener("click", (e) => { e.preventDefault(); onClick(); });
  p.append(a);
  return p;
}

function legal(): HTMLParagraphElement {
  const p = el("p", "auth-shell-legal");
  p.append(document.createTextNode("By creating an account, you agree to our "));
  const mk = (text: string, url: string) => {
    const a = el("a", undefined, text);
    a.href = "#";
    a.addEventListener("click", (e) => { e.preventDefault(); window.yo.openExternal(url); });
    return a;
  };
  p.append(
    mk("Terms of Service", TERMS_URL),
    document.createTextNode(", "),
    mk("Privacy Policy", PRIVACY_URL),
    document.createTextNode(", and "),
    mk("Refund Policy", REFUND_URL),
    document.createTextNode("."),
  );
  return p;
}

// ── 6-digit code input, mirroring the platform CodeInput behavior ──

function codeInput(onComplete: (code: string) => void): { grid: HTMLDivElement; focus: () => void } {
  const length = 6;
  const grid = el("div", "code-input-grid");
  const boxes: HTMLInputElement[] = [];

  for (let i = 0; i < length; i++) {
    const box = el("input", "code-input-box");
    box.type = "text";
    box.inputMode = "numeric";
    box.maxLength = 1;
    box.autocomplete = "one-time-code";
    boxes.push(box);
    grid.append(box);
  }

  const fire = () => {
    const full = boxes.map((b) => b.value).join("");
    if (full.length === length && !boxes.some((b) => b.value === "")) {
      onComplete(full);
    }
  };

  boxes.forEach((box, i) => {
    box.addEventListener("input", () => {
      const val = box.value.replace(/\D/g, "");
      if (!val) { box.value = ""; return; }
      box.value = val[0];
      if (i < length - 1) boxes[i + 1].focus();
      fire();
    });

    box.addEventListener("keydown", (e) => {
      const ev = e as KeyboardEvent;
      if (ev.key === "Backspace") {
        ev.preventDefault();
        if (box.value) {
          box.value = "";
        } else if (i > 0) {
          boxes[i - 1].value = "";
          boxes[i - 1].focus();
        }
      } else if (ev.key === "ArrowLeft" && i > 0) {
        boxes[i - 1].focus();
      } else if (ev.key === "ArrowRight" && i < length - 1) {
        boxes[i + 1].focus();
      }
    });
  });

  boxes[0].addEventListener("paste", (e) => {
    e.preventDefault();
    const pasted = (e.clipboardData?.getData("text") || "").replace(/\D/g, "").slice(0, length);
    if (!pasted) return;
    for (let i = 0; i < pasted.length; i++) boxes[i].value = pasted[i];
    const focusIdx = Math.min(pasted.length, length - 1);
    boxes[focusIdx].focus();
    fire();
  });

  return { grid, focus: () => boxes[0].focus() };
}

function renderAuthStep(mode: AuthMode): void {
  if (!stepAuth) return;
  setStatus("");
  stepAuth.innerHTML = "";

  if (mode === "login") {
    stepAuth.append(title("Welcome back"));
    stepAuth.append(lede("Sign in to your workspace."));

    const form = el("form", "auth-shell-form");
    form.noValidate = true;
    const email = field({ id: "ob-login-email", label: "Email", type: "email", placeholder: "you@example.com", autofocus: true });
    const pw = field({ id: "ob-login-password", label: "Password", type: "password" });
    const err = formError();
    const btn = primaryButton("Sign in");

    const submit = async (e?: Event) => {
      e?.preventDefault();
      err.clear();
      let bad = false;
      if (!email.input.value.trim()) { email.setError("Email is required"); bad = true; }
      else if (!EMAIL_RE.test(email.input.value.trim())) { email.setError("Enter a valid email address"); bad = true; }
      if (!pw.input.value) { pw.setError("Password is required"); bad = true; }
      if (bad) return;
      btn.disabled = true; btn.textContent = "Signing in…";
      const r = await window.yo.authLogin(email.input.value.trim(), pw.input.value);
      btn.disabled = false; btn.textContent = "Sign in";
      if (r.ok) completeOnboarding();
      else err.show(r.error || "Sign in failed");
    };

    form.addEventListener("submit", submit);
    form.append(email.wrap, pw.wrap, err.el, actions(btn));
    stepAuth.append(form);
    stepAuth.append(metaLink("Need an account?", "Create one", () => renderAuthStep("register-email")));
  } else if (mode === "register-email") {
    stepAuth.append(title("Create your account"));
    stepAuth.append(lede("One workspace. Every tool. Get started in under a minute."));

    const form = el("form", "auth-shell-form");
    form.noValidate = true;
    const email = field({ id: "ob-reg-email", label: "Work email", type: "email", placeholder: "you@example.com", autofocus: true });
    const err = formError();
    const btn = primaryButton("Continue");

    const submit = async (e?: Event) => {
      e?.preventDefault();
      err.clear();
      if (!email.input.value.trim()) { email.setError("Email is required"); return; }
      if (!EMAIL_RE.test(email.input.value.trim())) { email.setError("Enter a valid email address"); return; }
      btn.disabled = true; btn.textContent = "Sending…";
      const r = await window.yo.authRegister(email.input.value.trim());
      btn.disabled = false; btn.textContent = "Continue";
      if (r.ok) { regEmail = email.input.value.trim(); renderAuthStep("register-code"); }
      else err.show(r.error || "Registration failed");
    };

    form.addEventListener("submit", submit);
    form.append(email.wrap, err.el, actions(btn));
    stepAuth.append(form);
    stepAuth.append(metaLink("Already have an account?", "Sign in", () => renderAuthStep("login")));
    stepAuth.append(legal());
  } else if (mode === "register-code") {
    stepAuth.append(title("Check your email"));
    stepAuth.append(ledeEmail("We sent a 6-digit code to ", regEmail, "."));

    const err = formError();
    const loadingEl = el("p", "auth-shell-loading", "Verifying…");
    loadingEl.style.display = "none";
    loadingEl.style.marginTop = "1rem";
    err.el.style.marginTop = "1rem";

    const resend = secondaryButton("Resend code");

    const ci = codeInput(async (code) => {
      err.clear();
      loadingEl.style.display = "";
      resend.disabled = true;
      const r = await window.yo.authVerifyCode(regEmail, code);
      loadingEl.style.display = "none";
      resend.disabled = false;
      if (r.ok) renderAuthStep("register-profile");
      else err.show(r.error || "Verification failed");
    });

    resend.addEventListener("click", async () => {
      err.clear();
      resend.disabled = true;
      const prev = resend.textContent;
      resend.textContent = "Sending…";
      const r = await window.yo.authRegister(regEmail);
      resend.disabled = false;
      resend.textContent = prev;
      if (!r.ok) err.show(r.error || "Failed to resend code");
    });

    const resendWrap = actions(resend);
    resendWrap.style.marginTop = "1.5rem";

    stepAuth.append(ci.grid, err.el, loadingEl, resendWrap);
    stepAuth.append(metaLink("Wrong email?", "Use a different one", () => renderAuthStep("register-email")));
    setTimeout(() => ci.focus(), 60);
  } else {
    stepAuth.append(title("Complete your profile"));
    stepAuth.append(lede("A few details and you're in."));

    const form = el("form", "auth-shell-form");
    form.noValidate = true;

    const row = el("div", "auth-shell-field-row");
    const first = field({ id: "ob-first", label: "First name", type: "text", autofocus: true });
    const last = field({ id: "ob-last", label: "Last name", type: "text" });
    row.append(first.wrap, last.wrap);

    const pw = field({ id: "ob-pw", label: "Password", type: "password", placeholder: "At least 8 characters" });
    const pw2 = field({ id: "ob-pw2", label: "Confirm password", type: "password" });
    const org = field({ id: "ob-org", label: "Organization", type: "text", placeholder: "Your company or team", optional: true });

    const err = formError();
    const btn = primaryButton("Create account");

    const submit = async (e?: Event) => {
      e?.preventDefault();
      err.clear();
      let bad = false;
      if (!first.input.value.trim()) { first.setError("First name is required"); bad = true; }
      if (!last.input.value.trim()) { last.setError("Last name is required"); bad = true; }
      if (!pw.input.value) { pw.setError("Password is required"); bad = true; }
      else if (pw.input.value.length < 8) { pw.setError("Password must be at least 8 characters"); bad = true; }
      if (!pw2.input.value) { pw2.setError("Please confirm your password"); bad = true; }
      else if (pw.input.value && pw.input.value !== pw2.input.value) { pw2.setError("Passwords do not match"); bad = true; }
      if (bad) return;
      btn.disabled = true; btn.textContent = "Creating…";
      const r = await window.yo.authCompleteProfile({
        email: regEmail,
        firstName: first.input.value.trim(),
        lastName: last.input.value.trim(),
        password: pw.input.value,
        confirmPassword: pw2.input.value,
        orgName: org.input.value.trim() || undefined,
      });
      btn.disabled = false; btn.textContent = "Create account";
      if (r.ok) completeOnboarding();
      else err.show(r.error || "Account creation failed");
    };

    form.addEventListener("submit", submit);
    form.append(row, pw.wrap, pw2.wrap, org.wrap, err.el, actions(btn));
    stepAuth.append(form);
  }
}
