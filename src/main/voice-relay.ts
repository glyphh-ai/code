/**
 * Voice Relay — polls the server for voice commands from the phone,
 * feeds them to the yo-agent, and pushes responses back.
 *
 * Activated when the user enables "Remote" in settings.
 */

import { BrowserWindow } from "electron";
import { isAuthenticated, serverGetAuthed, serverPostAuthed } from "./auth";
import { getPreference } from "./preferences";

interface VoiceMessage {
  id: string;
  text: string;
  from: string;
}

type AgentSendFn = (text: string) => void;
type OnDoneFn = (cb: (text: string) => void) => void;

export class VoiceRelay {
  private polling = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private agentSend: AgentSendFn | null = null;
  private pendingReply: ((text: string) => void) | null = null;

  setAgentSend(fn: AgentSendFn) { this.agentSend = fn; }

  start() {
    if (this.polling) return;
    if (!isAuthenticated()) return;
    this.polling = true;
    console.log("[voice-relay] started polling");
    this.timer = setInterval(() => this.poll(), 3000);
  }

  stop() {
    this.polling = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    console.log("[voice-relay] stopped");
  }

  /** Push the agent's response back to the server for the phone to pick up. */
  async respond(text: string) {
    try {
      await serverPostAuthed("/api/voice/respond", { text });
    } catch (err) {
      console.error("[voice-relay] respond failed:", err);
    }
  }

  private async poll() {
    if (!this.polling || !isAuthenticated()) return;

    try {
      const data = await serverGetAuthed<{ messages: VoiceMessage[] }>("/api/voice/poll");
      if (!data.messages?.length) return;

      for (const msg of data.messages) {
        console.log("[voice-relay] received:", msg.text);

        // Show in yo panel
        const win = BrowserWindow.getAllWindows()[0];
        if (win && !win.isDestroyed()) {
          win.webContents.send("yo-panel-open", "");
        }

        // Feed to agent
        if (this.agentSend) {
          this.agentSend(msg.text);
        }
      }
    } catch {
      // Network errors are expected when offline — silently ignore
    }
  }
}
