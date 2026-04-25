/**
 * act.format — shape output for the caller's context.
 *
 * Targets:
 *   - "input"     → plain text, no markdown, single line if possible
 *   - "chat"      → markdown OK, structured, longer
 *   - "json"      → strict JSON object/array
 *   - "auto"      → leave as-is
 *
 * The skill never asks; the runner picks a target based on caller context
 * (e.g. ".sup ." injecting into a focused input → "input").
 */

export type FormatTarget = "input" | "chat" | "json" | "auto";

export function actFormat(text: string, target: FormatTarget): string {
  if (target === "auto") return text;

  if (target === "input") {
    // Strip markdown headings, fences, list markers; collapse blank lines
    let out = text;
    out = out.replace(/```[\s\S]*?```/g, (m) => {
      // keep code content but strip the fence
      return m.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "");
    });
    out = out.replace(/^#{1,6}\s+/gm, "");           // headings
    out = out.replace(/^\s*[-*+]\s+/gm, "");          // bullets
    out = out.replace(/^\s*\d+\.\s+/gm, "");          // numbered lists
    out = out.replace(/`([^`]+)`/g, "$1");            // inline code
    out = out.replace(/\*\*([^*]+)\*\*/g, "$1");      // bold
    out = out.replace(/\*([^*]+)\*/g, "$1");          // italics
    out = out.replace(/\n{3,}/g, "\n\n");             // collapse blank runs
    return out.trim();
  }

  if (target === "chat") {
    // Already markdown-friendly; just ensure no trailing whitespace runs
    return text.replace(/[ \t]+$/gm, "").trimEnd();
  }

  if (target === "json") {
    // If the LLM wrapped JSON in fences, extract it
    const m = text.match(/```(?:json)?\n?([\s\S]+?)\n?```/);
    if (m) {
      try { JSON.parse(m[1]); return m[1].trim(); } catch { /* fall through */ }
    }
    // If the whole thing is valid JSON, return as-is
    try { JSON.parse(text); return text.trim(); } catch { /* fall through */ }
    // Otherwise, attempt to extract the first JSON object/array
    const objMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (objMatch) {
      try { JSON.parse(objMatch[0]); return objMatch[0]; } catch { /* fall through */ }
    }
    return text;
  }

  return text;
}
