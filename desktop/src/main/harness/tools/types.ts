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
  /** per-session todo list (TodoWrite state) */
  todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }>;
  /** Injected runtime services (e.g. WebSearch's SearchService). Absent for tools
   *  that need none; a tool depending on one must handle its absence as a config error. */
  services?: ToolServices;
}

export interface ToolResultPayload {
  /** What the model sees (post-truncation). */
  text: string;
  isError?: boolean;
  /** Edit/Write attach jsdiff hunks so the existing diff card renders. */
  structuredPatch?: StructuredPatchHunk[];
}

export interface NativeTool<A = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<A>;
  /** The permission SUBJECT for rule matching: Bash → command string; file
   *  tools → the file path; undefined → tool-name-only matching. */
  permissionSubject(args: A): string | undefined;
  /** Interactive tools (AskUserQuestion) are routed by the DRIVER straight to
   *  askUser() — guards/decide are skipped (asking permission to ask a question
   *  is absurd) and execute() never runs. */
  interactive?: boolean;
  execute(args: A, ctx: ToolContext): Promise<ToolResultPayload>;
}
