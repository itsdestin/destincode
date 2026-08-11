// 'auto' is Claude Code's classifier-backed mode (CC v2.1.83+, March 2026).
// Sits between 'auto-accept' (only file edits + 7 safe bash) and 'bypass'
// (no checks): a background classifier blocks risky actions like mass deletion
// or curl|bash. Plan-gated by Anthropic — only surfaced in the Shift+Tab cycle
// when the session is running on Opus 4.7 1M.
export type PermissionMode = 'normal' | 'auto-accept' | 'plan' | 'auto' | 'bypass';

// Advanced permission overrides for bypass mode. Controls which PermissionRequest
// categories are auto-approved when --dangerously-skip-permissions is active.
// These only affect the small set of requests that bypass mode still fires:
// protected path writes, compound cd commands, etc.
export interface PermissionOverrides {
  approveAll: boolean;            // Blanket approve everything (except AskUserQuestion)
  protectedConfigFiles: boolean;  // .bashrc, .gitconfig, .mcp.json, etc.
  protectedDirectories: boolean;  // .git/, .claude/ (non-exempt paths)
  compoundCdRedirect: boolean;    // cd + output redirection (path resolution bypass)
  compoundCdGit: boolean;         // cd + git (bare repository attack protection)
}

export const PERMISSION_OVERRIDES_DEFAULT: PermissionOverrides = {
  approveAll: false,
  protectedConfigFiles: false,
  protectedDirectories: false,
  compoundCdRedirect: false,
  compoundCdGit: false,
};

// Which runtime backend powers a session — defaults to 'claude'.
// 'claude'  = Claude Code CLI over PTY (the original path).
// 'native'  = YouCoded's first-party harness (Phase 1+ of the platform
//             roadmap; dormant until window.claude.native.supported is true).
// 'gemini' was removed 2026-07-10 — Google discontinued the Gemini CLI
// (June 2026); Gemini models are reachable through the native runtime via
// OpenRouter or a direct Google key instead.
export type SessionProvider = 'claude' | 'native';

// A model reference portable ACROSS devices — persisted on a Conversation Store
// record (conversations/store-core.ts) so the resume selector can pre-fill
// without a round-trip. Deliberately NOT the device-local providerId ULID: that
// ULID only resolves via THIS device's ~/.youcoded/providers.json, so
// persisting it would silently break resume on every OTHER synced device.
// modelId/providerType/providerLabel are the portable identity a peer device
// can re-resolve (or just display).
//
// Lives here (shared/types.ts), not conversations/store-core.ts, because
// PastSession below needs it and shared/ must never import FROM main/ (main →
// shared is the only legal direction — see SessionProvider above for the same
// pattern). store-core.ts re-exports this type so its existing importers
// (conversation-store.ts, service.ts, portable-model.ts, ipc-handlers.ts)
// didn't need to change their import paths.
export interface PortableModelRef {
  modelId: string;
  providerType: string;
  providerLabel: string;
}

// M1: ack shape for native:send — 'sent' = turn dispatched now, 'queued' = FIFO'd
// behind the in-flight turn, 'failed' = refused (reason says why, exactly).
// Task 11 (cancel/edit queued messages): the 'queued' arm carries the host-
// minted queueId (NativeSessionHost.send()'s randomUUID()) so the renderer can
// target this exact entry later with native:queue-remove.
export type NativeSendResult =
  | { status: 'sent' }
  | { status: 'queued'; queueId: string }
  | { status: 'failed'; reason: 'not-live' | 'queue-full' };

export interface SessionInfo {
  id: string;
  name: string;
  cwd: string;
  permissionMode: PermissionMode;
  skipPermissions: boolean;
  status: 'active' | 'idle' | 'destroyed';
  createdAt: number;
  /** Which runtime backend this session runs — 'claude' (default) or 'native' */
  provider: SessionProvider;
  /** Native runtime only: the RESOLVED harness preset id ('assistant' | 'coder',
   *  post legacy-mapping — a stored 'chat' header resolves to 'assistant'). Drives
   *  the renderer's preset badge. Absent for Claude sessions. */
  harnessId?: string;
  /** Model alias the session was started with (e.g. 'claude-sonnet-4-6') */
  model?: string;
  /** Optional text to prefill into the input bar after this session is selected.
   *  Consumed once by InputBar on first render after session switch; cleared via
   *  a consumed-set ref so it never re-fires on re-renders. */
  initialInput?: string;
}

export interface HookEvent {
  type: string;
  sessionId: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

// --- Transcript watcher types ---

export type TranscriptEventType =
  | 'user-message'
  | 'assistant-text'
  | 'tool-use'
  | 'tool-result'
  | 'thinking'
  // Extended-thinking models emit `thinking` blocks between tool calls that
  // carry no chat text — the watcher surfaces them as heartbeats so the
  // attention classifier doesn't misread the silence as 'stuck'.
  | 'assistant-thinking'
  | 'turn-complete'
  // Emitted when Claude Code writes a {type:"user", isCompactSummary:true}
  // entry — the canonical "compaction finished" signal. In-session /compact
  // appends to the SAME file (no shrink), so we can't use file-size heuristics.
  | 'compact-summary'
  // Emitted when Claude Code writes a user-interrupt marker ("[Request
  // interrupted by user]" / "...for tool use"), produced when the user
  // presses ESC during a turn. The reducer uses this to end the turn
  // without rendering the marker as a user bubble.
  | 'user-interrupt'
  // Terminal marker appended by the TRANSCRIPT_REPLAY handler after the last
  // historical event — NEVER parsed from a transcript, so it is not persisted
  // and cannot be replayed twice. A transcript ends wherever the process died,
  // so a tool_use with no result replays as a card that spins forever after a
  // resume (Destin, 2026-08-09 dogfood). This event is the "history is over"
  // barrier the reducer needs to reap those orphans.
  // `data.sessionIdle` says whether main can AFFIRM nothing is in flight: the
  // same replay also fires when a window re-docks a live, mid-turn session,
  // where the running tool is real and must not be failed.
  | 'replay-complete'
  // Native-runtime only: a provider/stream failure ended the turn. Carries the
  // human-readable message in data.text. Never emitted by CC's transcript
  // watcher and never persisted to the native session store (stale on resume).
  | 'session-error'
  // Native-runtime only: /clear's CONTEXT BARRIER (M3 item 2). The native
  // session log is append-only with a write-once header, so "clear" cannot
  // erase anything — it appends this marker instead, and everything before it
  // is ignored when history is rebuilt. The conversation therefore keeps its
  // identity and stays fully readable on disk while the model's memory resets.
  // Unlike session-error this IS persisted: a barrier that vanished on resume
  // would silently resurrect the context the user deliberately dropped.
  | 'context-clear'
  // Native-runtime only: a user-invoked skill (/skill-name, M3 item 1). Persisted
  // because the skill's instructions ARE part of the model's history — a resume
  // that dropped them would replay a conversation whose first move makes no sense.
  // `data.body` carries those instructions for history rebuild; the UI renders
  // only `skillId`/`displayName`/`args` as a compact card, because a 26k-character
  // SKILL.md as a user bubble is unreadable (Destin, 2026-07-28). `skillPath`
  // makes the card open the real file in the artifact viewer.
  | 'skill-invoked';

export interface TranscriptEvent {
  type: TranscriptEventType;
  sessionId: string; // desktop session ID
  /** The JSONL line's uuid — used for deduplication */
  uuid: string;
  timestamp: number;
  data: {
    text?: string;
    toolUseId?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: string;
    isError?: boolean;
    stopReason?: string;
    /** Edit/MultiEdit tool-result payloads carry structuredPatch hunks. */
    structuredPatch?: StructuredPatchHunk[];
    /** Native user-message events: absolute composer attachment paths, persisted so
     *  resume can re-read the pixels (events carry no binary). #290 follow-up fix 2. */
    attachments?: string[];
    /** Native tool-result events: absolute paths of images the tool delivered
     *  (Read on an image). Resume re-reads them; the UI may render a chip. */
    images?: string[];
    // Task 1.1: widened turn-complete payload so the reducer can attach the
    // per-turn model, token/cache usage, and the Anthropic requestId to the
    // completing AssistantTurn for UI surfacing. All optional — the field is
    // shared across event types, and turn-complete is the only current writer.
    /** Model ID used for the completing turn (e.g. "claude-opus-4-7"). */
    model?: string;
    /** Anthropic API request id from the JSONL line's top-level `requestId`. */
    anthropicRequestId?: string;
    /** Token + cache usage snapshot from message.usage. */
    usage?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      /** Native runtime only: output tokens / stream seconds. CC never reports this. */
      tokensPerSecond?: number;
      /** Native runtime only: the session's REAL context window (resolved in main,
       *  Task 4/5). Carried on the per-turn payload so the renderer's StatusBar can
       *  compute context % without a separate IPC. Constant per session; CC omits it. */
      contextLength?: number | null;
      /** Native runtime only: tokens OCCUPYING the window after this turn — the
       *  last step's prompt plus its output. Distinct from inputTokens, which
       *  sums every step and therefore re-counts the history once per step. */
      contextUsedTokens?: number;
    };
    /**
     * Populated only on events emitted from a subagent JSONL — identifies
     * the parent Agent tool_use that this subagent's work threads into.
     */
    parentAgentToolUseId?: string;
    /** Stable subagent ID — matches the filename agent-<agentId>.jsonl on disk. */
    agentId?: string;
    /** Streaming-part id used to merge reasoning chunks; emitted by the native harness, not CC's watcher. */
    partId?: string;
    /**
     * Native runtime only. Set on an `assistant-thinking` heartbeat when the
     * streaming watchdog has seen NO chunk for STALL_WARNING_MS. Drives the
     * ThinkingIndicator's "taking a while… retrying" countdown. `willRetry` =
     * the harness will auto-retry the step when the countdown ends (nothing had
     * streamed yet); false = it will surface a session-error instead. A heartbeat
     * WITHOUT this field means activity resumed and clears the warning.
     */
    stallWarning?: { retryInMs: number; willRetry: boolean };
    /**
     * Native runtime only. Emitted on `assistant-thinking` the moment a step's
     * stream opens, BEFORE any token arrives, so the UI can say the model is
     * reading the prompt rather than showing an idle spinner. Local models take
     * minutes to prefill a long prompt and there is otherwise nothing to tell
     * that apart from a hang — which is what made the 75s stall watchdog's false
     * alarm so alarming (2026-07-26). `budgetMs` is how long prefill is allowed
     * to take before the watchdog treats the silence as a real stall.
     */
    promptProcessing?: { promptTokens: number; budgetMs: number; source?: 'prompt' | 'tool-output'; processed?: number; cached?: number; etaMs?: number | null; timeMs?: number };
    /**
     * Populated only on `user-interrupt` events. Distinguishes the two exact
     * marker strings Claude Code writes: `[Request interrupted by user]`
     * (plain) vs `[Request interrupted by user for tool use]` (tool-use).
     */
    kind?: 'plain' | 'tool-use';
    /**
     * Populated on `compact-summary` events. The full text of the compaction
     * summary CC wrote into the JSONL — pre-stripped of system tags. The
     * reducer attaches it to the SystemMarker so the user can click-to-expand
     * the otherwise-thin "Compacted" divider.
     */
    summary?: string;
    /**
     * Native runtime only: set on a `compact-summary` emitted by the harness's
     * SPONTANEOUS two-stage compaction (spec §4.4). CC's transcript-watcher
     * compact-summary events never carry it. The renderer renders the marker for
     * an auto-compaction without the manual-/compact `compactionPending` flag —
     * without it a native auto-compaction would replace ~all history and show
     * NOTHING. Kept off CC's path so manual /compact and resume-from-summary are
     * unchanged.
     */
    autoCompaction?: boolean;
    /** `skill-invoked` only (M3 item 1). `skillId` is the resolved, qualified id
     *  (wecoded-themes-plugin:theme-builder); `body` is the SKILL.md text that
     *  enters model history on rebuild and is deliberately NOT rendered;
     *  `skillPath` lets the card open the real file in the artifact viewer. */
    skillId?: string;
    displayName?: string;
    args?: string;
    body?: string;
    skillPath?: string;
    /**
     * `replay-complete` only. Whether main could AFFIRM the session has no work
     * in flight, which is what gates the reducer's orphan reap — the same replay
     * fires when a window re-docks a genuinely mid-turn session, where the
     * running tool is real and must not be failed. Only NativeSessionHost can
     * answer (`entry.inFlight`); CC sessions report false.
     *
     * DECLARED, not just commented, because producer (ipc-handlers.ts) and
     * consumer (App.tsx, BubbleFeed.tsx) are otherwise linked by nothing but a
     * matching string literal through an `any`-typed `evt.sender.send`. A typo
     * on either side reads undefined → false, silently disabling the reap with
     * the whole suite still green (found reviewing PR #287, 2026-08-10).
     */
    sessionIdle?: boolean;
  };
}

// --- Chat view types ---

export type ToolCallStatus = 'running' | 'complete' | 'failed' | 'awaiting-approval';

// jsdiff-style hunk. Claude Code's Edit/MultiEdit tool results include
// `toolUseResult.structuredPatch`: pre-computed hunks with absolute file
// line numbers + interleaved context/add/del rows. Preferred over
// reconstructing a diff from old_string/new_string because line numbers
// reflect the real file position.
export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each string begins with ' ' (context), '-' (deletion), or '+' (addition). */
  lines: string[];
}

/**
 * One entry in a subagent's nested timeline rendered inside AgentView.
 * Narrower than ToolCallState — no awaiting-approval, no tool groups,
 * no turn tracking (subagents don't hit the permission hook flow and
 * don't have user-typed messages).
 */
export type SubagentSegment =
  | { type: 'text'; id: string; content: string }
  | {
      type: 'tool';
      id: string;
      toolUseId: string;
      toolName: string;
      input: Record<string, unknown>;
      status: 'running' | 'complete' | 'failed';
      response?: string;
      error?: string;
      structuredPatch?: StructuredPatchHunk[];
    };

export interface ToolCallState {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  status: ToolCallStatus;
  requestId?: string;
  permissionSuggestions?: string[];
  /** Native broker only: winning rule came from the destructive deny-list →
   *  the "Always allow" button shows a consequence-gated confirm. Task 13. */
  denyListed?: boolean;
  response?: string;
  error?: string;
  /** Set when the tool result carries a structuredPatch (Edit/MultiEdit). */
  structuredPatch?: StructuredPatchHunk[];
  // Populated for Agent tools only (toolName === 'Agent'):
  // - subagentSegments: appended to as the subagent's JSONL streams in; drives AgentView timeline
  // - agentType: copied from meta.json once the subagent is bound (e.g. 'Explore', 'Plan')
  // - agentId: stable subagent ID, matches the filename agent-<agentId>.jsonl on disk
  subagentSegments?: SubagentSegment[];
  agentType?: string;
  agentId?: string;
}

export interface ToolGroupState {
  id: string;
  toolIds: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  // Exact file paths the user attached with this message (from InputBar's file
  // picker). Carried alongside content — which space-joins them — so
  // UserMessage can render each as a clickable pill even when the path
  // contains spaces (regex detection can't recover those from the joined
  // string). Live-bubble only: transcript-confirmed entries don't carry it.
  attachments?: string[];
}

// --- Command drawer / marketplace types ---

export interface SkillEntry {
  // Existing
  id: string;
  displayName: string;
  description: string;
  category: 'personal' | 'work' | 'development' | 'admin' | 'other';
  prompt: string;
  source: 'youcoded-core' | 'self' | 'plugin' | 'marketplace';
  pluginName?: string;

  // New — marketplace fields
  type: 'prompt' | 'plugin';
  author?: string;
  version?: string;
  rating?: number;
  ratingCount?: number;
  installs?: number;
  visibility: 'private' | 'shared' | 'published';
  installedAt?: string;
  updatedAt?: string;
  repoUrl?: string;
  // Phase 3c: optional config schema — when present, the detail view renders
  // a settings form for this entry. Anthropic plugins using native config.json
  // should NOT set this field.
  configSchema?: ConfigSchema;

  // Marketplace redesign Phase 1 — soft filter/curation fields populated from
  // overrides/<id>.json; all optional so pre-extension cache reads still work.
  tags?: string[];
  tagline?: string;
  longDescription?: string;
  lifeArea?: string[];
  audience?: 'general' | 'developer';

  // Marketplace redesign Phase 1 — component inventory from extract-components.
  // `null` means extraction failed (see componentsError). UI should hide the
  // "What's inside" peek for null; empty object {} means the plugin genuinely
  // has no components.
  components?: SkillComponents | null;
  componentsError?: string;

  // Propagated from sync.js for UI "deprecated" badges. Present only when true.
  deprecated?: boolean;
  deprecatedAt?: string;

  // When true, the plugins grid should hide this entry because it is surfaced
  // through the dedicated Integrations tile instead (e.g. google-services,
  // imessage). The entry is still installable — just not double-listed.
  integrationOnly?: boolean;

  // Source info from index.json — needed by the in-app file viewer to fetch
  // raw SKILL.md/commands/agents content when the plugin isn't installed.
  // 'local' = subdir in wecoded-marketplace repo (sourceRef is that subdir).
  // 'url' = git URL (sourceRef is the clone URL).
  // 'git-subdir' = git URL with a subdir (sourceRef is clone URL, sourceSubdir is the subdir).
  sourceType?: string;
  sourceRef?: string;
  sourceSubdir?: string;

  // Absolute path to the skill's own directory (the one holding SKILL.md).
  // Populated by scanSkills for filesystem-discovered skills. The native harness
  // needs it because `prompt` is only the slash-command string — it carries no
  // instructions — and the scanner otherwise discards the path it already knew
  // in order to read the frontmatter. Absent for registry-only entries the user
  // has not installed.
  skillDir?: string;
}

export interface SkillDetailView extends SkillEntry {
  fullDescription?: string;
  tags?: string[];
  publishedAt?: string;
  authorGithub?: string;
  sourceRegistry?: string;
}

// Command drawer entry — represents a slash command that can appear
// in the CommandDrawer's search results. Distinct from SkillEntry
// because commands may be unclickable (e.g. CC built-ins without a
// native UI in YouCoded).
export type CommandEntry = {
  name: string;                   // '/compact', '/superpowers:brainstorm'
  description: string;
  source: 'youcoded' | 'filesystem' | 'cc-builtin';
  clickable: boolean;
  disabledReason?: string;        // populated when clickable=false
  aliases?: string[];             // e.g. /clear → ['/reset', '/new']
};

export interface SkillFilters {
  type?: 'prompt' | 'plugin';
  category?: SkillEntry['category'];
  sort?: 'popular' | 'newest' | 'rating' | 'name';
  query?: string;
}

export interface ChipConfig {
  skillId?: string;  // optional — chips can exist without a backing skill (e.g., "Git Status" is just a prompt)
  label: string;
  prompt: string;
}

export interface MetadataOverride {
  displayName?: string;
  description?: string;
  category?: SkillEntry['category'];
}

// Component of an installed marketplace package (plugin, theme, etc.)
export interface PackageComponent {
  type: 'plugin' | 'theme';
  path: string;
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: { name?: string } | string;
  license?: string;
  recommends?: string[];   // soft recommendation — package works without these
  provides?: Record<string, { description: string; skill: string }>;
  optionalIntegrations?: Record<string, { whenAvailable: string; whenUnavailable: string }>;
  postInstall?: string;    // shell command run after install (trusted-org only)
}

// Tracked marketplace package — records what the marketplace installed
export interface PackageInfo {
  version: string;
  source: 'marketplace' | 'user';
  installedAt: string;
  removable: boolean;
  components: PackageComponent[];
  // Decomposition v3 §9.8: cross-device sync can surface a package that's
  // present in config but not yet on disk (e.g., Android pulled a desktop
  // config but hasn't installed the package yet). "pending" UIs can show an
  // Install CTA without confusing the user about whether it's really there.
  status?: 'installed' | 'pending';
}

export interface UserSkillConfig {
  version: 1 | 2;
  favorites: string[];
  /** Slugs of themes the user has pinned as favorites. Drives the Appearance
   *  panel (favorites-only) and the "My favorite themes" section in Library.
   *  Seeded with the four built-ins on first read; see SkillConfigStore.getThemeFavorites(). */
  themeFavorites?: string[];
  chips: ChipConfig[];
  overrides: Record<string, MetadataOverride>;
  privateSkills: SkillEntry[];
  // v2: unified package tracking (replaces installed_plugins)
  packages?: Record<string, PackageInfo>;
}

export interface SkillProvider {
  listMarketplace(filters?: SkillFilters): Promise<SkillEntry[]>;
  getSkillDetail(id: string): Promise<SkillDetailView>;
  search(query: string): Promise<SkillEntry[]>;
  getInstalled(): Promise<SkillEntry[]>;
  getFavorites(): Promise<string[]>;
  getChips(): Promise<ChipConfig[]>;
  getOverrides(): Promise<Record<string, MetadataOverride>>;
  install(id: string): Promise<any>;
  uninstall(id: string): Promise<void | { type: 'plugin' | 'prompt' }>;
  setFavorite(id: string, favorited: boolean): Promise<void>;
  setChips(chips: ChipConfig[]): Promise<void>;
  setOverride(id: string, override: MetadataOverride): Promise<void>;
  createPromptSkill(skill: Omit<SkillEntry, 'id'>): Promise<SkillEntry>;
  deletePromptSkill(id: string): Promise<void>;
  publish(id: string): Promise<{ prUrl: string }>;
  generateShareLink(id: string): Promise<string>;
  importFromLink(encoded: string): Promise<SkillEntry>;
  getFeatured?(): Promise<FeaturedData>;
}

// Marketplace redesign Phase 1 — discovery curation. Driven by featured.json
// in the wecoded-marketplace repo; edited via /feature admin skill.
export interface FeaturedHeroSlot {
  id: string;
  blurb: string;
  accentColor?: string;
}

export interface FeaturedRail {
  title: string;
  description?: string;
  slugs: string[];
}

export interface FeaturedData {
  hero?: FeaturedHeroSlot[];
  rails?: FeaturedRail[];
  // Legacy shape — passed through for older clients; to be dropped in Phase 2.
  skills?: Array<{ id: string; tagline?: string }>;
  themes?: Array<{ slug: string; tagline?: string }>;
}

// Marketplace redesign Phase 3 — integrations as a first-class kind.
// 'plugin' kind wraps an existing marketplace plugin + optional post-install
// slash command, avoiding a second install pipeline.
export type IntegrationKind = 'mcp' | 'shell' | 'http' | 'plugin';
export type IntegrationStatusValue =
  | 'not-installed'
  | 'installing'
  | 'needs-auth'
  | 'connected'
  | 'error';

export interface IntegrationSetup {
  type: 'script' | 'api-key' | 'macos-only' | 'plugin';
  path?: string;
  requiresOAuth?: boolean;
  oauthProvider?: string;
  keyName?: string;
  // setup.type === 'plugin' — the marketplace plugin id to install and an
  // optional slash command the app runs in a fresh session after install.
  pluginId?: string;
  postInstallCommand?: string;
}

export interface IntegrationEntry {
  slug: string;
  displayName: string;
  tagline: string;
  longDescription?: string;
  kind: IntegrationKind;
  setup: IntegrationSetup;
  status: 'available' | 'planned' | 'deprecated';
  accentColor?: string;
  lifeArea?: string[];
  // Relative path under integrations/icons/ in the marketplace repo; the UI
  // resolves this against the raw.githubusercontent.com base URL.
  iconUrl?: string;
  // Human tags for search and the detail-page chip row. Freeform strings;
  // the detail overlay renders each as a "#tag" pill.
  tags?: string[];
  // Platforms where this integration can run. When present and the current
  // platform isn't listed, the card shows a "<platform>-only" affordance.
  platforms?: Array<'darwin' | 'linux' | 'win32'>;
}

export interface IntegrationIndex {
  version: string;
  integrations: IntegrationEntry[];
}

export interface IntegrationState {
  slug: string;
  installed: boolean;
  connected: boolean;
  lastSync?: string;
  error?: string;
}

// AttentionState drives the UI decision between ThinkingIndicator (ok) and
// the AttentionBanner (everything else). A classifier reads the PTY buffer
// and maps its conclusions onto these states; process-exit events also
// transition to 'session-died' directly. See docs/chat-reducer.md.
//
// Narrowed 2026-04-26: 'awaiting-input' / 'shell-idle' / 'error' were
// removed because nothing in the codebase ever dispatched them — the
// classifier was simplified to spinner-only signals back in the April
// rewrite, but the type and the AttentionBanner copy table still carried
// the dead branches. Reducer tests that used them have been switched to
// 'stuck' (the only buffer-driven non-ok state). If we ever need finer
// distinctions, reintroduce them along with the dispatching code path.
//
// 2026-07-10: 'error' reintroduced WITH a writer for the native runtime
// (Phase 1 Plan A) — see the union member's comment for the dispatcher.
export type AttentionState =
  | 'ok'              // Default — indicator renders if isThinking
  | 'stuck'           // Spinner glyph stale ≥ 10s OR no spinner ≥ 20s while thinking
  | 'session-died'    // Process exited mid-turn
  // Native-runtime provider/stream failure (dispatcher: NATIVE_SESSION_ERROR,
  // fed by the 'session-error' transcript event). CC sessions never enter it.
  | 'error';

// Red | green | blue | gray — mirrors SessionStatusColor in renderer.
// Duplicated as a string literal type here (not imported) so main-process
// code in Node can consume this interface without dragging renderer
// imports across the main/renderer boundary.
// Mirrored in renderer as SessionStatusColor (StatusDot.tsx). Duplicated as a
// string literal here (not imported) so main-process Node code can consume
// this interface without crossing the main/renderer boundary. Keep the two
// unions in sync — adding a color in one place without the other will make
// the AttentionSummary IPC payload reject valid renderer values.
export type SessionStatusDotColor = 'green' | 'red' | 'amber' | 'blue' | 'gray';

export interface AttentionSummary {
  anyNeedsAttention: boolean;
  perSession: Record<string, {
    attentionState: AttentionState;
    awaitingApproval: boolean;
    // Derived dot color from the main window's reducer (matches what the
    // main session switcher renders). Pushed to buddy surfaces so the
    // SessionPill's dot is visually identical to the same session's dot
    // in the main window. Absent for sessions that haven't reported yet.
    status?: SessionStatusDotColor;
  }>;
}

// Payload sent by renderer → main via the attention:report IPC channel.
// Main aggregates these across all windows and broadcasts an AttentionSummary.
// The 'clear' variant fires when a session is removed from the renderer.
export type AttentionReport =
  | {
      sessionId: string;
      attentionState: AttentionState;
      awaitingApproval: boolean;
      status?: SessionStatusDotColor;
    }
  | { sessionId: string; clear: true };

export interface AttentionApi {
  report(payload: AttentionReport): void;
}

export interface BuddyApi {
  show(): Promise<void>;
  hide(): Promise<void>;
  toggleChat(): Promise<void>;
  setSession(sessionId: string): Promise<void>;
  subscribe(sessionId: string): Promise<void>;
  unsubscribe(sessionId: string): Promise<void>;
  getViewedSession(): Promise<string | null>;
  // Fire-and-forget. Called by BuddyMascot during pointer drag; main
  // places the mascot at the supplied target (clamped to visible workArea).
  // Anchor-based, not delta-based, so per-move rounding on HiDPI displays
  // cannot accumulate drift between the cursor and the mascot.
  moveMascot(target: { targetX: number; targetY: number }): void;
  onAttentionSummary(cb: (summary: AttentionSummary) => void): () => void;
  // Pre-existing preload methods that were missing from this interface —
  // added while typing the buddy-upgrades members so call sites don't need
  // `(window as any)` casts. Main does the hide/capture/restore dance and
  // pushes the PNG path to the chat renderer on BUDDY_ATTACH_FILE.
  captureDesktop(): Promise<string | null>;
  onAttachFile(cb: (filePath: string) => void): () => void;
  // ── Buddy upgrades (action bar, dismiss, dock/peek) ──
  // Typed centrally here (instead of `as any` casts at call sites) so the
  // preload, remote-shim, and renderer callers all agree on one contract.
  /** Fire-and-forget: mascot renderer signals drag release (edge-snap check). */
  dragEnded(): void;
  /** Restore + focus the main window, switching to the buddy's viewed session. */
  openMain(): Promise<void>;
  /** Hide the buddy for this app run only (preference stays enabled). */
  dismiss(): Promise<void>;
  // WHY keepAbove rides on getStatus() rather than a dedicated getter: Task
  // 8 only adds one new channel (setKeepAbove, for the write); reusing the
  // existing getStatus() round-trip for the read keeps that true instead of
  // growing a second buddy:* channel just to answer "what's it set to now".
  // Optional (not just boolean) because the remote-shim stub throws before
  // ever constructing a payload, so no caller can assume the field exists.
  getStatus(): Promise<{ dismissed: boolean; visible: boolean; keepAbove?: boolean }>;
  onStatusChanged(cb: (s: { dismissed: boolean; visible: boolean }) => void): () => void;
  onBarState(cb: (s: { visible: boolean }) => void): () => void;
  onMascotState(cb: (s: { mode: 'free' | 'docked' | 'peeking'; edge: string | null }) => void): () => void;
  onChatState(cb: (s: { visible: boolean }) => void): () => void;
  onFocusSession(cb: (sessionId: string) => void): () => void;
  // ── Linux Wayland overlay (Task 3+4) — only the overlay renderer calls
  // these; other buddy surfaces (three-window model) never mount them.
  /** Renderer → main pull, called once on overlay mount: returns the
   *  window-local workArea/mascot/dock the overlay's DOM mascot needs, or
   *  null when the caller isn't the live overlay window. WHY pull, not a
   *  main→renderer push (2026-07-23 dead-floater lesson): a push sent at
   *  did-finish-load races React's mount — in dev, Vite loads the module
   *  graph AFTER did-finish-load, so the one-shot push was gone before the
   *  subscription existed and the overlay rendered nothing forever. A pull
   *  cannot lose that race by construction. */
  overlayReady(): Promise<{
    workArea: { x: number; y: number; width: number; height: number };
    mascot: { x: number; y: number } | null;
    dock: string | null;
  } | null>;
  /** Main → overlay push: external (tray/menu) chat toggle request. */
  onOverlayToggleChat(cb: () => void): () => void;
  /** Fire-and-forget, hover-hot path: overlay renderer reports whether the
   *  pointer is over an interactive element (mascot/bar/chat) so main can
   *  flip the click-through window between ignore/accept mouse events. */
  overlaySetInteractive(interactive: boolean): void;
  /** Fire-and-forget: overlay renderer's own drag/dock logic (DOM-side)
   *  reports the final mascot position + dock edge to persist. */
  overlayPersist(state: { mascot: { x: number; y: number }; dock: string | null }): void;
  // ── Task 8: opt-in KDE keep-above (Settings toggle, Linux only) ──
  /** Persists `enabled` to the buddy positions file and applies it live via
   *  a KWin scripting DBus call (see kwin-keep-above.ts). The toggle itself
   *  is a saved PREFERENCE, not a live-state indicator — it displays and
   *  persists the user's request in both directions regardless of this
   *  result (controller ruling 2026-07-22: a symmetric OR asymmetric
   *  reconcile against this boolean both produced contradictions — see
   *  SettingsPanel.tsx's toggleKeepAbove WHY comment). The resolved boolean
   *  reports only whether the KWin apply actually ran just now — true on
   *  KDE Plasma where the script ran, false everywhere else (GNOME/wlroots/
   *  no qdbus, or a transient DBus failure) — and is used solely to drive
   *  Settings' inline "couldn't reach KWin" hint. Never rejects. */
  setKeepAbove(enabled: boolean): Promise<boolean>;
}

// Marketplace redesign Phase 1 — per-entry component inventory for the
// "What's inside" peek on cards and detail overlays. Extracted at sync time
// by scripts/extract-components.js; `null` on the entry signals extraction
// failure and the UI should hide the peek.
export interface SkillComponents {
  skills: string[];
  hooks: string[];
  commands: string[];
  agents: string[];
  mcpServers: string[];
  hasHooksManifest: boolean;
  hasMcpConfig: boolean;
}

// Known session flag names. Add new flags here + in the renderer's pill list.
// Server-side validation rejects any flag name not in this union.
export type SessionFlagName = 'complete' | 'priority';
export const SESSION_FLAG_NAMES: SessionFlagName[] = ['complete', 'priority'];

/** Generic fallback shown when a host answers session:get-meta with
 *  `supported: false` but no `unsupportedReason` of its own. As of Task 5
 *  (2026-07-2x) native sessions are real Conversation Store records and no
 *  longer answer this way — Android still can (tags/notes aren't built there
 *  yet), so this stays as the renderer's host-neutral catch-all rather than
 *  naming a cause it hasn't verified. Formerly NATIVE_META_UNSUPPORTED, which
 *  named native sessions specifically — renamed when that was no longer true.
 *  Shared by the ipcMain handlers, the remote WS handlers, and the renderer's
 *  disabled-state tooltip so all three say the same thing. */
export const META_UNSUPPORTED_FALLBACK =
  "Tags and notes aren't available for this session.";

/** session:get-meta result. `supported: false` means writes will be REFUSED for
 *  this session — render the controls disabled rather than accepting edits. */
export interface SessionMetaResult {
  tags: string[];
  note: string;
  /** Reserved flags (SESSION_FLAG_NAMES) currently set on the conversation.
   *  OPTIONAL: an older remote peer or Android answers without it, and the
   *  renderer must treat missing as "none set" rather than as an error. Added
   *  2026-07-31 so the in-session tag chip can offer Priority the same way the
   *  Resume Browser does — as a built-in tag rather than a separate control. */
  flags?: Partial<Record<SessionFlagName, boolean>>;
  /** OPTIONAL on purpose: any remote peer running an older build answers get-meta
   *  without this field. Callers must treat a MISSING value as supported — only an
   *  explicit `false` disables the UI. */
  supported?: boolean;
  /** Why writes are unsupported, supplied by whichever backend answered. Hosts
   *  differ (a desktop native session vs. Android, where tags/notes simply aren't
   *  built yet), and showing one host's reason on another would be a misleading
   *  error message. Renderers display this and fall back to the generic constant. */
  unsupportedReason?: string;
}

export interface PastSession {
  /** Claude Code's internal session ID (JSONL filename without extension) */
  sessionId: string;
  /** Human-readable name from topic file, or 'Untitled' */
  name: string;
  /** Project directory slug (e.g. 'C--Users-alice') */
  projectSlug: string;
  /** Display-friendly project path derived from slug */
  projectPath: string;
  /** Last modified timestamp (epoch ms) */
  lastModified: number;
  /** File size in bytes — proxy for conversation length */
  size: number;
  /** User-set flags. `complete` hides from resume menu; `priority` pins to top.
   *  Multiple flags per session are allowed. */
  flags?: Partial<Record<SessionFlagName, boolean>>;
  /** Which runtime owns this past session: `'claude'` (a Claude Code JSONL
   *  transcript — the historical default) or `'native'` (a YouCoded
   *  native-harness session persisted by NativeSessionHost). Drives the Resume
   *  Browser badge + which resume path App uses. Also populated on
   *  Conversation-Store rows (Phase 2a). Typed `string` (not the `'claude' |
   *  'native'` union) because store-fed rows assign it from a stored string. */
  provider?: string;
  /** Native runtime only: the stored harness preset id from the session header
   *  ('assistant' | 'coder' | legacy 'chat'). Drives the Resume Browser's preset
   *  label. Absent for Claude transcripts. */
  harnessId?: string;
  /** Applied custom-tag ids (from the conversation store's `tag:<id>` flag
   *  keys). Resolved to labels/colors by the renderer via the tag registry. */
  tags?: string[];
  /** User's freeform note for this session ('' / absent = none). */
  note?: string;
  /** Last device that ran a turn. Populated on store-fed rows (Conversation
   *  Store, Phase 2a) so the Resume Browser can show where a conversation ran. */
  device?: string;
  /** True when the conversation's project folder is not present on THIS device
   *  (a conversation synced in from another device). Resume is disabled for
   *  these rows — the working directory to resume into doesn't exist here. */
  missingProject?: boolean;
  /** True when the project folder IS on this device but the transcript hasn't
   *  been materialized into ~/.claude/projects yet (sync in flight). Resume is
   *  disabled — `claude --resume` would error on the missing JSONL. Distinct
   *  from missingProject so the renderer can word the note accurately. */
  notSyncedYet?: boolean;
  /** Portable reference to the model this conversation last ran a turn with —
   *  read straight off the Conversation Store record (Task 4 writes it via
   *  noteModelUsed). Absent for legacy-only rows and for a store record no
   *  turn has landed on yet. Task 6 uses it to pre-fill the resume selector. */
  lastUsedModel?: PortableModelRef;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// Phase 3c: per-entry config schema for marketplace packages. Entries
// that declare configSchema get a settings form in the detail view.
// Anthropic plugins using their own native config.json are left alone.
export interface ConfigField {
  name: string;
  type: 'string' | 'boolean' | 'number' | 'select';
  label: string;
  description?: string;
  default?: string | boolean | number;
  required?: boolean;
  options?: { value: string; label: string }[]; // for 'select' type
}

export interface ConfigSchema {
  fields: ConfigField[];
}

// Decomposition v3 §9.9: what SkillDetail needs to render integration badges.
// Populated by skill-provider.getIntegrationInfo() which reads the plugin's
// own plugin.json (if installed) or the marketplace entry (if not).
export interface IntegrationInfo {
  // Capabilities the package says it needs (with fallback behavior)
  optionalIntegrations: Array<{
    capability: string;
    installed: boolean;                 // does any installed plugin provide this?
    providerPackageId?: string;         // which one, if installed
    whenAvailable?: string;
    whenUnavailable?: string;
  }>;
  // Capabilities the package itself provides
  provides: Array<{ capability: string; description: string; skill: string }>;
}

// IPC channel names
export const IPC = {
  // Renderer -> Main
  SESSION_CREATE: 'session:create',
  SESSION_DESTROY: 'session:destroy',
  SESSION_INPUT: 'session:input',
  SESSION_RESIZE: 'session:resize',
  SESSION_LIST: 'session:list',
  SESSION_SWITCH: 'session:switch',
  SKILLS_LIST: 'skills:list',
  COMMANDS_LIST: 'commands:list',
  SKILLS_LIST_MARKETPLACE: 'skills:list-marketplace',
  SKILLS_GET_DETAIL: 'skills:get-detail',
  SKILLS_SEARCH: 'skills:search',
  SKILLS_INSTALL: 'skills:install',
  SKILLS_UNINSTALL: 'skills:uninstall',
  SKILLS_GET_FAVORITES: 'skills:get-favorites',
  SKILLS_SET_FAVORITE: 'skills:set-favorite',
  SKILLS_GET_CHIPS: 'skills:get-chips',
  SKILLS_SET_CHIPS: 'skills:set-chips',
  SKILLS_GET_OVERRIDE: 'skills:get-override',
  SKILLS_SET_OVERRIDE: 'skills:set-override',
  SKILLS_CREATE_PROMPT: 'skills:create-prompt',
  SKILLS_DELETE_PROMPT: 'skills:delete-prompt',
  SKILLS_PUBLISH: 'skills:publish',
  SKILLS_GET_SHARE_LINK: 'skills:get-share-link',
  SKILLS_IMPORT_FROM_LINK: 'skills:import-from-link',
  SKILLS_GET_CURATED_DEFAULTS: 'skills:get-curated-defaults',
  // Marketplace redesign Phase 1: featured (hero/rails) for the redesigned
  // discovery UI.
  SKILLS_GET_FEATURED: 'skills:get-featured',
  // Marketplace redesign Phase 3: integrations as a first-class content kind.
  INTEGRATIONS_LIST: 'integrations:list',
  INTEGRATIONS_INSTALL: 'integrations:install',
  INTEGRATIONS_UNINSTALL: 'integrations:uninstall',
  INTEGRATIONS_STATUS: 'integrations:status',
  INTEGRATIONS_CONFIGURE: 'integrations:configure',
  // Re-runs postInstallCommand for an already-installed integration; used
  // by the detail overlay's Connect button when state is installed-but-not-
  // connected (e.g. OAuth expired).
  INTEGRATIONS_CONNECT: 'integrations:connect',
  // Static-per-session lookup — returns 'darwin' | 'win32' | 'linux' | 'android'.
  // Used by the integration cards to gate UI by platform before the user
  // clicks (backend integration-installer.ts also re-checks).
  PLATFORM_GET: 'platform:get',
  // Decomposition v3 §9.9: used by SkillDetail to render integration badges
  SKILLS_GET_INTEGRATION_INFO: 'skills:get-integration-info',
  // Decomposition v3 §9.10: onboarding bulk install + output-style apply
  SKILLS_INSTALL_MANY: 'skills:install-many',
  SKILLS_APPLY_OUTPUT_STYLE: 'skills:apply-output-style',
  TERMINAL_READY: 'session:terminal-ready',
  // Main -> Renderer
  SESSION_CREATED: 'session:created',
  SESSION_DESTROYED: 'session:destroyed',
  // Plan 2b Task 8: pushed to the renderer + remote when another device took over
  // a conversation this device held — the holder-side takeover ends the local
  // session and the UI shows a "moved to <device>" banner.
  SESSION_MOVED: 'session:moved',
  PTY_OUTPUT: 'pty:output',
  HOOK_EVENT: 'hook:event',
  SESSION_RENAMED: 'session:renamed',
  DIALOG_OPEN_FILE: 'dialog:open-file',
  DIALOG_OPEN_FOLDER: 'dialog:open-folder',
  DIALOG_OPEN_SOUND: 'dialog:open-sound',
  CLIPBOARD_SAVE_IMAGE: 'clipboard:save-image',
  STATUS_DATA: 'status:data',
  READ_TRANSCRIPT_META: 'transcript:read-meta',
  OPEN_CHANGELOG: 'shell:open-changelog',
  UPDATE_CHANGELOG: 'update:changelog',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_CANCEL: 'update:cancel',
  UPDATE_LAUNCH: 'update:launch',
  UPDATE_PROGRESS: 'update:progress',
  UPDATE_GET_CACHED_DOWNLOAD: 'update:get-cached-download',
  OPEN_EXTERNAL: 'shell:open-external',
  SHOW_ITEM_IN_FOLDER: 'shell:show-item-in-folder',
  // Open a local file with the OS default app (HTML→browser, .docx→Word, etc.).
  // Desktop-only: Android has no desktop shell; remote-shim no-ops it.
  OPEN_PATH: 'shell:open-path',
  PERMISSION_RESPOND: 'permission:respond',
  // Remote settings
  REMOTE_GET_CONFIG: 'remote:get-config',
  REMOTE_SET_PASSWORD: 'remote:set-password',
  REMOTE_SET_CONFIG: 'remote:set-config',
  REMOTE_DETECT_TAILSCALE: 'remote:detect-tailscale',
  REMOTE_GET_CLIENT_COUNT: 'remote:get-client-count',
  REMOTE_GET_CLIENT_LIST: 'remote:get-client-list',
  REMOTE_DISCONNECT_CLIENT: 'remote:disconnect-client',
  REMOTE_INSTALL_TAILSCALE: 'remote:install-tailscale',
  REMOTE_AUTH_TAILSCALE: 'remote:auth-tailscale',
  UI_ACTION_BROADCAST: 'ui:action:broadcast',
  UI_ACTION_RECEIVED: 'ui:action:received',
  TRANSCRIPT_EVENT: 'transcript:event',
  // JSONL truncation — fired on /clear or /compact rewrite. App uses to
  // detect /compact completion (see slash-command-dispatcher).
  TRANSCRIPT_SHRINK: 'transcript:shrink',
  // Session browser
  SESSION_BROWSE: 'session:browse',
  SESSION_HISTORY: 'session:history',
  // Mark/unmark a session flag (complete, priority, helpful, …)
  SESSION_SET_FLAG: 'session:set-flag',
  // Broadcast when session metadata changes (carries a flag + value)
  SESSION_META_CHANGED: 'session:meta-changed',
  // Custom session tags (registry CRUD + application) and per-session notes.
  SESSION_SET_TAG: 'session:set-tag',   // (sessionId, tagId, value)
  SESSION_SET_NOTE: 'session:set-note', // (sessionId, note)
  SESSION_GET_META: 'session:get-meta', // (sessionId) → { tags, note, supported }
  TAGS_LIST: 'tags:list',
  TAGS_CREATE: 'tags:create',           // (label, color)
  TAGS_UPDATE: 'tags:update',           // (id, { label?, color?, archived? })
  TAGS_DELETE: 'tags:delete',           // (id)
  TAGS_CHANGED: 'tags:changed',         // push: registry mutated
  // Folder switcher
  FOLDERS_LIST: 'folders:list',
  FOLDERS_ADD: 'folders:add',
  FOLDERS_REMOVE: 'folders:remove',
  FOLDERS_RENAME: 'folders:rename',
  // Theme system
  THEME_RELOAD: 'theme:reload',   // Main -> Renderer: a theme file changed
  THEME_LIST: 'theme:list',       // Renderer -> Main: get list of user theme slugs
  THEME_READ_FILE: 'theme:read-file', // Renderer -> Main: read a user theme JSON by slug
  THEME_WRITE_FILE: 'theme:write-file',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_SET_ICON: 'window:set-icon', // theme-driven window + dock icon hot-swap
  // Repositions macOS traffic lights so they sit inside the floating chrome's
  // rounded header; null restores OS default. Called from theme-engine.
  WINDOW_SET_TRAFFIC_LIGHT_POS: 'window:set-traffic-light-pos',
  // Zoom controls
  ZOOM_IN: 'zoom:in',
  ZOOM_OUT: 'zoom:out',
  ZOOM_RESET: 'zoom:reset',
  ZOOM_GET: 'zoom:get',
  // Theme marketplace
  THEME_MARKETPLACE_LIST: 'theme-marketplace:list',
  THEME_MARKETPLACE_DETAIL: 'theme-marketplace:detail',
  THEME_MARKETPLACE_INSTALL: 'theme-marketplace:install',
  THEME_MARKETPLACE_UNINSTALL: 'theme-marketplace:uninstall',
  THEME_MARKETPLACE_UPDATE: 'theme-marketplace:update',
  THEME_MARKETPLACE_PUBLISH: 'theme-marketplace:publish',
  THEME_MARKETPLACE_GENERATE_PREVIEW: 'theme-marketplace:generate-preview',
  THEME_MARKETPLACE_RESOLVE_PUBLISH_STATE: 'theme-marketplace:resolve-publish-state',
  THEME_MARKETPLACE_REFRESH_REGISTRY: 'theme-marketplace:refresh-registry',
  // Unified marketplace — packages + update + config (Phase 3)
  MARKETPLACE_GET_PACKAGES: 'marketplace:get-packages',
  SKILLS_UPDATE: 'skills:update',
  MARKETPLACE_GET_CONFIG: 'marketplace:get-config',
  MARKETPLACE_SET_CONFIG: 'marketplace:set-config',
  // Phase 4 — force-refresh the featured/index caches without waiting for
  // the 24h TTL. Useful right after /feature curation lands.
  MARKETPLACE_INVALIDATE_CACHE: 'marketplace:invalidate-cache',
  // In-app file viewer — reads a plugin's SKILL.md / command / agent markdown.
  // Tries the local install dir first, falls back to a raw GitHub URL derived
  // from the marketplace entry's sourceType/sourceRef.
  MARKETPLACE_READ_COMPONENT: 'marketplace:read-component',
  // First-run
  FIRST_RUN_STATE: 'first-run:state',
  FIRST_RUN_RETRY: 'first-run:retry',
  FIRST_RUN_START_AUTH: 'first-run:start-auth',
  FIRST_RUN_SUBMIT_API_KEY: 'first-run:submit-api-key',
  FIRST_RUN_DEV_MODE_DONE: 'first-run:dev-mode-done',
  FIRST_RUN_SKIP: 'first-run:skip',
  // Sync management
  SYNC_GET_STATUS: 'sync:get-status',
  SYNC_GET_CONFIG: 'sync:get-config',
  SYNC_SET_CONFIG: 'sync:set-config',
  SYNC_FORCE: 'sync:force',
  SYNC_GET_LOG: 'sync:get-log',
  SYNC_DISMISS_WARNING: 'sync:dismiss-warning',
  // Cross-device sync spaces (spec 2026-07-03) — distinct from the legacy sync:* above
  SYNC_SPACES_STATUS: 'syncspaces:status',
  SYNC_SPACES_ENABLE: 'syncspaces:enable',
  SYNC_SPACES_SYNC_NOW: 'syncspaces:sync-now',
  SYNC_SPACES_CREATE_PROJECT: 'syncspaces:create-project',
  SYNC_SPACES_IMPORT_PROJECT: 'syncspaces:import-project',
  SYNC_SPACES_RENAME_PROJECT: 'syncspaces:rename-project',
  SYNC_SPACES_STOP_PROJECT: 'syncspaces:stop-project',
  // Conversation-lease takeover (Plan 2b Task 9). query = who holds this session;
  // takeover = ask-hand-off-then-poll-and-acquire; force = overwrite a stale lease.
  SYNC_SPACES_LEASE_QUERY: 'syncspaces:lease-query',
  SYNC_SPACES_LEASE_TAKEOVER: 'syncspaces:lease-takeover',
  SYNC_SPACES_LEASE_FORCE: 'syncspaces:lease-force',
  // Device registry (Plan 2b spec §10a) — the "Your devices" list + rename.
  SYNC_SPACES_LIST_DEVICES: 'syncspaces:list-devices',
  SYNC_SPACES_RENAME_DEVICE: 'syncspaces:rename-device',
  SYNC_SPACES_REMOVE_DEVICE: 'syncspaces:remove-device',
  SYNC_SPACES_EVENT: 'syncspaces:event',
  // Connect-GitHub modal (device-flow auth) — lets non-developers connect GitHub
  // in-app so enabling Sync never dead-ends on "gh not installed / not signed in".
  // status/install are plain request-response; connect-start kicks off main-side
  // device-flow polling and pushes GITHUB_CONNECT_DONE when it settles.
  GITHUB_STATUS: 'github:status',
  GITHUB_CONNECT_START: 'github:connect-start',
  GITHUB_CONNECT_CANCEL: 'github:connect-cancel',
  GITHUB_INSTALL_GH: 'github:install-gh',
  GITHUB_DISCONNECT: 'github:disconnect', // clears the app's stored token (Connected accounts)
  GITHUB_CONNECT_DONE: 'github:connect-done', // push: {ok, login?, error?}
  // Multi-window detach subsystem (Renderer <-> Main)
  WINDOW_GET_ID: 'window:get-id',
  WINDOW_DIRECTORY_UPDATED: 'window:directory-updated',
  WINDOW_GET_DIRECTORY: 'window:get-directory',
  WINDOW_LEADER_CHANGED: 'window:leader-changed',
  WINDOW_OPEN_DETACHED: 'window:open-detached',
  WINDOW_FOCUS_AND_SWITCH: 'window:focus-and-switch',
  SESSION_OWNERSHIP_ACQUIRED: 'session:ownership-acquired',
  SESSION_OWNERSHIP_LOST: 'session:ownership-lost',
  SESSION_DETACH_START: 'session:detach-start',
  // Chrome-style live tear-off: spawn the peer window mid-drag (before pointerup)
  // once the pill has moved far enough from the header. Source window then
  // streams cursor positions via SESSION_DRAG_WINDOW_MOVE so the new window
  // tracks the cursor until the user releases.
  SESSION_DETACH_LIVE: 'session:detach-live',
  SESSION_DRAG_WINDOW_MOVE: 'session:drag-window-move',
  SESSION_DRAG_STARTED: 'session:drag-started',
  SESSION_DRAG_ENDED: 'session:drag-ended',
  SESSION_DRAG_DROPPED: 'session:drag-dropped',
  SESSION_DROP_RESOLVE: 'session:drop-resolve',
  CROSS_WINDOW_CURSOR: 'session:cross-window-cursor',
  // Request the full transcript history for a session — used when a window
  // acquires ownership and needs to hydrate its reducer from disk.
  TRANSCRIPT_REPLAY: 'transcript:replay-from-start',
  // Appearance sync across peer windows — Renderer → Main broadcasts, Main
  // → other Renderers applies without re-broadcasting. Lets a theme change
  // in window 2 propagate to window 1 without a reload.
  APPEARANCE_BROADCAST: 'appearance:broadcast',
  APPEARANCE_SYNC: 'appearance:sync',
  APPEARANCE_GET_FAVORITE_THEMES: 'appearance:get-favorite-themes',
  APPEARANCE_FAVORITE_THEME: 'appearance:favorite-theme',
  // Buddy floater (desktop-only MVP)
  BUDDY_SHOW: 'buddy:show',
  BUDDY_HIDE: 'buddy:hide',
  BUDDY_TOGGLE_CHAT: 'buddy:toggle-chat',
  BUDDY_SET_SESSION: 'buddy:set-session',
  BUDDY_SUBSCRIBE: 'buddy:subscribe',
  BUDDY_UNSUBSCRIBE: 'buddy:unsubscribe',
  BUDDY_GET_VIEWED_SESSION: 'buddy:get-viewed-session',
  // Renderer → main drag events. Fire-and-forget because drag generates
  // ~60 events/sec while the pointer moves; invoke() round-trips would
  // starve the renderer's event loop. Main clamps and calls setPosition.
  BUDDY_MOVE_MASCOT: 'buddy:move-mascot',
  // Capture the desktop with buddy windows excluded, write to a temp PNG,
  // and push the file path to the chat renderer on BUDDY_ATTACH_FILE.
  // Invoked from the capture-icon renderer; main does the hide/capture/
  // restore sequence because the renderer can't hide Electron windows.
  BUDDY_CAPTURE_DESKTOP: 'buddy:capture-desktop',
  // Main → chat-renderer push. Chat renderer's InputBar listens and adds
  // the file as an attachment (same pipeline as clipboard-image paste).
  BUDDY_ATTACH_FILE: 'buddy:attach-file',
  // ── Buddy upgrades (action bar, dismiss, dock/peek) ──
  // Fire-and-forget: mascot + bar renderers report pointer enter/leave; main
  // coalesces with a grace timeout to decide bar visibility.
  // Fire-and-forget: mascot renderer signals drag release so main can run
  // edge-snap detection against the window's final bounds.
  BUDDY_DRAG_ENDED: 'buddy:drag-ended',
  // Restore + focus the main window and switch it to the buddy's viewed session.
  BUDDY_OPEN_MAIN: 'buddy:open-main',
  // Hide the buddy for this app run only (preference stays enabled).
  BUDDY_DISMISS: 'buddy:dismiss',
  BUDDY_GET_STATUS: 'buddy:get-status',
  // Main → all windows: { dismissed, visible } so open Settings panels update live.
  BUDDY_STATUS_CHANGED: 'buddy:status-changed',
  // Main → bar renderer: fade the action bar in/out (window stays shown; CSS animates).
  BUDDY_BAR_STATE: 'buddy:bar-state',
  // Main → mascot renderer: dock/peek state for the sink animation + peek pose.
  BUDDY_MASCOT_STATE: 'buddy:mascot-state',
  // Main → chat renderer: entrance/exit animation cue around show/hide.
  BUDDY_CHAT_STATE: 'buddy:chat-state',
  // Linux Wayland overlay (Task 3+): main → overlay renderer, sent once on
  // did-finish-load with window-local workArea/mascot/dock (BuddyOverlayManager's
  // overlayInitPayload). External toggle-chat push for the same overlay
  // window. The rest of the overlay IPC surface (renderer→main channels,
  // BuddyApi, preload wiring) lands in the next commit (Task 4) — these two
  // are added now only so this commit's manager code type-checks.
  BUDDY_OVERLAY_READY: 'buddy:overlay-ready',
  BUDDY_OVERLAY_TOGGLE_CHAT: 'buddy:overlay-toggle-chat',
  // Task 4: renderer → main, fire-and-forget. Hover-hot path (mousemove over
  // the mascot/bar/chat toggles hit-testing many times/sec) so this is `send`,
  // not `invoke` — same reasoning as BUDDY_MOVE_MASCOT above.
  BUDDY_OVERLAY_SET_INTERACTIVE: 'buddy:overlay-set-interactive',
  // Task 4: renderer → main, fire-and-forget. Renderer owns drag/dock state
  // (DOM-side for the overlay model) and pushes the final position here to
  // persist — main never computes it, just writes it to BUDDY_POS_FILE.
  BUDDY_OVERLAY_PERSIST: 'buddy:overlay-persist',
  // Task 8: renderer → main, invoke/handle (unlike the fire-and-forget
  // overlay channels above — this one returns a result, and toggling is
  // rare/user-driven, not a hover-hot path). Settings' keep-above toggle:
  // persists to BUDDY_POS_FILE and runs the KWin script live.
  BUDDY_OVERLAY_KEEP_ABOVE: 'buddy:overlay-keep-above',
  // Main → main window: switch active session (sent by buddy:open-main).
  SESSION_FOCUS_REQUEST: 'session:focus-request',
  SESSION_ATTENTION_SUMMARY: 'session:attention-summary',
  ATTENTION_REPORT: 'attention:report',
  // Settings → Development feature (bug report, contribute, known issues)
  DEV_LOG_TAIL: 'dev:log-tail',
  DEV_DIAGNOSTICS: 'dev:diagnostics',
  DEV_SUMMARIZE_ISSUE: 'dev:summarize-issue',
  DEV_SUBMIT_ISSUE: 'dev:submit-issue',
  DEV_INSTALL_WORKSPACE: 'dev:install-workspace',
  DEV_INSTALL_PROGRESS: 'dev:install-progress',
  DEV_OPEN_SESSION_IN: 'dev:open-session-in',
  // Performance / GPU settings — not app:restart because future restart-required
  // settings (e.g. renderer process changes) can reuse the same generic channel.
  PERFORMANCE_GET_CONFIG: 'performance:get-config',
  PERFORMANCE_SET_CONFIG: 'performance:set-config',
  APP_RESTART: 'app:restart',
  // System namespace — hardware back button bridge (Android only)
  SYSTEM_NOTIFY_STACK_STATE: 'system:notify-stack-state',
  SYSTEM_BACK: 'system:back',
  // ---- Native runtime (YouCoded first-party harness — platform roadmap Phase 1+) ----
  // Capability probe: false everywhere until Phase 1 ships the engine.
  NATIVE_SUPPORTED: 'native:supported',
  // ---- Native runtime Plan A (Phase 1): session I/O + provider management ----
  NATIVE_SEND: 'native:send',
  // Task 11: cancel/edit a queued-but-not-yet-sent message. invoke →
  // NativeSessionHost.removeQueued(sessionId, queueId): boolean.
  NATIVE_QUEUE_REMOVE: 'native:queue-remove',
  NATIVE_INTERRUPT: 'native:interrupt',
  // M3 item 2 — user-initiated /compact for a native session. invoke (not send):
  // the caller needs the {ok, reason} result to explain a refusal.
  NATIVE_COMPACT: 'native:compact',
  // M3 item 2 — /clear as a context barrier. invoke: the caller needs {ok, reason}.
  NATIVE_CLEAR: 'native:clear',
  NATIVE_INVOKE_SKILL: 'native:invoke-skill',
  NATIVE_SET_BINDING: 'native:set-binding',
  NATIVE_SET_PERMISSION_MODE: 'native:set-permission-mode',
  // Read the session's current native permission mode. Seeds the StatusBar chip
  // on create/resume so a fresh Coder session shows AUTO EDIT (not the default ASK).
  NATIVE_GET_PERMISSION_MODE: 'native:get-permission-mode',
  NATIVE_SESSIONS_LIST: 'native:sessions-list',
  PROVIDER_LIST: 'provider:list',
  PROVIDER_UPSERT: 'provider:upsert',
  PROVIDER_REMOVE: 'provider:remove',
  PROVIDER_TEST: 'provider:test',
  PROVIDER_SET_KEY: 'provider:set-key',
  PROVIDER_CATALOG: 'provider:catalog',
  // ---- WebSearch providers (Phase 2 Plan B): keyed Tavily/Exa upgrades ----
  // list = the fixed upgradeable-backend rows (hasKey flags); set/remove-key
  // manage the encrypted key; test = never-throws connectivity check.
  SEARCH_LIST: 'search:list',
  SEARCH_SET_KEY: 'search:set-key',
  SEARCH_REMOVE_KEY: 'search:remove-key',
  SEARCH_TEST: 'search:test',
  // ---- Native runtime Plan B (Phase 1): local llama.cpp engine ----
  ENGINE_STATUS: 'engine:status',
  ENGINE_INSTALL: 'engine:install',
  ENGINE_RESTART: 'engine:restart',
  // Push events (no id): install progress + run-state transitions.
  ENGINE_INSTALL_PROGRESS: 'engine:install-progress',
  ENGINE_STATUS_CHANGED: 'engine:status-changed',
  // ---- Native runtime Plan C (Phase 1): model manager ----
  ENGINE_SET_BACKEND: 'engine:set-backend',
  ENGINE_SET_CONTEXT: 'engine:set-context',   // context-length knob (Task 9)
  MODELS_CURATED: 'models:curated',
  MODELS_SEARCH: 'models:search',
  MODELS_QUANTS: 'models:quants',
  MODELS_DOWNLOAD: 'models:download',
  MODELS_DOWNLOAD_CANCEL: 'models:download-cancel',
  MODELS_DOWNLOAD_PROGRESS: 'models:download-progress',  // push
  MODELS_DELETE: 'models:delete',
  MODELS_INSTALLED: 'models:installed',
  // Orphaned .partial scan (2026-07-15) — invoke → OrphanedPartial[]; lists
  // .partial files left by a PREVIOUS app run so the UI can clean/resume them.
  MODELS_ORPHANED_PARTIALS: 'models:orphaned-partials',
  ENDPOINTS_DETECT: 'endpoints:detect',
  // ---- Model memory lifecycle (2026-07-14): per-model residency + guards ----
  ENGINE_MODELS: 'engine:models',                 // invoke → EngineModel[] with live state
  ENGINE_MODELS_CHANGED: 'engine:models-changed', // push → EngineModel[] on any state change
  NATIVE_MODEL_STATE: 'native:model-state',       // push → per-session bound-model state
  MODELS_MEMORY_CHECK: 'models:memory-check',     // invoke(modelId) → MemoryVerdict
  MODELS_LOAD: 'models:load',                     // invoke(modelId) → true ([Reload Model])
} as const;

// Performance / GPU configuration snapshot — returned by performance:get-config.
// multiGpuDetected: false means the Performance section in Settings is hidden.
export interface PerformanceConfigSnapshot {
  preferPowerSaving: boolean;
  appliedAtLaunch: boolean;
  multiGpuDetected: boolean;
  gpuList: string[];
}

// --- Window registry / detach types ---

export interface WindowInfo {
  id: number;           // BrowserWindow webContentsId
  label: string;        // e.g. "window 2" (creation order)
  createdAt: number;
}

export interface WindowDirectoryEntry {
  window: WindowInfo;
  sessions: SessionInfo[];
}

export interface WindowDirectory {
  leaderWindowId: number;
  windows: WindowDirectoryEntry[];
}

export interface SessionOwnershipAcquired {
  sessionId: string;
  sessionInfo: SessionInfo;
  /** True when the window was just created for this session (skip replay delay UI). */
  freshWindow: boolean;
}

export interface SessionOwnershipLost {
  sessionId: string;
}

export interface DetachStartPayload {
  sessionId: string;
  screenX: number;
  screenY: number;
}

export interface DragDroppedPayload {
  sessionId: string;
  targetWindowId: number;
  insertIndex: number;
}

export interface CrossWindowCursor {
  screenX: number;
  screenY: number;
}

// Discriminator for development-flow IPC payloads.
export type DevIssueKind = 'bug' | 'feature';
