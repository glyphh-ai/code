/**
 * McpExpose — local MCP server for the capture store.
 *
 * Runs a local HTTP+SSE server that any MCP client
 * (Claude Desktop, Cursor, etc.) can connect to. Exposes:
 *   - yo: search across all captured content (vector + keyword)
 *   - sup: push content into the capture store (chunk + embed + index)
 *
 * Protected by bearer tokens configured in Advanced settings.
 */

import http from "http";
import crypto from "crypto";
import type { CaptureStore } from "./capture-store";
import { getPreference, setPreference } from "./preferences";

const DEFAULT_PORT = 7860;
const TOKEN_TTL_DAYS = 90;

interface McpToken {
  token: string;
  label: string;
  createdAt: string;
  expiresAt: string;
}

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

  /** Generate a new access token with label and expiration, persist it. ttlDays=0 means never expires. */
  generateToken(label: string = "default", ttlDays: number = TOKEN_TTL_DAYS): McpToken {
    const now = new Date();
    const expires = ttlDays > 0
      ? new Date(now.getTime() + ttlDays * 86400000)
      : new Date("9999-12-31T23:59:59.999Z");
    const entry: McpToken = {
      token: `yo_${crypto.randomBytes(24).toString("hex")}`,
      label: label || "default",
      createdAt: now.toISOString(),
      expiresAt: expires.toISOString(),
    };
    const tokens = this.getTokens();
    tokens.push(entry);
    setPreference("mcpExposeTokens", tokens);
    return entry;
  }

  /** Remove an access token by its value. */
  revokeToken(token: string): void {
    const tokens = this.getTokens();
    setPreference("mcpExposeTokens", tokens.filter((t) => t.token !== token));
  }

  /** Get all non-expired tokens. Prunes expired ones on read. */
  getTokens(): McpToken[] {
    const raw = getPreference<(McpToken | string)[]>("mcpExposeTokens", []);
    const now = Date.now();
    const migrated: McpToken[] = raw.map((t) => {
      if (typeof t === "string") {
        return { token: t, label: "default", createdAt: new Date().toISOString(), expiresAt: new Date(now + TOKEN_TTL_DAYS * 86400000).toISOString() };
      }
      return t;
    });
    const active = migrated.filter((t) => new Date(t.expiresAt).getTime() > now);
    if (active.length !== raw.length) {
      setPreference("mcpExposeTokens", active);
    }
    return active;
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

    // Streamable HTTP endpoint — single URL for MCP clients like Claude Code
    if (url === "/mcp" && req.method === "POST") {
      this.handleStreamableHttp(req, res);
      return;
    }

    // REST endpoint — simple POST to ingest content (used by hooks)
    if (url === "/api/sup" && req.method === "POST") {
      this.handleApiSup(req, res);
      return;
    }

    // Health check
    if (url === "/" || url === "/mcp") {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ name: "yo", version: "1.0.0", status: "ok" }));
        return;
      }
    }

    res.writeHead(404);
    res.end("Not found");
  }

  private checkAuth(req: http.IncomingMessage): boolean {
    const tokens = this.getTokens();
    if (tokens.length === 0) return false;

    const authHeader = req.headers.authorization;
    if (!authHeader) return false;

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;

    return tokens.some((t) => t.token === match[1]);
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

  // ── Streamable HTTP (single-endpoint MCP) ──────────────────

  private async handleStreamableHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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
    if (response) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } else {
      res.writeHead(202);
      res.end();
    }
  }

  // ── JSON-RPC message handling (legacy SSE transport) ──────

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
            serverInfo: { name: "yo", version: "1.0.0" },
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
                name: "yo",
                description: "Search the user's .Yo capture store. Returns context from across all the user's apps — conversations, code, emails, docs, anything they've worked on. Uses vector similarity for semantic search with keyword fallback. Use descriptive natural language queries, not keywords.",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string", description: "Natural language search query — describe what you're looking for, not just keywords" },
                    limit: { type: "number", description: "Max results to return (default 10)" },
                  },
                  required: ["query"],
                },
              },
              {
                name: "sup",
                description: "Push context into the user's .Yo capture store. The content will be chunked, embedded, and indexed for future search via the 'yo' tool. Use this to share code, conversation snippets, research, notes, or any context the user might want to recall later.",
                inputSchema: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Short label for this context (e.g. 'pricing-thread', 'auth-refactor', 'meeting-notes')" },
                    content: { type: "string", description: "The content to store — markdown, code, conversation text, etc." },
                  },
                  required: ["name", "content"],
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

  private async handleApiSup(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.captureStore) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Capture store not available" }));
      return;
    }

    let body = "";
    for await (const chunk of req) body += chunk;

    let data: { name?: string; content?: string };
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const name = String(data.name || "").trim();
    const content = String(data.content || "").trim();

    if (!name || !content) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Both name and content are required" }));
      return;
    }

    const entryId = await this.captureStore.ingest(name, content);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: entryId }));
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
      case "yo": {
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
        if (results.length === 0) {
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `No results for "${query}".` }] } };
        }

        const text = results.map((r) =>
          `[${r.meta.source}] (score: ${r.score.toFixed(2)}) ${new Date(r.meta.created).toLocaleString()}\n${r.content}`,
        ).join("\n\n---\n\n");

        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
      }

      case "sup": {
        const name = String(args.name || "").trim();
        const content = String(args.content || "").trim();

        if (!name || !content) {
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: "Both name and content are required." }], isError: true },
          };
        }

        const entryId = await this.captureStore.ingest(name, content);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `Stored "${name}" (id: ${entryId}). Content chunked, embedded, and indexed.` }] },
        };
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
