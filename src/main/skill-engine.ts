/**
 * SkillEngine — folder-based skill storage and lifecycle execution.
 *
 * A skill is a folder under ~/yo/skills/<name>/ containing:
 *   - SKILL.md    (required): YAML frontmatter + prompt body
 *   - SKILL.js    (optional): deterministic lifecycle runner (init/start/end/exit)
 *   - Any other files (arbitrary artifacts, templates, examples)
 *
 * This file handles storage, CRUD, and run history.
 * The runner lives in skill-runner.ts.
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import yaml from "js-yaml";
import AdmZip from "adm-zip";

import { LLMConfig, createCompletion } from "./llm-config";
import {
  Skill,
  SkillManifest,
  SkillSummary,
  SkillRun,
  ProgressEvent,
  RunOpts,
  RunTrigger,
} from "./skill-types";

const SKILL_MD = "SKILL.md";
const SKILL_JS = "SKILL.js";
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// Legacy fallback prompt when a skill has neither runner nor body.
const DEFAULT_SKILL_PROMPT = `You are a context capture assistant.
Given the following session content (raw conversation between a user and an AI),
extract and organize the key information into clean markdown.

Include:
- Summary of what was discussed
- Key decisions made
- Action items or follow-ups
- Important code snippets or commands
- Any unresolved questions

Format as clean, readable markdown. Be concise.`;

export class SkillEngine {
  private skillsDir: string;
  private llmConfig: LLMConfig | null = null;
  private runHistory: Map<string, SkillRun[]> = new Map();
  private onChangeCallbacks: Array<() => void> = [];

  constructor() {
    this.skillsDir = path.join(os.homedir(), "yo", "skills");
    fs.mkdirSync(this.skillsDir, { recursive: true });
  }

  setLLMConfig(config: LLMConfig): void { this.llmConfig = config; }
  getLLMConfig(): LLMConfig | null { return this.llmConfig; }
  getSkillsDir(): string { return this.skillsDir; }

  onChange(cb: () => void): void { this.onChangeCallbacks.push(cb); }
  private emitChange(): void { for (const cb of this.onChangeCallbacks) try { cb(); } catch {} }

  // ── Path helpers ─────────────────────────────────────

  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  }

  private skillFolder(name: string): string {
    return path.join(this.skillsDir, this.sanitizeName(name));
  }

  /** Validate a path stays within the skills directory (path traversal guard). */
  private safePath(base: string, rel: string): string | null {
    const joined = path.resolve(base, rel);
    const baseResolved = path.resolve(base);
    if (!joined.startsWith(baseResolved + path.sep) && joined !== baseResolved) return null;
    return joined;
  }

  // ── Frontmatter ──────────────────────────────────────

  parseFrontmatter(md: string): { manifest: SkillManifest; body: string } {
    const match = md.match(FRONTMATTER_RE);
    if (!match) return { manifest: { name: "" }, body: md };
    try {
      const parsed = yaml.load(match[1]) as SkillManifest;
      return { manifest: parsed || { name: "" }, body: match[2] };
    } catch {
      return { manifest: { name: "" }, body: md };
    }
  }

  serializeFrontmatter(manifest: SkillManifest, body: string): string {
    // Strip undefined/null entries for a clean file
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(manifest)) {
      if (v !== undefined && v !== null) clean[k] = v;
    }
    const fm = yaml.dump(clean, { noRefs: true, lineWidth: 0 });
    return `---\n${fm.trim()}\n---\n\n${body.trim()}\n`;
  }

  // ── CRUD ─────────────────────────────────────────────

  listSkills(): string[] {
    if (!fs.existsSync(this.skillsDir)) return [];
    const names: string[] = [];
    for (const entry of fs.readdirSync(this.skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mdPath = path.join(this.skillsDir, entry.name, SKILL_MD);
      if (fs.existsSync(mdPath)) names.push(entry.name);
    }
    return names.sort();
  }

  listSkillsDetailed(): SkillSummary[] {
    return this.listSkills().map((name) => {
      const s = this.getSkill(name);
      if (!s) return { name, hasRunner: false, scheduled: false };
      return {
        name,
        description: s.manifest.description,
        hasRunner: s.hasRunner,
        scheduled: !!s.manifest.schedule,
        scheduleExpr: s.manifest.schedule ?? undefined,
      };
    });
  }

  getSkill(name: string): Skill | null {
    const folder = this.skillFolder(name);
    const mdPath = path.join(folder, SKILL_MD);
    if (!fs.existsSync(mdPath)) return null;
    const raw = fs.readFileSync(mdPath, "utf-8");
    const { manifest, body } = this.parseFrontmatter(raw);
    // Ensure manifest.name matches folder
    if (!manifest.name) manifest.name = name;
    return {
      name,
      manifest,
      prompt: body,
      hasRunner: fs.existsSync(path.join(folder, SKILL_JS)),
      folderPath: folder,
    };
  }

  /** Back-compat: returns the prompt body (markdown) of a skill, or null. */
  readSkill(name: string): string | null {
    const s = this.getSkill(name);
    return s ? s.prompt : null;
  }

  /**
   * Create or update a skill folder. If runnerCode is provided, writes SKILL.js.
   * If runnerCode is null and SKILL.js exists, deletes it.
   * If runnerCode is undefined, leaves existing SKILL.js untouched.
   */
  writeSkill(name: string, manifest: SkillManifest, prompt: string, runnerCode?: string | null): boolean {
    name = this.sanitizeName(name);
    if (!name) return false;
    manifest.name = name;
    const folder = this.skillFolder(name);
    fs.mkdirSync(folder, { recursive: true });
    const mdPath = path.join(folder, SKILL_MD);
    const mdContent = this.serializeFrontmatter(manifest, prompt || "");
    fs.writeFileSync(mdPath, mdContent, "utf-8");

    const jsPath = path.join(folder, SKILL_JS);
    if (runnerCode === null) {
      if (fs.existsSync(jsPath)) fs.unlinkSync(jsPath);
    } else if (typeof runnerCode === "string") {
      fs.writeFileSync(jsPath, runnerCode, "utf-8");
    }
    this.emitChange();
    return true;
  }

  /** Legacy: createSkill(name, prompt) — creates with minimal manifest. */
  createSkill(name: string, prompt: string): void {
    this.writeSkill(name, { name, description: "" }, prompt);
  }

  /** Legacy: updateSkill(name, prompt) — updates prompt body only. */
  updateSkill(name: string, prompt: string): boolean {
    const existing = this.getSkill(name);
    if (!existing) return false;
    return this.writeSkill(name, existing.manifest, prompt);
  }

  deleteSkill(name: string): boolean {
    const folder = this.skillFolder(name);
    if (!fs.existsSync(folder)) return false;
    // Safety: verify folder is inside skillsDir
    const resolved = path.resolve(folder);
    if (!resolved.startsWith(path.resolve(this.skillsDir) + path.sep)) return false;
    fs.rmSync(folder, { recursive: true, force: true });
    this.runHistory.delete(name);
    this.emitChange();
    return true;
  }

  // ── File ops within a skill folder ──────────────────

  listSkillFiles(name: string): string[] {
    const folder = this.skillFolder(name);
    if (!fs.existsSync(folder)) return [];
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), relPath);
        } else {
          out.push(relPath);
        }
      }
    };
    walk(folder, "");
    return out.sort();
  }

  readSkillFile(name: string, relPath: string): string | null {
    const folder = this.skillFolder(name);
    const full = this.safePath(folder, relPath);
    if (!full || !fs.existsSync(full)) return null;
    return fs.readFileSync(full, "utf-8");
  }

  writeSkillFile(name: string, relPath: string, content: string): boolean {
    const folder = this.skillFolder(name);
    fs.mkdirSync(folder, { recursive: true });
    const full = this.safePath(folder, relPath);
    if (!full) return false;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
    this.emitChange();
    return true;
  }

  deleteSkillFile(name: string, relPath: string): boolean {
    const folder = this.skillFolder(name);
    const full = this.safePath(folder, relPath);
    if (!full || !fs.existsSync(full)) return false;
    // Don't allow deleting SKILL.md (core file)
    if (path.basename(full) === SKILL_MD) return false;
    fs.unlinkSync(full);
    this.emitChange();
    return true;
  }

  // ── Export / Import (.yo bundles) ──────────────────────

  exportSkill(name: string): Buffer | null {
    const folder = this.skillFolder(name);
    if (!fs.existsSync(folder)) return null;
    const zip = new AdmZip();
    zip.addLocalFolder(folder, name);
    // Also bundle any required skills recursively
    const skill = this.getSkill(name);
    const bundled = new Set<string>([name]);
    const bundleReqs = (reqs: string[] | undefined) => {
      if (!reqs) return;
      for (const req of reqs) {
        if (bundled.has(req)) continue;
        const reqFolder = this.skillFolder(req);
        if (!fs.existsSync(reqFolder)) continue;
        zip.addLocalFolder(reqFolder, req);
        bundled.add(req);
        const sub = this.getSkill(req);
        if (sub) bundleReqs(sub.manifest.requires);
      }
    };
    bundleReqs(skill?.manifest.requires);
    return zip.toBuffer();
  }

  importSkill(zipBuffer: Buffer, opts: { overwrite?: boolean } = {}): { imported: string[]; skipped: string[] } {
    const zip = new AdmZip(zipBuffer);
    const imported: string[] = [];
    const skipped: string[] = [];
    // Group entries by top-level folder (skill name)
    const byFolder = new Map<string, AdmZip.IZipEntry[]>();
    for (const entry of zip.getEntries()) {
      const parts = entry.entryName.split("/");
      if (parts.length < 2) continue;
      const skillName = this.sanitizeName(parts[0]);
      if (!skillName) continue;
      const list = byFolder.get(skillName) ?? [];
      list.push(entry);
      byFolder.set(skillName, list);
    }
    for (const [skillName, entries] of byFolder) {
      const targetFolder = this.skillFolder(skillName);
      if (fs.existsSync(targetFolder) && !opts.overwrite) {
        skipped.push(skillName);
        continue;
      }
      fs.mkdirSync(targetFolder, { recursive: true });
      for (const entry of entries) {
        const relPath = entry.entryName.substring(skillName.length + 1);
        if (!relPath) continue;
        const safe = this.safePath(targetFolder, relPath);
        if (!safe) continue;
        if (entry.isDirectory) {
          fs.mkdirSync(safe, { recursive: true });
        } else {
          fs.mkdirSync(path.dirname(safe), { recursive: true });
          fs.writeFileSync(safe, entry.getData());
        }
      }
      imported.push(skillName);
    }
    if (imported.length) this.emitChange();
    return { imported, skipped };
  }

  // ── Run history ─────────────────────────────────────

  appendRun(run: SkillRun): void {
    const list = this.runHistory.get(run.skillName) ?? [];
    list.unshift(run);
    if (list.length > 10) list.length = 10;
    this.runHistory.set(run.skillName, list);
  }

  getRunHistory(skillName: string): SkillRun[] {
    return this.runHistory.get(skillName) ?? [];
  }

  clearRunHistory(skillName?: string): void {
    if (skillName) this.runHistory.delete(skillName);
    else this.runHistory.clear();
  }

  // ── Prompt-mode processing (fallback for skills without a runner) ──────

  async process(buffer: string, skillName?: string): Promise<string> {
    const skill = skillName ? this.getSkill(skillName) : null;
    const prompt = (skill?.prompt && skill.prompt.trim()) || DEFAULT_SKILL_PROMPT;

    if (!this.llmConfig?.apiKey) {
      return `---\ncaptured: ${new Date().toISOString()}\nskill: ${skillName || "default"}\n---\n\n${buffer}`;
    }
    return this.callLLM(prompt, buffer);
  }

  async processWithPrompt(content: string, prompt: string): Promise<string> {
    if (!this.llmConfig?.apiKey) return content;
    return this.callLLM(prompt, content);
  }

  async generatePrompt(name: string, description: string): Promise<string> {
    if (!this.llmConfig?.apiKey) return "";
    const system = "You are a skill prompt writer. Given a skill name and description, write a system prompt that an AI assistant should follow when processing content with this skill. Output ONLY the system prompt text, nothing else. Make it clear, specific, and actionable. Include an instruction to output plain text only (no markdown formatting) since output gets pasted into real apps.";
    try {
      const response = await createCompletion(this.llmConfig, {
        system,
        messages: [{ role: "user", content: `Skill name: ${name}\nDescription: ${description}` }],
        maxTokens: 2048,
      });
      const block = response.content[0];
      if (block.type === "text") return block.text;
      return "";
    } catch { return ""; }
  }

  private async callLLM(systemPrompt: string, content: string): Promise<string> {
    try {
      const response = await createCompletion(this.llmConfig!, {
        system: systemPrompt,
        messages: [{ role: "user", content: `Here is the raw session content to process:\n\n${content}` }],
        maxTokens: 4096,
      });
      const block = response.content[0];
      if (block.type === "text") return block.text;
      return content;
    } catch {
      return `---\nerror: LLM processing failed\ncaptured: ${new Date().toISOString()}\n---\n\n${content}`;
    }
  }

  // ── Run a skill via its lifecycle runner (delegates to skill-runner) ──────

  async runSkill(name: string, input: unknown, opts: RunOpts = {}): Promise<unknown> {
    const { runSkillLifecycle } = await import("./skill-runner");
    return runSkillLifecycle(this, name, input, opts);
  }
}

// Re-export types for callers
export { Skill, SkillManifest, SkillRun, ProgressEvent } from "./skill-types";
