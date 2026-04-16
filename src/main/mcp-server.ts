/**
 * Local server — HTTP endpoints + MCP tools for note push/search.
 *
 * Runs on http://127.0.0.1:3939
 *
 * HTTP endpoints:
 *   POST /sup          — write a note to ~/yo/notes/
 *   GET  /yo?q=...     — search notes (vector + keyword)
 *   GET  /health       — status check
 *
 * MCP endpoint (for Claude Desktop / Claude Code):
 *   POST /mcp          — MCP protocol with sup + yo tools
 */

import http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { NoteStore } from "./note-store";

const MCP_PORT = 3939;

export class MCPServer {
  private running = false;
  private httpServer: http.Server | null = null;

  constructor(private noteStore: NoteStore) {}

  private createMcpServer(): McpServer {
    const mcp = new McpServer({
      name: "yo-local",
      version: "0.3.0",
    });

    mcp.tool(
      "sup",
      "Push a note into the user's local yo notes. Use this to share content, notes, or summaries that the user can later retrieve with .yo queries.",
      {
        title: z.string().describe("Title for the note"),
        content: z.string().describe("Text content to store"),
        source: z.string().optional().describe("Source identifier (e.g. 'claude-code', 'agent')"),
      },
      async ({ title, content, source }) => {
        const filepath = await this.noteStore.write(title, content, source || "mcp");
        return {
          content: [{
            type: "text" as const,
            text: `Saved note: ${filepath} (${content.length} chars)`,
          }],
        };
      }
    );

    mcp.tool(
      "yo",
      "Search the user's notes. Returns relevant notes ranked by similarity.",
      {
        query: z.string().describe("Search query"),
        limit: z.number().optional().describe("Max results (default 10)"),
      },
      async ({ query, limit }) => {
        const results = await this.noteStore.search(query, limit || 10);
        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No results for "${query}"` }],
          };
        }
        const text = results.map((r) =>
          `[${r.title} | ${r.file} | ${this.formatAge(r.timestamp)}]\n${r.content}`
        ).join("\n\n---\n\n");
        return { content: [{ type: "text" as const, text }] };
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

      // ── POST /sup — write a note
      if (req.method === "POST" && req.url === "/sup") {
        try {
          const body = await this.parseBody(req) as any;
          if (!body?.content) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing content" }));
            return;
          }
          const title = body.title || body.panel_id || "push";
          const filepath = await this.noteStore.write(title, body.content, body.source || "http");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, file: filepath, chars: body.content.length }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Failed to write note" }));
        }
        return;
      }

      // ── GET /yo?q=... — search notes
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
          const results = await this.noteStore.search(query, limit);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            query,
            count: results.length,
            results: results.map((r) => ({
              file: r.file,
              title: r.title,
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
          endpoints: ["POST /sup", "GET /yo?q=", "POST /mcp"],
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
