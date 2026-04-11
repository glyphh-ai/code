/**
 * ProxyCapture — intercepts HTTP traffic from webview panels.
 *
 * Uses Electron's webRequest API to capture outbound prompts
 * and inbound LLM responses flowing through each panel.
 * No DOM scraping, no provider-specific parsers — just raw
 * network traffic buffered in memory.
 */

import { WebContents, session } from "electron";

interface CapturedExchange {
  timestamp: number;
  url: string;
  method: string;
  requestBody?: string;
  responseStatus?: number;
  responseBody?: string;
  panelId: string;
}

export class ProxyCapture {
  private buffer: CapturedExchange[] = [];
  private maxBufferSize = 500;

  /** Attach capture hooks to a panel's session */
  attach(panelId: string, webContents: WebContents): void {
    const ses = webContents.session;

    // Capture outbound requests
    ses.webRequest.onBeforeSendHeaders(
      { urls: ["*://*.anthropic.com/*", "*://*.openai.com/*", "*://*.google.com/*"] },
      (details, callback) => {
        this.buffer.push({
          timestamp: Date.now(),
          url: details.url,
          method: details.method,
          panelId,
        });

        this.trimBuffer();
        callback({ requestHeaders: details.requestHeaders });
      }
    );

    // Capture response metadata
    ses.webRequest.onCompleted(
      { urls: ["*://*.anthropic.com/*", "*://*.openai.com/*", "*://*.google.com/*"] },
      (details) => {
        // Find the matching request and update with response info
        const exchange = this.buffer.findLast(
          (e) => e.url === details.url && e.panelId === panelId
        );
        if (exchange) {
          exchange.responseStatus = details.statusCode;
        }
      }
    );

    // For full response body capture (streaming SSE), we'll use
    // the debugger protocol in a future iteration. The webRequest
    // API only gives us metadata, not response bodies.
    //
    // TODO: webContents.debugger.attach() for Network.getResponseBody
  }

  /** Get the current session buffer as raw text */
  currentBuffer(): string {
    if (this.buffer.length === 0) return "";

    return this.buffer
      .map((e) => {
        const time = new Date(e.timestamp).toISOString();
        let line = `[${time}] ${e.method} ${e.url}`;
        if (e.requestBody) line += `\nREQ: ${e.requestBody}`;
        if (e.responseBody) line += `\nRES: ${e.responseBody}`;
        return line;
      })
      .join("\n\n");
  }

  /** Clear the buffer (after yo saves) */
  clear(): void {
    this.buffer = [];
  }

  /** Get buffer size */
  get size(): number {
    return this.buffer.length;
  }

  private trimBuffer(): void {
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer = this.buffer.slice(-this.maxBufferSize);
    }
  }
}
