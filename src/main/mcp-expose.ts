/**
 * McpExpose — read-only MCP server exposing the capture store.
 *
 * Pro feature. Runs a local HTTP+SSE server that any MCP client
 * (Claude Desktop, Cursor, etc.) can connect to. Exposes:
 *   - search_captures: vector/keyword search across all captures
 *   - recent_captures: most recent captures by timestamp
 *
 * Protected by bearer tokens configured in Advanced settings.
 * Only exposes data — never consumes external tools.
 */

import http from "http";
import crypto from "crypto";
import type { CaptureStore } from "./capture-store";
import { getPreference, setPreference } from "./preferences";

const DEFAULT_PORT = 7860;

interface McpRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface SseClient {
  res: http.ServerResponse;
  id: string;
}

export class McpExpose {
  private server: http.Server | null = null;
  private captureStore: CaptureStore | null = null;
  private clients = new Map<string, SseClient>();
  private port = DEFAULT_PORT;

  setCaptureStore(store: CaptureStore): void {
    this.captureStore = store;
  }

  get isRunning(): boolean {
    return this.server?.listening ?? false;
  }

  getPort(): number {
    return this.port;
  }

  /** Start the MCP server on the configured port. */
  async start(): Promise<{ ok: boolean; error?: string }> {
    if (this.server?.listening) return { ok: true };

    this.port = getPreference<number>("mcpExposePort", DEFAULT_PORT);

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          resolve({ ok: false, error: `Port ${this.port} is already in use` });
        } else {
          resolve({ ok: false, error: err.message });
        }
      });

      this.server.listen(this.port, "127.0.0.1", () => {
        console.log(`[mcp-expose] listening on http://127.0.0.1:${this.port}`);
        resolve({ ok: true });
      });
    });
  }

  /** Stop the server and disconnect all clients. */
  stop(): void {
    for (const client of this.clients.values()) {
      try { client.res.end(); } catch {}
    }
    this.clients.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
      console.log("[mcp-expose] stopped");
    }
  }

  /** Generate a new access token and persist it. */
  generateToken(): string {
    const token = `yo_${crypto.randomBytes(24).toString("hex")}`;
    const tokens = getPreference<string[]>("mcpExposeTokens", []);
    tokens.push(token);
    setPreference("mcpExposeTokens", tokens);
    return token;
  }

  /** Remove an access token. */
  revokeToken(token: string): void {
    const tokens = getPreference<string[]>("mcpExposeTokens", []);
    setPreference("mcpExposeTokens", tokens.filter((t) => t !== token));
  }

  /** Get all active tokens. */
  getTokens(): string[] {
    return getPreference<string[]>("mcpExposeTokens", []);
  }

  // ── HTTP handling ─────────────────────────────────────────

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Auth check
    if (!this.checkAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // CORS for local tools
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url || "/";

    // SSE endpoint — MCP client connects here
    if (url === "/sse" && req.method === "GET") {
      this.handleSse(req, res);
      return;
    }

    // Message endpoint — MCP client POSTs JSON-RPC here
    if (url.startsWith("/message") && req.method === "POST") {
      this.handleMessage(req, res);
      return;
    }

    // Health check
    if (url === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "yo-capture-store", version: "1.0.0", status: "ok" }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    const tokens = this.getTokens();
    if (tokens.length === 0) return false; // No tokens = no access

    const auth = req.headers.authorization;
    if (!auth) return false;

    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;

    return tokens.includes(match[1]);
  }

  // ── SSE ─────────────────────────────────────────────────

  private handleSse(_req: http.IncomingMessage, res: http.ServerResponse): void {
    const clientId = crypto.randomBytes(8).toString("hex");

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send endpoint event so client knows where to POST
    res.write(`event: endpoint\ndata: /message?clientId=${clientId}\n\n`);

    this.clients.set(clientId, { res, id: clientId });

    res.on("close", () => {
      this.clients.delete(clientId);
    });
  }

  private sendToClient(clientId: string, message: Record<string, unknown>): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    try {
      client.res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    } catch {}
  }

  // ── JSON-RPC message handling ─────────────────────────────

  private async handleMessage(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const clientId = url.searchParams.get("clientId") || "";

    let body = "";
    for await (const chunk of req) body += chunk;

    let rpc: McpRequest;
    try {
      rpc = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const response = await this.processRpc(rpc);

    // Send response via SSE if client is connected, else in HTTP response
    if (clientId && this.clients.has(clientId) && response) {
      this.sendToClient(clientId, response);
      res.writeHead(202);
      res.end();
    } else if (response) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } else {
      res.writeHead(202);
      res.end();
    }
  }

  private async processRpc(rpc: McpRequest): Promise<Record<string, unknown> | null> {
    const { id, method, params } = rpc;

    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "yo-capture-store", version: "1.0.0" },
          },
        };

      case "notifications/initialized":
        return null; // No response needed

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "search_captures",
                description: "Search across all captured content from the user's active apps. Uses vector similarity and keyword matching.",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string", description: "Natural language search query" },
                    limit: { type: "number", description: "Max results to return (default 10)" },
                  },
                  required: ["query"],
                },
              },
              {
                name: "recent_captures",
                description: "Get the most recently captured content, ordered by time.",
                inputSchema: {
                  type: "object",
                  properties: {
                    limit: { type: "number", description: "Number of captures to return (default 10)" },
                  },
                },
              },
            ],
          },
        };

      case "tools/call":
        return this.handleToolCall(id, params as { name: string; arguments?: Record<string, unknown> });

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }

  private async handleToolCall(
    id: string | number | undefined,
    params: { name: string; arguments?: Record<string, unknown> },
  ): Promise<Record<string, unknown>> {
    if (!this.captureStore) {
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "Capture store not available." }], isError: true },
      };
    }

    const args = params.arguments || {};

    switch (params.name) {
      case "search_captures": {
        const query = String(args.query || "");
        const limit = Number(args.limit) || 10;

        if (!query) {
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: "query is required" }], isError: true },
          };
        }

        const results = await this.captureStore.search(query, limit);
        const text = results.length === 0
          ? "No captures found."
          : results.map((r) =>
            `[${r.meta.source}] (${new Date(r.meta.created).toLocaleString()})\n${r.content}`,
          ).join("\n\n---\n\n");

        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
      }

      case "recent_captures": {
        const limit = Number(args.limit) || 10;
        const results = this.captureStore.recentCaptures(limit);
        const text = results.length === 0
          ? "No captures yet."
          : results.map((r) =>
            `[${r.meta.source}] (${new Date(r.meta.created).toLocaleString()})\n${r.content}`,
          ).join("\n\n---\n\n");

        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${params.name}` },
        };
    }
  }
}
