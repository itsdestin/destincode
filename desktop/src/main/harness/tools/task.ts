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
import { resolveP, toPosix } from './guards';
import { resolveSpecialist, listSpecialists } from '../specialists/registry';
import { SPECIALIST_SPAWN_BUDGET_PER_SESSION } from '../specialists/limits';
import {
  resolveDelegatedBinding, resolveRequestedModel, DelegatedModelRefused, type DelegatedTier,
} from '../specialists/delegated-models';
import type { CatalogModel, ModelBinding } from '../../../shared/provider-types';

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

// Task 6 (spec §5, own-children-only) — verbatim per the plan, and reused
// EVERYWHERE a task_id turns out not to be this parent's own child: a foreign
// task_id and a nonexistent one must read identically, so the wording can
// never be used to probe for another session's child ids.
const REFUSED_NOT_OWN_CHILD = 'Refused: that task_id does not belong to a specialist of this session.';

// Task 6 — the writer-busy / at-capacity refusal copy, unchanged verbatim
// from plan 1a/1b, now shared by BOTH the new-spawn reservation (below) and
// the task_id resume reservation (a resumed child re-takes a slot exactly
// like a new spawn) — one function so the two paths cannot drift apart on
// wording.
function reservationRefusalText(reservation: { reason: 'writer-busy' } | { reason: 'at-capacity'; max: number }): string {
  if (reservation.reason === 'writer-busy') {
    return 'Refused: another specialist with write access is running under this session. '
      + 'Wait for it to finish, or delegate to a read-only specialist (e.g. explorer, researcher, reviewer) instead.';
  }
  // Task 13: reservation.max is the RESOLVED ceiling reserveSpecialist
  // actually enforced (a local session's engine-measured cap can be smaller
  // than the hosted constant) — never a hardcoded constant, per
  // error-message-standards.md ("must be specific and accurate").
  return `Refused: this session is at capacity (max ${reservation.max} concurrent specialists). `
    + 'Wait for one of the running specialists to finish before starting another.';
}

const schema = z.object({
  // Task 6: these four were unconditionally required through plan 1a/1b —
  // now optional because a task_id call (steer/resume/interrupt an EXISTING
  // specialist) needs none of them; execute() enforces "required unless
  // task_id is set" itself, below, with a typed refusal rather than a bare
  // schema-validation failure.
  description: z.string().optional().describe(
    'A short (3-6 word) label for this delegated task, shown in the launch card (e.g. "Find the auth bug"). '
    + 'Required when starting a new specialist; omit when managing one by task_id.',
  ),
  prompt: z.string().optional().describe(
    'Starting a new specialist: the complete, self-contained brief — it has NO access to this conversation, '
    + 'so include everything it needs: what to do, relevant file paths, and what "done" looks like. '
    + 'Managing one by task_id: the steer message, or its next brief on resume. Omit only when interrupt is true.',
  ),
  agent: z.string().optional().describe(
    `Which specialist to run. One of: ${listSpecialists().map((s) => s.id).join(', ')}. `
    + 'Required when starting a new specialist; omit when managing one by task_id — the specialist type follows the task_id.',
  ),
  work_dir: z.string().optional().describe(
    'The directory the specialist works in — usually the project root you are working in. '
    + 'Passing a subdirectory narrows what the specialist can read (and, for a read-write specialist, edit). '
    + 'Required when starting a new specialist; omit when managing one by task_id.',
  ),
  // Task 4 (plan 1b) — background execution. Optional so every existing 1a
  // call (which always blocks until the report comes back) keeps working
  // unchanged; only setting this true opts into the detached-run path. Also
  // read on a task_id RESUME (Task 6): same meaning, applied to the resumed
  // run instead of a new one.
  background: z.boolean().optional().describe(
    'Set true for anything long — you keep working and the report is delivered to you automatically when the specialist finishes. '
    + 'On a task_id resume, applies to the resumed run.',
  ),
  // Task 14: verbatim per the spec ruling — the only two named tiers, plus an
  // escape hatch for a user-directed specific id. Omitting this (the default
  // for every existing call and every built-in specialist) is unchanged
  // behavior: run on the parent's own model. Not read on a task_id call — a
  // steer/resume/interrupt keeps the child's own model.
  model: z.string().optional().describe(
    'Optional: "budget" or "frontier" to use the models the user designated in Settings, or a specific '
    + 'model id — only name a specific model when the user asked for it. Omit to run the specialist on '
    + "this conversation's model. Not used with task_id — a resumed specialist keeps its own model.",
  ),
  // Task 6 — the task_id management surface. Semantics documented verbatim in
  // the tool description below (TASK_ID_DOCTRINE).
  task_id: z.string().optional().describe(
    'The task_id from an earlier launch, to manage that specialist instead of starting a new one. If it is '
    + 'still RUNNING, "prompt" is delivered as a steer at its next natural pause. If it has FINISHED or was '
    + 'INTERRUPTED, it resumes — its state is rebuilt cold from its own transcript — with "prompt" as its next '
    + 'brief, foreground or background per "background". Combine with interrupt: true to cancel it instead (no '
    + '"prompt" needed). A task_id that is not one of THIS conversation\'s own specialists is refused, whether it '
    + "belongs to a different conversation or never existed at all — you can only manage specialists you yourself started.",
  ),
  interrupt: z.boolean().optional().describe('With task_id: cancel that specialist instead of steering or resuming it.'),
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

// Codex's orchestration-doctrine line: a specialist cannot ask a conversational
// follow-up question (child-ask-router.ts denies AskUserQuestion instantly —
// it routes permission GATES to the parent's card, not interactive questions),
// so the caller must front-load everything into one brief.
const DOCTRINE = 'Specialists work independently and report back once; give each specialist a complete, self-contained brief — they cannot ask you a follow-up question.';

// Task 6 — the task_id management surface, documented VERBATIM in the tool
// description (per the plan's own instruction) so a model reads these four
// outcomes as part of learning the tool, not as a refusal it hits by
// surprise later.
const TASK_ID_DOCTRINE =
  'To manage a specialist you already started, pass its task_id instead of agent/work_dir/description:\n'
  + "- Still running: \"prompt\" is delivered as a steer at its next natural pause.\n"
  + '- Finished or interrupted: it resumes — state rebuilt cold from its own transcript — with "prompt" as its '
  + 'next brief, foreground or background per "background".\n'
  + '- Add interrupt: true to cancel it instead (no "prompt" needed).\n'
  + "- A task_id that isn't one of THIS conversation's own specialists is refused the same way whether it "
  + 'belongs to another conversation or never existed — you can only manage specialists you yourself started.';

export function createTaskTool(): NativeTool<TaskArgs> {
  return defineTool<TaskArgs>({
    name: 'Task',
    description:
      'Delegate one focused piece of work to a specialist subagent. The specialist works independently '
      + "and reports back when it's done. Available specialists:\n"
      + describeSpecialists() + '\n\n' + DOCTRINE + '\n\n' + TASK_ID_DOCTRINE,
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
    // Task 11 (ROADMAP fold-in): resolve work_dir before it becomes part of
    // the remembered-rule key. Before this, '.', './x', and the absolute form
    // of the SAME directory each minted a DIFFERENT envelope pattern, so
    // approving one left the other two spellings still asking every time.
    //
    // Fix pass (Finding 1): this used to call guards.ts's `canonicalize()`,
    // which — per that function's own doc comment — case-folds the WHOLE path
    // on win32. That was right for the sensitive-path comparison sets it was
    // built for, but wrong here: this string becomes the rule's stored
    // `pattern`, which describe-rule.ts slices straight into what the
    // permissions screen renders, so a real path like "C:/Users/Destin/Proj"
    // was showing up lowercased to the user. Switched to `resolveP` + toPosix
    // — guards.ts's own display-safe pair, documented there as the one to use
    // for "anything a user or model reads back" — which still resolves
    // `.`/`./x`/absolute forms to ONE key (same `path.resolve` guards.ts's
    // canonicalize uses internally) without folding case. Matching an
    // existing grant still works: subject-glob.ts's subjectMatches always
    // matches case-insensitively (the 'i' regex flag), so a rule written
    // under the OLD lowercased pattern still matches a NEW real-cased ask
    // subject computed here — no grant is lost by this change.
    // permissionSubject has no session cwd to resolve a relative work_dir
    // against (the NativeTool contract passes only the raw args), so it
    // resolves against the process's own cwd, same as canonicalize did.
    // Task 6: a task_id management call may omit work_dir entirely (it isn't
    // starting anything new — see the schema's own comment) — undefined here
    // means tool-name-only matching (NativeTool.permissionSubject's own
    // documented contract), never a crash on a path that was never given.
    permissionSubject: (a) => {
      if (!a.work_dir) return undefined;
      const specialist = a.agent ? resolveSpecialist(a.agent) : undefined;
      const workDir = toPosix(resolveP(a.work_dir, process.cwd()));
      return specialist ? `${specialist.charter}:${workDir}` : workDir;
    },
    moreHint: 'narrow the brief, pick a different specialist, or split the work across more than one Task call',
    async execute(args, ctx: ToolContext): Promise<ToolResultPayload> {
      const services = ctx.services?.specialists;
      if (!services) {
        // A configuration gap (Task attached but its host callbacks were not
        // wired), never a model mistake — say so plainly rather than guessing.
        // Checked FIRST (moved ahead of every args-shaped refusal below, Task
        // 6): both the task_id branch and the new-spawn branch need it, and
        // no existing test pins the OLD relative order against an unknown
        // specialist / trivial prompt.
        return { text: 'Task failed: no specialist services are wired for this session (configuration error).', isError: true };
      }
      const parentId = ctx.sessionId;

      // ---- Task 6: task_id management surface — checked BEFORE the spawn
      // path entirely (order per the plan): steer a running child, resume a
      // finished/interrupted one, or interrupt one outright. Never reaches
      // the unknown-specialist / prompt-floor / placeholder / budget checks
      // below, which only make sense for STARTING something new. ----
      if (args.task_id) {
        const taskId = args.task_id;

        // interrupt is checked before steer/resume (order per the plan).
        if (args.interrupt) {
          const result = services.interruptSpecialist(parentId, taskId);
          if (result.status === 'not-yours') return { text: REFUSED_NOT_OWN_CHILD, isError: true };
          if (result.status === 'not-running') {
            return {
              text: `task_id ${taskId} is not currently running — there is nothing to interrupt. `
                + 'Call Task again with the same task_id and no "interrupt" to resume it instead.',
              isError: true,
            };
          }
          return { text: `Interrupted ${result.title}${result.description ? ` — it was: ${result.description}` : ''}.` };
        }

        // Steer and resume both need a prompt (the message, or the next
        // brief) — interrupt above is the only task_id use that doesn't.
        if (!args.prompt?.trim()) {
          return {
            text: 'Steering or resuming a specialist needs "prompt" — the message to deliver, or its next brief. '
              + 'Omit "prompt" only when interrupt is true.',
            isError: true,
          };
        }
        const trimmedPrompt = args.prompt.trim();

        const steerResult = services.steerSpecialist(parentId, taskId, trimmedPrompt);
        if (steerResult.status === 'not-yours') return { text: REFUSED_NOT_OWN_CHILD, isError: true };
        if (steerResult.status === 'ok') {
          return { text: `Steer delivered to ${steerResult.title}.` };
        }

        // steerResult.status === 'not-running' — the child is this parent's
        // own, but has finished or been interrupted: resume it. Its charter
        // comes from the ledger's own recorded agentType (steerResult), NOT
        // from args.agent — a resume never re-reads the model's own claim
        // about which specialist this is, it re-reads the ORIGINAL one.
        const specialist = resolveSpecialist(steerResult.agentType);
        if (!specialist) {
          return {
            text: `Refused: the specialist type "${steerResult.agentType}" that ${taskId} was running is no longer `
              + 'available — it may have been removed from the roster.',
            isError: true,
          };
        }

        // A resumed child re-takes a reservation exactly like a new spawn —
        // including the writer lock if its charter is read-write (plan's own
        // instruction: "a resumed Worker re-takes the writer lock").
        const reservation = services.reserve(parentId, { writer: specialist.charter === 'read-write' });
        if (!reservation.ok) return { text: reservationRefusalText(reservation), isError: true };

        if (args.background) {
          try {
            const result = await services.resumeSpecialist(parentId, {
              childId: taskId, prompt: trimmedPrompt, background: true,
              parentToolCallId: ctx.toolCallId ?? '', reservation: reservation.token,
            });
            if (result.status === 'not-yours') {
              services.release(reservation.token);
              return { text: REFUSED_NOT_OWN_CHILD, isError: true };
            }
            if (result.status === 'still-running') {
              services.release(reservation.token);
              return { text: `${taskId} started running again before this resume could take effect — nothing to do.`, isError: true };
            }
            // result.status === 'ok-background' (the only remaining case,
            // since this call requested background: true) — ownership of the
            // reservation transferred to the detached chain, same as a fresh
            // background spawn; this call site does NOT release it. The
            // `status === 'ok'` guard below is belt-and-suspenders for the
            // type checker (SpecialistResumeOutcome has two 'ok' shapes) —
            // resumeSpecialist itself never returns the foreground shape here.
            if (result.status === 'ok') throw new Error(`resumeSpecialist returned a foreground result for a background request (task_id ${taskId}) — this is a host bug, not a refusal.`);
            return {
              text: `${result.title} (${specialist.id}) is now working in the background (task_id: ${result.childId}). `
                + 'Their report will be delivered to you automatically when they finish — do not wait or poll. '
                + 'Keep working; a status block at the start of your turns tracks running specialists.',
            };
          } catch (err: any) {
            services.release(reservation.token);
            return { text: `The ${specialist.displayName} specialist failed to resume in the background: ${err?.message ?? String(err)}`, isError: true };
          }
        }

        try {
          const result = await services.resumeSpecialist(parentId, {
            childId: taskId, prompt: trimmedPrompt, background: false,
            parentToolCallId: ctx.toolCallId ?? '', reservation: reservation.token,
          });
          if (result.status === 'not-yours') return { text: REFUSED_NOT_OWN_CHILD, isError: true };
          if (result.status === 'still-running') {
            return { text: `${taskId} started running again before this resume could take effect — nothing to do.`, isError: true };
          }
          // result.status === 'ok' (the only remaining case, since this call
          // requested background: false) — belt-and-suspenders throw for the
          // type checker, mirroring the background branch above.
          if (result.status === 'ok-background') throw new Error(`resumeSpecialist returned a background result for a foreground request (task_id ${taskId}) — this is a host bug, not a refusal.`);
          return { text: result.report };
        } catch (err: any) {
          return { text: `The ${specialist.displayName} specialist failed to resume: ${err?.message ?? String(err)}`, isError: true };
        } finally {
          services.release(reservation.token);
        }
      }

      // ---- Starting a NEW specialist (unchanged from plan 1a/1b, gated on
      // the four fields task_id calls above deliberately omit). ----
      if (!args.agent || !args.work_dir || !args.description || !args.prompt) {
        return {
          text: 'Starting a new specialist needs "agent", "work_dir", "description", and "prompt". '
            + 'Omit all four and pass "task_id" instead to steer, resume, or interrupt a specialist you already started.',
          isError: true,
        };
      }

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

      // Task 14: resolve what model this child runs on. 'parent' — no
      // args.model AND no specialist.modelPreference, the default for every
      // existing call and every built-in specialist — needs nothing beyond
      // ctx.binding, so a session that never touches this feature never
      // needs ToolServices.models wired at all. Only a tier or a specific id
      // reaches resolveDelegatedBinding.
      const requestedModel = resolveRequestedModel(args.model, specialist.modelPreference);
      let resolvedBinding: ModelBinding | undefined;
      let fallbackNote = '';
      if (requestedModel !== 'parent') {
        if (!ctx.binding) {
          return { text: 'Task failed: no model binding is wired for this session (configuration error).', isError: true };
        }
        const models = ctx.services?.models;
        if (!models) {
          return { text: 'Task failed: no model catalog is wired for this session (configuration error).', isError: true };
        }
        // Catalog is fetched ONLY for a specific-id request — a tier lookup
        // never needs it (DelegatedModels.get is the whole answer), so the
        // common tier path pays no catalog-fetch cost.
        const catalog: CatalogModel[] | null = typeof requestedModel === 'object'
          ? (await models.catalog()) ?? null
          : null;
        let resolution;
        try {
          resolution = resolveDelegatedBinding({
            requested: requestedModel, parent: ctx.binding, designated: models.designated, catalog,
          });
        } catch (err) {
          // A user-directed specific model id that couldn't be confirmed —
          // never silently substituted (spec ruling). Rethrow anything else:
          // an unexpected throw here is a bug, not a refusal to render.
          if (err instanceof DelegatedModelRefused) return { text: err.message, isError: true };
          throw err;
        }
        resolvedBinding = resolution.binding;
        if (resolution.fellBack) {
          // requestedModel is a DelegatedTier here — the { modelId } branch
          // above either resolves or throws, it never falls back.
          fallbackNote = `\n\n(No ${requestedModel as DelegatedTier} model is set in Settings — using this conversation's model.)`;
        }
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

      // Task 1 (plan 1b): ONE synchronous reserve-or-refuse call, folding the
      // single-writer check and the slot check into the same step (host-side:
      // reserveSpecialist). 1a's split — check isWriterBusy() here, then set
      // the lock after an await deep inside spawnSpecialist — was safe only
      // under serial tool execution; two Task calls issued in one parallel
      // tool-call step could both pass the check before either set the lock.
      // The refusal copy below is unchanged from 1a (verbatim, per
      // error-message-standards.md) — only WHEN it fires moved.
      const reservation = services.reserve(parentId, { writer: specialist.charter === 'read-write' });
      if (!reservation.ok) return { text: reservationRefusalText(reservation), isError: true };

      // Task 4 (plan 1b) — background: the reservation's release ownership
      // moves off THIS call site the moment spawnBackground actually returns:
      // the detached delivery chain (native-session-host.ts's
      // spawnSpecialistBackground) releases it once the run settles, however
      // long that takes. Its OWN try/catch, separate from the foreground path
      // below, because the two paths must NOT share one `finally` — a shared
      // finally would release on the happy path too, undoing the ownership
      // transfer the whole background design depends on. Only a THROWN launch
      // (the promise rejects — the child never came into existence, or its
      // ledger row never got recorded) means ownership never transferred
      // anywhere, so this catch is the one place background still releases.
      if (args.background) {
        try {
          const { childId, title } = await services.spawnBackground(parentId, {
            specialist,
            prompt: args.prompt,
            workDir: args.work_dir,
            parentToolCallId: ctx.toolCallId ?? '',
            description: args.description,
            token: reservation.token,
          });
          return {
            text: `${title} (${args.agent}) is now working in the background (task_id: ${childId}). Their report will be delivered to you automatically when they finish — do not wait or poll. Keep working; a status block at the start of your turns tracks running specialists.`,
          };
        } catch (err: any) {
          services.release(reservation.token);
          // Specific and accurate (error-message-standards.md): the real
          // thrown message, never a guessed cause — same relay discipline as
          // the foreground catch below.
          return { text: `The ${specialist.displayName} specialist failed to start in the background: ${err?.message ?? String(err)}`, isError: true };
        }
      }

      try {
        const { report } = await services.spawn(parentId, {
          specialist,
          prompt: args.prompt,
          workDir: args.work_dir,
          parentToolCallId: ctx.toolCallId ?? '',
          description: args.description,
          token: reservation.token,
          ...(resolvedBinding ? { binding: resolvedBinding } : {}),
        });
        // Task 14: the one honest line a tier fallback earns — appended to the
        // report, never folded into it, so the child's own words stay intact.
        return { text: fallbackNote ? `${report}${fallbackNote}` : report };
      } catch (err: any) {
        // Every failure path must resolve a tool result — never a dangling
        // call. err.message is expected to already name the child id when one
        // was minted (native-session-host.ts's spawnSpecialist crafts it that
        // way), so this stays a plain relay rather than a second guess at cause.
        return { text: `The ${specialist.displayName} specialist failed: ${err?.message ?? String(err)}`, isError: true };
      } finally {
        // Sole owner of the release, whether spawn succeeded, threw, or never
        // ran (this finally covers both): the tool reserves, spawnSpecialist
        // only BINDS the reservation to the real childId, this releases it.
        services.release(reservation.token);
      }
    },
  });
}
