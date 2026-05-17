/**
 * jammer-capabilities — probe a jammer's machine for VCS capability at
 * jam-start, so "this jammer has no git" becomes a non-event instead of an
 * agent burning turns on `gh auth` and dying on an unknown error.
 *
 * A remote jammer's machine may have no git, git but no GitHub auth, or a
 * fully wired setup. We detect which, provision credentials when we can
 * (`gh auth setup-git` wires an already-authenticated gh into git), and
 * hand the agent a briefing line telling it exactly what it may do.
 *
 * A jammer that cannot push is not stuck — it submits a work package via the
 * `submit_work` tool and the maestro integrates it. Git is an optimization,
 * never a requirement.
 */

import { execFile } from "child_process";
import { getShellPath } from "./shell-path";

export interface JammerCapabilities {
  /** `git` binary is on PATH. */
  hasGit: boolean;
  /** `gh` (GitHub CLI) binary is on PATH. */
  hasGh: boolean;
  /** `gh` is logged in to a GitHub account. */
  ghAuthed: boolean;
  /** The jammer can push to GitHub directly (git present + gh authenticated). */
  canPush: boolean;
}

/**
 * Run a command non-interactively; resolve true on a clean exit-0.
 *
 * Hardened so it can NEVER hang the jammer's startup: a hard deadline
 * force-kills the child and resolves false even if execFile's callback
 * never fires — which happens on Windows when a killed process leaves a
 * grandchild holding the stdio pipes open. The old version awaited a bare
 * execFile and could hang `startAgent` forever.
 */
function probe(cmd: string, args: string[], cwd?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (val: boolean) => { if (!settled) { settled = true; resolve(val); } };
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(cmd, args, {
        cwd,
        timeout: 4000,
        windowsHide: true,           // no console window flash on Windows
        env: {
          ...process.env,
          PATH: getShellPath(),
          GIT_TERMINAL_PROMPT: "0",  // never block on a credential prompt
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
        },
      }, (err) => settle(!err));
    } catch {
      settle(false);
      return;
    }
    // Hard deadline: guarantees the probe resolves even if execFile's
    // callback never fires.
    const deadline = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      settle(false);
    }, 6000);
    child.once("exit", () => clearTimeout(deadline));
    child.once("error", () => { clearTimeout(deadline); settle(false); });
  });
}

/**
 * Probe the jammer's VCS capability. When git is present and gh is
 * authenticated, also wires gh's token into git (`gh auth setup-git`) so
 * `git push` works without prompts — provisioning from the runtime rather
 * than asking the agent to do it.
 */
export async function probeJammerCapabilities(cwd: string): Promise<JammerCapabilities> {
  let hasGit = false, hasGh = false, ghAuthed = false;
  try {
    [hasGit, hasGh] = await Promise.all([
      probe("git", ["--version"]),
      probe("gh", ["--version"]),
    ]);
    if (hasGh) ghAuthed = await probe("gh", ["auth", "status"]);
    if (hasGit && ghAuthed) {
      // Wire the authenticated gh token into git's credential helper —
      // fire-and-forget so it can never delay or hang jammer startup.
      void probe("gh", ["auth", "setup-git"], cwd);
    }
  } catch {
    /* probe() never rejects, but stay defensive */
  }
  return { hasGit, hasGh, ghAuthed, canPush: hasGit && ghAuthed };
}

/** A briefing line telling the agent exactly what it may do with VCS. */
export function capabilityBriefing(caps: JammerCapabilities): string {
  if (caps.canPush) {
    return "GIT/GITHUB: This machine has git and an authenticated GitHub CLI — "
      + "commit and push your work to the repo as normal.";
  }
  const why = !caps.hasGit ? "git is not installed" : "GitHub is not authenticated";
  return `GIT/GITHUB: This machine CANNOT push to GitHub (${why}). `
    + "Do NOT run `git push`, `git remote`, or `gh auth` — they will fail and waste your turns. "
    + "Edit files in your working directory normally. When your task is complete, call the "
    + "`submit_work` tool with a short summary — the cypher collects your changes and the "
    + "maestro integrates and pushes them. "
    + "IMPORTANT: if you are LEADING this cypher, the missing git does NOT block you — keep "
    + "orchestrating: decompose the goal and assign tasks to your reports right now. Do not "
    + "stall on the git situation; task assignment, coordination, and submit_work all work fine.";
}
