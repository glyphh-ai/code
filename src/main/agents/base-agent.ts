/**
 * BaseSubAgent — abstract sub-agent with non-streaming tool loop.
 *
 * Each specialist extends this, providing its own tools, system prompt,
 * and tool execution. The base handles the LLM call loop, abort,
 * result summarisation, and substrate breath cycle.
 *
 * Substrate integration:
 *   - Budget: shared with the orchestrator (same BudgetTracker instance)
 *   - Reflex: each run is recorded so sense.recall can surface patterns
 *   - Firewall: content tools are scanned for prompt injection
 */

import type { LLMConfig } from "../llm-config";
import { createCompletion } from "../llm-config";
import { usageTracker } from "../usage-tracker";
import type { SubAgentResult, SubAgentContext, ToolDef, AgentMode } from "./types";
import { gate } from "../action-gate";
import { scanForInjection } from "../firewall";
import { BudgetTracker } from "../substrate/think-budget";
import { reflexRemember } from "../substrate/reflex-remember";
import type { Intent } from "../substrate/types";

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
  private _modelOverride: string | null = null;
  private _budget: BudgetTracker | null = null;

  /** Name used for usage tracking + substrate reflex. Override in subclasses. */
  protected agentName = "sub-agent";

  /** Max tool-loop iterations before forcing a response. */
  protected maxIterations = 10;

  /** Max tokens per LLM response. Override in subclasses that produce large outputs. */
  protected responseMaxTokens = 2048;

  setLLMConfig(config: LLMConfig): void { this.llmConfig = config; }
  setMode(mode: AgentMode): void { this._mode = mode; }
  setModelOverride(model: string | null): void { this._modelOverride = model; }
  setApprovalCallback(cb: ApprovalCallback | null): void { this._approvalCallback = cb; }
  setBudget(budget: BudgetTracker | null): void { this._budget = budget; }
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

  async execute(
    instruction: string,
    context: SubAgentContext,
    onToolUse?: (name: string) => void,
  ): Promise<SubAgentResult> {
    if (!this.llmConfig) {
      return { summary: "LLM not configured.", success: false, toolsUsed: [] };
    }
    this.aborted = false;

    // Substrate: enter depth on shared budget
    this._budget?.enterDepth();
    const startTs = Date.now();

    const parts: string[] = [];
    if (context.conversationSummary) parts.push(`[Conversation context: ${context.conversationSummary}]`);
    if (context.availableMcpTools) parts.push(`[Connected MCP tools — use these in allowed_tools when building skills/vibes]\n${context.availableMcpTools}`);
    parts.push(`User's original message: ${context.userMessage}`);
    parts.push(`Your task: ${instruction}`);
    const preamble = parts.join("\n\n");

    const messages: any[] = [{ role: "user", content: preamble }];
    const toolsUsed: string[] = [];

    let result: SubAgentResult;
    let outcome: "success" | "error" = "success";
    try {
      result = await this.toolLoop(messages, toolsUsed, onToolUse, 0);
      outcome = result.success ? "success" : "error";
    } catch (err) {
      outcome = "error";
      result = { summary: err instanceof Error ? err.message : String(err), success: false, toolsUsed };
    } finally {
      this._budget?.exitDepth();

      // Substrate reflex: record this run for future recall
      try {
        reflexRemember({
          intent: "do" as Intent,
          skill: this.agentName,
          chain: [...new Set(toolsUsed)],
          outcome,
          durationMs: Date.now() - startTs,
          input: instruction,
          output: result!.summary,
        });
      } catch { /* non-fatal */ }
    }

    return result;
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
      maxTokens: this.responseMaxTokens,
      model,
    });

    if (response.usage) {
      usageTracker.record(this.agentName, response.usage);
      // Substrate budget: count against shared parent budget
      this._budget?.countTokens(response.usage.inputTokens + response.usage.outputTokens);
    }

    messages.push({ role: "assistant", content: response.content });

    const toolBlocks = response.content.filter((b: any) => b.type === "tool_use");

    if (toolBlocks.length > 0 && response.stopReason === "tool_use") {
      if (iteration >= this.maxIterations) {
        const results = toolBlocks.map((b: any) => ({
          type: "tool_result",
          tool_use_id: b.id,
          content: "[iteration limit — summarise what you have]",
        }));
        messages.push({ role: "user", content: results });
        return this.toolLoop(messages, toolsUsed, onToolUse, iteration + 1);
      }

      // Budget: count tool calls before executing
      for (const _block of toolBlocks) {
        this._budget?.countToolCall();
      }

      const results: any[] = [];
      for (const block of toolBlocks) {
        if (this.aborted) break;

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
          } else {
            results.push({ type: "tool_result", tool_use_id: block.id, content: "[blocked — no approval handler available]" });
            continue;
          }
        }

        if (onToolUse) onToolUse(block.name);
        toolsUsed.push(block.name);
        let result = await this.execTool(block.name, block.input as Record<string, unknown>);
        if (result.length > 6000) {
          result = result.slice(0, 6000) + "\n\n[truncated — content too long]";
        }
        // Firewall: scan content tools for prompt injection
        const CONTENT_TOOLS = new Set(["grab_panel", "scan_panel", "read_file", "clipboard_read"]);
        if (CONTENT_TOOLS.has(block.name) && result.length > 50) {
          const scan = scanForInjection(result);
          if (scan.blocked) {
            result = `[content blocked by firewall: ${scan.reason}]`;
          }
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

    return this.extractResult(messages, toolsUsed, true);
  }

  private extractResult(messages: any[], toolsUsed: string[], success: boolean): SubAgentResult {
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

  private getCheapModel(): string {
    if (!this.llmConfig) return "";
    if (this._modelOverride === "orchestrator") return this.llmConfig.model;
    if (this._modelOverride && this._modelOverride !== "auto") return this._modelOverride;
    return CHEAP_MODELS[this.llmConfig.provider] || this.llmConfig.model;
  }
}
