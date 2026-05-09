/**
 * drop-gh-landing — "Continue with GitHub" landing card for The Drop.
 *
 * THE-PIVOT-GITHUB Phase 1. Rendered by drop.ts when:
 *   1. enableGhAuth feature flag is on (dev-flags.enableGhAuth = true), AND
 *   2. The Drop session is missing or expired (drop.ghStatus().signedIn === false)
 *
 * Once the user signs in, this module fades the landing out and re-emits a
 * `drop-gh-signed-in` CustomEvent for drop.ts to react to (re-render header,
 * pull projects, etc.).
 *
 * If the feature flag is off OR the user already has a Drop session, this
 * module is a no-op and the existing Drop UI runs as before.
 */

interface DropGlobals {
  devFlags: () => Promise<{ cyphersEnabled?: boolean; enableGhAuth?: boolean }>;
  ghStatus: () => Promise<{ signedIn: boolean; github: { gh_login: string; gh_avatar: string } | null; expiresAt: number | null }>;
  signInWithGitHub: () => Promise<{ ok: true; status: { signedIn: boolean } } | { ok: false; error: string; status?: number }>;
}
const drop = () => (window as unknown as { drop?: DropGlobals }).drop;

export interface GhGateResult {
  shown: boolean;       // did we render the landing
  signedIn: boolean;    // is the user currently GH-bound
}

/**
 * Returns true if the Drop should keep the rest of the UI hidden until the
 * user finishes GH sign-in. Call from drop.ts boot — if `shown && !signedIn`
 * the caller short-circuits its normal render.
 */
export async function maybeRenderGhLanding(host: HTMLElement): Promise<GhGateResult> {
  const d = drop();
  const flags = await safeCall(d?.devFlags) ?? {};
  if (!flags.enableGhAuth) return { shown: false, signedIn: true /* gate disabled = treat as passed */ };

  const status = await safeCall(d?.ghStatus);
  if (status?.signedIn) return { shown: false, signedIn: true };

  // Render the landing.
  host.innerHTML = "";
  host.classList.add("yo-gh-landing");
  host.style.display = "flex";
  host.innerHTML = `
    <div class="yo-gh-landing-card">
      <div class="yo-gh-landing-mark">🐙</div>
      <h1>Continue with GitHub</h1>
      <p class="yo-gh-landing-sub">
        The Drop now runs on GitHub Projects. Sign in with GitHub to host
        cyphers, get assignments, and earn merged-PR reputation.
      </p>
      <button class="yo-gh-landing-btn" id="yo-gh-signin">Continue with GitHub →</button>
      <details class="yo-gh-landing-why">
        <summary>Why GitHub?</summary>
        <p>
          Cyphers map 1:1 to Projects v2: items become assignments, PRs
          become signal, merges become reputation. yo-server only mediates
          matchmaking — your code, identity, and repos stay yours.
        </p>
      </details>
      <div class="yo-gh-landing-error" id="yo-gh-error" hidden></div>
    </div>
  `;

  const btn = host.querySelector<HTMLButtonElement>("#yo-gh-signin")!;
  const err = host.querySelector<HTMLDivElement>("#yo-gh-error")!;

  btn.addEventListener("click", async () => {
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Opening sign-in window…";
    try {
      const r = await drop()!.signInWithGitHub();
      if ("ok" in r && r.ok) {
        host.style.display = "none";
        host.classList.remove("yo-gh-landing");
        window.dispatchEvent(new CustomEvent("drop-gh-signed-in"));
        return;
      }
      err.hidden = false;
      err.textContent = ("error" in r ? r.error : "sign-in failed") + ((r as any).status === 501 ? "  (server not yet configured — Phase 10 still stubbed)" : "");
    } catch (e) {
      err.hidden = false;
      err.textContent = e instanceof Error ? e.message : "sign-in failed";
    } finally {
      btn.disabled = false;
      btn.textContent = "Continue with GitHub →";
    }
  });

  return { shown: true, signedIn: false };
}

async function safeCall<T>(fn?: () => Promise<T>): Promise<T | undefined> {
  if (!fn) return undefined;
  try { return await fn(); } catch { return undefined; }
}
