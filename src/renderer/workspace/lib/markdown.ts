/**
 * markdown.ts — render markdown → safe HTML for workspace screens.
 *
 * Uses `marked` (full CommonMark + GFM: code fences, tables, task lists, …)
 * then sanitizes with DOMPurify before it's injected into the DOM. Style the
 * output via the `.yo-md` container class (themed from tokens).
 *
 * (The chat panel keeps its own lightweight `format-markdown.ts`; this is for
 * rebuilt workspace screens like the Skills viewer.)
 */

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

/** Markdown source → sanitized HTML string. */
export function renderMarkdown(src: string | null | undefined): string {
  if (!src) return "";
  const html = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html);
}
