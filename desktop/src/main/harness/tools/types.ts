// Shared contracts for the native tool framework (spec §2.3). Every native tool
// implements NativeTool<A>; the driver (Task 9) owns validation + permission
// gating, and defineTool() (registry.ts) wraps execute with truncation + errors.
import type { z } from 'zod';
import type { StructuredPatchHunk } from '../../../shared/types';

// Runtime services injected into tools that need process-level collaborators
// (spec §3.2). WebSearch reads services.search — the chain-walking SearchService.
// Structural (not the concrete class) so tests inject fakes and the tool never
// imports the service implementation.
export interface ToolServices {
  search?: { search(query: string, signal: AbortSignal): Promise<{ results: Array<{ title: string; url: string; snippet?: string }>; source: string }> };
}

export interface ToolContext {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  /** read-before-edit registry: canonical path → mtimeMs at last Read. RESETS on resume (spec §2.5). */
  readRegistry: Map<string, number>;
  /** Scoped-persistence shell cwd: the directory the NEXT Bash call starts in.
   *  Absent → Bash falls back to `cwd` (stateless, the pre-2026-07-18 behavior),
   *  which is what test/one-off contexts get for free. */
  shellCwd?: string;
  /** Bash reports the post-command directory here when it resolved INSIDE `cwd`.
   *  The session owns the state; the tool never mutates ctx directly. */
  setShellCwd?(next: string): void;
  /** Opt-in env persistence (17/17 four-round harness reviews asked for this,
   *  2026-08-01 through 2026-08-09): the accumulated vars a `persistent_env: true`
   *  Bash call captured. Absent/empty → every call is a fresh shell env, which is
   *  still the default (Opus 5's dissent in the same review round: cwd should stay
   *  the only sticky thing UNLESS a call opts in). Mirrors shellCwd's pattern
   *  exactly — the session owns the state, the tool only reads/writes through the
   *  accessor below. */
  shellEnv?: Record<string, string>;
  /** Bash calls this after a persistent_env:true call to merge newly-captured vars
   *  (or drop ones the command unset) into the session's running set. */
  setShellEnv?(next: Record<string, string>): void;
  /** per-session todo list (TodoWrite state) */
  todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }>;
  /** Injected runtime services (e.g. WebSearch's SearchService). Absent for tools
   *  that need none; a tool depending on one must handle its absence as a config error. */
  services?: ToolServices;
}

/** What a tool omitted from its own result, and how to see more.
 *
 *  WHY this is structured instead of a string the tool writes itself: the single
 *  shared advice string in truncate.ts used to tell EVERY tool's caller to "use
 *  offset/limit" — advice that is correct for Read and meaningless for Bash and
 *  WebSearch, which have no such parameters. A tool now declares the FACT and the
 *  pipeline renders the prose, so a tool structurally cannot suggest a parameter
 *  it does not accept. See the 2026-08-01 multi-model harness review. */
export interface ResultBounds {
  /** Units actually represented in `text`. */
  shown: number;
  /** Units that exist. `null` = genuinely unknown, e.g. a walk that stopped early.
   *  Rendered as "at least N" — never as a number we did not measure. */
  total: number | null;
  unit: 'lines' | 'chars' | 'bytes' | 'files' | 'matches' | 'results';
  /** How to widen, in THIS tool's vocabulary: "| head -n 100", "offset=2390",
   *  "narrow the glob". The pipeline never supplies a default. */
  moreHint: string;
}

export interface ToolResultPayload {
  /** What the model sees (post-truncation). */
  text: string;
  isError?: boolean;
  /** Edit/Write attach jsdiff hunks so the existing diff card renders. */
  structuredPatch?: StructuredPatchHunk[];
  /** Declared by any tool that bounded its own output. Rendered by defineTool —
   *  never hand-written into `text`, or advice drifts from capability again. */
  bounds?: ResultBounds;
}

export interface NativeTool<A = any> {
  name: string;
  description: string;
  /** Compact one-line description used for SIMPLIFIED tool presentation on small
   *  local models (spec §4.2). When the resolved profile is 'simplified',
   *  buildAiTools() hands the model this instead of the full `description` to keep
   *  the tool schema small enough for a weak model to follow. Tools without one
   *  fall back to `description`. */
  shortDescription?: string;
  inputSchema: z.ZodType<A>;
  /** JSON Schema straight from an MCP server, when this tool came from one.
   *  buildAiTools() sends THIS to the model instead of translating inputSchema,
   *  because converting JSON Schema → zod is lossy and a lossy conversion that
   *  rejects a valid call would be a bug we invented. `inputSchema` stays
   *  required and permissive for MCP tools: it keeps the driver's single
   *  validation path (harness-session.ts safeParse) intact, and the SERVER is
   *  the authority on its own arguments. */
  rawInputSchema?: Record<string, unknown>;
  /** The permission SUBJECT for rule matching: Bash → command string; file
   *  tools → the file path; undefined → tool-name-only matching. */
  permissionSubject(args: A): string | undefined;
  /** Interactive tools (AskUserQuestion) are routed by the DRIVER straight to
   *  askUser() — guards/decide are skipped (asking permission to ask a question
   *  is absurd) and execute() never runs. */
  interactive?: boolean;
  /** How to widen THIS tool's output, in its own vocabulary — a static property,
   *  independent of whether the tool or the pipeline did the cutting.
   *
   *  WHY static (2026-08-06): `bounds.moreHint` only exists when the TOOL bounded its
   *  own output. The pipeline cap in defineTool is a separate event that fires on its
   *  own schedule — for content-mode Grep it is the common one — and without a hint to
   *  fall back on the model was told content vanished and given no way to get it back. */
  moreHint?: string;
  execute(args: A, ctx: ToolContext): Promise<ToolResultPayload>;
}
