/**
 * feed-sanitize — the redaction layer for the cypher feed (three-layer model).
 *
 * The cypher feed is the SHARED layer: every jammer's client renders every
 * other jammer's activity. The PRIVATE layer (raw tool output, full thinking,
 * local file contents) stays in the per-agent thread store and never leaves
 * the machine. This module is what keeps the line between them clean:
 *
 *   - `summarizeToolInput` turns a raw tool call into a short feed label
 *     (a file path, a truncated command) — never a file's contents or a diff.
 *   - `redactSecrets` masks credential-shaped strings before any body is
 *     published, so a command like `git push https://x:TOKEN@…` or an
 *     `export API_KEY=…` can't leak through the feed.
 *
 * Redaction happens at PUBLICATION (before the event reaches the bus/server),
 * not at render — once content is on the server it is exposed; filtering in
 * the UI does not un-leak it.
 */

/** Credential-shaped patterns masked out of any feed-bound text. */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, "«private key redacted»"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, "«github token redacted»"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "«github token redacted»"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, "«api key redacted»"],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, "«api key redacted»"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "«aws key redacted»"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "«slack token redacted»"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "«jwt redacted»"],
  [/\b(Bearer|Authorization:)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "$1 «redacted»"],
  // URLs carrying inline credentials: https://user:pass@host
  [/(\bhttps?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1«credentials redacted»@"],
  // KEY=value / TOKEN: value style assignments
  [/\b([A-Za-z][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?))\s*[=:]\s*['"]?[^\s'"]{6,}/gi, "$1=«redacted»"],
];

/** Mask credential-shaped substrings. Safe on empty/undefined input. */
export function redactSecrets(text: string | null | undefined): string {
  if (!text) return text ?? "";
  let out = text;
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  return out;
}

/**
 * Turn a raw tool call into a short feed label. Returns a path, a truncated
 * command, or a pattern — never file contents, a diff, or a tool result.
 */
export function summarizeToolInput(toolName: string, input: any): string {
  if (!input) return "";
  const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);
  let label: string;
  switch (toolName) {
    case "Read": case "Edit": case "Write":
      label = String(input.file_path || "");
      break;
    case "Bash":
      label = input.command ? cap(String(input.command), 80) : "";
      break;
    case "Grep": case "Glob":
      label = String(input.pattern || input.glob || "");
      break;
    case "WebFetch":
      label = String(input.url || "");
      break;
    case "WebSearch":
      label = String(input.query || "");
      break;
    case "Agent":
      label = String(input.description || (input.prompt ? cap(String(input.prompt), 60) : ""));
      break;
    case "TodoWrite":
      label = `${(input.todos || []).length} tasks`;
      break;
    default:
      if (input.body) label = cap(String(input.body), 80);
      else if (input.command) label = cap(String(input.command), 80);
      else if (input.query) label = cap(String(input.query), 80);
      else if (input.path || input.file_path) label = String(input.path || input.file_path);
      else label = "";
  }
  // Even a tool *label* can carry a secret (a token in a Bash command, a
  // credentialed URL in WebFetch) — scrub before it reaches the feed.
  return redactSecrets(label);
}
