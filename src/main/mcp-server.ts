/**
 * Local server — HTTP endpoints + MCP tools for context push/pull.
 *
 * Runs on http://127.0.0.1:3939
 *
 * HTTP endpoints (simple, no protocol overhead):
 *   POST /sup          — push context into the store
 *   GET  /yo?q=...     — search the context store
 *   POST /sup/capture  — force immediate panel capture
 *   GET  /health       — status check
 *
 * MCP endpoint (for Claude Desktop / Claude Code):
 *   POST /mcp          — MCP protocol with sup + yo tools
 */

import http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ContextStore } from "./context-store";
import type { AmbientCapture } from "./ambient-capture";

const MCP_PORT = 3939;

export class MCPServer {
  private running = false;
  private httpServer: http.Server | null = null;

  constructor(
    private contextStore: ContextStore,
    private ambientCapture: AmbientCapture | null = null,
  ) {}

  setAmbientCapture(capture: AmbientCapture): void {
    this.ambientCapture = capture;
  }

  private createMcpServer(): McpServer {
    const mcp = new McpServer({
      name: "yo-local",
      version: "0.2.0",
    });

    mcp.tool(
      "sup",
      "Push context into the local yo context store. Use this to share content, notes, or summaries that the user can later retrieve with .yo queries.",
      {
        panel_id: z.string().describe("Source identifier (e.g. 'claude', 'server', 'agent')"),
        content: z.string().describe("Text content to store"),
        title: z.string().optional().describe("Title for the content"),
        url: z.string().optional().describe("Source URL"),
      },
      async ({ panel_id, content, title, url }) => {
        const stored = this.contextStore.insertCapture(
          panel_id,
          url || "",
          title || panel_id,
          content,
        );
        return {
          content: [{
            type: "text" as const,
            text: stored
              ? `Stored ${content.length} chars from ${panel_id}`
              : `Content unchanged for ${panel_id} (skipped)`,
          }],
        };
      }
    );

    mcp.tool(
      "yo",
      "Search the user's ambient context store. Returns relevant chunks from all captured panels.",
      {
        query: z.string().describe("Search query"),
        limit: z.number().optional().describe("Max results (default 10)"),
      },
      async ({ query, limit }) => {
        const results = this.contextStore.search(query, limit || 10);
        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No results for "${query}"` }],
          };
        }
        const text = results.map((r) =>
          `[${r.panel_id} | ${r.title} | ${this.formatAge(r.timestamp)}]\n${r.content}`
        ).join("\n\n---\n\n");
        return { content: [{ type: "text" as const, text }] };
      }
    );

    mcp.tool(
      "sup_capture",
      "Force an immediate capture of all open panels into the context store (normally runs every 45s).",
      {},
      async () => {
        if (!this.ambientCapture) {
          return {
            content: [{ type: "text" as const, text: "Ambient capture not available" }],
            isError: true,
          };
        }
        const count = await this.ambientCapture.captureNow();
        return {
          content: [{ type: "text" as const, text: `Captured ${count} panels` }],
        };
      }
    );

    return mcp;
  }

  async start(): Promise<void> {
    this.httpServer = http.createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

      // ── POST /sup — push context
      if (req.method === "POST" && req.url === "/sup") {
        try {
          const body = await this.parseBody(req) as any;
          if (!body?.panel_id || !body?.content) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing panel_id or content" }));
            return;
          }
          const stored = this.contextStore.insertCapture(
            body.panel_id,
            body.url || "",
            body.title || body.panel_id,
            body.content,
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, stored, chars: body.content.length }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to store context" }));
        }
        return;
      }

      // ── GET /yo?q=... — search context
      if (req.method === "GET" && req.url?.startsWith("/yo")) {
        try {
          const url = new URL(req.url, `http://127.0.0.1:${MCP_PORT}`);
          const query = url.searchParams.get("q");
          const limit = parseInt(url.searchParams.get("limit") || "10", 10);
          if (!query) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing q parameter" }));
            return;
          }
          const results = this.contextStore.search(query, limit);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            query,
            count: results.length,
            results: results.map((r) => ({
              panel_id: r.panel_id,
              title: r.title,
              url: r.url,
              content: r.content,
              age: this.formatAge(r.timestamp),
              rank: r.rank,
            })),
          }));
        } catch {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Search failed" }));
        }
        return;
      }

      // ── POST /sup/capture — force immediate capture
      if (req.method === "POST" && req.url === "/sup/capture") {
        if (!this.ambientCapture) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Ambient capture not available" }));
          return;
        }
        try {
          const count = await this.ambientCapture.captureNow();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, captured: count }));
        } catch {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Capture failed" }));
        }
        return;
      }

      // ── MCP protocol endpoint
      if (req.url === "/mcp") {
        try {
          const body = req.method === "POST" ? await this.parseBody(req) : undefined;
          const mcp = this.createMcpServer();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          res.on("close", () => transport.close());
          await mcp.connect(transport);
          await transport.handleRequest(req, res, body);
        } catch {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        }
        return;
      }

      // ── Health check
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          endpoints: ["POST /sup", "GET /yo?q=", "POST /sup/capture", "POST /mcp"],
        }));
        return;
      }

      res.writeHead(404).end("Not found");
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.warn(`[mcp] port ${MCP_PORT} in use, skipping local server`);
          resolve();
        } else {
          reject(err);
        }
      });
      this.httpServer!.listen(MCP_PORT, "127.0.0.1", () => {
        console.log(`[mcp] local server on http://127.0.0.1:${MCP_PORT}`);
        resolve();
      });
    });

    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.httpServer?.close();
    this.httpServer = null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private formatAge(ts: number): string {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  private parseBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          resolve(undefined);
        }
      });
      req.on("error", reject);
    });
  }
}
