/**
 * sense.app — figure out which app's tools are relevant for this turn.
 *
 * Combines: active panel (strongest signal) + keyword match in user message.
 * Returns the app id (matching INTERNAL_APPS / DEFAULT_APPS / connected apps).
 */

interface AppDeps {
  listConnectedApps?: () => Array<{ id: string; name: string; aliases?: string[] }>;
  getActivePanelId?: () => string | null;
}

let deps: AppDeps = {};
export function setAppDeps(d: AppDeps): void { deps = { ...deps, ...d }; }

export function senseApp(userMessage: string): string | null {
  // 1) Active panel wins if the user didn't name another app
  const apps = deps.listConnectedApps?.() ?? [];
  const lower = userMessage.toLowerCase();

  // 2) Direct app name match
  for (const app of apps) {
    if (lower.includes(app.name.toLowerCase())) return app.id;
    if (lower.includes(app.id.toLowerCase())) return app.id;
    for (const alias of app.aliases ?? []) {
      if (lower.includes(alias.toLowerCase())) return app.id;
    }
  }

  // 3) Common synonyms
  const SYNONYMS: Record<string, string> = {
    email: "gmail", inbox: "gmail", mail: "gmail",
    cal: "calendar", schedule: "calendar", meeting: "calendar",
    pr: "github", issue: "github", repo: "github",
    chat: "slack", channel: "slack", dm: "slack",
    page: "notion", doc: "notion",
  };
  for (const [keyword, appId] of Object.entries(SYNONYMS)) {
    if (lower.includes(keyword) && apps.some((a) => a.id === appId)) return appId;
  }

  // 4) Fallback: active panel
  return deps.getActivePanelId?.() ?? null;
}
