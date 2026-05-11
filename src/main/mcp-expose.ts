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
import type { EventLog, YoEvent } from "./event-log";
import type { WorkspaceManager } from "./workspace-manager";
import type { CypherBus } from "./cypher-bus";
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

interface CallContext {
  agent: string;
  workspace: string;
}

export interface HierarchyEntry {
  agentId: string;
  position: string;
  parentAgentId: string | null;
  reports: string[];
  area: string | null;
  contract: string | null;
}

export class McpExpose {
  private server: http.Server | null = null;
  private captureStore: CaptureStore | null = null;
  private clients = new Map<string, SseClient>();
  private port = DEFAULT_PORT;
  private eventLog: EventLog | null = null;
  private workspaceManager: WorkspaceManager | null = null;
  private bus: CypherBus | null = null;
  private hierarchyContext: Map<string, HierarchyEntry> | null = null;

  setCaptureStore(store: CaptureStore): void {
    this.captureStore = store;
  }

  setBus(bus: CypherBus): void {
    this.bus = bus;
  }

  setHierarchyContext(ctx: Map<string, HierarchyEntry> | null): void {
    this.hierarchyContext = ctx;
  }

  setWorkspaceBackend(eventLog: EventLog, wm: WorkspaceManager): void {
    this.eventLog = eventLog;
    this.workspaceManager = wm;
  }

  private workspaceGetter: (() => string) | null = null;
  setWorkspaceGetter(fn: () => string): void {
    this.workspaceGetter = fn;
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

  private extractContext(req: http.IncomingMessage): CallContext {
    return {
      agent: String(req.headers["x-yo-agent"] || ".yo"),
      workspace: String(req.headers["x-yo-workspace"] || this.workspaceGetter?.() || "default"),
    };
  }

  // ── HTTP handling ─────────────────────────────────────────

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS for local tools — must run before auth so preflight isn't blocked
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Yo-Agent, X-Yo-Workspace");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check
    if (!this.checkAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
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

    const ctx = this.extractContext(req);
    const response = await this.processRpc(rpc, ctx);
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

  private async processRpc(rpc: McpRequest, ctx?: CallContext): Promise<Record<string, unknown> | null> {
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
        return { jsonrpc: "2.0", id, result: { tools: this.buildToolList() } };

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

    const entryId = await this.captureStore.ingest(name, content, this.workspaceGetter?.());
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: entryId }));
  }

  private async handleToolCall(
    id: string | number | undefined,
    params: { name: string; arguments?: Record<string, unknown> },
    ctx?: CallContext,
  ): Promise<Record<string, unknown>> {
    const args = params.arguments || {};
    const reply = (text: string, isError = false) => ({
      jsonrpc: "2.0" as const, id,
      result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
    });
    const replyJson = (data: unknown) => reply(JSON.stringify(data, null, 2));

    switch (params.name) {
      // ── Capture store tools ────────────────────────────────
      case "yo": {
        if (!this.captureStore) return reply("Capture store not available.", true);
        const query = String(args.query || "");
        const limit = Number(args.limit) || 10;
        if (!query) return reply("query is required", true);

        const results = await this.captureStore.search(query, limit);
        if (results.length === 0) return reply(`No results for "${query}".`);

        const text = results.map((r) =>
          `[${r.meta.source}] (score: ${r.score.toFixed(2)}) ${new Date(r.meta.created).toLocaleString()}\n${r.content}`,
        ).join("\n\n---\n\n");
        return reply(text);
      }

      case "sup": {
        if (!this.captureStore) return reply("Capture store not available.", true);
        const name = String(args.name || "").trim();
        const content = String(args.content || "").trim();
        if (!name || !content) return reply("Both name and content are required.", true);

        const entryId = await this.captureStore.ingest(name, content, this.workspaceGetter?.());
        return reply(`Stored "${name}" (id: ${entryId}). Content chunked, embedded, and indexed.`);
      }

      // ── Workspace tools ────────────────────────────────────
      case "team_status": {
        if (!this.workspaceManager || !this.eventLog) return reply("Workspace backend not available.", true);
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const ws = this.workspaceManager.get(wsSlug);
        if (!ws) return reply(`Unknown workspace: ${wsSlug}`, true);
        const agents = this.workspaceManager.listAgents(wsSlug);
        const status = this.eventLog.teamStatus(wsSlug, agents);
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
        if (!this.eventLog) return reply("Workspace backend not available.", true);
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const filter = (args.filter as Record<string, unknown>) || args;
        const events = this.eventLog.read(wsSlug, {
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
        if (!this.eventLog) return reply("Workspace backend not available.", true);
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const name = String(args.name || "").trim();
        if (!name) return reply("name is required", true);
        const kind = String(args.kind || "scratchpad");
        if (kind === "log") {
          const events = this.eventLog.read(wsSlug, { from: [name] });
          return replyJson({ agent: name, events });
        }
        const text = this.eventLog.readScratchpad(wsSlug, name);
        return reply(text || `(${name} has no scratchpad yet)`);
      }

      case "post": {
        if (!this.eventLog) return reply("Workspace backend not available.", true);
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const body = String(args.body || "").trim();
        if (!body) return reply("body is required", true);
        const tags = mergeTags(asStringArray(args.tags) ?? [], ctx || { agent: ".yo", workspace: wsSlug });
        if (this.bus) {
          await this.bus.post(wsSlug, {
            from: ctx?.agent || ".yo",
            kind: (args.kind as string) || "post",
            body,
            tags,
            refs: asStringArray(args.refs),
          });
        } else {
          this.eventLog.append(wsSlug, {
            from: ctx?.agent || ".yo",
            tags,
            kind: (args.kind as YoEvent["kind"]) || "post",
            body,
            refs: asStringArray(args.refs),
          });
        }
        return replyJson({ ts: Date.now() });
      }

      case "post_to": {
        if (!this.eventLog) return reply("Workspace backend not available.", true);
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const to = String(args.agent || "").trim();
        const body = String(args.body || "").trim();
        if (!to) return reply("agent is required", true);
        if (!body) return reply("body is required", true);
        const tags = mergeTags(asStringArray(args.tags) ?? [], ctx || { agent: ".yo", workspace: wsSlug });
        if (this.bus) {
          await this.bus.post(wsSlug, {
            from: ctx?.agent || ".yo",
            to,
            kind: (args.kind as string) || "post",
            body,
            tags,
            refs: asStringArray(args.refs),
          });
        } else {
          this.eventLog.append(wsSlug, {
            from: ctx?.agent || ".yo",
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
        if (!this.workspaceManager) return reply("Workspace backend not available.", true);
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const filter = (args.filter as Record<string, unknown>) || args;
        const result = this.workspaceManager.addSubscription(wsSlug, ctx?.agent || ".yo", {
          tags: asStringArray(filter.tags),
          from: asStringArray(filter.from),
          mentions_me: filter.mentions_me === true,
        });
        if (!result.ok) return reply(result.error!, true);
        return replyJson({ id: result.id });
      }

      case "unsubscribe": {
        if (!this.workspaceManager) return reply("Workspace backend not available.", true);
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const subId = String(args.id || "").trim();
        if (!subId) return reply("id is required", true);
        const ok = this.workspaceManager.removeSubscription(wsSlug, ctx?.agent || ".yo", subId);
        return reply(ok ? "ok" : `No subscription ${subId}`, !ok);
      }

      // ── Hierarchy tools (cypher mode only) ──────────────────
      case "get_hierarchy": {
        if (!this.hierarchyContext) return reply("No hierarchy context (not in cypher mode)", true);
        const agent = ctx?.agent || ".yo";
        const entry = this.hierarchyContext.get(agent);
        if (!entry) return reply(`Agent "${agent}" not found in hierarchy`, true);
        const chain: string[] = [];
        let cur = entry.parentAgentId;
        while (cur) {
          chain.push(cur);
          const p = this.hierarchyContext.get(cur);
          cur = p?.parentAgentId ?? null;
        }
        return replyJson({ ...entry, chain_of_command: chain });
      }

      case "assign_task": {
        if (!this.hierarchyContext) return reply("No hierarchy context (not in cypher mode)", true);
        const agent = ctx?.agent || ".yo";
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const caller = this.hierarchyContext.get(agent);
        if (!caller) return reply(`Agent "${agent}" not found in hierarchy`, true);
        if (caller.reports.length === 0) return reply(`${agent} has no direct reports — only leaders/lieutenants/sub-leads can assign tasks`, true);
        const target = String(args.agent || "").trim();
        const taskBody = String(args.body || "").trim();
        if (!target) return reply("agent is required", true);
        if (!taskBody) return reply("body is required", true);
        if (!caller.reports.includes(target)) return reply(`${target} is not a direct report of ${agent}. Your reports: ${caller.reports.join(", ")}`, true);
        if (this.bus) {
          await this.bus.post(wsSlug, { from: agent, to: target, kind: "assign_task", body: taskBody });
        }
        return replyJson({ ok: true, assigned_to: target, task: taskBody });
      }

      case "accept_task": {
        if (!this.hierarchyContext) return reply("No hierarchy context (not in cypher mode)", true);
        const agent = ctx?.agent || ".yo";
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const caller = this.hierarchyContext.get(agent);
        if (!caller) return reply(`Agent "${agent}" not found in hierarchy`, true);
        const taskId = String(args.task_id || "").trim();
        if (this.bus) {
          await this.bus.post(wsSlug, {
            from: agent,
            to: caller.parentAgentId || undefined,
            kind: "accept_task",
            body: taskId ? `Accepted task ${taskId}` : "Task accepted",
            meta: taskId ? { task_id: taskId } : undefined,
          });
        }
        return replyJson({ ok: true, accepted_by: agent });
      }

      case "complete_task": {
        if (!this.hierarchyContext) return reply("No hierarchy context (not in cypher mode)", true);
        const agent = ctx?.agent || ".yo";
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const caller = this.hierarchyContext.get(agent);
        if (!caller) return reply(`Agent "${agent}" not found in hierarchy`, true);
        const summary = String(args.summary || "").trim();
        if (!summary) return reply("summary is required", true);
        if (this.bus) {
          await this.bus.post(wsSlug, {
            from: agent,
            to: caller.parentAgentId || undefined,
            kind: "complete_task",
            body: summary,
          });
        }
        return replyJson({ ok: true, completed_by: agent });
      }

      case "report_status": {
        if (!this.hierarchyContext) return reply("No hierarchy context (not in cypher mode)", true);
        const agent = ctx?.agent || ".yo";
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const caller = this.hierarchyContext.get(agent);
        if (!caller) return reply(`Agent "${agent}" not found in hierarchy`, true);
        const statusBody = String(args.body || "").trim();
        if (!statusBody) return reply("body is required", true);
        const statusKind = String(args.kind || "progress");
        if (this.bus) {
          await this.bus.post(wsSlug, {
            from: agent,
            to: caller.parentAgentId || undefined,
            kind: "report_status",
            body: statusBody,
            meta: { status_kind: statusKind },
          });
        }
        return replyJson({ ok: true, reported_by: agent, to: caller.parentAgentId });
      }

      case "request_review": {
        if (!this.hierarchyContext) return reply("No hierarchy context (not in cypher mode)", true);
        const agent = ctx?.agent || ".yo";
        const wsSlug = ctx?.workspace || this.workspaceGetter?.() || "default";
        const caller = this.hierarchyContext.get(agent);
        if (!caller) return reply(`Agent "${agent}" not found in hierarchy`, true);
        const reviewBody = String(args.body || "").trim();
        if (!reviewBody) return reply("body is required", true);
        if (this.bus) {
          await this.bus.post(wsSlug, {
            from: agent,
            to: caller.parentAgentId || undefined,
            kind: "request_review",
            body: reviewBody,
          });
        }
        return replyJson({ ok: true, requested_by: agent, reviewer: caller.parentAgentId });
      }

      default:
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params.name}` } };
    }
  }

  // ── Tool definitions ───────────────────────────────────────

  private buildToolList() {
    const tools: Record<string, unknown>[] = [
      {
        name: "yo",
        description: "Search the user's .Yo capture store. Returns context from across all the user's apps — conversations, code, emails, docs, anything they've worked on.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural language search query" },
            limit: { type: "number", description: "Max results (default 10)" },
          },
          required: ["query"],
        },
      },
      {
        name: "sup",
        description: "Push context into the user's .Yo capture store. Content is chunked, embedded, and indexed for future search.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short label (e.g. 'auth-refactor')" },
            content: { type: "string", description: "The content to store" },
          },
          required: ["name", "content"],
        },
      },
    ];

    if (this.workspaceManager && this.eventLog) {
      tools.push(
        {
          name: "team_status",
          description: "List all agents in this workspace with roles and last-post timestamps.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "read_log",
          description: "Read workspace event log. Filter by tags, sender, kind, or time.",
          inputSchema: {
            type: "object",
            properties: {
              tags: { type: "array", items: { type: "string" } },
              from: { type: "array", items: { type: "string" } },
              to: { type: "string" },
              since: { type: "number" },
              until: { type: "number" },
              kinds: { type: "array", items: { type: "string" } },
              limit: { type: "number" },
            },
          },
        },
        {
          name: "read_agent",
          description: "Read another agent's scratchpad or post history.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Agent name" },
              kind: { type: "string", enum: ["scratchpad", "log"] },
            },
            required: ["name"],
          },
        },
        {
          name: "post",
          description: "Append an event to the workspace log. Tags: ['broadcast'] for status, ['role:X'] for role-targeted, 'blocking' if response needed.",
          inputSchema: {
            type: "object",
            properties: {
              body: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              kind: { type: "string", enum: ["post", "status", "question", "answer", "artifact"] },
              refs: { type: "array", items: { type: "string" } },
            },
            required: ["body"],
          },
        },
        {
          name: "post_to",
          description: "Direct message another agent.",
          inputSchema: {
            type: "object",
            properties: {
              agent: { type: "string" },
              body: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              kind: { type: "string", enum: ["post", "status", "question", "answer", "artifact"] },
              refs: { type: "array", items: { type: "string" } },
            },
            required: ["agent", "body"],
          },
        },
        {
          name: "subscribe",
          description: "Register a tag-filter for inbox delivery of matching events.",
          inputSchema: {
            type: "object",
            properties: {
              tags: { type: "array", items: { type: "string" } },
              from: { type: "array", items: { type: "string" } },
              mentions_me: { type: "boolean" },
            },
          },
        },
        {
          name: "unsubscribe",
          description: "Remove a subscription by id.",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      );
    }

    if (this.hierarchyContext) {
      tools.push(
        {
          name: "get_hierarchy",
          description: "Returns your position, parent, direct reports, and full chain of command in the cypher hierarchy.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "assign_task",
          description: "Assign a task to one of your direct reports. Only leaders, lieutenants, and sub-leads can call this.",
          inputSchema: {
            type: "object",
            properties: {
              agent: { type: "string", description: "Agent name of the direct report to assign to" },
              body: { type: "string", description: "Task description" },
            },
            required: ["agent", "body"],
          },
        },
        {
          name: "accept_task",
          description: "Accept a task assigned to you by your parent in the chain of command.",
          inputSchema: {
            type: "object",
            properties: {
              task_id: { type: "string", description: "Optional task identifier" },
            },
          },
        },
        {
          name: "complete_task",
          description: "Mark your current task as complete. Notifies your parent in the chain of command.",
          inputSchema: {
            type: "object",
            properties: {
              summary: { type: "string", description: "Summary of what was accomplished" },
            },
            required: ["summary"],
          },
        },
        {
          name: "report_status",
          description: "Report progress, blockers, or other status to your parent in the chain of command.",
          inputSchema: {
            type: "object",
            properties: {
              body: { type: "string", description: "Status update" },
              kind: { type: "string", enum: ["progress", "blocker", "question", "complete"], description: "Status type (default: progress)" },
            },
            required: ["body"],
          },
        },
        {
          name: "request_review",
          description: "Request your parent to review your completed work before it's considered done.",
          inputSchema: {
            type: "object",
            properties: {
              body: { type: "string", description: "Description of what needs review" },
            },
            required: ["body"],
          },
        },
      );
    }

    return tools;
  }
}

// ── helpers ─────────────────────────────────────────────────

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

function mergeTags(userTags: string[], ctx: CallContext): string[] {
  const merged = new Set<string>(userTags);
  merged.add(`from:${ctx.agent}`);
  merged.add(`workspace:${ctx.workspace}`);
  return Array.from(merged);
}
