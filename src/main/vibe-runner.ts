/**
 * VibeRunner — deterministic cross-app sequences with NL intelligence at the seams.
 *
 * A vibe is a replayable sequence of app commands across multiple panels.
 * Each step uses a mapped command (fast, deterministic) with NL fallback
 * when selectors fail. LLM only fires on fallback, dynamic values, or
 * conditional branching — not in the hot path.
 *
 * Stored as JSON in ~/yo/vibes/{name}.json
 */

import fs from "fs";
import path from "path";
import os from "os";
import type { AppConnector, CommandGuide } from "./app-connector";
import type { LLMConfig } from "./llm-config";
import { createCompletion } from "./llm-config";

// ── Types ───────────────────────────────────────────────

/** How a step's value is resolved */
export interface DynamicValue {
  /** "step" = from a previous step's output, "input" = from vibe inputs, "llm" = generate with AI */
  from: "step" | "input" | "llm";
  /** Step index (for "step") or input name (for "input") */
  ref?: number | string;
  /** LLM prompt (for "llm"), e.g. "write a professional reply to this email" */
  prompt?: string;
}

export interface VibeStep {
  /** Panel ID to act on */
  app: string;
  /** Command key from that app's commands (grab, submit, input, etc.) */
  command: string;
  /** Static value, or dynamic resolution */
  value?: string | DynamicValue;
  /** NL description for fallback element finding if command selector fails */
  find?: string;
  /** Selector to wait for before moving to the next step */
  waitFor?: string;
  /** Milliseconds to wait after this step */
  waitMs?: number;
  /** Human-readable step description */
  describe?: string;
  /** NL condition for branching — evaluated against current DOM state */
  condition?: string;
  /** Step index to jump to if condition is true */
  onTrue?: number;
  /** Step index to jump to if condition is false */
  onFalse?: number;
  /** How many times to retry on failure (default: 1) */
  retries?: number;
}

export interface Vibe {
  name: string;
  description: string;
  /** Named inputs the vibe accepts */
  inputs?: Array<{ name: string; description: string; required?: boolean }>;
  steps: VibeStep[];
}

export interface StepResult {
  stepIndex: number;
  success: boolean;
  output: string;
  /** Next step to execute (for branching) */
  nextStep?: number;
}

export interface VibeResult {
  name: string;
  success: boolean;
  stepsRun: number;
  stepResults: StepResult[];
  summary: string;
}

/** A running background vibe job */
export interface VibeJob {
  id: string;
  vibeName: string;
  startedAt: number;
  /** Resolve to abort */
  abort: () => void;
}

// ── VibeRunner ──────────────────────────────────────────

export class VibeRunner {
  private vibes: Map<string, Vibe> = new Map();
  private vibesDir: string;

  // Callbacks (wired from main.ts)
  private commandRunner: ((panelId: string, command: string, value?: string) => Promise<string>) | null = null;
  private panelScanner: ((panelId: string) => Promise<string | null>) | null = null;
  private panelClicker: ((panelId: string, text?: string, selector?: string) => Promise<string>) | null = null;
  private panelTyper: ((panelId: string, text: string, opts: { selector?: string; clear?: boolean; submit?: boolean }) => Promise<string>) | null = null;
  private panelGrabber: ((panelId: string) => Promise<string | null>) | null = null;
  private appConnector: AppConnector | null = null;
  private llmConfig: LLMConfig | null = null;

  // Background execution
  private activeJobs: Map<string, VibeJob> = new Map();
  private abortedJobs: Set<string> = new Set();
  private onJobComplete: ((jobId: string, result: VibeResult) => void) | null = null;

  /**
   * Background panel resolver — given an app ID, returns/creates a hidden
   * panel ID for background execution. Panels are prefixed "bgv-" to avoid
   * conflict with the user's visible panels.
   */
  private backgroundPanelResolver: ((appId: string) => Promise<string | null>) | null = null;

  /** Cleanup callback — destroys background panels after a job finishes */
  private backgroundPanelCleanup: ((panelIds: string[]) => void) | null = null;

  constructor() {
    this.vibesDir = path.join(os.homedir(), "yo", "vibes");
    fs.mkdirSync(this.vibesDir, { recursive: true });
    this.loadAll();
  }

  // ── Setters ─────────────────────────────────────────────

  setCommandRunner(fn: typeof this.commandRunner): void { this.commandRunner = fn; }
  setPanelScanner(fn: typeof this.panelScanner): void { this.panelScanner = fn; }
  setPanelClicker(fn: typeof this.panelClicker): void { this.panelClicker = fn; }
  setPanelTyper(fn: typeof this.panelTyper): void { this.panelTyper = fn; }
  setPanelGrabber(fn: typeof this.panelGrabber): void { this.panelGrabber = fn; }
  setAppConnector(ac: AppConnector): void { this.appConnector = ac; }
  setLLMConfig(config: LLMConfig): void { this.llmConfig = config; }
  setOnJobComplete(fn: typeof this.onJobComplete): void { this.onJobComplete = fn; }
  setBackgroundPanelResolver(fn: typeof this.backgroundPanelResolver): void { this.backgroundPanelResolver = fn; }
  setBackgroundPanelCleanup(fn: typeof this.backgroundPanelCleanup): void { this.backgroundPanelCleanup = fn; }

  // ── CRUD ────────────────────────────────────────────────

  create(name: string, vibe: Vibe): void {
    name = this.sanitizeName(name);
    if (!name) return;
    vibe.name = name;
    this.vibes.set(name, vibe);
    this.save(vibe);
  }

  list(): Array<{ name: string; description: string; stepCount: number }> {
    return Array.from(this.vibes.values()).map((v) => ({
      name: v.name,
      description: v.description,
      stepCount: v.steps.length,
    }));
  }

  get(name: string): Vibe | null {
    return this.vibes.get(name) ?? null;
  }

  update(name: string, vibe: Vibe): boolean {
    name = this.sanitizeName(name);
    if (!this.vibes.has(name)) return false;
    vibe.name = name;
    this.vibes.set(name, vibe);
    this.save(vibe);
    return true;
  }

  remove(name: string): boolean {
    name = this.sanitizeName(name);
    if (!this.vibes.has(name)) return false;
    this.vibes.delete(name);
    const filePath = path.join(this.vibesDir, `${name}.json`);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.vibesDir))) return false;
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return true;
  }

  // ── Run ─────────────────────────────────────────────────

  async run(name: string, inputs?: Record<string, string>): Promise<VibeResult> {
    const vibe = this.vibes.get(name);
    if (!vibe) {
      return { name, success: false, stepsRun: 0, stepResults: [], summary: `Vibe "${name}" not found.` };
    }

    // Validate required inputs
    if (vibe.inputs) {
      for (const inp of vibe.inputs) {
        if (inp.required && (!inputs || !inputs[inp.name])) {
          return {
            name, success: false, stepsRun: 0, stepResults: [],
            summary: `Missing required input: "${inp.name}" — ${inp.description}`,
          };
        }
      }
    }

    const stepResults: StepResult[] = [];
    const stepOutputs: string[] = [];
    let currentStep = 0;
    const maxSteps = vibe.steps.length * 3; // circuit breaker for loops
    let totalExecuted = 0;

    while (currentStep < vibe.steps.length && totalExecuted < maxSteps) {
      const step = vibe.steps[currentStep];
      totalExecuted++;

      const result = await this.executeStep(step, currentStep, inputs || {}, stepOutputs);
      stepResults.push(result);
      stepOutputs[currentStep] = result.output;

      if (!result.success) {
        // Step failed — abort the vibe
        return {
          name,
          success: false,
          stepsRun: totalExecuted,
          stepResults,
          summary: this.buildSummary(vibe, stepResults, false),
        };
      }

      // Advance: branch or sequential
      if (result.nextStep !== undefined) {
        currentStep = result.nextStep;
      } else {
        currentStep++;
      }
    }

    return {
      name,
      success: true,
      stepsRun: totalExecuted,
      stepResults,
      summary: this.buildSummary(vibe, stepResults, true),
    };
  }

  // ── Background execution ─────────────────────────────────

  /**
   * Run a vibe in the background. Returns immediately with a job ID.
   * The vibe executes on hidden panels (bgv-*) so it doesn't interfere
   * with the user's workspace. Fires onJobComplete when done.
   */
  runBackground(name: string, inputs?: Record<string, string>): string | null {
    const vibe = this.vibes.get(name);
    if (!vibe) return null;
    if (!this.backgroundPanelResolver) return null;

    const jobId = `vibe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const job: VibeJob = {
      id: jobId,
      vibeName: name,
      startedAt: Date.now(),
      abort: () => { this.abortedJobs.add(jobId); },
    };
    this.activeJobs.set(jobId, job);

    // Fire and forget — runs in background
    this.executeBackground(jobId, vibe, inputs || {}).then((result) => {
      this.activeJobs.delete(jobId);
      this.abortedJobs.delete(jobId);
      this.onJobComplete?.(jobId, result);
    }).catch((err) => {
      this.activeJobs.delete(jobId);
      this.abortedJobs.delete(jobId);
      const result: VibeResult = {
        name, success: false, stepsRun: 0, stepResults: [],
        summary: `Background vibe "${name}" crashed: ${err instanceof Error ? err.message : err}`,
      };
      this.onJobComplete?.(jobId, result);
    });

    return jobId;
  }

  /** List active background jobs */
  listJobs(): Array<{ id: string; vibeName: string; startedAt: number; elapsed: number }> {
    return Array.from(this.activeJobs.values()).map((j) => ({
      id: j.id,
      vibeName: j.vibeName,
      startedAt: j.startedAt,
      elapsed: Date.now() - j.startedAt,
    }));
  }

  /** Abort a running background job */
  abortJob(jobId: string): boolean {
    const job = this.activeJobs.get(jobId);
    if (!job) return false;
    job.abort();
    return true;
  }

  /**
   * Execute a vibe on background panels. Maps each app to a hidden
   * "bgv-{app}" panel, runs all steps there, then cleans up.
   */
  private async executeBackground(
    jobId: string,
    vibe: Vibe,
    inputs: Record<string, string>,
  ): Promise<VibeResult> {
    // Collect unique apps used by this vibe
    const apps = new Set(vibe.steps.map((s) => s.app));
    const panelMap = new Map<string, string>(); // app → bgv-app panel ID
    const bgPanelIds: string[] = [];

    // Create hidden panels for each app
    for (const app of apps) {
      if (!this.backgroundPanelResolver) break;
      const bgId = await this.backgroundPanelResolver(app);
      if (bgId) {
        panelMap.set(app, bgId);
        bgPanelIds.push(bgId);
      }
    }

    // Run the vibe with remapped panel IDs
    const stepResults: StepResult[] = [];
    const stepOutputs: string[] = [];
    let currentStep = 0;
    const maxSteps = vibe.steps.length * 3;
    let totalExecuted = 0;

    while (currentStep < vibe.steps.length && totalExecuted < maxSteps) {
      // Check abort
      if (this.abortedJobs.has(jobId)) {
        // Cleanup background panels
        if (this.backgroundPanelCleanup) this.backgroundPanelCleanup(bgPanelIds);
        return {
          name: vibe.name,
          success: false,
          stepsRun: totalExecuted,
          stepResults,
          summary: `Vibe "${vibe.name}" was cancelled after ${totalExecuted} steps.`,
        };
      }

      const step = vibe.steps[currentStep];
      // Remap app → background panel ID
      const bgStep = { ...step, app: panelMap.get(step.app) || step.app };
      totalExecuted++;

      const result = await this.executeStep(bgStep, currentStep, inputs, stepOutputs);
      stepResults.push(result);
      stepOutputs[currentStep] = result.output;

      if (!result.success) {
        if (this.backgroundPanelCleanup) this.backgroundPanelCleanup(bgPanelIds);
        return {
          name: vibe.name,
          success: false,
          stepsRun: totalExecuted,
          stepResults,
          summary: this.buildSummary(vibe, stepResults, false),
        };
      }

      if (result.nextStep !== undefined) {
        currentStep = result.nextStep;
      } else {
        currentStep++;
      }
    }

    // Cleanup background panels
    if (this.backgroundPanelCleanup) this.backgroundPanelCleanup(bgPanelIds);

    return {
      name: vibe.name,
      success: true,
      stepsRun: totalExecuted,
      stepResults,
      summary: this.buildSummary(vibe, stepResults, true),
    };
  }

  // ── Step execution ──────────────────────────────────────

  private async executeStep(
    step: VibeStep,
    stepIndex: number,
    inputs: Record<string, string>,
    stepOutputs: string[],
  ): Promise<StepResult> {
    const retries = step.retries ?? 1;
    let lastError = "";

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        // 1. Resolve dynamic value if needed
        const value = await this.resolveValue(step.value, inputs, stepOutputs);

        let output: string | null = null;

        // 2. Generic recorder-produced commands ("click", "input", "navigate")
        //    bypass the command map and use the captured selector directly.
        if (step.command === "click" && step.find) {
          output = await this.tryDirectClick(step.app, step.find);
        } else if (step.command === "input" && step.find) {
          output = await this.tryDirectType(step.app, value || "", step.find);
        } else if (step.command === "navigate" && value) {
          output = await this.tryNavigate(step.app, value);
        } else {
          // 3. Try the mapped command (fast path)
          output = await this.tryCommand(step.app, step.command, value);
        }

        // 4. If command failed and we have a NL fallback, try that
        if (output === null && step.find) {
          output = await this.tryFallback(step.app, step.command, step.find, value);
        }

        // 5. If still failed, check command guide for recovery hint
        if (output === null) {
          const guide = this.getCommandGuide(step.app, step.command);
          if (guide?.recover) {
            output = await this.tryRecovery(step.app, guide.recover, value);
          }
        }

        if (output === null) {
          lastError = `Step ${stepIndex}: command "${step.command}" failed on "${step.app}"`;
          continue; // retry
        }

        // 5. Wait if needed
        const guide = this.getCommandGuide(step.app, step.command);
        const waitMs = step.waitMs ?? guide?.delay ?? 0;
        if (waitMs > 0) {
          await new Promise((r) => setTimeout(r, Math.min(waitMs, 10000)));
        }

        // 6. Wait for selector if specified
        if (step.waitFor) {
          const appeared = await this.waitForSelector(step.app, step.waitFor, 5000);
          if (!appeared) {
            lastError = `Step ${stepIndex}: timed out waiting for "${step.waitFor}"`;
            continue; // retry
          }
        }

        // 7. Verify via command guide
        if (guide?.verify) {
          const verified = await this.waitForSelector(step.app, guide.verify, 3000);
          if (!verified) {
            lastError = `Step ${stepIndex}: verification failed — "${guide.verify}" not found`;
            continue; // retry
          }
        }

        // 8. Handle branching
        if (step.condition) {
          const branch = await this.evaluateCondition(step.app, step.condition);
          return {
            stepIndex,
            success: true,
            output,
            nextStep: branch ? step.onTrue : step.onFalse,
          };
        }

        return { stepIndex, success: true, output };
      } catch (err) {
        lastError = `Step ${stepIndex}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return { stepIndex, success: false, output: lastError };
  }

  // ── Value resolution ────────────────────────────────────

  private async resolveValue(
    value: string | DynamicValue | undefined,
    inputs: Record<string, string>,
    stepOutputs: string[],
  ): Promise<string | undefined> {
    if (value === undefined) return undefined;
    if (typeof value === "string") return value;

    switch (value.from) {
      case "input":
        return inputs[value.ref as string] ?? undefined;

      case "step": {
        const idx = value.ref as number;
        return stepOutputs[idx] ?? undefined;
      }

      case "llm": {
        if (!this.llmConfig?.apiKey || !value.prompt) return undefined;
        // Feed context from step outputs into LLM
        const context = stepOutputs.filter(Boolean).slice(-3).join("\n---\n");
        try {
          const response = await createCompletion(this.llmConfig, {
            system: "You generate content as instructed. Return only the requested text, nothing else. No markdown, no explanation.",
            messages: [{
              role: "user",
              content: context
                ? `Context from previous steps:\n${context}\n\nInstruction: ${value.prompt}`
                : value.prompt,
            }],
            maxTokens: 1024,
          });
          const block = response.content[0];
          return block?.type === "text" ? block.text : undefined;
        } catch {
          return undefined;
        }
      }

      default:
        return undefined;
    }
  }

  // ── Command execution ───────────────────────────────────

  private async tryCommand(app: string, command: string, value?: string): Promise<string | null> {
    if (!this.commandRunner) return null;
    try {
      const result = await this.commandRunner(app, command, value);
      if (result.includes("not found") || result.includes("No command") || result.includes("failed")) {
        return null;
      }
      return result;
    } catch {
      return null;
    }
  }

  // ── Direct execution (for generic recorder steps) ───────

  /** Click using the recorded CSS selector directly on the panel's live DOM. */
  private async tryDirectClick(app: string, selector: string): Promise<string | null> {
    if (!this.panelClicker) return null;
    try {
      const result = await this.panelClicker(app, undefined, selector);
      if (result.includes("Not found")) return null;
      return result;
    } catch {
      return null;
    }
  }

  /** Type into the recorded CSS selector directly on the panel's live DOM. */
  private async tryDirectType(app: string, value: string, selector: string): Promise<string | null> {
    if (!this.panelTyper) return null;
    try {
      const result = await this.panelTyper(app, value, { selector, clear: true });
      if (result.includes("not found") || result.includes("not loaded")) return null;
      return result;
    } catch {
      return null;
    }
  }

  /** Navigate a panel to a URL. */
  private async tryNavigate(app: string, url: string): Promise<string | null> {
    // Navigate uses the commandRunner with a "navigate" command if available,
    // otherwise fall through to tryCommand which will handle it.
    if (!this.commandRunner) return null;
    try {
      const result = await this.commandRunner(app, "navigate", url);
      if (result.includes("not found") || result.includes("No command")) return null;
      return result;
    } catch {
      return null;
    }
  }

  // ── NL fallback via DomScanner ──────────────────────────

  private async tryFallback(app: string, command: string, find: string, value?: string): Promise<string | null> {
    if (!this.panelScanner) return null;

    const scan = await this.panelScanner(app);
    if (!scan) return null;

    // Parse the scan to find a matching element by NL description
    // The scan is a formatted text — look for buttons/inputs matching the `find` description
    const findLower = find.toLowerCase();

    // Try to find a matching button or input from the scan text
    const selectorMatch = this.extractSelectorFromScan(scan, findLower);
    if (!selectorMatch) return null;

    // Determine action based on command type
    const cmdAction = this.getCommandAction(command);

    switch (cmdAction) {
      case "click":
        if (!this.panelClicker) return null;
        return this.panelClicker(app, undefined, selectorMatch);

      case "setValue":
        if (!this.panelTyper || !value) return null;
        return this.panelTyper(app, value, { selector: selectorMatch, clear: true });

      case "extractText":
        if (!this.panelGrabber) return null;
        return this.panelGrabber(app);

      default:
        // For unknown actions, try clicking the found element
        if (!this.panelClicker) return null;
        return this.panelClicker(app, find);
    }
  }

  // ── Recovery via guide hint ─────────────────────────────

  private async tryRecovery(app: string, recover: string, value?: string): Promise<string | null> {
    // The recover hint is NL, e.g. "try clicking the icon button instead"
    // We treat it as a click-by-text as a simple recovery strategy
    if (!this.panelClicker) return null;
    try {
      return await this.panelClicker(app, recover);
    } catch {
      return null;
    }
  }

  // ── Selector matching ───────────────────────────────────

  private extractSelectorFromScan(scan: string, find: string): string | null {
    // Parse scan output lines to find elements matching the NL description
    // Scan format: '"Button Text": selector' or 'type: selector "placeholder"'
    const lines = scan.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      // Match button format: "text": selector
      const btnMatch = trimmed.match(/^"([^"]+)":\s*(.+?)(?:\s+near=|$)/);
      if (btnMatch) {
        const [, text, selector] = btnMatch;
        if (text.toLowerCase().includes(find) || find.includes(text.toLowerCase())) {
          return selector.trim();
        }
      }

      // Match input format: type: selector "placeholder"
      const inputMatch = trimmed.match(/^\w+:\s*(\S+)\s*"([^"]*)"?/);
      if (inputMatch) {
        const [, selector, placeholder] = inputMatch;
        if (placeholder && (placeholder.toLowerCase().includes(find) || find.includes(placeholder.toLowerCase()))) {
          return selector.trim();
        }
      }
    }

    return null;
  }

  /** Map standard command names to their typical action type */
  private getCommandAction(command: string): string {
    const clickCommands = new Set(["submit", "new", "send", "compose", "reply", "stop", "like", "run"]);
    const inputCommands = new Set(["input", "search", "to-field", "subject-field", "body-field", "title-field"]);
    const extractCommands = new Set(["grab", "read-latest", "read-email", "feed", "file-tree", "list-threads", "list-items"]);

    if (clickCommands.has(command)) return "click";
    if (inputCommands.has(command)) return "setValue";
    if (extractCommands.has(command)) return "extractText";

    // Check the actual command mapping if available
    if (this.appConnector) {
      const app = this.appConnector.get(command.split("/")[0] || "");
      // Can't determine — default to click
    }
    return "click";
  }

  // ── Wait for selector ───────────────────────────────────

  private async waitForSelector(app: string, selector: string, timeoutMs: number): Promise<boolean> {
    if (!this.panelScanner) return true; // no scanner = skip verification
    const deadline = Date.now() + timeoutMs;
    const POLL_MS = 500;

    while (Date.now() < deadline) {
      const scan = await this.panelScanner(app);
      if (scan && scan.includes(selector)) return true;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return false;
  }

  // ── Condition evaluation ────────────────────────────────

  private async evaluateCondition(app: string, condition: string): Promise<boolean> {
    if (!this.llmConfig?.apiKey) return true; // default to true if no LLM

    // Grab current DOM state for context
    let domContext = "";
    if (this.panelGrabber) {
      const content = await this.panelGrabber(app);
      if (content) domContext = content.slice(0, 2000);
    }

    try {
      const response = await createCompletion(this.llmConfig, {
        system: "You evaluate conditions against page content. Respond with exactly 'true' or 'false', nothing else.",
        messages: [{
          role: "user",
          content: `Page content:\n${domContext}\n\nCondition: ${condition}\n\nIs this condition true or false?`,
        }],
        maxTokens: 10,
      });
      const block = response.content[0];
      const answer = block?.type === "text" ? block.text.trim().toLowerCase() : "true";
      return answer === "true" || answer === "yes";
    } catch {
      return true; // default to true on error
    }
  }

  // ── Command guide lookup ────────────────────────────────

  private getCommandGuide(app: string, command: string): CommandGuide | null {
    if (!this.appConnector) return null;
    const config = this.appConnector.get(app);
    if (!config) return null;
    return config.commands[command]?.guide ?? null;
  }

  // ── Summary builder ─────────────────────────────────────

  private buildSummary(vibe: Vibe, results: StepResult[], success: boolean): string {
    const lines: string[] = [];
    if (success) {
      lines.push(`Vibe "${vibe.name}" completed (${results.length} steps).`);
    } else {
      const failed = results.find((r) => !r.success);
      lines.push(`Vibe "${vibe.name}" failed at step ${failed?.stepIndex ?? "?"}.`);
    }

    for (const r of results) {
      const step = vibe.steps[r.stepIndex];
      const icon = r.success ? "+" : "x";
      const desc = step?.describe || `${step?.command} on ${step?.app}`;
      lines.push(`  ${icon} ${r.stepIndex}: ${desc}`);
      if (!r.success) lines.push(`    Error: ${r.output}`);
    }

    return lines.join("\n");
  }

  // ── Persistence ─────────────────────────────────────────

  private sanitizeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
  }

  private save(vibe: Vibe): void {
    const filePath = path.join(this.vibesDir, `${vibe.name}.json`);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(this.vibesDir))) return;
    fs.writeFileSync(filePath, JSON.stringify(vibe, null, 2), "utf-8");
  }

  private loadAll(): void {
    if (!fs.existsSync(this.vibesDir)) return;
    for (const file of fs.readdirSync(this.vibesDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = fs.readFileSync(path.join(this.vibesDir, file), "utf-8");
        const vibe: Vibe = JSON.parse(raw);
        this.vibes.set(vibe.name, vibe);
      } catch {
        // skip corrupt files
      }
    }
  }
}
