/**
 * waz-manager — disposable agent windows.
 *
 * `.waz <prompt>` spawns a popup BrowserWindow with its own YoAgent instance.
 * Same agent loop, same tools, fully independent of the main yo panel.
 * Multiple .waz windows can run concurrently.
 */

import { BrowserWindow, ipcMain } from "electron";
import path from "path";
import { YoAgent, YoAgentCallbacks } from "./yo-agent";
import type { LLMConfig } from "./llm-config";
import type { CaptureStore } from "./capture-store";
import type { SessionCache } from "./session-cache";
import type { SkillEngine } from "./skill-engine";
import type { MemoryStore } from "./memory-store";
import type { NoteStore } from "./note-store";

interface WazInstance {
  id: string;
  win: BrowserWindow;
  agent: YoAgent;
  prompt: string;
}

export class WazManager {
  private instances = new Map<string, WazInstance>();
  private counter = 0;

  private llmConfig: LLMConfig | null = null;
  private captureStore: CaptureStore | null = null;
  private sessionCache: SessionCache | null = null;
  private skillEngine: SkillEngine | null = null;
  private memoryStore: MemoryStore | null = null;
  private noteStore: NoteStore | null = null;
  private workspaceGetter: (() => string) | null = null;
  private themeFn: (() => string) | null = null;

  setLLMConfig(config: LLMConfig): void { this.llmConfig = config; }
  setCaptureStore(store: CaptureStore): void { this.captureStore = store; }
  setSessionCache(cache: SessionCache): void { this.sessionCache = cache; }
  setSkillEngine(engine: SkillEngine): void { this.skillEngine = engine; }
  setMemoryStore(store: MemoryStore): void { this.memoryStore = store; }
  setNoteStore(store: NoteStore): void { this.noteStore = store; }
  setWorkspaceGetter(fn: () => string): void { this.workspaceGetter = fn; }
  setThemeFn(fn: () => string): void { this.themeFn = fn; }

  spawn(prompt: string): string {
    const id = `waz-${++this.counter}-${Date.now()}`;

    const agent = new YoAgent();
    if (this.llmConfig) agent.setLLMConfig(this.llmConfig);
    if (this.captureStore) agent.setCaptureStore(this.captureStore);
    if (this.sessionCache) agent.setSessionCache(this.sessionCache);
    if (this.skillEngine) agent.setSkillEngine(this.skillEngine);
    if (this.memoryStore) agent.setMemoryStore(this.memoryStore);
    if (this.noteStore) agent.setNoteStore(this.noteStore);
    if (this.workspaceGetter) agent.setWorkspaceGetter(this.workspaceGetter);

    const preloadPath = path.join(__dirname, "waz-preload.js");

    const win = new BrowserWindow({
      width: 520,
      height: 600,
      minWidth: 360,
      minHeight: 300,
      frame: false,
      titleBarStyle: "hidden",
      trafficLightPosition: { x: -100, y: -100 },
      transparent: false,
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    const instance: WazInstance = { id, win, agent, prompt };
    this.instances.set(id, instance);

    this.wireIPC(instance);

    const htmlPath = path.join(__dirname, "..", "renderer", "waz.html");
    win.loadFile(htmlPath);

    win.once("ready-to-show", () => {
      win.show();
    });

    win.on("closed", () => {
      agent.abort();
      this.instances.delete(id);
    });

    return id;
  }

  private wireIPC(instance: WazInstance): void {
    const { id, win, agent } = instance;
    const wc = win.webContents;

    wc.ipc.handle("waz-context", () => {
      return { id, prompt: instance.prompt };
    });

    wc.ipc.handle("get-theme", () => {
      return this.themeFn?.() || "dark";
    });

    wc.ipc.handle("waz-get-mode", () => {
      return agent.getMode();
    });

    wc.ipc.on("waz-send", (_e, message: string) => {
      this.runAgent(instance, message);
    });

    wc.ipc.on("waz-stop", () => {
      agent.abort();
    });

    wc.ipc.on("waz-close", () => {
      agent.abort();
      win.close();
    });

    wc.ipc.on("waz-minimize", () => {
      win.minimize();
    });

    wc.ipc.on("waz-set-mode", (_e, mode: string) => {
      agent.setMode(mode as any);
    });

    // Approval responses from the renderer
    const pendingApprovals = new Map<string, (approved: boolean) => void>();
    (instance as any)._pendingApprovals = pendingApprovals;

    wc.ipc.on("waz-approval-respond", (_e, approvalId: string, approved: boolean) => {
      const resolve = pendingApprovals.get(approvalId);
      if (resolve) {
        pendingApprovals.delete(approvalId);
        resolve(approved);
      }
    });

    let approvalCounter = 0;
    agent.setApprovalCallback(async (toolName, input) => {
      const approvalId = `waz-approval-${id}-${++approvalCounter}`;
      let toolLabel = toolName.replace(/_/g, " ");
      const mcpMatch = toolName.match(/^mcp__[^_]+__(.+)$/);
      if (mcpMatch) toolLabel = mcpMatch[1].replace(/_/g, " ");
      if (!wc.isDestroyed()) {
        wc.send("waz-approval-request", approvalId, toolName, toolLabel, input);
      }
      return new Promise<boolean>((resolve) => {
        pendingApprovals.set(approvalId, resolve);
        setTimeout(() => {
          if (pendingApprovals.has(approvalId)) {
            pendingApprovals.delete(approvalId);
            resolve(false);
          }
        }, 60000);
      });
    });
  }

  private runAgent(instance: WazInstance, message: string): void {
    const { win, agent } = instance;
    const wc = win.webContents;

    const callbacks: YoAgentCallbacks = {
      onText: (delta) => {
        if (!wc.isDestroyed()) wc.send("waz-token", delta);
      },
      onToolUse: (toolId, name, input) => {
        if (!wc.isDestroyed()) wc.send("waz-tool-use", toolId, name, input);
      },
      onToolResult: (toolId, detail) => {
        if (!wc.isDestroyed()) wc.send("waz-tool-result", toolId, detail);
      },
      onToolProgress: (toolId, status) => {
        if (!wc.isDestroyed()) wc.send("waz-tool-progress", toolId, status);
      },
      onDone: (fullText) => {
        if (!wc.isDestroyed()) wc.send("waz-done", fullText);
      },
      onError: (error) => {
        if (!wc.isDestroyed()) wc.send("waz-error", error);
      },
    };

    agent.send(message, callbacks).catch((err) => {
      if (!wc.isDestroyed()) {
        wc.send("waz-error", err instanceof Error ? err.message : String(err));
      }
    });
  }

  closeAll(): void {
    for (const instance of this.instances.values()) {
      instance.agent.abort();
      if (!instance.win.isDestroyed()) instance.win.close();
    }
    this.instances.clear();
  }

  getCount(): number {
    return this.instances.size;
  }
}
