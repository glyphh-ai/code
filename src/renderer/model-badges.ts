/**
 * model-badges.ts — per-model-type provider logos.
 *
 * Preserved from the old Council panel. The swarm feed reuses these to show
 * which agent (by model type) is acting at a glance.
 */

/** Normalize any provider/model string to a known brand key. */
export function brandFor(provider: string): string {
  const p = (provider || "").toLowerCase();
  if (p.startsWith("anthropic") || p === "claude") return "anthropic";
  if (p.startsWith("openai") || p === "gpt" || p.startsWith("codex")) return "openai";
  if (p.startsWith("google") || p === "gemini") return "google";
  if (p.startsWith("xai") || p === "grok") return "xai";
  if (p.startsWith("perplexity") || p === "pplx") return "perplexity";
  return "generic";
}

/** Pulls the official favicon from each brand's own site via Google's
 *  S2 favicon service. These are the actual brand marks (claude.ai's
 *  Claude burst, chatgpt.com's spiral, etc.) — not random CDN-hosted
 *  approximations. */
export const BRAND_LOGOS: Record<string, string> = {
  anthropic: "https://www.google.com/s2/favicons?domain=claude.ai&sz=64",
  openai:    "https://www.google.com/s2/favicons?domain=chatgpt.com&sz=64",
  google:    "https://www.google.com/s2/favicons?domain=gemini.google.com&sz=64",
  xai:       "https://www.google.com/s2/favicons?domain=grok.com&sz=64",
  perplexity:"https://www.google.com/s2/favicons?domain=perplexity.ai&sz=64",
};

/** Logo URL for a provider, or null when there's no brand logo. */
export function logoUrlFor(provider: string): string | null {
  return BRAND_LOGOS[brandFor(provider)] || null;
}

/** Human display name for a brand — used in the yo-panel header
 *  ("Sup Claude" / "Sup Gpt" etc.) and similar chrome labels. */
const BRAND_DISPLAY: Record<string, string> = {
  anthropic: "Claude",
  openai: "Gpt",
  google: "Gemini",
  xai: "Grok",
  perplexity: "Perplexity",
  generic: "Yo",
};
export function brandDisplayFor(provider: string): string {
  return BRAND_DISPLAY[brandFor(provider)] || "Yo";
}

/** Map a model slug to its brand key. Falls back to "anthropic" when no
 *  model is set (default workspace model is currently Claude). */
export function brandForModel(model: string): string {
  if (!model) return "anthropic";
  const m = model.toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gpt") || m.startsWith("codex")) return "openai";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("grok")) return "xai";
  if (m.startsWith("pplx")) return "perplexity";
  return "generic";
}

/**
 * An <img> badge for a provider's brand logo, falling back to a single-letter
 * initial when the brand is unknown.
 */
export function badgeImgFor(provider: string, model: string): string {
  const b = brandFor(provider);
  const url = BRAND_LOGOS[b];
  if (url) return `<img src="${url}" alt="${b}" />`;
  const letter = (model || provider || "?").charAt(0).toUpperCase();
  return `<span class="member-badge-initial">${letter}</span>`;
}
