/**
 * Local MCP server — exposes yo/sup as tools.
 *
 * Claude Code and Cowork connect to this natively.
 * Two tools: yo (save context) and sup (recall context).
 */

import { Library } from "./library";

export class MCPServer {
  private library: Library;
  private running = false;

  constructor(library: Library) {
    this.library = library;
  }

  async start(): Promise<void> {
    // TODO: Wire up @modelcontextprotocol/sdk server
    // Listen on stdio or HTTP for MCP clients
    //
    // Tools:
    //   yo(name, content) → write to library
    //   sup(name) → read from library
    //   sup_list() → list all contexts
    //   sup_search(term) → search contexts

    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
