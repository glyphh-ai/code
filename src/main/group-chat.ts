/**
 * GroupChat — manages a multi-model group conversation.
 *
 * The group chat panel (yo://group) is the unified view.
 * This class routes user messages to each model's panel
 * via sendAndWait, streams results back to the group panel.
 */

import { BrowserWindow, ipcMain, WebContents } from "electron";

export interface GroupMessage {
  from: string;
  text: string;
  type: "user" | "model" | "system";
}

export class GroupChat {
  private participants: string[] = [];
  private history: GroupMessage[] = [];
  private groupWc: WebContents | null = null;
  private active = false;
  private aborted = false;

  // Injected from main.ts — same callbacks yo-agent uses
  private panelTyper: ((panelId: string, text: string, opts: { clear?: boolean; submit?: boolean }) => Promise<string>) | null = null;
  private panelGrabber: ((panelId: string) => Promise<string | null>) | null = null;
  private panelCommandRunner: ((panelId: string, command: string) => Promise<string>) | null = null;
  private commandRunner: ((cmd: string) => Promise<string>) | null = null;

  setPanelTyper(fn: typeof this.panelTyper): void { this.panelTyper = fn; }
  setPanelGrabber(fn: typeof this.panelGrabber): void { this.panelGrabber = fn; }
  setPanelCommandRunner(fn: typeof this.panelCommandRunner): void { this.panelCommandRunner = fn; }
  setCommandRunner(fn: typeof this.commandRunner): void { this.commandRunner = fn; }

  /** Set the group panel's WebContents for sending messages to it. */
  setGroupWebContents(wc: WebContents): void {
    this.groupWc = wc;
  }

  getParticipants(): string[] { return [...this.participants]; }
  isActive(): boolean { return this.active; }

  /** Start a new group chat session with the given participants. */
  start(participants: string[]): void {
    this.participants = [...participants];
    this.history = [];
    this.active = true;
    this.aborted = false;
    this.notifyParticipantsChanged();
    this.sendToPanel({ from: "system", text: `Group started with ${participants.join(", ")}`, type: "system" });
  }

  /** Add a participant mid-session. */
  addParticipant(id: string): void {
    if (this.participants.includes(id)) return;
    this.participants.push(id);
    this.notifyParticipantsChanged();
    this.sendToPanel({ from: "system", text: `${id} joined the group`, type: "system" });
  }

  /** Remove a participant mid-session. */
  removeParticipant(id: string): void {
    this.participants = this.participants.filter((p) => p !== id);
    this.notifyParticipantsChanged();
    this.sendToPanel({ from: "system", text: `${id} left the group`, type: "system" });
    if (this.participants.length === 0) {
      this.active = false;
      this.sendToPanel({ from: "system", text: "Group ended — no participants left", type: "system" });
    }
  }

  /** Handle a user message: route to all participants in parallel. */
  async handleUserMessage(text: string): Promise<void> {
    if (!this.active || this.participants.length === 0) return;
    this.aborted = false;

    this.history.push({ from: "you", text, type: "user" });

    // Build context: last few exchanges so models know the conversation
    const context = this.buildContext();
    const prompt = context
      ? `You are in a group chat with: ${this.participants.join(", ")} and the user.\n\nRecent conversation:\n${context}\n\nUser: ${text}\n\nRespond naturally. Keep it concise.`
      : text;

    // Send to all participants in parallel
    const promises = this.participants.map(async (panelId) => {
      if (this.aborted) return;
      this.setTyping(panelId, true);
      try {
        const response = await this.sendAndWait(panelId, prompt);
        if (this.aborted) return;
        const msg: GroupMessage = { from: panelId, text: response, type: "model" };
        this.history.push(msg);
        this.sendToPanel(msg);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.sendToPanel({ from: panelId, text: `[Error: ${errMsg}]`, type: "model" });
      } finally {
        this.setTyping(panelId, false);
      }
    });

    await Promise.all(promises);
    if (!this.aborted) {
      this.sendToPanel({ from: "system", text: "All models responded", type: "system" });
    }
  }

  abort(): void {
    this.aborted = true;
  }

  /** Register IPC handlers — call once from main.ts. */
  registerIPC(): void {
    ipcMain.on("grp:send", (_e, text: string) => {
      this.handleUserMessage(text).catch((err) =>
        console.error("[group-chat] send error:", err),
      );
    });

    ipcMain.on("grp:add", (_e, id: string) => {
      this.addParticipant(id);
    });

    ipcMain.on("grp:remove", (_e, id: string) => {
      this.removeParticipant(id);
    });

    ipcMain.handle("grp:participants", () => {
      return this.getParticipants();
    });
  }

  // ── Private helpers ───────────────────────────────────────

  private sendToPanel(msg: GroupMessage): void {
    if (this.groupWc && !this.groupWc.isDestroyed()) {
      this.groupWc.send("grp:message", msg);
    }
  }

  private setTyping(modelId: string, typing: boolean): void {
    if (this.groupWc && !this.groupWc.isDestroyed()) {
      this.groupWc.send("grp:typing", modelId, typing);
    }
  }

  private notifyParticipantsChanged(): void {
    if (this.groupWc && !this.groupWc.isDestroyed()) {
      this.groupWc.send("grp:participants-changed", this.participants);
    }
  }

  /** Build conversation context for models (last 6 messages). */
  private buildContext(): string {
    const recent = this.history.slice(-6);
    if (recent.length === 0) return "";
    return recent
      .map((m) => `${m.from}: ${m.text.slice(0, 300)}`)
      .join("\n");
  }

  /** Send a prompt to a panel and wait for response — mirrors yo-agent's sendAndWait. */
  private async sendAndWait(panelId: string, prompt: string): Promise<string> {
    if (!this.panelTyper) return `[${panelId}] Panel typing not available.`;
    if (!this.panelGrabber) return `[${panelId}] Panel grabbing not available.`;

    const baseline = await this.panelGrabber(panelId);
    if (baseline === null) {
      // Try opening the panel
      if (this.commandRunner) {
        await this.commandRunner(`dip ${panelId}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
      const retry = await this.panelGrabber(panelId);
      if (retry === null) return `[${panelId}] Panel not loaded.`;
    }

    // Focus input
    if (this.panelCommandRunner) {
      try { await this.panelCommandRunner(panelId, "input"); } catch { /* ok */ }
      await new Promise((r) => setTimeout(r, 200));
    }

    // Type
    const typeResult = await this.panelTyper(panelId, prompt, { clear: true, submit: false });
    if (typeResult.includes("not found") || typeResult.includes("not loaded")) {
      return `[${panelId}] Could not type: ${typeResult}`;
    }
    await new Promise((r) => setTimeout(r, 300));

    // Submit
    let submitted = false;
    if (this.panelCommandRunner) {
      try {
        const result = await this.panelCommandRunner(panelId, "submit");
        if (result && !result.includes("not found") && !result.includes("No command") && !result.includes("failed")) {
          submitted = true;
        }
      } catch { /* fallback */ }
    }
    if (!submitted) {
      await this.panelTyper(panelId, "", { clear: false, submit: true });
    }

    // Poll for response
    const deadline = Date.now() + 90_000;
    const changeDeadline = Date.now() + 20_000;
    let prevContent = "";
    let stableCount = 0;
    let contentChanged = false;
    const POLL_MS = 2500;

    while (Date.now() < deadline) {
      if (this.aborted) return `[${panelId}] Aborted.`;
      await new Promise((r) => setTimeout(r, POLL_MS));
      const content = await this.panelGrabber(panelId);
      if (!content) continue;

      if (!contentChanged) {
        if (content !== baseline) {
          contentChanged = true;
          prevContent = content;
          stableCount = 0;
        } else if (Date.now() > changeDeadline) {
          return `[${panelId}] No response — submit may have failed.`;
        }
        continue;
      }

      if (content === prevContent) {
        stableCount++;
        if (stableCount >= 2) {
          return content.length > 4000
            ? content.slice(-4000) + "\n[truncated]"
            : content;
        }
      } else {
        stableCount = 0;
        prevContent = content;
      }
    }
    return await this.panelGrabber(panelId) || `[${panelId}] Timed out.`;
  }
}
