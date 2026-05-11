/**
 * Shared types for the skill system.
 */

export interface SkillManifest {
  name: string;
  description?: string;
  when_to_use?: string;
  type?: "skill";
  inputs?: Array<{ name: string; type: string; description?: string }>;
  outputs?: Array<{ name: string; type: string; description?: string }>;
  "allowed-tools"?: string[];
  requires?: string[];
  schedule?: string | null;
  model?: string | null;
}

export interface Skill {
  name: string;
  manifest: SkillManifest;
  prompt: string;
  folderPath: string;
}

export interface SkillSummary {
  name: string;
  description?: string;
  scheduled: boolean;
  scheduleExpr?: string;
  hasRunner: boolean;       // SKILL.js present
  hasApp: boolean;          // skill folder includes app/index.html (vibes)
  requires?: string[];
  allowedTools?: string[];
}

// ── Progress / observability ─────────────────────────────

export type ProgressEventType =
  | "step"
  | "skill"
  | "agent"
  | "mcp"
  | "evaluate"
  | "message"
  | "ask-user";

export type ProgressStatus = "running" | "success" | "error";

export interface ProgressEvent {
  id: string;
  parentId?: string;
  type: ProgressEventType;
  label: string;
  status: ProgressStatus;
  startedAt: number;
  endedAt?: number;
  metadata?: {
    skillName?: string;
    toolName?: string;
    model?: string;
    error?: string;
  };
}

// ── Run history ──────────────────────────────────────────

export type RunTrigger = "manual" | "schedule" | "skill";

export interface SkillRun {
  id: string;
  skillName: string;
  trigger: RunTrigger;
  startedAt: number;
  durationMs?: number;
  input: unknown;
  output?: unknown;
  error?: string;
  events: ProgressEvent[];
  logs: string[];
}

// ── Runner options ───────────────────────────────────────

export interface RunOpts {
  trigger?: RunTrigger;
  parentRunId?: string;               // when called via ctx.skill()
  parentEventId?: string;             // for nesting events in UI tree
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  onAskUser?: (question: string) => Promise<string>;
}

// ── Errors ──────────────────────────────────────────────

export class SkillError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "SkillError";
  }
}
export class SkillNotAllowedError extends SkillError {
  constructor(skillName: string, caller: string) {
    super(`Skill "${skillName}" is not in caller's requires list (caller: ${caller})`, "SKILL_NOT_ALLOWED");
  }
}
export class ToolNotAllowedError extends SkillError {
  constructor(toolName: string) {
    super(`Tool "${toolName}" is not in skill's allowed-tools list`, "TOOL_NOT_ALLOWED");
  }
}
export class AppNotConnectedError extends SkillError {
  constructor(appId: string) {
    super(`App "${appId}" is referenced in allowed-tools but not connected`, "APP_NOT_CONNECTED");
  }
}
