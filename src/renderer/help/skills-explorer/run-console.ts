/**
 * run-console.ts — the skill viewer's runner. Owns a console pane + an optional
 * sandboxed web-preview iframe. `run()` invokes window.yo.skillsRun, streams
 * onSkillProgress events into the console, then prints the final output.
 * Ported from the v4 workspace skills explorer.
 */

import { el } from "./dom.js";

interface SkillProgressEvent {
  type: string;
  label: string;
  status: "running" | "success" | "error";
  metadata?: { error?: string };
}

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

  private ensureListening(): void {
    if (this.listening) return;
    this.listening = true;
    window.yo.onSkillProgress(({ event }: { runId: string; event: SkillProgressEvent }) => {
      if (!this.activeRunId) return;
      const status = event.status === "error" ? "err" : event.status === "success" ? "ok" : "run";
      const tag = (event.type || "").toUpperCase();
      this.line(status, `[${tag}] ${event.label}${event.metadata?.error ? " — " + event.metadata.error : ""}`);
    });
  }

  async run(name: string): Promise<void> {
    this.clear();
    this.ensureListening();
    this.activeRunId = `run-${Date.now()}`;
    this.line("sys", `$ run ${name}`);
    this.line("run", "Invoking skill…");
    try {
      const result = await window.yo.skillsRun(name, {});
      if (result.ok) {
        const body = typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2);
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
