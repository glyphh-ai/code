/**
 * provider-models — the catalog of models per provider.
 *
 * Ships with current built-in defaults but is USER-OVERRIDABLE: providers
 * deprecate/rename models over time, so the user can edit the list (and the
 * default) per provider from Settings → Providers without waiting for an app
 * update. Overrides persist under the `providerModels` preference.
 */

import { getPreference, setPreference } from "./preferences";

export interface ProviderModelConfig {
  /** Model id used when a caller doesn't pick one (test prompt, council auto-pick). */
  default: string;
  /** The full pick-list shown in dropdowns. */
  models: string[];
}

/** Current, known-good defaults (Jan 2026). Editable by the user at runtime. */
const BUILTIN: Record<string, ProviderModelConfig> = {
  anthropic:  { default: "claude-sonnet-4-6", models: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"] },
  openai:     { default: "gpt-4o",            models: ["gpt-4o", "gpt-4o-mini", "o3", "gpt-4.1", "gpt-4.1-mini"] },
  google:     { default: "gemini-2.5-flash",  models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-flash-latest"] },
  xai:        { default: "grok-3",            models: ["grok-4", "grok-3", "grok-3-mini"] },
  perplexity: { default: "sonar",             models: ["sonar", "sonar-pro", "sonar-reasoning"] },
};

export const KNOWN_PROVIDERS = Object.keys(BUILTIN);

type Overrides = Record<string, { default?: string; models?: string[] }>;

function readOverrides(): Overrides {
  return (getPreference("providerModels", {}) as Overrides) || {};
}

/** Effective config for a provider — user override merged over the built-in. */
export function getProviderModelConfig(provider: string): ProviderModelConfig {
  const base = BUILTIN[provider] || { default: "", models: [] };
  const o = readOverrides()[provider];
  if (!o) return { ...base };
  const models = (o.models && o.models.length) ? o.models.slice() : base.models.slice();
  const def = (o.default && models.includes(o.default)) ? o.default : (models[0] || base.default);
  return { default: def, models };
}

export function getDefaultModel(provider: string): string {
  return getProviderModelConfig(provider).default;
}

export function getAllProviderModels(): Record<string, ProviderModelConfig> {
  const out: Record<string, ProviderModelConfig> = {};
  for (const p of KNOWN_PROVIDERS) out[p] = getProviderModelConfig(p);
  return out;
}

/** Persist a user override for a provider (empty/equal-to-builtin clears it). */
export function setProviderModels(provider: string, models: string[], def?: string): void {
  const clean = models.map((m) => m.trim()).filter(Boolean);
  const overrides = readOverrides();
  if (clean.length === 0) {
    delete overrides[provider];
  } else {
    overrides[provider] = { models: clean, default: def && clean.includes(def) ? def : clean[0] };
  }
  setPreference("providerModels", overrides);
}

export function resetProviderModels(provider: string): void {
  const overrides = readOverrides();
  delete overrides[provider];
  setPreference("providerModels", overrides);
}
