import { ipcMain } from "electron";
import type { SkillEngine } from "./skill-engine";
import type { McpManager } from "./mcp-manager";
import type { AppConnector } from "./app-connector";
import type { SkillScheduler } from "./skill-scheduler";

interface SkillsIpcDeps {
  skillEngine: SkillEngine;
  mcpManager: McpManager | null;
  appConnector: AppConnector | null;
  skillScheduler: SkillScheduler | null;
  canCreateSkill: (count: number) => { allowed: boolean; reason?: string };
  listBuiltinYoTools: () => Array<{ name: string; description: string }>;
}

export function registerSkillsIpc(deps: SkillsIpcDeps): void {
  const {
    skillEngine,
    mcpManager,
    appConnector,
    skillScheduler,
    canCreateSkill,
    listBuiltinYoTools,
  } = deps;

  // IPC: skills CRUD (legacy-compatible signatures)
  ipcMain.handle("skills-list", () => skillEngine.listSkills());
  ipcMain.handle("skills-list-detailed", () => skillEngine.listSkillsDetailed());
  ipcMain.handle("mcp-tools-list", () => (mcpManager?.getAllTools() ?? []).map((t) => ({
    serverId: t.serverId,
    serverName: t.serverName,
    name: t.name,
    qualifiedName: t.qualifiedName,
    description: t.description,
  })));
  ipcMain.handle("skills-read", (_e, name: string) => skillEngine.readSkill(name));
  ipcMain.handle("skills-get", (_e, name: string) => {
    const s = skillEngine.getSkill(name);
    if (!s) return null;
    const hasRunner = skillEngine.hasRunner(name);
    const hasApp = !!skillEngine.readSkillFile(name, "app/index.html");
    const runnerCode = hasRunner ? skillEngine.readSkillFile(name, "SKILL.js") : null;
    const runnerSchedule = skillEngine.getSkillJsSchedule(name);
    return {
      name: s.name,
      manifest: s.manifest,
      prompt: s.prompt,
      hasRunner,
      hasApp,
      runnerCode,
      runnerSchedule,
    };
  });
  ipcMain.handle("skills-write", (_e, name: string, prompt: string) => {
    // Legacy signature: writes prompt only, preserves manifest if exists
    const existing = skillEngine.getSkill(name);
    if (existing) {
      skillEngine.writeSkill(name, existing.manifest, prompt);
      return true;
    }
    const gate = canCreateSkill(skillEngine.listSkills().length);
    if (!gate.allowed) return { error: gate.reason };
    skillEngine.writeSkill(name, { name, description: "" }, prompt);
    return true;
  });
  ipcMain.handle("skills-write-full", (_e, name: string, manifest: any, prompt: string, runnerCode?: string | null) => {
    const existing = skillEngine.getSkill(name);
    if (!existing) {
      const gate = canCreateSkill(skillEngine.listSkills().length);
      if (!gate.allowed) return { error: gate.reason };
    }
    skillEngine.writeSkill(name, manifest, prompt);
    // Persist SKILL.js alongside SKILL.md when the editor has runner code; if
    // the caller passes null we explicitly remove an existing runner file.
    if (typeof runnerCode === "string" && runnerCode.trim().length > 0) {
      skillEngine.writeSkillFile(name, "SKILL.js", runnerCode);
    } else if (runnerCode === null) {
      skillEngine.deleteSkillFile(name, "SKILL.js");
    }
    skillScheduler?.refresh();
    return true;
  });
  ipcMain.handle("skills-remove", (_e, name: string) => skillEngine.deleteSkill(name));
  ipcMain.handle("skills-generate", (_e, name: string, description: string) =>
    skillEngine.generatePrompt(name, description),
  );
  ipcMain.handle("skills-available-tools", () => {
    const groups: Array<{ namespace: string; label: string; tools: Array<{ name: string; description: string }> }> = [];
    const yoTools = listBuiltinYoTools();
    if (yoTools.length) {
      groups.push({ namespace: "yo", label: "yo (built-in)", tools: yoTools.map(t => ({ name: t.name, description: t.description })) });
    }
    if (mcpManager) {
      const byApp = new Map<string, { label: string; tools: Array<{ name: string; description: string }> }>();
      for (const t of mcpManager.getAllTools()) {
        const appId = t.serverId;
        const app = appConnector?.get(appId);
        const label = app?.name || appId;
        if (!byApp.has(appId)) byApp.set(appId, { label, tools: [] });
        byApp.get(appId)!.tools.push({ name: t.name, description: t.description });
      }
      for (const [appId, group] of byApp) {
        groups.push({ namespace: appId, label: group.label, tools: group.tools });
      }
    }
    return groups;
  });
  // File operations within a skill folder
  ipcMain.handle("skills-list-files", (_e, name: string) => skillEngine.listSkillFiles(name));
  ipcMain.handle("skills-read-file", (_e, name: string, rel: string) => skillEngine.readSkillFile(name, rel));
  ipcMain.handle("skills-write-file", (_e, name: string, rel: string, content: string) =>
    skillEngine.writeSkillFile(name, rel, content),
  );
  ipcMain.handle("skills-delete-file", (_e, name: string, rel: string) => skillEngine.deleteSkillFile(name, rel));
  // Run a skill (LLM call with skill's prompt)
  ipcMain.handle("skills-run", async (_e, name: string, input: unknown) => {
    try {
      // runSkill() dispatches to the JS runner if SKILL.js exists, else falls
      // back to prompt-mode (process()) — same code path the scheduler uses.
      const output = await skillEngine.runSkill(name, input, { trigger: "manual" });
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle("skills-run-history", (_e, name: string) => skillEngine.getRunHistory(name));
  // Export/import .yo bundles
  ipcMain.handle("skills-export", (_e, name: string) => {
    const buf = skillEngine.exportSkill(name);
    return buf ? buf.toString("base64") : null;
  });
  ipcMain.handle("skills-import", (_e, base64: string, overwrite?: boolean) => {
    try {
      const buf = Buffer.from(base64, "base64");
      return skillEngine.importSkill(buf, { overwrite });
    } catch (err) {
      return { imported: [], skipped: [], error: err instanceof Error ? err.message : String(err) };
    }
  });
  // Scheduler
  ipcMain.handle("skills-schedule-status", () => skillScheduler?.status() ?? []);
  ipcMain.handle("skills-pause-schedule", (_e, name: string) => { skillScheduler?.pause(name); });
  ipcMain.handle("skills-resume-schedule", (_e, name: string) => { skillScheduler?.resume(name); });
}
