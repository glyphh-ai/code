/**
 * WorkspaceMcpServer — local HTTP MCP server that backs the multi-agent
 * workspace. Code-terminals (each running `claude`) talk to it via the
 * `.mcp.json` we drop in the workspace's rootDir.
 *
 * Transport: HTTP on 127.0.0.1:<random-port>. No auth — loopback only.
 * Each request carries identity headers set by the agent's .mcp.json:
 *   X-Yo-Agent       — caller's agent name (or ".yo" / "user")
 *   X-Yo-Workspace   — caller's workspace slug
 *
 * Tools (locked by MULTI-AGENT-PLAN §3.4):
 *   team_status(), read_log(filter?), read_agent(name, kind?),
 *   post(body, tags?, kind?, refs?), post_to(agent, body, tags?),
 *   subscribe(filter), unsubscribe(id)
 *
 * Server is a single instance shared across workspaces — the active
 * workspace is per-request via the X-Yo-Workspace header. Falls back to
 * the active workspace via workspaceGetter() if the header is absent.
 */
import http from "http";
import type { EventLog, YoEvent } from "./event-log";
import type { WorkspaceManager, CodeAgent } from "./workspace-manager";
import type { CypherBus } from "./cypher-bus";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface CallContext {
  agent: string;       // X-Yo-Agent header (or ".yo" fallback)
  workspace: string;   // X-Yo-Workspace header (or active workspace)
}

const SERVER_NAME = "yo-workspace";
const SERVER_VERSION = "1.0.0";

export class WorkspaceMcpServer {
  private server: http.Server | null = null;
  private port = 0;
  private bus: CypherBus | null = null;

  constructor(
    private eventLog: EventLog,
    private workspaceManager: WorkspaceManager,
  ) {}

  setBus(bus: CypherBus): void {
    this.bus = bus;
  }

  get isRunning(): boolean {
    return this.server?.listening ?? false;
  }

  /** Bound port (0 if not started). */
  getPort(): number {
    return this.port;
  }

  /** URL agents should connect to: http://127.0.0.1:<port>/mcp */
  getUrl(): string | null {
    return this.isRunning ? `http://127.0.0.1:${this.port}/mcp` : null;
  }

  /** Start on a random loopback port. Idempotent. */
  start(): Promise<{ ok: boolean; error?: string }> {
    if (this.isRunning) return Promise.resolve({ ok: true });
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.on("error", (err: NodeJS.ErrnoException) => {
        resolve({ ok: false, error: err.message });
      });
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          console.log(`[workspace-mcp] listening on http://127.0.0.1:${this.port}/mcp`);
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: "failed to bind" });
        }
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = 0;
      console.log("[workspace-mcp] stopped");
    }
  }

  // ── HTTP ──────────────────────────────────────────────────

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // CORS for local tools (loopback only, but harmless to send).
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Yo-Agent, X-Yo-Workspace");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url || "/";

    if (url === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: SERVER_NAME, version: SERVER_VERSION, status: "ok" }));
      return;
    }

    if (url === "/mcp" && req.method === "POST") {
      await this.handleMcp(req, res);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  }

  private async handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body = "";
    for await (const chunk of req) body += chunk;

    let rpc: RpcRequest;
    try {
      rpc = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const ctx: CallContext = {
      agent: String(req.headers["x-yo-agent"] || ".yo"),
      workspace: String(req.headers["x-yo-workspace"] || this.workspaceManager.getActiveSlug()),
    };

    const response = await this.processRpc(rpc, ctx);
    if (response) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } else {
      res.writeHead(202);
      res.end();
    }
  }

  // ── JSON-RPC ──────────────────────────────────────────────

  private async processRpc(rpc: RpcRequest, ctx: CallContext): Promise<Record<string, unknown> | null> {
    const { id, method, params } = rpc;

    switch (method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        };

      case "notifications/initialized":
        return null;

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

      case "tools/call":
        return this.handleToolCall(id, params as { name: string; arguments?: Record<string, unknown> }, ctx);

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
    ctx: CallContext,
  ): Promise<Record<string, unknown>> {
    const args = params.arguments || {};
    const reply = (text: string, isError = false) => ({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
    });
    const replyJson = (data: unknown) =>
      reply(JSON.stringify(data, null, 2));

    try {
      switch (params.name) {
        case "team_status": {
          const ws = this.workspaceManager.get(ctx.workspace);
          if (!ws) return reply(`Unknown workspace: ${ctx.workspace}`, true);
          const agents = this.workspaceManager.listAgents(ctx.workspace);
          const status = this.eventLog.teamStatus(ctx.workspace, agents);
          return replyJson({
            workspace: ws.slug,
            rootDir: ws.rootDir,
            agents: status.map((s) => ({
              ...s,
              lastPostAt: s.lastPostTs ? new Date(s.lastPostTs).toISOString() : null,
            })),
          });
        }

        case "read_log": {
          const filter = (args.filter as Record<string, unknown>) || args;
          const events = this.eventLog.read(ctx.workspace, {
            tags: asStringArray(filter.tags),
            from: asStringArray(filter.from),
            to: typeof filter.to === "string" ? filter.to : undefined,
            since: typeof filter.since === "number" ? filter.since : undefined,
            until: typeof filter.until === "number" ? filter.until : undefined,
            kinds: asStringArray(filter.kinds) as YoEvent["kind"][] | undefined,
            limit: typeof filter.limit === "number" ? filter.limit : undefined,
          });
          return replyJson({ count: events.length, events });
        }

        case "read_agent": {
          const name = String(args.name || "").trim();
          if (!name) return reply("name is required", true);
          const kind = String(args.kind || "scratchpad");
          if (kind === "log") {
            const events = this.eventLog.read(ctx.workspace, { from: [name] });
            return replyJson({ agent: name, events });
          }
          // Default: scratchpad
          const text = this.eventLog.readScratchpad(ctx.workspace, name);
          return reply(text || `(${name} has no scratchpad yet)`);
        }

        case "post": {
          const body = String(args.body || "").trim();
          if (!body) return reply("body is required", true);
          const tags = mergeTags(asStringArray(args.tags) ?? [], ctx);
          if (this.bus) {
            await this.bus.post(ctx.workspace, {
              from: ctx.agent,
              kind: (args.kind as string) || "post",
              body,
              tags,
              refs: asStringArray(args.refs),
            });
          } else {
            this.eventLog.append(ctx.workspace, {
              from: ctx.agent,
              tags,
              kind: (args.kind as YoEvent["kind"]) || "post",
              body,
              refs: asStringArray(args.refs),
            });
          }
          return replyJson({ ts: Date.now() });
        }

        case "post_to": {
          const to = String(args.agent || "").trim();
          const body = String(args.body || "").trim();
          if (!to) return reply("agent is required", true);
          if (!body) return reply("body is required", true);
          const tags = mergeTags(asStringArray(args.tags) ?? [], ctx);
          if (this.bus) {
            await this.bus.post(ctx.workspace, {
              from: ctx.agent,
              to,
              kind: (args.kind as string) || "post",
              body,
              tags,
              refs: asStringArray(args.refs),
            });
          } else {
            this.eventLog.append(ctx.workspace, {
              from: ctx.agent,
              to,
              tags,
              kind: (args.kind as YoEvent["kind"]) || "post",
              body,
              refs: asStringArray(args.refs),
            });
          }
          return replyJson({ ts: Date.now() });
        }

        case "subscribe": {
          const filter = (args.filter as Record<string, unknown>) || args;
          const result = this.workspaceManager.addSubscription(ctx.workspace, ctx.agent, {
            tags: asStringArray(filter.tags),
            from: asStringArray(filter.from),
            mentions_me: filter.mentions_me === true,
          });
          if (!result.ok) return reply(result.error, true);
          return replyJson({ id: result.id });
        }

        case "unsubscribe": {
          const subId = String(args.id || "").trim();
          if (!subId) return reply("id is required", true);
          const ok = this.workspaceManager.removeSubscription(ctx.workspace, ctx.agent, subId);
          return reply(ok ? "ok" : `No subscription ${subId} for ${ctx.agent}`, !ok);
        }

        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: `Unknown tool: ${params.name}` },
          };
      }
    } catch (err) {
      return reply(`Tool error: ${(err as Error).message}`, true);
    }
  }
}

// ── helpers ─────────────────────────────────────────────────

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

/** Auto-stamp role:<role> + from:<agent> + workspace:<slug> tags so consumers
 *  can filter by them without each agent remembering to add them. */
function mergeTags(userTags: string[], ctx: CallContext): string[] {
  const merged = new Set<string>(userTags);
  merged.add(`from:${ctx.agent}`);
  merged.add(`workspace:${ctx.workspace}`);
  return Array.from(merged);
}

// ── tool definitions (sent in tools/list response) ─────────

const TOOLS = [
  {
    name: "team_status",
    description:
      "List all agents in this workspace with their roles, last post timestamp, and post counts. Use this at the start of a session to see who else is on the team.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_log",
    description:
      "Read the workspace event log. Optional filter narrows by tags, sender, recipient, kind, or time. Returns latest-first.",
    inputSchema: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" }, description: "Match events tagged with any of these (e.g. ['role:ui', 'broadcast'])" },
        from: { type: "array", items: { type: "string" }, description: "Match events from any of these agent names" },
        to: { type: "string", description: "Match events directly addressed to this agent" },
        since: { type: "number", description: "Match events with ts > since (ms epoch)" },
        until: { type: "number", description: "Match events with ts <= until (ms epoch)" },
        kinds: { type: "array", items: { type: "string" }, description: "post | status | question | answer | artifact" },
        limit: { type: "number", description: "Max events (default 50)" },
      },
    },
  },
  {
    name: "read_agent",
    description:
      "Read another agent's scratchpad markdown (kind='scratchpad', default) or the events they've posted (kind='log').",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Agent name" },
        kind: { type: "string", enum: ["scratchpad", "log"], description: "scratchpad (default) or log" },
      },
      required: ["name"],
    },
  },
  {
    name: "post",
    description:
      "Append an event to the workspace log. Use for status updates (tags: ['broadcast']), role-targeted messages (tags: ['role:server']), or internal notes (no tags). Add tag 'blocking' if you need a teammate response before continuing.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", description: "Message body (markdown ok)" },
        tags: { type: "array", items: { type: "string" }, description: "Tags — see description" },
        kind: { type: "string", enum: ["post", "status", "question", "answer", "artifact"], description: "Event kind (default: post)" },
        refs: { type: "array", items: { type: "string" }, description: "File paths, commit shas, or ts of replied-to event" },
      },
      required: ["body"],
    },
  },
  {
    name: "post_to",
    description:
      "Direct message another agent. Sets the `to` field for fast-path delivery (subscribed peers see it within ~1s).",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Recipient agent name" },
        body: { type: "string", description: "Message body" },
        tags: { type: "array", items: { type: "string" } },
        kind: { type: "string", enum: ["post", "status", "question", "answer", "artifact"] },
        refs: { type: "array", items: { type: "string" } },
      },
      required: ["agent", "body"],
    },
  },
  {
    name: "subscribe",
    description:
      "Register a tag-filter so the orchestrator delivers matching events to your inbox. Default subscriptions (mentions_me, your role, broadcast) are auto-added at panel creation; this is for adding extras.",
    inputSchema: {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" }, description: "Match events tagged with any of these" },
        from: { type: "array", items: { type: "string" }, description: "Match events from any of these agents" },
        mentions_me: { type: "boolean", description: "Match events with `to: <my-name>`" },
      },
    },
  },
  {
    name: "unsubscribe",
    description: "Remove a subscription by id (returned from subscribe()).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
];
