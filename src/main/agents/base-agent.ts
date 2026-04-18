/**
 * BaseSubAgent — abstract sub-agent with non-streaming tool loop.
 *
 * Each specialist extends this, providing its own tools, system prompt,
 * and tool execution. The base handles the LLM call loop, abort, and
 * result summarisation.
 */

import type { LLMConfig } from "../llm-config";
import { createCompletion } from "../llm-config";
import { usageTracker } from "../usage-tracker";
import type { SubAgentResult, SubAgentContext, ToolDef, AgentMode } from "./types";
import { gate } from "../action-gate";

/** Provider-specific cheap model overrides. */
const CHEAP_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4.1-mini",
  google: "gemini-2.0-flash",
  xai: "grok-3-mini-fast",
  deepseek: "deepseek-chat",
};

/** Callback to request user approval for a mutate tool. Resolves true if approved. */
export type ApprovalCallback = (toolName: string, input: Record<string, unknown>) => Promise<boolean>;

export abstract class BaseSubAgent {
  protected llmConfig: LLMConfig | null = null;
  private aborted = false;
  private _mode: AgentMode = "ask";
  private _approvalCallback: ApprovalCallback | null = null;
  private _modelOverride: string | null = null;  // "auto" | specific model | "orchestrator" | null

  /** Name used for usage tracking. Override in subclasses. */
  protected agentName = "sub-agent";

  /** Max tool-loop iterations before forcing a response. */
  protected maxIterations = 10;

  setLLMConfig(config: LLMConfig): void { this.llmConfig = config; }
  setMode(mode: AgentMode): void { this._mode = mode; }
  setModelOverride(model: string | null): void { this._modelOverride = model; }
  setApprovalCallback(cb: ApprovalCallback | null): void { this._approvalCallback = cb; }
  abort(): void { this.aborted = true; }
  resetAbort(): void { this.aborted = false; }
  get isAborted(): boolean { return this.aborted; }

  // ── Abstract interface ────────────────────────────────

  /** System prompt for this specialist. */
  abstract get systemPrompt(): string;

  /** Tool definitions available to this specialist. */
  abstract get tools(): ToolDef[];

  /** Execute a single tool call. Return result string. */
  abstract execTool(name: string, input: Record<string, unknown>): Promise<string>;

  // ── Execution ─────────────────────────────────────────

  /**
   * Run the sub-agent with an instruction and context.
   * Returns a concise SubAgentResult for the orchestrator.
   */
  async execute(
    instruction: string,
    context: SubAgentContext,
    onToolUse?: (name: string) => void,
  ): Promise<SubAgentResult> {
    if (!this.llmConfig) {
      return { summary: "LLM not configured.", success: false, toolsUsed: [] };
    }
    this.aborted = false;

    // Build messages: context preamble + instruction
    const preamble = context.conversationSummary
      ? `[Conversation context: ${context.conversationSummary}]\n\nUser's original message: ${context.userMessage}\n\nYour task: ${instruction}`
      : `User's original message: ${context.userMessage}\n\nYour task: ${instruction}`;

    const messages: any[] = [{ role: "user", content: preamble }];
    const toolsUsed: string[] = [];

    return this.toolLoop(messages, toolsUsed, onToolUse, 0);
  }

  private async toolLoop(
    messages: any[],
    toolsUsed: string[],
    onToolUse: ((name: string) => void) | undefined,
    iteration: number,
  ): Promise<SubAgentResult> {
    if (this.aborted) {
      return this.extractResult(messages, toolsUsed, false);
    }

    const model = this.getCheapModel();

    const response = await createCompletion(this.llmConfig!, {
      system: this.systemPrompt,
      messages,
      tools: this.tools,
      maxTokens: 2048,
      model,
    });

    if (response.usage) {
      usageTracker.record(this.agentName, response.usage);
    }

    messages.push({ role: "assistant", content: response.content });

    const toolBlocks = response.content.filter((b: any) => b.type === "tool_use");

    if (toolBlocks.length > 0 && response.stopReason === "tool_use") {
      // Enforce iteration limit
      if (iteration >= this.maxIterations) {
        const results = toolBlocks.map((b: any) => ({
          type: "tool_result",
          tool_use_id: b.id,
          content: "[iteration limit — summarise what you have]",
        }));
        messages.push({ role: "user", content: results });
        // One more call to get the summary
        return this.toolLoop(messages, toolsUsed, onToolUse, iteration + 1);
      }

      const results: any[] = [];
      for (const block of toolBlocks) {
        if (this.aborted) break;

        // Gate check: decide whether to execute, request approval, or skip
        const decision = gate(block.name, this._mode);
        if (decision === "skip") {
          results.push({ type: "tool_result", tool_use_id: block.id, content: "[skipped — plan mode]" });
          continue;
        }
        if (decision === "needs_approval") {
          if (this._approvalCallback) {
            const approved = await this._approvalCallback(block.name, block.input as Record<string, unknown>);
            if (!approved) {
              results.push({ type: "tool_result", tool_use_id: block.id, content: "[blocked by user]" });
              continue;
            }
          }
          // No callback set — fall through and execute (degraded mode)
        }

        if (onToolUse) onToolUse(block.name);
        toolsUsed.push(block.name);
        let result = await this.execTool(block.name, block.input as Record<string, unknown>);
        // Cap tool results to prevent context overflow (200k token limit)
        if (result.length > 12000) {
          result = result.slice(0, 12000) + "\n\n[truncated — content too long]";
        }
        results.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }

      // Patch dangling tool_use if aborted mid-loop
      if (this.aborted) {
        const answered = new Set(results.map((r: any) => r.tool_use_id));
        for (const block of toolBlocks) {
          if (!answered.has(block.id)) {
            results.push({ type: "tool_result", tool_use_id: block.id, content: "[interrupted]" });
          }
        }
      }

      messages.push({ role: "user", content: results });

      if (this.aborted) {
        return this.extractResult(messages, toolsUsed, false);
      }

      return this.toolLoop(messages, toolsUsed, onToolUse, iteration + 1);
    }

    // End turn — extract text
    return this.extractResult(messages, toolsUsed, true);
  }

  /** Extract the final text from the last assistant message. */
  private extractResult(messages: any[], toolsUsed: string[], success: boolean): SubAgentResult {
    // Walk backwards to find last assistant text
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const text = msg.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        if (text) {
          return { summary: text.slice(0, 3000), success, toolsUsed };
        }
      }
    }
    return { summary: "(no response)", success: false, toolsUsed };
  }

  /** Get the model for sub-agent calls. Respects user override. */
  private getCheapModel(): string {
    if (!this.llmConfig) return "";
    if (this._modelOverride === "orchestrator") return this.llmConfig.model;
    if (this._modelOverride && this._modelOverride !== "auto") return this._modelOverride;
    return CHEAP_MODELS[this.llmConfig.provider] || this.llmConfig.model;
  }
}
