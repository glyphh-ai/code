/**
 * act.checkpoint — confirm before irreversible actions.
 *
 * Detects destructive verbs in tool names + a small allowlist of action
 * keywords. When triggered, blocks until the user explicitly confirms
 * (via ctx.ask.user, exposed by the runner).
 */

import { CheckpointDecision } from "./types";

const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(send|publish|post|deploy|push)\b/i, reason: "sending/publishing is irreversible" },
  { re: /\b(delete|remove|destroy|drop|purge|wipe)\b/i, reason: "deletion is irreversible" },
  { re: /\b(transfer|charge|pay|invoice)\b/i, reason: "payment actions are irreversible" },
  { re: /\b(revoke|disable|block|ban)\b/i, reason: "access changes are hard to roll back" },
];

export function isDestructive(toolOrAction: string): { destructive: boolean; reason?: string } {
  for (const { re, reason } of DESTRUCTIVE_PATTERNS) {
    if (re.test(toolOrAction)) return { destructive: true, reason };
  }
  return { destructive: false };
}

export interface CheckpointOpts {
  /** When false, skip the prompt (e.g. user already opted into auto-mode). */
  enabled?: boolean;
  /** Auto-approve specific tool/action names (allowlist). */
  preApproved?: string[];
}

export async function actCheckpoint(
  toolOrAction: string,
  details: string,
  askUser: (question: string) => Promise<string>,
  opts: CheckpointOpts = {},
): Promise<CheckpointDecision> {
  if (opts.enabled === false) return { approved: true };
  const { destructive, reason } = isDestructive(toolOrAction);
  if (!destructive) return { approved: true };
  if (opts.preApproved?.includes(toolOrAction)) return { approved: true };

  const question = `Confirm: ${toolOrAction}\n\n${details}\n\nReason this needs confirmation: ${reason}\n\nReply "yes" to proceed, anything else to cancel.`;
  try {
    const answer = (await askUser(question)).trim().toLowerCase();
    const approved = answer === "yes" || answer === "y" || answer === "ok" || answer === "approve";
    return { approved, reason: approved ? undefined : `User declined: "${answer}"` };
  } catch (err) {
    return { approved: false, reason: err instanceof Error ? err.message : "ask-user failed" };
  }
}
