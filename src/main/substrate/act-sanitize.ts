/**
 * act.sanitize — strip secrets, scripts, and prompt-injection payloads.
 *
 * Runs on every output before injection or persistence. Detected secrets
 * are replaced with [REDACTED:type] markers so the agent's intent is
 * preserved but the values are blocked.
 */

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // API keys / tokens
  { name: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9]{48,}\b/g },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "stripe-key", re: /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{20,}\b/g },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "yo-mcp-token", re: /\byo_[A-Za-z0-9_\-]{30,}\b/g },
  // Generic patterns (less aggressive — single line, looks like a token)
  { name: "bearer-token", re: /\b(?:Bearer|bearer)\s+[A-Za-z0-9_\-]{30,}\b/g },
  // Private keys
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g },
];

const SCRIPT_PATTERNS: Array<{ name: string; re: RegExp; replace: string }> = [
  { name: "script-tag", re: /<script\b[\s\S]*?<\/script\s*>/gi, replace: "[REDACTED:script]" },
  { name: "javascript-uri", re: /javascript:/gi, replace: "redacted:" },
  { name: "data-html-uri", re: /data:text\/html[^"'\s)]*/gi, replace: "[REDACTED:data-uri]" },
];

// Prompt-injection markers — common payload patterns
const INJECTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "ignore-prior", re: /\b(ignore|disregard)\s+(all|the|previous|prior|above)\s+(instructions|context|prompts?)\b/gi },
  { name: "system-override", re: /\b(you are now|new instructions?|forget everything)\b/gi },
];

export interface SanitizeResult {
  text: string;
  redactions: Array<{ type: string; count: number }>;
  warnings: string[];
}

export function actSanitize(input: string, opts: { redactInjections?: boolean } = {}): SanitizeResult {
  let text = input;
  const tally = new Map<string, number>();
  const warnings: string[] = [];

  for (const { name, re } of SECRET_PATTERNS) {
    text = text.replace(re, () => {
      tally.set(name, (tally.get(name) ?? 0) + 1);
      return `[REDACTED:${name}]`;
    });
  }

  for (const { name, re, replace } of SCRIPT_PATTERNS) {
    text = text.replace(re, () => {
      tally.set(name, (tally.get(name) ?? 0) + 1);
      return replace;
    });
  }

  if (opts.redactInjections) {
    for (const { name, re } of INJECTION_PATTERNS) {
      const matches = text.match(re);
      if (matches && matches.length > 0) {
        warnings.push(`Possible prompt injection: ${name} (${matches.length}x)`);
      }
    }
  }

  return {
    text,
    redactions: [...tally.entries()].map(([type, count]) => ({ type, count })),
    warnings,
  };
}
