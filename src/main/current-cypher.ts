/**
 * Current cypher holder — single-slot module state for "which cypher is the
 * .yo piloting right now?". Set by the renderer when entering The Drop's
 * Workspace; cleared on leave. Read by substrate cypher tools.
 */

let currentId: string | null = null;

export function setCurrentCypher(id: string | null): void {
  currentId = id || null;
}

export function getCurrentCypher(): string | null {
  return currentId;
}
