/**
 * Renderer — titlebar + grid handles + boot gate.
 *
 * All user commands (yo/dip/drip) happen inside app panels
 * via the interceptor, or from the command bar. The renderer
 * manages window chrome and session state display.
 */

// Help overlay moved to yo://home app
import { showOnboarding } from "./onboarding.js";
import { formatMarkdown } from "./format-markdown.js";
import { initBootGate } from "./boot-gate-ui.js";
import { initDownloads } from "./downloads-ui.js";
import { initDrip } from "./drip-ui.js";
import { initTabBar } from "./tab-bar-ui.js";
import { initGrid } from "./grid-ui.js";
import { initYoPanel } from "./yo-panel-ui.js";

type TabInfo = { id: string; name: string; favicon?: string; layoutFavicons?: string[]; pinned?: boolean; url?: string };

declare global {
  interface Window {
    yo: {
      copyToClipboard: (text: string) => void;
      windowClose: () => void;
      windowMinimize: () => void;
      windowMaximize: () => void;
      panelsHide: () => void;
      panelsShow: () => void;
      cmdPaletteOpen: () => void;
      capturePanels: () => Promise<Array<{ dataUrl: string; bounds: { x: number; y: number; width: number; height: number } }>>;
      panelsRefresh: (id?: string) => void;
      panelsZoom: (factor: number) => void;
      panelsGetZoom: () => Promise<number>;
      // Skills
      skillsList: () => Promise<string[]>;
      skillsListDetailed: () => Promise<Array<{ name: string; description?: string; hasRunner: boolean; hasApp: boolean; scheduled: boolean; scheduleExpr?: string }>>;
      skillsRead: (name: string) => Promise<string | null>;
      skillsGet: (name: string) => Promise<{ name: string; manifest: any; prompt: string; hasRunner: boolean; hasApp: boolean; runnerCode: string | null; runnerSchedule: string | null } | null>;
      skillsWrite: (name: string, prompt: string) => Promise<boolean | { error: string }>;
      skillsWriteFull: (name: string, manifest: any, prompt: string, runnerCode?: string | null) => Promise<boolean | { error: string }>;
      skillsRemove: (name: string) => Promise<boolean>;
      skillsGenerate: (name: string, description: string) => Promise<string>;
      skillsAvailableTools: () => Promise<Array<{ namespace: string; label: string; tools: Array<{ name: string; description: string }> }>>;
      skillsListFiles: (name: string) => Promise<string[]>;
      skillsReadFile: (name: string, rel: string) => Promise<string | null>;
      skillsWriteFile: (name: string, rel: string, content: string) => Promise<boolean>;
      skillsDeleteFile: (name: string, rel: string) => Promise<boolean>;
      skillsRun: (name: string, input: unknown) => Promise<{ ok: true; output: unknown } | { ok: false; error: string }>;
      skillsCancel: (runId: string) => Promise<boolean>;
      skillsUserResponse: (qid: string, answer: string) => Promise<boolean>;
      skillsRunHistory: (name: string) => Promise<any[]>;
      skillsExport: (name: string) => Promise<string | null>;
      skillsImport: (base64: string, overwrite?: boolean) => Promise<{ imported: string[]; skipped: string[]; error?: string }>;
      skillsScheduleStatus: () => Promise<Array<{ name: string; schedule: string; paused: boolean }>>;
      skillsPauseSchedule: (name: string) => Promise<void>;
      skillsResumeSchedule: (name: string) => Promise<void>;
      onSkillProgress: (cb: (data: { runId: string; event: any }) => void) => void;
      onSkillAskUser: (cb: (data: { runId: string; qid: string; question: string }) => void) => void;
      // Apps
      appsList: () => Promise<Array<{
        id: string; name: string; url?: string; connected: boolean; connectedSlug?: string;
        forceWeb?: boolean; doNotRecord?: boolean;
        commands: Record<string, { selector: string; action: string; description: string }>;
        meta?: { description: string; capabilities: string[] };
        connection?: { pipedreamSlug: string; accountId?: string; healthy?: boolean };
        mcp?: { transport: "stdio" | "sse" | "streamable-http"; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string>; enabled: boolean };
      }>>;
      appsAdd: (id: string, name: string, url?: string) => Promise<unknown>;
      appsSetMcp: (id: string, mcp: { transport: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled: boolean }) => Promise<unknown>;
      appsRemoveMcp: (id: string) => Promise<boolean>;
      appsRemove: (id: string) => Promise<boolean>;
      appsSetConnection: (id: string, pipedreamSlug: string) => Promise<boolean>;
      appsRemoveConnection: (id: string) => Promise<boolean>;
      appsUpdateId: (oldId: string, newId: string) => Promise<boolean>;
      appsUpdateName: (id: string, name: string) => Promise<boolean>;
      appsUpdateUrl: (id: string, url: string) => Promise<boolean>;
      appsUpdateForceWeb: (id: string, forceWeb: boolean) => Promise<boolean>;
      appsUpdateDoNotRecord: (id: string, doNotRecord: boolean) => Promise<boolean>;
      appsUpdateCapturePolicy: (id: string, policy: { type: string; maxVersions?: number; windowHours?: number; minDeltaChars?: number }) => Promise<boolean>;
      appsGetCapturePolicy: (id: string) => Promise<{ type: string; maxVersions?: number; windowHours?: number; minDeltaChars?: number }>;
      appsSetConnectedSlug: (id: string, slug: string | null) => Promise<boolean>;
      appsSetCommand: (id: string, key: string, mapping: { selector: string; action: string; description: string }) => Promise<boolean>;
      appsRemoveCommand: (id: string, key: string) => Promise<boolean>;
      appsTestCommand: (id: string, key: string, wcId?: number) => Promise<string>;
      startPicker: (wcId: number) => void;
      onPickerResult: (cb: (result: { selector: string; tag: string; text: string; isEditable: boolean; isClickable: boolean }) => void) => void;

      // Layouts
      layoutsList: () => Promise<Array<{ name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; splits: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }>>;
      layoutsSave: (name: string, panelIds: string[]) => Promise<boolean>;
      layoutsSaveGrid: (grid: { name: string; cols: number; rows: number; colWidths: number[]; rowHeights: number[]; cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }> }) => Promise<boolean>;
      layoutsDelete: (name: string) => Promise<boolean>;
      pickDirectory: () => Promise<string | null>;
      // Grid resize
      gridDragEnd: (type: "col" | "row", index: number, fraction: number) => void;
      // Session
      sessionInfo: () => Promise<{ hasContent: boolean; label: string; fileName: string }>;
      sessionClear: () => Promise<boolean>;
      onSessionChanged: (callback: (info: { hasContent: boolean; label: string; fileName: string }) => void) => void;
      // Preferences + boot
      relaunch: () => void;
      setPreference: (key: string, value: unknown) => void;
      getPreference: (key: string, defaultVal?: unknown) => Promise<unknown>;
      onboardingComplete: () => Promise<void>;

      getAppVersion: () => Promise<string>;
      startAuth: (mode: "register" | "login") => Promise<boolean>;
      isAuthenticated: () => Promise<boolean>;
      getAccountInfo: () => Promise<{ email: string; firstName: string; lastName: string; role: string; orgName: string; tier: string; billingStatus: string } | null>;
      logout: () => Promise<void>;
      validateApiKey: () => Promise<{ valid: boolean }>;
      getApiKey: () => Promise<null>;
      onBoot: (callback: (data: { authenticated: boolean; status: string; tier?: string; needsOnboarding: boolean; hideWelcome?: boolean; theme?: string }) => void) => void;
      onThemeChanged: (callback: (theme: string) => void) => void;
      onShowOnboarding: (callback: () => void) => void;
      onAccountLocked: (callback: (info: { status: string; upgradeUrl: string }) => void) => void;
      onAccountUnlocked: (callback: () => void) => void;
      recheckAccount: () => Promise<{ status: string }>;
      onShowWelcome: (callback: () => void) => void;
      onOpenSettings: (callback: () => void) => void;
      onFocusInput: (callback: () => void) => void;
      onExecCommandFromPalette: (callback: (cmd: string) => void) => void;
      createAppFromTab: (tabId: string, url: string, name: string) => void;
      onOpenNewApp: (callback: (data: { url?: string; name?: string; tabId?: string }) => void) => void;
      convertTabToApp: (tabId: string, appId: string) => void;
      openInEditor: (filePath: string) => void;
      getWorkingDir: () => Promise<string | null>;
      pickWorkingDir: () => Promise<string | null>;
      onWorkingDirChanged: (callback: (dir: string | null) => void) => void;
      onSplitState: (callback: (info: {
        panelIds: string[];
        cols: number;
        rows: number;
        colWidths: number[];
        rowHeights: number[];
        cells: Array<{ panelId: string; col: number; row: number; colSpan: number; rowSpan: number }>;
      } | null) => void) => void;
      // Command execution
      execCommand: (cmd: string) => Promise<string>;
      // Downloads
      onDownloadStart: (cb: (info: { filename: string; totalBytes: number; savePath: string }) => void) => void;
      onDownloadProgress: (cb: (info: { filename: string; receivedBytes: number; totalBytes: number }) => void) => void;
      onDownloadDone: (cb: (info: { filename: string; savePath: string; state: string }) => void) => void;
      downloadShow: (filePath: string) => void;
      // Drip effects
      onDripEffect: (callback: (effect: string) => void) => void;
      // Drips CRUD
      dripsList: () => Promise<Array<{ name: string; recipe: string }>>;
      dripsSave: (name: string, recipe: string) => Promise<string>;
      dripsDelete: (name: string) => Promise<string>;
      dripsPreview: (recipe: string) => Promise<string>;
      dripsBuiltinEffects: () => Promise<string[]>;
      // Dashboard
      dashboardToday: (tz?: string) => Promise<any>;
      dashboardHistory: (days?: number, tz?: string) => Promise<any[]>;
      dashboardAllTime: (tz?: string) => Promise<{ agents: Record<string, any>; total: any }>;
      dashboardApps: () => Promise<Array<{ name: string; path: string; modified: string }>>;
      dashboardOpenApp: (name: string) => void;
      dashboardDeleteApp: (name: string) => Promise<boolean>;
      dashboardReminders: () => Promise<Array<{ id: string; message: string; fireAt: number }>>;
      dashboardCancelReminder: (id: string) => Promise<boolean>;
      dashboardLLMInfo: () => Promise<{ provider: string; model: string }>;
      // Prompt log
      promptsList: (offset?: number, limit?: number) => Promise<Array<{ id: string; startTs: number; endTs: number; prompt: string; response: string; inputTokens: number; outputTokens: number; model: string; provider: string; mode: string; toolsUsed: string[] }>>;
      promptsSearch: (query: string, limit?: number) => Promise<Array<{ id: string; startTs: number; endTs: number; prompt: string; response: string; inputTokens: number; outputTokens: number; model: string; provider: string; mode: string; toolsUsed: string[] }>>;
      promptsGet: (id: string) => Promise<{ id: string; startTs: number; endTs: number; prompt: string; response: string; inputTokens: number; outputTokens: number; model: string; provider: string; mode: string; toolsUsed: string[] } | null>;
      promptsCount: () => Promise<number>;
      // Capture store
      capturesStats: () => Promise<{ count: number; sources: Record<string, number>; diskBytes: number; oldestTs: number; newestTs: number; embeddedCount: number; ingestCount: number; searchCount: number; ingestBytes: number }>;
      capturesList: (offset: number, limit: number) => Promise<Array<{ meta: { id: string; source: string; created: number; chunkParent?: string }; snippet: string; size: number }>>;
      capturesRead: (id: string) => Promise<string | null>;
      capturesDelete: (id: string) => Promise<boolean>;
      capturesDeleteBySource: (source: string) => Promise<number>;
      capturesClear: () => Promise<number>;
      capturesSearch: (query: string, limit: number) => Promise<Array<{ meta: { id: string; source: string; created: number }; content: string; score: number }>>;
      capturesDailyHistory: (days?: number) => Promise<Array<{ date: string; count: number; bytes: number }>>;
      capturesEntrySize: (id: string) => Promise<number>;
      capturesStatsForSource: (source: string) => Promise<{ count: number; diskBytes: number; oldestTs: number; newestTs: number; embeddedCount: number }>;
      capturesListForSource: (source: string, offset: number, limit: number) => Promise<Array<{ meta: { id: string; source: string; created: number; chunkParent?: string }; snippet: string; size: number }>>;
      capturesDailyHistoryForSource: (source: string, days?: number) => Promise<Array<{ date: string; count: number; bytes: number }>>;
      // LLM config
      getLLMConfig: () => Promise<{ provider: string; model: string }>;
      getLLMPresets: () => Promise<Record<string, { name: string; models: string[]; defaultModel: string }>>;
      saveLLMConfig: (config: { provider: string; model: string }) => Promise<{ ok: boolean; error?: string }>;
      // Tabs
      tabList: () => Promise<{ tabs: TabInfo[]; activeId: string; visible: boolean }>;
      tabSwitch: (id: string) => void;
      tabClose: (id: string) => void;
      tabReorder: (newOrder: string[]) => void;
      tabNew: () => void;
      tabNewApp: (appId: string) => void;
      onTabState: (callback: (state: { tabs: TabInfo[]; activeId: string; visible: boolean }) => void) => void;
      // URL bar
      urlBarNavigate: (url: string) => void;
      urlBarBack: () => void;
      urlBarForward: () => void;
      urlBarRefresh: () => void;
      panelNavBack: (panelId: string) => void;
      panelNavForward: (panelId: string) => void;
      panelNavRefresh: (panelId: string) => void;
      panelNavTo: (panelId: string, url: string) => void;
      urlBarToggle: (show: boolean) => void;
      onUrlUpdate: (cb: (info: { url: string; favicon: string; canGoBack?: boolean; canGoForward?: boolean }) => void) => void;
      onUrlBarForce: (cb: (show: boolean) => void) => void;
      onTabFavicon: (cb: (info: { id: string; favicon: string }) => void) => void;
      onPanelUrlUpdate: (cb: (info: { id: string; url: string; favicon: string }) => void) => void;
      // Theme
      getTheme: () => Promise<string>;
      setTheme: (theme: string) => Promise<void>;
      // Account info
      getAuthStatus: () => Promise<{ authenticated: boolean; status: string; tier?: string }>;
      refreshAuth: () => Promise<{ tier: string; status: string }>;
      openExternal: (url: string) => void;
      platformUrl: string;
      openAccountDashboard: () => void;
      openBilling: () => void;
      // Support
      submitSupportTicket: (ticket: { subject: string; description: string }) => Promise<{ ok: boolean; error?: string }>;
      // Voice transcription
      transcribeAudio: (audioBuffer: ArrayBuffer) => Promise<{ ok: boolean; text?: string; error?: string }>;
      // Yo agent panel
      yoPanelOpen: (query: string) => void;
      yoPanelSend: (message: string) => void;
      yoPanelDismiss: () => void;
      yoPanelStop: () => void;
      onYoPanelOpen: (cb: (query: string) => void) => void;
      onYoPanelToggle: (cb: () => void) => void;
      onYoPanelKickoff: (cb: (prompt: string) => void) => void;
      onYoPanelToken: (cb: (delta: string) => void) => void;
      onYoPanelToolUse: (cb: (id: string, name: string, input: unknown) => void) => void;
      onYoPanelToolResult: (cb: (id: string, detail: string) => void) => void;
      onYoPanelToolProgress: (cb: (id: string, status: string) => void) => void;
      onYoPanelDone: (cb: (fullText: string) => void) => void;
      onYoPanelError: (cb: (err: string) => void) => void;
      onYoPanelClose: (cb: () => void) => void;
      onYoPanelCouncilReady: (cb: (info: { name: string; members: Array<{ provider: string; model: string }>; style: string; round_cap: number }) => void) => void;
      // Cypher chat layer
      onYoPanelChatMsg: (cb: (msg: { from: string; body: string; ts: number; isLocal: boolean }) => void) => void;
      onYoPanelDripEffect: (cb: (recipe: string) => void) => void;
      // Yo panel resize
      yoPanelResize: (width: number) => void;
      yoPanelWidthSave: (width: number) => void;
      yoPanelGetWidth: () => Promise<number>;
      // Files left rail
      filesRailResize: (width: number) => void;
      filesRailWidthSave: (width: number) => void;
      filesRailGetWidth: () => Promise<number>;
      listDir: (dirPath: string) => Promise<Array<{ name: string; isDir: boolean }>>;
      openFile: (filePath: string) => void;
      createFile: (filePath: string) => Promise<{ ok: boolean; error?: string }>;
      mkdir: (dirPath: string) => Promise<{ ok: boolean; error?: string }>;
      deleteEntry: (targetPath: string) => Promise<{ ok: boolean; error?: string }>;
      openHomeSection: (section: string, sub?: string) => void;
      onGotoSection: (cb: (section: string, sub?: string) => void) => void;
      getPendingSection: () => Promise<{ section: string; sub?: string } | null>;
      // Yo chat history
      yoChatsList: () => Promise<Array<{ id: string; title: string; created: string; messageCount: number }>>;
      yoChatsLoad: (id: string) => Promise<Array<{ role: string; text: string; tools?: Array<{ name: string; input?: unknown }> }> | null>;
      yoChatsDelete: (id: string) => Promise<boolean>;
      yoChatNew: () => Promise<boolean>;
      // Agent mode + guardrails
      getAgentMode: () => Promise<string>;
      setAgentMode: (mode: string) => void;
      onAgentModeChanged: (cb: (mode: string) => void) => void;
      getToolRegistry: () => Promise<Array<{ name: string; label: string; description: string; tier: string; override: string }>>;
      setToolOverride: (toolName: string, override: string) => void;
      onApprovalRequest: (cb: (id: string, toolName: string, toolLabel: string, input: unknown) => void) => void;
      approvalRespond: (id: string, approved: boolean) => void;
      // Connectors (Pipedream Connect)
      connectorsGetApps: (search?: string, offset?: number) => Promise<{ apps: Array<{ id: string; name: string; description: string; icon?: string; categories?: string[] }>; hasMore: boolean }>;
      connectorsGetAccounts: () => Promise<Array<{ id: string; appSlug: string; appName: string; createdAt: string; healthy: boolean }>>;
      connectorsConnect: (appSlug: string) => Promise<{ ok: boolean; error?: string }>;
      connectorsDisconnect: (accountId: string) => Promise<boolean>;
      connectorsRefreshMcp: () => Promise<{ ok: boolean; error?: string; toolCount: number }>;
      onConnectorsChanged: (cb: () => void) => void;
      // Auto-update
      onUpdateStatus: (cb: (info: { status: string; version?: string; percent?: number; error?: string }) => void) => void;
      updateInstall: () => void;
      checkForUpdates: () => Promise<string | null>;
      // MCP Expose
      mcpExposeStart: () => Promise<{ ok: boolean; error?: string }>;
      mcpExposeStop: () => Promise<void>;
      mcpExposeStatus: () => Promise<{ running: boolean; port: number }>;
      mcpExposeGetTokens: () => Promise<Array<{ token: string; label: string; createdAt: string; expiresAt: string }>>;
      mcpExposeGenToken: (label: string, ttlDays?: number) => Promise<{ token: string; label: string; createdAt: string; expiresAt: string }>;
      mcpExposeRevokeToken: (token: string) => Promise<void>;

      // BYOK provider keys (Phase 1 of THE-PIVOT-BYOK)
      providerKeysList: () => Promise<Array<{
        provider: string;
        configured: boolean;
        savedAt: string | null;
        lastTested: string | null;
        lastTestOk: boolean | null;
        lastTestError: string | null;
      }>>;
      providerKeysSet: (provider: string, key: string) => Promise<{ ok: boolean; error?: string }>;
      providerKeysRemove: (provider: string) => Promise<{ ok: boolean }>;
      providerKeysTest: (provider: string) => Promise<{ ok: boolean; error?: string }>;

      // Claude Code bootstrap (Phase 2 of THE-PIVOT-BYOK)
      ccStatus: () => Promise<{
        found: boolean; location: string | null; kind: "file" | "keychain" | null; claudePath: string | null;
      }>;
      ccLoginOpenTerminal: () => Promise<{ ok: boolean; error?: string }>;
      onCcShowModal: (callback: () => void) => () => void;
      // Capability Offer
      capabilitiesSetEnabled: (enabled: boolean) => Promise<{ ok: boolean; enabled: boolean; derived_tier?: string; client_id?: string; error?: string }>;
      capabilitiesGetStatus: () => Promise<{ enabled: boolean; client_id: string; derived_tier: string | null; report: unknown }>;
      // Agents
      agentsList: () => Promise<unknown[]>;
      agentsGet: (id: string) => Promise<unknown>;
      agentsSave: (cfg: unknown) => Promise<unknown>;
      agentsRemove: (id: string) => Promise<boolean>;
      agentsIdAvailable: (id: string) => Promise<boolean>;
      // yos wallet
      yosBalance: () => Promise<{ user_id: string; balance: number } | { error: string }>;
      yosRateCards: () => Promise<{ cards: Array<{ tier: string; yos_per_1k_input: number; yos_per_1k_output: number; yos_per_idle_minute: number }> } | { error: string }>;
      modelsList: () => Promise<{ models: Array<{ provider: string; model: string; display_name: string; yos_per_1k_input: number; yos_per_1k_output: number }> } | { error: string }>;
      yosBuyUrl: () => Promise<{ url: string }>;
      // Marketplace + reservations
      marketplaceAvailable: (opts?: { tier?: string; provider?: string; limit?: number }) => Promise<{ entries: Array<{ offer_handle: string; derived_tier: string; providers: string[]; pricing: { terms: string; tier: string; yos_per_1k_input?: number; yos_per_1k_output?: number } | null; last_seen_at: string }>; count: number; ts: string } | { error: string }>;
      agentsLeaderboard: (opts?: { skills?: string; days?: number; limit?: number }) => Promise<{
        entries: Array<{
          published_agent_id: string | null;
          user_id: string;
          agent_local_id: string;
          name: string;
          avatar_url: string | null;
          bio: string | null;
          skills: string[];
          cyphers_count: number;
          tasks_completed: number;
          tasks_assigned: number;
          success_rate: number;
          avg_approval: number | null;
          total_yos: number;
          last_active_at: string | null;
          score: number;
        }>;
        count: number;
      } | { error: string }>;
      reservationCreate: (body: { provider_handle: string; idle_minutes: number; guardrails?: unknown }) => Promise<{ ok: boolean; reservation?: { id: string; status: string; idle_budget_yos: number; release_at: string }; buyer_balance_after?: number; error?: string }>;
      reservationRelease: (id: string, reason?: string) => Promise<{ ok: boolean; reservation?: unknown; buyer_balance_after?: number; idle_yos_settled?: number; provider_earned?: number; error?: string }>;
      reservationList: (opts?: { status?: string }) => Promise<{ reservations: Array<{ id: string; provider_client_id: string; status: string; idle_budget_yos: number; idle_yos_used: number; release_at: string; reserved_at: string }>; count: number } | { error: string }>;
      // Cyphers
      cypherCreate: (input: Record<string, unknown>) => Promise<{ ok: boolean; cypher?: { id: string; slug: string; status: string; type: string; visibility: string; title: string }; error?: string }>;
      cypherUpdate: (id: string, patch: Record<string, unknown>) => Promise<{ ok: boolean; cypher?: unknown; error?: string }>;
      cypherPublish: (id: string, opts?: { initial_kitty_deposit?: number; lobby_duration_seconds?: number | null }) => Promise<{ ok: boolean; cypher?: { id: string; slug: string; status: string }; kitty_balance?: number; error?: string }>;
      cypherStart: (id: string) => Promise<{ ok: boolean; cypher?: { id: string; slug: string; status: string }; error?: string }>;
      cypherWrap: (id: string) => Promise<{ ok: boolean; cypher?: { id: string; status: string }; refunds?: Array<{ user_id: string; amount: number }>; error?: string }>;
      cypherCancel: (id: string) => Promise<{ ok: boolean; cypher?: unknown; error?: string }>;
      cypherDiscover: (opts?: { status?: string; type?: string; limit?: number; offset?: number }) => Promise<{ cyphers: Array<{ id: string; slug: string; title: string; description: string | null; type: string; status: string; visibility: string; max_jammers: number | null; created_at: string }>; count: number } | { error: string }>;
      cypherListMine: () => Promise<{ cyphers: Array<{ id: string; slug: string; title: string; type: string; status: string; visibility: string; created_at: string; updated_at: string }>; count: number } | { error: string }>;
      cypherGet: (id: string) => Promise<{ cypher: { id: string; slug: string; title: string; description: string | null; goal: string | null; type: string; status: string; visibility: string; max_jammers: number | null; min_tier: string | null; requirements: { skills?: string[]; apps?: string[]; mcp_servers?: string[]; model_provider?: string; min_tier?: string }; sensitivity: string; owner_user_id: string; created_at: string; started_at: string | null; ended_at: string | null }; kitty_balance: number } | { error: string }>;
      cypherGetBySlug: (slug: string) => Promise<{ cypher: unknown } | { error: string }>;
      cypherJoin: (id: string, agent_local_id: string, role?: string, invite_token?: string) => Promise<{ ok: boolean; cypher?: unknown; cohort_size?: number; error?: string }>;
      cypherInviteMint: (id: string, opts?: { role?: string; ttl_seconds?: number; multi_use?: boolean; invitee_user_id?: string }) => Promise<{ ok: boolean; invite?: { jti: string; cypher_id: string; role: string; multi_use: boolean; expires_at: string; invitee_user_id: string | null; revoked_at: string | null; used_at: string | null }; token?: string; error?: string }>;
      cypherInviteList: (id: string) => Promise<{ invites: Array<{ jti: string; role: string; multi_use: boolean; expires_at: string; invitee_user_id: string | null; revoked_at: string | null; used_at: string | null; used_by_user_id: string | null; created_at: string }>; count: number } | { error: string }>;
      cypherInviteRevoke: (id: string, jti: string) => Promise<{ ok: boolean; invite?: unknown; error?: string }>;
      cypherLeave: (id: string, agent_local_id: string) => Promise<{ ok: boolean }>;
      cypherJammers: (id: string) => Promise<{ jammers: Array<{ user_id: string; agent_local_id: string; role: string; joined_at: string; left_at: string | null }>; count: number } | { error: string }>;
      cypherJamsList: (id: string) => Promise<{ jams: Array<{ id: string; slug: string; title: string; description: string | null; state_doc: unknown; state_version: string }>; count: number } | { error: string }>;
      cypherJamCreate: (id: string, slug: string, title: string, description?: string) => Promise<{ ok: boolean; jam?: { id: string; slug: string }; error?: string }>;
      cypherJamSetState: (id: string, jam_id: string, expected_version: number, state: unknown) => Promise<{ ok: boolean; version?: number; error?: string }>;
      cypherEventPost: (id: string, kind: string, payload: unknown, jam_id?: string, by_agent_id?: string) => Promise<{ ok: boolean; event?: { id: string; seq: string }; error?: string }>;
      cypherEventsList: (id: string, opts?: { since?: number; jam_id?: string; limit?: number }) => Promise<{ events: Array<{ id: string; seq: string; kind: string; jam_id: string | null; by_user_id: string | null; by_agent_id: string | null; payload: unknown; created_at: string }>; count: number } | { error: string }>;
      cypherKittyDeposit: (id: string, amount: number) => Promise<{ ok: boolean; kitty_balance?: number; user_balance?: number; error?: string }>;
      cypherKittyBalance: (id: string) => Promise<{ balance: number } | { error: string }>;
      cypherKittyLedger: (id: string, opts?: { limit?: number }) => Promise<{ entries: Array<{ id: string; user_id: string; delta: number; kind: string; description: string | null; created_at: string }>; count: number } | { error: string }>;
      // MCP Servers (custom user-configured)
      mcpGetServers: () => Promise<Array<{ config: { id: string; name: string; transport: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; enabled: boolean }; status: string; error?: string; tools: Array<{ name: string; description?: string }> }>>;
      mcpAddServer: (config: Record<string, unknown>) => Promise<void>;
      mcpUpdateServer: (id: string, updates: Record<string, unknown>) => Promise<void>;
      mcpRemoveServer: (id: string) => Promise<void>;
      mcpConnectServer: (id: string) => Promise<{ ok: boolean; error?: string }>;
      mcpDisconnectServer: (id: string) => Promise<void>;
      mcpGetToolOverride: (serverId: string, toolName: string) => Promise<string>;
      mcpSetToolOverride: (serverId: string, toolName: string, override: string) => void;
      mcpSetServerOverride: (serverId: string, override: string) => void;
      onMcpChanged: (cb: () => void) => void;
    };
  }
}

const gridHandles = document.getElementById("grid-handles")!;
const screenshotContainer = document.getElementById("panel-screenshots")!;

// -- Panel screenshot helpers (freeze-frame when hiding panels) --

async function showPanelScreenshots(): Promise<void> {
  const captures = await window.yo.capturePanels();
  for (const cap of captures) {
    const div = document.createElement("div");
    div.className = "panel-screenshot";
    div.style.left = `${cap.bounds.x}px`;
    div.style.top = `${cap.bounds.y}px`;
    div.style.width = `${cap.bounds.width}px`;
    div.style.height = `${cap.bounds.height}px`;
    div.style.backgroundImage = `url(${cap.dataUrl})`;
    screenshotContainer.appendChild(div);
  }
}

function clearPanelScreenshots(): void {
  screenshotContainer.innerHTML = "";
}

// -- Window controls --

document.getElementById("btn-close")!.addEventListener("click", () => window.yo.windowClose());
document.getElementById("btn-minimize")!.addEventListener("click", () => window.yo.windowMinimize());
document.getElementById("btn-maximize")!.addEventListener("click", () => window.yo.windowMaximize());
document.getElementById("splash-close")?.addEventListener("click", () => window.yo.windowClose());

// -- Titlebar label -> open home tab --

document.getElementById("titlebar-label")!.addEventListener("click", () => {
  window.yo.tabNewApp("home");
});


// Yos badge removed in Phase 7 of THE-PIVOT-BYOK — yo-server no longer
// tracks balances; users pay providers directly. The window.refreshYosBadge
// hook becomes a no-op for any caller that still touches it.
(window as unknown as { refreshYosBadge?: () => void }).refreshYosBadge = () => {};


// -- Yo panel (extracted to yo-panel-ui.ts) --
const { openYoPanel, closeYoPanel, isYoPanelOpen, yoScroll, showYoWelcome, hideYoWelcome, getYoPanelWidth } = initYoPanel({
  renderGridHandles: () => gridApi.renderGridHandles(),
});

// -- Tab bar (extracted to tab-bar-ui.ts) --
const tabApi = initTabBar({
  isYoControlsInited: () => false,  // yo panel manages this internally now
  getCurrentMode: () => "standard",
  setModeValue: () => {},
  syncAgentMode: () => {},
});

// -- URL bar --

const urlBar = document.getElementById("url-bar")!;
const urlBarInput = document.getElementById("url-bar-input") as HTMLInputElement;
const urlBarFavicon = document.getElementById("url-bar-favicon") as HTMLImageElement;

function setUrlBarVisible(show: boolean) {
  urlBar.classList.toggle("hidden", !show);
  document.body.style.setProperty("--content-top", show ? "72px" : "38px");
}

// Load initial URL bar visibility
window.yo.getPreference("showUrlBar", true).then((show) => {
  setUrlBarVisible(show as boolean);
});

// Nav buttons
const urlBarBack = document.getElementById("url-bar-back") as HTMLButtonElement;
const urlBarForward = document.getElementById("url-bar-forward") as HTMLButtonElement;
const urlBarRefresh = document.getElementById("url-bar-refresh") as HTMLButtonElement;

urlBarBack.addEventListener("click", () => window.yo.urlBarBack());
urlBarForward.addEventListener("click", () => window.yo.urlBarForward());
urlBarRefresh.addEventListener("click", () => window.yo.urlBarRefresh());

// Navigate on Enter
urlBarInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const url = urlBarInput.value.trim();
    if (url) {
      window.yo.urlBarNavigate(url);
      urlBarInput.blur();
    }
  }
  if (e.key === "Escape") {
    urlBarInput.blur();
  }
});

// Select all on focus for easy replacement
urlBarInput.addEventListener("focus", () => {
  urlBarInput.select();
});

// Receive URL updates from main (active panel navigated)
window.yo.onUrlUpdate((info: { url: string; favicon: string; canGoBack?: boolean; canGoForward?: boolean }) => {
  urlBarInput.value = info.url;
  urlBarFavicon.src = info.favicon || "";
  urlBarFavicon.onerror = () => { urlBarFavicon.src = ""; };
  urlBarBack.disabled = !info.canGoBack;
  urlBarForward.disabled = !info.canGoForward;
});

// Force URL bar visible for browser panels even when globally hidden
window.yo.onUrlBarForce((show: boolean) => {
  setUrlBarVisible(show);
});


// -- Cmd+. opens yo agent panel --

// focus-command-input from main → open agent panel
window.yo.onFocusInput(() => {
  if (!isYoPanelOpen()) {
    window.yo.yoPanelOpen("");
    openYoPanel("");
  }
});



// Commands submitted from the palette child window
window.yo.onExecCommandFromPalette((cmd) => window.yo.execCommand(cmd));

// -- Global keyboard shortcuts --

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (isYoPanelOpen()) window.yo.yoPanelDismiss();
  }

  // Cmd+. (without shift) — toggle yo agent panel
  if (e.key === "." && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
    e.preventDefault();
    if (isYoPanelOpen()) {
      window.yo.yoPanelDismiss();
    } else {
      window.yo.yoPanelOpen("");
      openYoPanel("");
    }
    return;
  }

  // Cmd+R / Ctrl+R to refresh panels
  if (e.key === "r" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.yo.panelsRefresh();
  }

  // Cmd+Plus / Cmd+Minus to zoom panels
  if ((e.key === "=" || e.key === "+") && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.yo.panelsGetZoom().then((z) => window.yo.panelsZoom(z + 0.1));
  }
  if (e.key === "-" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.yo.panelsGetZoom().then((z) => window.yo.panelsZoom(z - 0.1));
  }
  if (e.key === "0" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    window.yo.panelsZoom(1.0);
  }
});


// yo help trigger from main process — open home tab
window.yo.onShowWelcome(() => window.yo.tabNewApp("home"));
window.yo.onOpenSettings(() => window.yo.tabNewApp("home"));


// -- Grid (extracted to grid-ui.ts) --
const gridApi = initGrid({
  isYoPanelOpen,
  getYoPanelWidth,
  isUrlBarHidden: () => urlBar.classList.contains("hidden"),
  setUrlBarVisibility: (hidden) => { urlBar.style.visibility = hidden ? "hidden" : ""; },
  showPanelScreenshots,
  clearPanelScreenshots,
});

// -- Downloads dropdown (extracted to downloads-ui.ts) --
initDownloads();

// -- Left rail: working-folder picker + app navigation --
{
  const rail = document.getElementById("files-rail")!;
  const railToggle = document.getElementById("files-rail-toggle")!;
  const railTitle = document.getElementById("files-rail-title")!;
  const railName = document.getElementById("files-rail-name")!;
  const railResize = document.getElementById("files-rail-resize")!;

  let railRoot: string | null = null;
  let railWidth = 240;

  const setInset = (px: number) => {
    document.body.style.setProperty("--left-inset", `${px}px`);
    window.yo.filesRailResize(px);
  };

  function refreshFolderName() {
    if (railRoot) {
      railName.textContent = railRoot.split("/").filter(Boolean).pop() || railRoot;
      railTitle.title = `Working folder: ${railRoot} — click to change`;
    } else {
      railName.textContent = "Pick a folder";
      railTitle.title = "Pick the working folder";
    }
  }

  function applyOpen(open: boolean) {
    railToggle.classList.toggle("active", open);
    if (open) {
      rail.classList.remove("hidden");
      void rail.offsetHeight;
      rail.classList.add("open");
      setInset(railWidth);
    } else {
      rail.classList.remove("open");
      setInset(0);
      setTimeout(() => rail.classList.add("hidden"), 200);
    }
    try { localStorage.setItem("filesRailOpen", open ? "1" : "0"); } catch {}
  }

  railToggle.addEventListener("click", () => applyOpen(!rail.classList.contains("open")));
  railTitle.addEventListener("click", () => { void window.yo.pickWorkingDir(); });

  // Nav: app sections + Settings, then Platform + Sign Out (pinned bottom).
  rail.querySelectorAll<HTMLElement>(".files-rail-navitem[data-section]").forEach((btn) => {
    btn.addEventListener("click", () => {
      window.yo.openHomeSection(btn.dataset.section!, btn.dataset.sub);
    });
  });
  document.getElementById("files-rail-platform")!.addEventListener("click", () => {
    void window.yo.execCommand(`dip ${window.yo.platformUrl}`);
  });
  document.getElementById("files-rail-logout")!.addEventListener("click", () => {
    void window.yo.logout();
  });

  // Resize handle.
  let dragging = false;
  railResize.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    railResize.classList.add("dragging");
    rail.style.transition = "none";
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    railWidth = Math.max(160, Math.min(window.innerWidth * 0.4, e.clientX));
    rail.style.width = `${railWidth}px`;
    setInset(railWidth);
  });
  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    railResize.classList.remove("dragging");
    rail.style.transition = "";
    window.yo.filesRailWidthSave(railWidth);
  });

  window.yo.onWorkingDirChanged((dir) => {
    railRoot = dir;
    refreshFolderName();
  });

  void (async () => {
    railWidth = await window.yo.filesRailGetWidth().catch(() => 240);
    rail.style.width = `${railWidth}px`;
    railRoot = await window.yo.getWorkingDir().catch(() => null);
    refreshFolderName();
    let savedOpen: string | null = null;
    try { savedOpen = localStorage.getItem("filesRailOpen"); } catch { /* ignore */ }
    applyOpen(savedOpen !== "0"); // default open
  })();
}

// -- Update bar --

const updateBar = document.getElementById("update-bar")!;
const updateMsg = document.getElementById("update-message")!;
const updateProgress = document.getElementById("update-progress")!;
const updateFill = document.getElementById("update-progress-fill")!;
const updateAction = document.getElementById("update-action")!;
const updateDismiss = document.getElementById("update-dismiss")!;

window.yo.onUpdateStatus(({ status, version, percent, error }) => {
  if (status === "available") {
    updateMsg.textContent = `Downloading v${version}...`;
    updateProgress.classList.remove("hidden");
    updateAction.classList.add("hidden");
    updateBar.classList.remove("hidden");
  } else if (status === "downloading") {
    updateFill.style.width = `${percent || 0}%`;
  } else if (status === "ready") {
    updateMsg.textContent = `v${version} ready — restart to update`;
    updateProgress.classList.add("hidden");
    updateAction.classList.remove("hidden");
    updateBar.classList.remove("hidden");
  } else if (status === "error") {
    updateMsg.textContent = `Update failed: ${error || "unknown error"}`;
  }
});

updateAction.addEventListener("click", () => {
  window.yo.updateInstall();
});

updateDismiss.addEventListener("click", () => {
  updateBar.classList.add("hidden");
});

// -- Drip effects (extracted to drip-ui.ts) --
initDrip();


// -- First-run: auto-open the yo agent panel --
// On the very first launch — after the splash, and after onboarding for a
// brand-new user — drop the user straight into the yo agent so the assistant
// is the first thing they reach for. Once-only, guarded by a preference.
function maybeAutoOpenYoPanel(): void {
  window.yo.getPreference("hasAutoOpenedYoPanel", false).then((opened) => {
    if (opened) return;
    window.yo.setPreference("hasAutoOpenedYoPanel", true);
    setTimeout(() => {
      if (!isYoPanelOpen()) {
        window.yo.yoPanelOpen("");
        openYoPanel("");
      }
    }, 1200);
  });
}

// Brand-new user: fires once onboarding activation completes.
window.addEventListener("yo-onboarding-done", () => {
  setTimeout(maybeAutoOpenYoPanel, 800);
});

// -- Boot gate --

initBootGate({
  onBootReady: (data) => {
    // Returning/authenticated user's first launch with this build — a
    // brand-new user reaches this via the yo-onboarding-done path instead.
    if (!data.needsOnboarding) maybeAutoOpenYoPanel();
  },
  showPanels: () => window.yo.panelsShow(),
  hidePanels: () => window.yo.panelsHide(),
  applyTheme: (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("yoTheme", theme); } catch {}
  },
  showOnboarding: (requiresAuth) => showOnboarding(requiresAuth),
});
