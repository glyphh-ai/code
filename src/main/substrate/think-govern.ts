/**
 * think.govern — apply allowed-tools allowlist to filter LLM tool spec.
 *
 * Thin re-export of the existing tool-router. Lives here so the substrate
 * presents a single consistent surface, even if the implementation lives
 * in skill-tool-router.ts.
 */

export { SkillToolRouter } from "../skill-tool-router";
export type { ResolvedTool } from "../skill-tool-router";
