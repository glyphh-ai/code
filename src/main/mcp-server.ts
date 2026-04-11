/**
 * Local MCP server — exposes yo/sup as tools over HTTP.
 *
 * Runs on http://127.0.0.1:3939/mcp so Claude Desktop, Claude Code,
 * and any local MCP-capable tool can connect.
 */

import http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Library } from "./library";

const MCP_PORT = 3939;

export class MCPServer {
  private library: Library;
  private running = false;
  private httpServer: http.Server | null = null;

  constructor(library: Library) {
    this.library = library;
  }

  private createMcpServer(): McpServer {
    const mcp = new McpServer({
      name: "yo-local",
      version: "0.1.0",
    });

    mcp.tool(
      "yo",
      "Save markdown content to your local yo library (~~/yo/library/)",
      {
        name: z.string().describe("Context name (e.g. meeting-notes, standup)"),
        content: z.string().describe("Markdown content to save"),
      },
      async ({ name, content }) => {
        this.library.write(name, content);
        return {
          content: [{ type: "text" as const, text: `Saved ${name}.md to ~/yo/library/` }],
        };
      }
    );

    mcp.tool(
      "sup",
      "Read markdown content from your local yo library",
      {
        name: z.string().describe("Context name to read"),
      },
      async ({ name }) => {
        const content = this.library.read(name);
        if (content === null) {
          return {
            content: [{ type: "text" as const, text: `${name}.md not found` }],
            isError: true,
          };
        }
        return { content: [{ type: "text" as const, text: content }] };
      }
    );

    mcp.tool(
      "sup_list",
      "List all contexts in your yo library",
      {},
      async () => {
        const names = this.library.list();
        if (names.length === 0) {
          return { content: [{ type: "text" as const, text: "Library is empty" }] };
        }
        return { content: [{ type: "text" as const, text: names.join("\n") }] };
      }
    );

    mcp.tool(
      "sup_search",
      "Search yo library by name or content",
      {
        term: z.string().describe("Search term"),
      },
      async ({ term }) => {
        const results = this.library.search(term);
        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No results for "${term}"` }],
          };
        }
        return { content: [{ type: "text" as const, text: results.join("\n") }] };
      }
    );

    return mcp;
  }

  async start(): Promise<void> {
    this.httpServer = http.createServer(async (req, res) => {
      // CORS for local tools
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

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
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        }
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, tools: ["yo", "sup", "sup_list", "sup_search"] }));
        return;
      }

      res.writeHead(404).end("Not found");
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.warn(`[mcp] port ${MCP_PORT} in use, skipping local MCP server`);
          resolve();
        } else {
          reject(err);
        }
      });
      this.httpServer!.listen(MCP_PORT, "127.0.0.1", () => {
        console.log(`[mcp] local server on http://127.0.0.1:${MCP_PORT}/mcp`);
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
