/**
 * RipStore — cross-app action sequences.
 *
 * A rip is a named pipeline of steps that chain commands across apps,
 * optionally processing context through skills or text prompts between steps.
 *
 * Stored as JSON in ~/yo/rips/{name}.json
 */

import fs from "fs";
import path from "path";
import os from "os";
import type { WebContents } from "electron";
import type { AppConnector, CommandMapping } from "./app-connector";
import type { SkillEngine } from "./skill-engine";

export interface RipOutput {
  field: string;
  app: string;
  command: string;
}

export interface RipStep {
  type: "app" | "agent";
  app?: string;
  command?: string;
  /** Skill name or inline text prompt — optional for app steps, required for agent steps */
  prompt?: string;
  /** Agent step outputs — map parsed [field] sections to app commands (setValue) */
  outputs?: RipOutput[];
  /** Delay in ms to wait after this step completes (default 200) */
  delay?: number;
}

export interface Rip {
  name: string;
  description?: string;
  steps: RipStep[];
}

const RIPS_DIR = path.join(os.homedir(), "yo", "rips");

function ensureDir(): void {
  if (!fs.existsSync(RIPS_DIR)) fs.mkdirSync(RIPS_DIR, { recursive: true });
}

function ripPath(name: string): string {
  return path.join(RIPS_DIR, `${name}.json`);
}

export class RipStore {
  list(): Rip[] {
    ensureDir();
    const files = fs.readdirSync(RIPS_DIR).filter((f) => f.endsWith(".json"));
    const rips: Rip[] = [];
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(RIPS_DIR, file), "utf-8"));
        rips.push(data);
      } catch { /* skip malformed */ }
    }
    return rips.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Rip | null {
    try {
      return JSON.parse(fs.readFileSync(ripPath(name), "utf-8"));
    } catch {
      return null;
    }
  }

  save(rip: Rip): boolean {
    ensureDir();
    if (!rip.name || !rip.steps?.length) return false;
    fs.writeFileSync(ripPath(rip.name), JSON.stringify(rip, null, 2));
    return true;
  }

  remove(name: string): boolean {
    try {
      fs.unlinkSync(ripPath(name));
      return true;
    } catch {
      return false;
    }
  }

  rename(oldName: string, newName: string): boolean {
    const rip = this.get(oldName);
    if (!rip) return false;
    rip.name = newName;
    this.save(rip);
    if (oldName !== newName) this.remove(oldName);
    return true;
  }
}

// ── Rip Runner ──────────────────────────────────────────

export interface RipRunnerDeps {
  appConnector: AppConnector;
  getWebContents: (appId: string) => WebContents | null;
  skillEngine: SkillEngine | null;
  onStep?: (index: number, step: RipStep, status: string) => void;
}

export interface RipResult {
  ok: boolean;
  context: string;
  log: string[];
}

function parseOutputSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const re = /\[(\w+)\]\s*/gi;
  let match: RegExpExecArray | null;
  const markers: Array<{ field: string; start: number }> = [];
  while ((match = re.exec(text)) !== null) {
    markers.push({ field: match[1].toLowerCase(), start: match.index + match[0].length });
  }
  for (let i = 0; i < markers.length; i++) {
    const end = i + 1 < markers.length ? text.lastIndexOf("[", markers[i + 1].start) : text.length;
    sections[markers[i].field] = text.slice(markers[i].start, end).trim();
  }
  return sections;
}

export async function runRip(rip: Rip, deps: RipRunnerDeps, initialContext = ""): Promise<RipResult> {
  const { executeCommand } = await import("./dom-bridge");
  let context = initialContext;
  const log: string[] = [];

  for (let i = 0; i < rip.steps.length; i++) {
    const step = rip.steps[i];
    deps.onStep?.(i, step, "running");

    // Agent steps: process context through skill/prompt only
    if (step.type === "agent") {
      if (!step.prompt) {
        const msg = `Step ${i + 1}: agent step has no prompt`;
        log.push(msg);
        deps.onStep?.(i, step, msg);
        return { ok: false, context, log };
      }
      if (!deps.skillEngine) {
        const msg = `Step ${i + 1}: no skill engine available`;
        log.push(msg);
        deps.onStep?.(i, step, msg);
        return { ok: false, context, log };
      }
      const isSkill = !step.prompt.includes(" ") && step.prompt.length < 40;
      if (isSkill) {
        const skills = deps.skillEngine.listSkills();
        const skillFile = skills.find((s) => s.replace(/\.md$/i, "") === step.prompt);
        if (skillFile) {
          context = await deps.skillEngine.process(context, skillFile);
          log.push(`Step ${i + 1}: agent → skill:${step.prompt}`);
        } else {
          context = await deps.skillEngine.processWithPrompt(context, step.prompt);
          log.push(`Step ${i + 1}: agent → prompt`);
        }
      } else {
        context = await deps.skillEngine.processWithPrompt(context, step.prompt);
        log.push(`Step ${i + 1}: agent → prompt`);
      }

      // Inject outputs — parse [field] sections and route to app commands
      if (step.outputs && step.outputs.length > 0) {
        const sections = parseOutputSections(context);
        for (const out of step.outputs) {
          const value = sections[out.field.toLowerCase()];
          if (!value) {
            log.push(`  → output "${out.field}": no [${out.field}] section in agent response`);
            continue;
          }
          const outApp = deps.appConnector.get(out.app);
          if (!outApp) { log.push(`  → output "${out.field}": app "${out.app}" not found`); continue; }
          const outMapping = outApp.commands[out.command];
          if (!outMapping) { log.push(`  → output "${out.field}": command "${out.command}" not found`); continue; }
          const outWc = deps.getWebContents(out.app);
          if (!outWc || outWc.isDestroyed()) { log.push(`  → output "${out.field}": ${out.app} panel not open`); continue; }
          const outResult = await executeCommand(outWc, outMapping, value);
          if (outResult.startsWith("Element not found")) {
            log.push(`  → output "${out.field}": ${outResult}`);
          } else {
            log.push(`  → output "${out.field}" → ${out.app}.${out.command}`);
          }
          await new Promise((r) => setTimeout(r, 150));
        }
      }

      deps.onStep?.(i, step, "done");
      if (i < rip.steps.length - 1) await new Promise((r) => setTimeout(r, step.delay ?? 200));
      continue;
    }

    // App steps: execute command on panel
    const app = deps.appConnector.get(step.app!);
    if (!app) {
      const msg = `Step ${i + 1}: app "${step.app}" not found`;
      log.push(msg);
      deps.onStep?.(i, step, msg);
      return { ok: false, context, log };
    }

    const mapping = app.commands[step.command!];
    if (!mapping) {
      const msg = `Step ${i + 1}: command "${step.command}" not found on ${step.app}`;
      log.push(msg);
      deps.onStep?.(i, step, msg);
      return { ok: false, context, log };
    }

    const wc = deps.getWebContents(step.app!);
    if (!wc || wc.isDestroyed()) {
      const msg = `Step ${i + 1}: ${step.app} panel not open`;
      log.push(msg);
      deps.onStep?.(i, step, msg);
      return { ok: false, context, log };
    }

    const isInject = mapping.action === "setValue";
    const result = await executeCommand(wc, mapping, isInject ? context : undefined);

    if (result.startsWith("Element not found")) {
      log.push(`Step ${i + 1}: ${result}`);
      deps.onStep?.(i, step, result);
      return { ok: false, context, log };
    }

    if (mapping.action === "extractText" || mapping.action === "extractHTML") {
      context = result;
    }

    log.push(`Step ${i + 1}: ${step.app}.${step.command} → ${mapping.action}${result.length > 80 ? " (" + result.length + " chars)" : ""}`);

    // Process context through skill or prompt if specified
    if (step.prompt && context) {
      const isSkill = !step.prompt.includes(" ") && step.prompt.length < 40;
      if (isSkill && deps.skillEngine) {
        const skills = deps.skillEngine.listSkills();
        const skillFile = skills.find((s) => s.replace(/\.md$/i, "") === step.prompt);
        if (skillFile) {
          context = await deps.skillEngine.process(context, skillFile);
          log.push(`  → skill:${step.prompt}`);
        } else {
          context = await deps.skillEngine.processWithPrompt(context, step.prompt);
          log.push(`  → prompt`);
        }
      } else if (deps.skillEngine) {
        context = await deps.skillEngine.processWithPrompt(context, step.prompt);
        log.push(`  → prompt`);
      }
    }

    deps.onStep?.(i, step, "done");

    if (i < rip.steps.length - 1) {
      await new Promise((r) => setTimeout(r, step.delay ?? 200));
    }
  }

  return { ok: true, context, log };
}
