/**
 * Council — deterministic multi-model debate orchestrator.
 *
 * No LLM in the loop. The orchestrator is pure mechanics:
 *   1. Switch to participant panel
 *   2. Inject prompt into the chat input
 *   3. Submit (Enter key)
 *   4. Wait for response (poll contentHash until stable)
 *   5. SmartGrab the response → ingest into CaptureStore
 *   6. Cross-pollinate: feed other participants' responses into next round
 *   7. Repeat for N rounds
 *
 * The LLM only enters at the end — the agent synthesizes the captured chunks.
 */

import type { WebContents, BrowserWindow } from "electron";
import { contentHash } from "./smart-grab";
import type { CaptureStore } from "./capture-store";

export interface CouncilConfig {
  participants: string[];
  prompt: string;
  rounds: number;
}

export interface CouncilResult {
  status: "complete" | "cancelled" | "error";
  rounds: number;
  participants: string[];
  totalCaptures: number;
  responses: Map<string, string[]>;
}

type ProgressFn = (msg: string) => void;

const RESPONSE_POLL_MS = 3000;
const RESPONSE_STABLE_MS = 6000;
const RESPONSE_TIMEOUT_MS = 120_000;
const SUBMIT_DELAY_MS = 2500;
const SWITCH_DELAY_MS = 800;

export class Council {
  private captureStore: CaptureStore | null = null;
  private panelSwitcher: ((id: string) => boolean) | null = null;
  private wcGetter: ((id: string) => WebContents | null) | null = null;
  private active = false;

  setCaptureStore(store: CaptureStore): void { this.captureStore = store; }
  private workspaceGetter: (() => string) | null = null;
  setWorkspaceGetter(fn: () => string): void { this.workspaceGetter = fn; }
  setPanelSwitcher(fn: (id: string) => boolean): void { this.panelSwitcher = fn; }
  setWebContentsGetter(fn: (id: string) => WebContents | null): void { this.wcGetter = fn; }

  isActive(): boolean { return this.active; }

  stop(): void { this.active = false; }

  async start(config: CouncilConfig, onProgress?: ProgressFn): Promise<CouncilResult> {
    if (this.active) return { status: "error", rounds: 0, participants: [], totalCaptures: 0, responses: new Map() };
    if (!this.wcGetter) {
      return { status: "error", rounds: 0, participants: config.participants, totalCaptures: 0, responses: new Map() };
    }

    this.active = true;
    const { participants, prompt, rounds } = config;
    const responses = new Map<string, string[]>();
    for (const p of participants) responses.set(p, []);
    let totalCaptures = 0;

    // Resolve webContents for all participants upfront
    const participantWc = new Map<string, WebContents>();
    for (const p of participants) {
      const wc = this.wcGetter(p);
      if (wc && !wc.isDestroyed()) {
        participantWc.set(p, wc);
      } else {
        onProgress?.(`Skipping ${p} — panel not loaded`);
      }
    }

    if (participantWc.size === 0) {
      this.active = false;
      return { status: "error", rounds: 0, participants, totalCaptures: 0, responses };
    }

    try {
      for (let round = 1; round <= rounds; round++) {
        if (!this.active) break;
        onProgress?.(`Round ${round}/${rounds} — sending to all participants...`);

        // Build prompts, snapshot text + hashes before injection
        const tasks: Array<{ participant: string; wc: WebContents; prompt: string; hashBefore: string | null; textBefore: string }> = [];
        for (const [participant, wc] of participantWc) {
          if (wc.isDestroyed()) continue;
          const roundPrompt = round === 1
            ? prompt
            : this.crossPollinate(prompt, round, participant, responses);
          const hashBefore = await contentHash(wc);
          const textBefore = await fullText(wc);
          tasks.push({ participant, wc, prompt: roundPrompt, hashBefore, textBefore });
        }

        // Inject prompts into ALL participants in parallel
        await Promise.all(tasks.map(t => this.injectAndSubmit(t.wc, t.prompt)));

        onProgress?.(`Round ${round}/${rounds} — waiting for responses...`);

        // Wait for ALL responses in parallel, then diff text to extract new content
        const results = await Promise.all(tasks.map(async (t) => {
          if (!this.active) return { participant: t.participant, response: null };
          await this.waitForStable(t.wc, t.hashBefore);
          const textAfter = await fullText(t.wc);
          const response = extractNewContent(t.textBefore, textAfter);
          return { participant: t.participant, response };
        }));

        // Collect responses
        for (const { participant, response } of results) {
          if (response) {
            responses.get(participant)!.push(response);
            totalCaptures++;
            onProgress?.(`Round ${round}/${rounds} — captured ${participant}`);

            if (this.captureStore) {
              try {
                await this.captureStore.ingest(`council:${participant}:r${round}`, response, this.workspaceGetter?.());
              } catch {}
            }
          } else {
            onProgress?.(`Round ${round}/${rounds} — no response from ${participant}`);
          }
        }
      }

      const status = this.active ? "complete" : "cancelled";
      this.active = false;
      return { status, rounds, participants, totalCaptures, responses };
    } catch (err) {
      this.active = false;
      return { status: "error", rounds, participants, totalCaptures, responses };
    }
  }

  // ── Cross-pollination ──────────────────────────────────

  private crossPollinate(
    originalPrompt: string,
    round: number,
    currentParticipant: string,
    responses: Map<string, string[]>,
  ): string {
    const others: string[] = [];
    for (const [participant, resps] of responses) {
      if (participant === currentParticipant) continue;
      const last = resps[resps.length - 1];
      if (last) others.push(`[${participant}]:\n${last.slice(0, 2000)}`);
    }

    if (others.length === 0) return originalPrompt;

    return [
      originalPrompt,
      "",
      `--- Round ${round} ---`,
      "Here is what the other participants said. Address points of agreement and disagreement:",
      "",
      others.join("\n\n"),
    ].join("\n");
  }

  // ── Input injection ────────────────────────────────────

  private async injectAndSubmit(wc: WebContents, text: string): Promise<void> {
    // Step 1: Focus the input and clear it
    await wc.executeJavaScript(`
      (function() {
        var el = null;
        var selectors = [
          '[role="textbox"]',
          '[contenteditable="true"]',
          'textarea:not([readonly])',
          'textarea',
        ];
        for (var i = 0; i < selectors.length; i++) {
          var els = document.querySelectorAll(selectors[i]);
          for (var j = 0; j < els.length; j++) {
            var r = els[j].getBoundingClientRect();
            if (r.width > 0 && r.height > 0) { el = els[j]; break; }
          }
          if (el) break;
        }
        if (!el) return false;
        el.focus();
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          var p = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          var s = Object.getOwnPropertyDescriptor(p, 'value');
          if (s && s.set) s.set.call(el, ''); else el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          var sel = window.getSelection();
          var range = document.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges();
          sel.addRange(range);
          document.execCommand('delete', false);
        }
        return true;
      })()
    `);

    // Step 2: Type the prompt using native keyboard input
    await wc.insertText(text);
    await sleep(300);

    // Step 3: Submit with Enter
    await wc.sendInputEvent({ type: "keyDown", keyCode: "Return" } as any);
    await sleep(50);
    await wc.sendInputEvent({ type: "keyUp", keyCode: "Return" } as any);
  }

  // ── Response detection ─────────────────────────────────

  private async waitForStable(wc: WebContents, hashBefore: string | null): Promise<void> {
    await sleep(SUBMIT_DELAY_MS);

    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    let lastHash = hashBefore;
    let stableStart = 0;

    while (Date.now() < deadline) {
      if (!this.active || wc.isDestroyed()) return;

      const hash = await contentHash(wc);

      if (hash !== lastHash) {
        lastHash = hash;
        stableStart = Date.now();
      } else if (stableStart > 0 && Date.now() - stableStart >= RESPONSE_STABLE_MS) {
        break;
      } else if (stableStart === 0 && hash !== hashBefore) {
        stableStart = Date.now();
      }

      await sleep(RESPONSE_POLL_MS);
    }
  }
}

/** Get full visible text from a webContents. */
async function fullText(wc: WebContents): Promise<string> {
  if (wc.isDestroyed()) return "";
  try {
    return await wc.executeJavaScript("document.body.innerText || ''");
  } catch {
    return "";
  }
}

/** Extract new content by diffing before/after text snapshots. */
function extractNewContent(before: string, after: string): string | null {
  if (!after || after === before) return null;

  // Find where the texts diverge
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  let commonPrefix = 0;
  while (
    commonPrefix < beforeLines.length &&
    commonPrefix < afterLines.length &&
    beforeLines[commonPrefix] === afterLines[commonPrefix]
  ) {
    commonPrefix++;
  }

  // Everything after the common prefix is new content
  const newLines = afterLines.slice(commonPrefix);

  // Also trim any lines from the end that match the old suffix
  // (UI elements that shifted down)
  let commonSuffix = 0;
  while (
    commonSuffix < beforeLines.length - commonPrefix &&
    commonSuffix < newLines.length &&
    beforeLines[beforeLines.length - 1 - commonSuffix] === newLines[newLines.length - 1 - commonSuffix]
  ) {
    commonSuffix++;
  }

  const content = (commonSuffix > 0 ? newLines.slice(0, -commonSuffix) : newLines)
    .join("\n")
    .trim();

  return content.length > 10 ? content : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
