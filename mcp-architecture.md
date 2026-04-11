# YoSup MCP Architecture

## The Problem

AI chat panels (Claude, ChatGPT, Gemini) run over HTTPS with encrypted SSE streams. The Electron app can't intercept or read conversation content from the network layer. DOM scraping is fragile and provider-specific.

## The Solution

**MCP tools give the AI direct access to yo/sup.** When a user says "yo this as meeting-notes" inside Claude, Claude already has the full conversation — it just calls the `yo` MCP tool and passes the content. No interception needed.

## Two MCP Servers, Same Tools

```
┌─────────────────────────────────────────────────────────┐
│  LOCAL MCP SERVER (yo-client)                           │
│  stdio / localhost                                      │
│                                                         │
│  Clients: Claude Desktop, Claude Code, Cowork,          │
│           any local MCP-capable tool                    │
│                                                         │
│  yo(name, content) → writes straight to ~/yo/library/   │
│  sup(name)         → reads straight from ~/yo/library/  │
│  sup_list()        → lists all contexts                 │
│  sup_search(term)  → searches contexts                  │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  CLOUD MCP SERVER (yo-server @ yo.yo.dev/mcp)           │
│  StreamableHTTP, bearer auth                            │
│                                                         │
│  Clients: Claude web (BrowserView panels), ChatGPT,     │
│           Gemini, any remote AI that can't hit localhost │
│                                                         │
│  yo(name, content) → transient store + skill processing │
│  sup(name)         → search + return from transient     │
│  sup_list()        → list pending contexts              │
│  sup_search(term)  → search pending contexts            │
└─────────────────────────────────────────────────────────┘
```

## Data Flow

### Save: "yo this as meeting-notes"

```
User in Claude BrowserView
  │
  │  "yo this conversation as meeting-notes"
  │
  ▼
Claude calls yo MCP tool ──────► yo.yo.dev/mcp
                                    │
                                    ├── auth (bearer token per user)
                                    ├── run skill if configured (Haiku)
                                    ├── store result transiently
                                    │   (pending queue, TTL ~24h)
                                    │
  Local Yo client (polling) ◄───────┘
  GET /api/pending
  │
  ├── pulls down new items
  ├── writes to ~/yo/library/meeting-notes.md
  ├── ACKs → cloud deletes transient copy
  └── done
```

### Recall: "sup meeting-notes"

```
User in Claude BrowserView
  │
  │  "what were my meeting notes? sup meeting-notes"
  │
  ▼
Claude calls sup MCP tool ──────► yo.yo.dev/mcp
                                    │
                                    ├── checks transient store first
                                    ├── if not found, proxies to
                                    │   local client via sync API
                                    │
                                    ▼
                              returns content inline
                              (Claude shows it in chat)
```

### Local MCP (Claude Desktop / Code)

```
User in Claude Desktop
  │
  │  "yo this as standup"
  │
  ▼
Claude calls yo tool ──► local MCP server (stdio)
                            │
                            └── writes ~/yo/library/standup.md
                                (no cloud, no sync, instant)
```

## Key Principles

1. **Local-first.** `~/yo/library/` is the source of truth. Markdown files the user owns, can read, can grep, can git.

2. **Cloud is transient.** The cloud server is a relay. Data passes through it, gets pulled down by the local client, then deleted. No long-term cloud storage.

3. **Same tools everywhere.** `yo` and `sup` work identically whether called from the local MCP server, the cloud MCP server, or the command bar in the Electron app.

4. **Skills run at capture time.** When `yo` is called with raw conversation content, the configured skill (system prompt → Haiku) processes it into structured markdown before saving. If no API key, raw content is saved as-is.

5. **Kill the proxy.** `ProxyCapture` is dead code. The AI sends its own context through MCP tools — no network interception, no DOM scraping, no provider-specific parsing.

## Components

### yo-client (Electron desktop app)

| Component | Role |
|-----------|------|
| `mcp-server.ts` | Local MCP server (stdio). yo/sup tools write/read `~/yo/library/` directly. |
| `cloud-sync.ts` | Polls `yo.yo.dev/api/pending`, pulls new captures, writes to library, ACKs. |
| `library.ts` | Filesystem CRUD for `~/yo/library/*.md`. |
| `skill-engine.ts` | Processes raw content through skill prompts via Haiku. |
| `command-parser.ts` | Command bar still works: `yo <name>` saves, `sup <name>` recalls. |

### yo-server (cloud relay @ yo.yo.dev)

| Component | Role |
|-----------|------|
| `server.ts` | Express + MCP StreamableHTTP transport. `/mcp` endpoint for AI clients. |
| `storage.ts` | Transient backend (Postgres/Redis with TTL). Pending queue per user. |
| `auth.ts` | Bearer token auth. One token per user, generated during onboarding. |
| `sync.ts` | `/api/pending` (GET) → return unACKed items. `/api/ack` (POST) → delete. |

### yo-web (marketing site @ yosup.dev)

Landing page, docs, download links. Not part of the MCP architecture.

## Sync Protocol

```
GET  /api/pending
     Authorization: Bearer <user-token>
     → [{ id, name, content, createdAt }]

POST /api/ack
     Authorization: Bearer <user-token>
     { ids: ["abc", "def"] }
     → { ok: true }
```

The local client polls every 5–10 seconds. On each poll:
1. Fetch pending items
2. Write each to `~/yo/library/`
3. ACK all fetched IDs
4. Cloud deletes ACKed items

## What Changes

- [ ] **Wire up local MCP server** (`yo-client/src/main/mcp-server.ts`) — implement with `@modelcontextprotocol/sdk`, expose yo/sup/sup_list/sup_search over stdio
- [ ] **Add cloud sync client** (`yo-client/src/main/cloud-sync.ts`) — poll /api/pending, write to library, ACK
- [ ] **Add sync endpoints to yo-server** — `/api/pending`, `/api/ack`, transient storage with TTL
- [ ] **Add sup_list and sup_search to yo-server MCP tools** — so AI can browse library contents
- [ ] **Remove ProxyCapture** — dead code, delete `proxy-capture.ts` and all references
- [ ] **Onboarding flow** — generate cloud auth token, store in yo-client preferences
- [ ] **Register cloud MCP server** with Claude MCP registry so it's available in BrowserView sessions
