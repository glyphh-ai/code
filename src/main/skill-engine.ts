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
import { Library } from "./library";

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
  private apiKey: string | null = null;

  constructor(private library: Library) {
    this.skillsDir = path.join(os.homedir(), "yo", "skills");
    fs.mkdirSync(this.skillsDir, { recursive: true });
    this.loadSkills();
    this.apiKey = process.env.ANTHROPIC_API_KEY || null;
  }

  /** Process raw session buffer through a skill */
  async process(buffer: string, skillName?: string): Promise<string> {
    const skill = skillName
      ? this.skills.get(skillName)
      : null;
    const prompt = skill?.prompt || DEFAULT_SKILL_PROMPT;

    if (!this.apiKey) {
      // No API key — return raw buffer with a header
      return `---\ncaptured: ${new Date().toISOString()}\nskill: ${skillName || "default"}\n---\n\n${buffer}`;
    }

    // Call the LLM with the skill prompt + captured buffer
    return this.callLLM(prompt, buffer);
  }

  /** Create a new skill */
  createSkill(name: string, prompt: string): void {
    const skill: Skill = { name, prompt };
    this.skills.set(name, skill);
    this.saveSkill(skill);
  }

  /** List all skills */
  listSkills(): string[] {
    return Array.from(this.skills.keys());
  }

  private async callLLM(systemPrompt: string, content: string): Promise<string> {
    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: this.apiKey! });

      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Here is the raw session content to process:\n\n${content}`,
          },
        ],
      });

      const block = response.content[0];
      if (block.type === "text") {
        return block.text;
      }
      return content;
    } catch (error) {
      // Fallback to raw content with error note
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
    fs.writeFileSync(
      path.join(this.skillsDir, `${skill.name}.md`),
      skill.prompt,
      "utf-8"
    );
  }
}
