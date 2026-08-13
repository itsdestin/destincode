// Task — delegate one focused piece of work to a specialist subagent, which
// works independently and reports back once (spec §1/§5, plan 1a). This is
// the MODEL-FACING half of NativeSessionHost.createChild (Task 5): it
// resolves the requested specialist, enforces the weak-model prompt floor,
// checks the per-parent slot + single-writer invariants, and only THEN hands
// the spawn to the host via ToolServices.specialists (native-session-host.ts's
// toolWiring — the same injection pattern WebSearch's SearchService uses).
// The host-side run loop that actually drives the child turn (runSpecialist)
// is Task 7 — this file only ever gets as far as calling services.spawn().
//
// Only ever attached when profile.canDelegate is true AND the session is not
// itself a specialist child (harness-session.ts's syncTaskTool) — delegation
// depth is capped at 1 by construction (two independent gates), never by
// convention.
import { z } from 'zod';
import { defineTool } from './registry';
import type { NativeTool, ToolContext, ToolResultPayload } from './types';
import { resolveSpecialist, listSpecialists } from '../specialists/registry';
import { HOSTED_MAX_CONCURRENT_SPECIALISTS, SPECIALIST_SPAWN_BUDGET_PER_SESSION } from '../specialists/limits';

// Minimal weak-model hardening (plan 1a): a specialist has NO access to the
// parent conversation, so a one-line prompt like "do the thing" leaves it to
// guess the entire brief. This is a floor, not a quality bar — the full pass
// (rubric-checked briefs) is plan 1b.
const MIN_PROMPT_LENGTH = 40;

// Task 12, item 2 (plan 1b, spec §3): reject placeholder prompts — TODO, "task
// 1", unexpanded template markers. This is layered ON TOP of the 40-char floor
// above, not instead of it: a bare "todo"/"tbd"/"fixme" is already caught by
// the floor, but a PADDED marker like "{{TASK_DESCRIPTION_GOES_HERE_PLEASE_FILL}}"
// clears 40 chars while still being nothing but an unexpanded template — an
// observed weak-model failure mode (platform research), not speculation.
// Deliberately NARROW and tested against the WHOLE TRIMMED PROMPT ONLY (never
// per-line) — external review 2026-08-12 flagged the false-positive risk of a
// per-line variant, which would catch a real multi-line brief that happens to
// contain a "TODO:" note among real content. See task-tool.test.ts's pinned
// ~45-char real-sentence boundary test.
const PLACEHOLDER_RE = /^(?:todo|tbd|task ?\d*|fixme|<[^>]*>|\{\{[^}]*\}\}|\.{3}|xxx+)[.!]?$/i;

const schema = z.object({
  description: z.string().describe('A short (3-6 word) label for this delegated task, shown in the launch card (e.g. "Find the auth bug").'),
  prompt: z.string().describe(
    'The complete, self-contained brief for the specialist. It has NO access to this conversation — '
    + 'include everything it needs: what to do, relevant file paths, and what "done" looks like.',
  ),
  agent: z.string().describe(`Which specialist to run. One of: ${listSpecialists().map((s) => s.id).join(', ')}.`),
  work_dir: z.string().describe(
    'The directory the specialist works in — usually the project root you are working in. '
    + 'Passing a subdirectory narrows what the specialist can read (and, for a read-write specialist, edit).',
  ),
});

type TaskArgs = z.infer<typeof schema>;

// This enumeration doubles as the 1a consent copy: it is the text a user sees
// when the envelope ask fires (permissionSubject below), since the pretty
// launch card is plan 1c. Snapshotted once — the built-in roster is static.
function describeSpecialists(): string {
  return listSpecialists()
    .map((s) => `- ${s.id} (${s.charter === 'read-write' ? 'can edit files' : 'read-only'}): ${s.description}`)
    .join('\n');
}

// Codex's orchestration-doctrine line: a specialist cannot ask a follow-up
// question (child-ask-policy.ts answers every ask as a decline), so the
// caller must front-load everything into one brief.
const DOCTRINE = 'Specialists work independently and report back once; give each specialist a complete, self-contained brief — they cannot ask you a follow-up question.';

export function createTaskTool(): NativeTool<TaskArgs> {
  return defineTool<TaskArgs>({
    name: 'Task',
    description:
      'Delegate one focused piece of work to a specialist subagent. The specialist works independently '
      + "and reports back when it's done. Available specialists:\n"
      + describeSpecialists() + '\n\n' + DOCTRINE,
    // Simplified presentation (small local models): ids + charter only, no
    // per-role descriptions — mirrors skill.ts's shortDescription trim.
    shortDescription:
      'Delegate a focused task to a specialist subagent. Specialists: '
      + listSpecialists().map((s) => `${s.id} (${s.charter === 'read-write' ? 'can edit files' : 'read-only'})`).join(', '),
    inputSchema: schema,
    // The envelope ask's subject (spec §1a/§5) — CHARTER-SCOPED (Fix 4, review
    // round 1): `${charter}:${work_dir}`, e.g. "read-only:/home/x/proj". Before
    // this the subject was the bare work_dir, so a remembered "Always allow" for
    // a read-only explorer at a path silently pre-approved a future read-write
    // worker at the SAME path too — the charter is the unit of envelope consent
    // (spec §5), so a standing grant must never cross charters. Unknown agent
    // name falls back to the bare work_dir: execute() above already refuses an
    // unknown specialist before ever spawning, so this text is only ever shown
    // on an ask that is about to be declined anyway, never a real standing grant.
    permissionSubject: (a) => {
      const specialist = resolveSpecialist(a.agent);
      return specialist ? `${specialist.charter}:${a.work_dir}` : a.work_dir;
    },
    moreHint: 'narrow the brief, pick a different specialist, or split the work across more than one Task call',
    async execute(args, ctx: ToolContext): Promise<ToolResultPayload> {
      const specialist = resolveSpecialist(args.agent);
      if (!specialist) {
        const available = listSpecialists().map((s) => s.id).join(', ');
        return { text: `Unknown specialist "${args.agent}". Available specialists: ${available}.`, isError: true };
      }

      const trimmedPrompt = args.prompt.trim();
      if (trimmedPrompt.length < MIN_PROMPT_LENGTH) {
        return {
          text: `That prompt is too short to be a self-contained brief (needs at least ${MIN_PROMPT_LENGTH} characters). `
            + 'The specialist has no access to this conversation — include what to do, relevant file paths, and what "done" looks like.',
          isError: true,
        };
      }

      if (PLACEHOLDER_RE.test(trimmedPrompt)) {
        return {
          text: 'That prompt looks like an unexpanded placeholder. Write the actual self-contained brief: '
            + 'what to do, relevant paths, what "done" looks like.',
          isError: true,
        };
      }

      const services = ctx.services?.specialists;
      if (!services) {
        // A configuration gap (Task attached but its host callbacks were not
        // wired), never a model mistake — say so plainly rather than guessing.
        return { text: 'Task failed: no specialist services are wired for this session (configuration error).', isError: true };
      }

      const parentId = ctx.sessionId;

      // Single-writer check FIRST (no side effects) — only a read-write
      // charter can conflict, so read-only specialists skip it entirely.
      if (specialist.charter === 'read-write' && services.isWriterBusy(parentId)) {
        return {
          text: 'Refused: another specialist with write access is running under this session. '
            + 'Wait for it to finish, or delegate to a read-only specialist (e.g. explorer, researcher, reviewer) instead.',
          isError: true,
        };
      }

      // Per-conversation spawn budget (Task 12, item 3): a LIFETIME cap,
      // distinct from the concurrency slot below — checked BEFORE reserving a
      // slot so a budget refusal never needs to release one. A runaway-loop
      // backstop for a model that keeps delegating without end, not a normal
      // capacity limit; the user's fix is a fresh conversation, not "wait".
      if (!services.trySpendSpawnBudget(parentId)) {
        return {
          text: `Refused: this conversation has reached its specialist budget (${SPECIALIST_SPAWN_BUDGET_PER_SESSION}). `
            + 'This is a runaway guard — the user can start a fresh conversation to continue delegating.',
          isError: true,
        };
      }

      if (!services.tryReserveSlot(parentId)) {
        return {
          // Fix: the parenthetical was closing before "concurrent specialists",
          // reading as "(max 3) concurrent specialists" instead of qualifying
          // the whole noun phrase — "at capacity (max 3 concurrent specialists)".
          text: `Refused: this session is at capacity (max ${HOSTED_MAX_CONCURRENT_SPECIALISTS} concurrent specialists). `
            + 'Wait for one of the running specialists to finish before starting another.',
          isError: true,
        };
      }

      try {
        const { report } = await services.spawn(parentId, {
          specialist,
          prompt: args.prompt,
          workDir: args.work_dir,
          parentToolCallId: ctx.toolCallId ?? '',
        });
        return { text: report };
      } catch (err: any) {
        // Every failure path must resolve a tool result — never a dangling
        // call. err.message is expected to already name the child id when one
        // was minted (native-session-host.ts's spawnSpecialist crafts it that
        // way), so this stays a plain relay rather than a second guess at cause.
        return { text: `The ${specialist.displayName} specialist failed: ${err?.message ?? String(err)}`, isError: true };
      } finally {
        services.releaseSlot(parentId);
      }
    },
  });
}
