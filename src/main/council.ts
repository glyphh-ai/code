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
import { smartGrab, contentHash } from "./smart-grab";
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
  setPanelSwitcher(fn: (id: string) => boolean): void { this.panelSwitcher = fn; }
  setWebContentsGetter(fn: (id: string) => WebContents | null): void { this.wcGetter = fn; }

  isActive(): boolean { return this.active; }

  stop(): void { this.active = false; }

  async start(config: CouncilConfig, onProgress?: ProgressFn): Promise<CouncilResult> {
    if (this.active) return { status: "error", rounds: 0, participants: [], totalCaptures: 0, responses: new Map() };
    if (!this.wcGetter || !this.panelSwitcher) {
      return { status: "error", rounds: 0, participants: config.participants, totalCaptures: 0, responses: new Map() };
    }

    this.active = true;
    const { participants, prompt, rounds } = config;
    const responses = new Map<string, string[]>();
    for (const p of participants) responses.set(p, []);
    let totalCaptures = 0;

    try {
      for (let round = 1; round <= rounds; round++) {
        if (!this.active) break;
        onProgress?.(`Round ${round}/${rounds}`);

        for (const participant of participants) {
          if (!this.active) break;
          onProgress?.(`Round ${round}/${rounds} — ${participant}`);

          const roundPrompt = round === 1
            ? prompt
            : this.crossPollinate(prompt, round, participant, responses);

          // Switch to the participant panel
          const switched = this.panelSwitcher(participant);
          if (!switched) {
            onProgress?.(`Skipping ${participant} — panel not found`);
            continue;
          }
          await sleep(SWITCH_DELAY_MS);

          // Get the guest webContents (where the actual AI chat lives)
          const wc = this.wcGetter(participant);
          if (!wc || wc.isDestroyed()) {
            onProgress?.(`Skipping ${participant} — not loaded`);
            continue;
          }

          // Snapshot content hash before injection
          const hashBefore = await contentHash(wc);

          // Inject prompt and submit
          await this.injectAndSubmit(wc, roundPrompt);

          // Wait for the AI to finish responding
          const response = await this.waitForResponse(wc, hashBefore);

          if (response) {
            responses.get(participant)!.push(response);
            totalCaptures++;

            if (this.captureStore) {
              try {
                await this.captureStore.ingest(`council:${participant}:r${round}`, response);
              } catch {}
            }
          } else {
            onProgress?.(`No response captured from ${participant}`);
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

  private async waitForResponse(wc: WebContents, hashBefore: string | null): Promise<string | null> {
    await sleep(SUBMIT_DELAY_MS);

    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;
    let lastHash = hashBefore;
    let stableStart = 0;

    while (Date.now() < deadline) {
      if (!this.active || wc.isDestroyed()) return null;

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

    try {
      return await smartGrab(wc);
    } catch {
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
