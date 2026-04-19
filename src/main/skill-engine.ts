/**
 * SkillEngine — processes captured session content with skill prompts.
 *
 * A skill is just a system prompt. Captured proxy traffic + skill
 * prompt → LLM API (BYOK) → structured markdown output.
 *
 * No parsing logic. The LLM handles format changes.
 */

import fs from "fs";
import path from "path";
import os from "os";

import { LLMConfig, createCompletion } from "./llm-config";

interface Skill {
  name: string;
  prompt: string;
}

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
  private skills: Map<string, Skill> = new Map();
  private skillsDir: string;
  private llmConfig: LLMConfig | null = null;

  constructor() {
    this.skillsDir = path.join(os.homedir(), "yo", "skills");
    fs.mkdirSync(this.skillsDir, { recursive: true });
    this.loadSkills();
  }

  setLLMConfig(config: LLMConfig): void { this.llmConfig = config; }

  /** Process raw session buffer through a skill */
  async process(buffer: string, skillName?: string): Promise<string> {
    const skill = skillName
      ? this.skills.get(skillName)
      : null;
    const prompt = skill?.prompt || DEFAULT_SKILL_PROMPT;

    if (!this.llmConfig?.apiKey) {
      // No API key — return raw buffer with a header
      return `---\ncaptured: ${new Date().toISOString()}\nskill: ${skillName || "default"}\n---\n\n${buffer}`;
    }

    // Call the LLM with the skill prompt + captured buffer
    return this.callLLM(prompt, buffer);
  }

  /** Sanitize skill name to prevent path traversal */
  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  }

  /** Create a new skill */
  createSkill(name: string, prompt: string): void {
    name = this.sanitizeName(name);
    if (!name) return;
    const skill: Skill = { name, prompt };
    this.skills.set(name, skill);
    this.saveSkill(skill);
  }

  /** List all skills with their prompts */
  listSkills(): string[] {
    return Array.from(this.skills.keys());
  }

  /** Read a skill's prompt */
  readSkill(name: string): string | null {
    return this.skills.get(name)?.prompt ?? null;
  }

  /** Update a skill's prompt */
  updateSkill(name: string, prompt: string): boolean {
    name = this.sanitizeName(name);
    if (!this.skills.has(name)) return false;
    const skill: Skill = { name, prompt };
    this.skills.set(name, skill);
    this.saveSkill(skill);
    return true;
  }

  /** Delete a skill */
  deleteSkill(name: string): boolean {
    name = this.sanitizeName(name);
    if (!this.skills.has(name)) return false;
    this.skills.delete(name);
    const filePath = path.join(this.skillsDir, `${name}.md`);
    // Verify resolved path is within skills directory
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.skillsDir))) return false;
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return true;
  }

  /** AI-generate a skill prompt from a name and description */
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
    } catch {
      return "";
    }
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
    } catch (error) {
      return `---\nerror: LLM processing failed\ncaptured: ${new Date().toISOString()}\n---\n\n${content}`;
    }
  }

  private loadSkills(): void {
    if (!fs.existsSync(this.skillsDir)) return;
    for (const file of fs.readdirSync(this.skillsDir)) {
      if (!file.endsWith(".md")) continue;
      const name = file.replace(/\.md$/, "");
      const prompt = fs.readFileSync(
        path.join(this.skillsDir, file),
        "utf-8"
      );
      this.skills.set(name, { name, prompt });
    }
  }

  private saveSkill(skill: Skill): void {
    const filePath = path.join(this.skillsDir, `${skill.name}.md`);
    // Verify resolved path is within skills directory
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.skillsDir))) return;
    fs.writeFileSync(filePath, skill.prompt, "utf-8");
  }
}
