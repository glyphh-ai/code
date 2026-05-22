/**
 * bridge.ts — typed access to the Electron preload bridge (`window.yo`).
 *
 * New workspace code imports `yo` / `hasBridge()` from here instead of
 * touching `(window as any).yo`. Add method signatures to `YoBridge` as
 * screens need them — keep it honest (only declare what you actually call).
 * In browser-preview (no Electron) `yo` is undefined; always guard with
 * `hasBridge()` before calling.
 */

/** A single streamed skill-run progress event (subset of the main-process shape). */
export interface SkillProgressEvent {
  id: string;
  parentId?: string;
  type: "step" | "skill" | "agent" | "mcp" | "evaluate" | "message" | "ask-user";
  label: string;
  status: "running" | "success" | "error";
  startedAt: number;
  endedAt?: number;
  metadata?: { skillName?: string; toolName?: string; model?: string; error?: string };
}

export interface YoBridge {
  // window chrome
  windowClose(): void;
  windowMinimize(): void;
  windowMaximize(): void;
  // preferences
  getPreference<T = unknown>(key: string, def?: T): Promise<T>;
  setPreference(key: string, value: unknown): void;
  // clipboard
  copyToClipboard(text: string): void;
  // skills
  skillsListDetailed(): Promise<Array<{
    name: string; description?: string;
    hasRunner: boolean; hasApp: boolean;
    scheduled: boolean; scheduleExpr?: string;
  }>>;
  skillsRemove(name: string): Promise<boolean>;
  skillsGet(name: string): Promise<{
    name: string; manifest: { description?: string; schedule?: string; [k: string]: unknown };
    prompt: string; hasRunner: boolean; hasApp: boolean;
    runnerCode: string | null; runnerSchedule: string | null;
  } | null>;
  skillsListFiles(name: string): Promise<string[]>;
  skillsReadFile(name: string, rel: string): Promise<string | null>;
  skillsWrite(name: string, prompt: string): Promise<boolean | { error: string }>;
  skillsWriteFull(
    name: string, manifest: Record<string, unknown>, prompt: string, runnerCode?: string | null,
  ): Promise<boolean | { error: string }>;
  skillsOpenInEditor(name: string): Promise<boolean>;
  skillsOpenFileInEditor(name: string, rel: string): Promise<boolean>;
  skillsRun(name: string, input: unknown): Promise<{ ok: true; output: unknown } | { ok: false; error: string }>;
  onSkillProgress(cb: (data: { runId: string; event: SkillProgressEvent }) => void): void;
  // …extend per screen. Prefer adding the exact signatures you use.
  [key: string]: unknown;
}

const _yo = (typeof window !== "undefined" ? (window as unknown as { yo?: YoBridge }).yo : undefined);

/** The preload bridge, or undefined in browser-preview. */
export const yo: YoBridge | undefined = _yo;

/** True when running inside Electron with the preload bridge available. */
export function hasBridge(): boolean {
  return !!_yo;
}
