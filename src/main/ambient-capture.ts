/**
 * AmbientCapture — background content indexing for all open panels.
 *
 * Runs on a timer, silently extracts content from each panel's WebContents,
 * detects changes via MD5 hash, compacts via LLM, and stores clean chunks
 * in the ContextStore.
 */

import { PanelManager } from "./panel-manager";
import { AppConnector } from "./app-connector";
import { ContextStore } from "./context-store";
import { LLMConfig, createCompletion } from "./llm-config";
import { executeCommand } from "./dom-bridge";
import crypto from "crypto";

const DEFAULT_INTERVAL_MS = 45_000; // 45 seconds
const MIN_CONTENT_LENGTH = 50;
const MAX_CONTENT_LENGTH = 50_000;

const COMPACT_PROMPT = `You are a content extractor. Given raw text captured from a web page, extract only the meaningful content.

Rules:
- Remove UI chrome: navigation, menus, sidebars, buttons, labels, footers, ads
- Remove repetitive UI text (e.g. "New chat", "Search", "Settings")
- Keep conversation content, messages, emails, documents, code, articles
- Keep names, dates, decisions, action items, questions asked
- Preserve the actual words and data — do not summarize or paraphrase
- Return the clean content as plain text, nothing else
- If there is no meaningful content, return exactly: empty`;

export class AmbientCapture {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHashes = new Map<string, string>();
  private capturing = false;
  private llmConfig: LLMConfig | null = null;

  constructor(
    private panels: PanelManager,
    private appConnector: AppConnector,
    private contextStore: ContextStore,
    private intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  setLLMConfig(config: LLMConfig): void { this.llmConfig = config; }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.captureAll(), this.intervalMs);
    // Initial capture after a short delay (let panels load)
    setTimeout(() => this.captureAll(), 5000);
    console.log(`[ambient] started (${this.intervalMs / 1000}s interval)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[ambient] stopped");
    }
  }

  /** Force immediate capture of all panels. Returns number of panels captured. */
  async captureNow(panelId?: string): Promise<number> {
    if (panelId) {
      const app = this.appConnector.get(panelId);
      if (!app || app.url.startsWith("yo://")) return 0;
      try {
        await this.capturePanel(app.id, app.url, app.name);
        return 1;
      } catch {
        return 0;
      }
    }
    return this.captureAll();
  }

  private async captureAll(): Promise<number> {
    if (this.capturing) return 0;
    this.capturing = true;
    let count = 0;

    try {
      const apps = this.appConnector.list();
      for (const app of apps) {
        if (app.url.startsWith("yo://")) continue;
        try {
          await this.capturePanel(app.id, app.url, app.name);
          count++;
        } catch {
          // Silently skip panels that fail
        }
      }
    } finally {
      this.capturing = false;
    }
    return count;
  }

  private async capturePanel(panelId: string, configUrl: string, name: string): Promise<void> {
    const wc = this.panels.getWebContents(panelId);
    if (!wc || wc.isDestroyed() || wc.isLoading()) return;

    // Extract raw text — prefer app-specific grab command, fall back to innerText
    let rawText = "";
    const appConfig = this.appConnector.get(panelId);
    if (appConfig?.commands.grab) {
      try {
        rawText = await executeCommand(wc, appConfig.commands.grab);
      } catch {}
    }
    if (!rawText || rawText.startsWith("[Element not found")) {
      try {
        rawText = await wc.executeJavaScript(
          `document.body.innerText.slice(0, ${MAX_CONTENT_LENGTH})`
        );
      } catch {
        return;
      }
    }

    if (!rawText || rawText.trim().length < MIN_CONTENT_LENGTH) return;

    // Fast hash check — skip if raw content hasn't changed
    const hash = crypto.createHash("md5").update(rawText).digest("hex");
    if (this.lastHashes.get(panelId) === hash) return;
    this.lastHashes.set(panelId, hash);

    // LLM compaction — clean the raw text before storing
    let cleanText = rawText;
    if (this.llmConfig?.apiKey) {
      try {
        const response = await createCompletion(this.llmConfig, {
          system: COMPACT_PROMPT,
          messages: [{ role: "user", content: rawText.slice(0, 12000) }],
          maxTokens: 4096,
        });
        const block = response.content[0];
        if (block.type === "text") {
          const result = block.text.trim();
          if (result && result !== "empty") {
            cleanText = result;
          }
        }
      } catch {
        // LLM failed — store raw text as fallback
      }
    }

    if (cleanText.trim().length < MIN_CONTENT_LENGTH) return;

    // Get page title and current URL
    let title = name;
    try {
      const pageTitle = await wc.executeJavaScript("document.title || ''");
      if (pageTitle) title = pageTitle;
    } catch {}

    let currentUrl = configUrl;
    try {
      currentUrl = wc.getURL() || configUrl;
    } catch {}

    // Store in context store (handles chunking + FTS indexing)
    const stored = this.contextStore.insertCapture(panelId, currentUrl, title, cleanText);
    if (stored) {
      console.log(`[ambient] captured ${panelId} (${rawText.length} → ${cleanText.length} chars)`);
    }
  }
}
