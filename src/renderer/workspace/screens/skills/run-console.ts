/**
 * run-console.ts — the Preview tab's runner mockup for the skill viewer.
 *
 * Owns a console pane (monospace, themed) + an optional sandboxed web-preview
 * iframe. `runSkill` invokes `yo.skillsRun`, streams `yo.onSkillProgress`
 * events into the console as they arrive, then prints the final output. When
 * the output looks like HTML it's rendered in the sandboxed iframe above the
 * console; otherwise the text lands in the console only. Best-effort mockup.
 */

import { el } from "../../lib/dom.js";
import { yo, hasBridge, type SkillProgressEvent } from "../../lib/bridge.js";

/** Heuristic: does this string look like a renderable HTML document/fragment? */
function looksLikeHtml(s: string): boolean {
  const t = s.trim().toLowerCase();
  return t.startsWith("<!doctype html") || t.startsWith("<html") ||
    /<(div|section|main|body|h1|h2|p|ul|table|img|svg|article)\b/.test(t);
}

export class RunConsole {
  readonly root: HTMLElement;
  private preview: HTMLIFrameElement;
  private previewWrap: HTMLElement;
  private console: HTMLElement;
  private listening = false;
  private activeRunId: string | null = null;

  constructor() {
    this.console = el("div", { class: "skill-run-console", attrs: { role: "log" } });
    this.preview = el("iframe", {
      class: "skill-run-iframe",
      attrs: { sandbox: "allow-scripts", title: "Skill web preview" },
    }) as HTMLIFrameElement;
    this.previewWrap = el("div", { class: "skill-run-preview hidden" }, [this.preview]);
    this.root = el("div", { class: "skill-run-pane" }, [this.previewWrap, this.console]);
    this.printSystem("Press Run to execute this skill. Output streams here.");
  }

  private line(cls: string, text: string): void {
    this.console.append(el("div", { class: `skill-run-line ${cls}`, text }));
    this.console.scrollTop = this.console.scrollHeight;
  }

  printSystem(text: string): void { this.line("sys", text); }

  private clear(): void {
    this.console.innerHTML = "";
    this.previewWrap.classList.add("hidden");
    this.preview.srcdoc = "";
  }

  /** Subscribe once to streamed progress; events for the active run are shown. */
  private ensureListening(): void {
    if (this.listening || !yo) return;
    this.listening = true;
    yo.onSkillProgress(({ event }: { runId: string; event: SkillProgressEvent }) => {
      // We can't correlate runId precisely (skillsRun resolves with the final
      // output, not a runId), so show whatever streams while a run is active.
      if (!this.activeRunId) return;
      const status = event.status === "error" ? "err" : event.status === "success" ? "ok" : "run";
      const tag = event.type.toUpperCase();
      this.line(status, `[${tag}] ${event.label}${event.metadata?.error ? " — " + event.metadata.error : ""}`);
    });
  }

  /** Run the named skill, streaming progress + final output into the console. */
  async run(name: string): Promise<void> {
    this.clear();
    if (!hasBridge() || !yo) { this.printSystem("Running requires the app."); return; }
    this.ensureListening();
    this.activeRunId = `run-${Date.now()}`;
    this.line("sys", `$ run ${name}`);
    this.line("run", "Invoking skill…");
    try {
      const result = await yo.skillsRun(name, {});
      if (result.ok) {
        const body = typeof result.output === "string"
          ? result.output
          : JSON.stringify(result.output, null, 2);
        if (typeof result.output === "string" && looksLikeHtml(result.output)) {
          this.previewWrap.classList.remove("hidden");
          this.preview.srcdoc = result.output;
          this.line("ok", "Rendered HTML output in the preview above.");
        } else {
          for (const ln of (body || "(no output)").split("\n")) this.line("out", ln);
        }
        this.line("ok", "Done.");
      } else {
        this.line("err", result.error || "Unknown error");
      }
    } catch (err) {
      this.line("err", err instanceof Error ? err.message : String(err));
    } finally {
      this.activeRunId = null;
    }
  }
}
