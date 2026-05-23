/**
 * Current council holder — single-slot module state for "which council is the
 * .yo piloting right now?". Set by the renderer when the Council panel
 * focuses a session; cleared when the panel closes or the session ends.
 * Read by substrate council tools.
 */

let currentId: string | null = null;

export function setCurrentCouncil(id: string | null): void {
  currentId = id || null;
}

export function getCurrentCouncil(): string | null {
  return currentId;
}
