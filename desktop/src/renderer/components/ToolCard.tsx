import React, { useState, useEffect, useRef, useCallback } from 'react';
import { ToolCallState } from '../../shared/types';
import { useChatDispatch } from '../state/chat-context';
import { useArtifactOptional } from '../state/ArtifactContext';
import { CheckIcon, FailIcon, QuestionIcon, ChevronIcon, NoteIcon } from './Icons';
import BrailleSpinner from './BrailleSpinner';
import { isAndroid } from '../platform';
import ToolBody from './tool-views/ToolBody';
import { useExpandAllToggle, getInitialExpanded } from '../hooks/useExpandAllToggle';

// --- Helpers for friendly display ---

function basename(filepath: string): string {
  const parts = filepath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || parts[parts.length - 2] || filepath;
}

function parentDir(filepath: string): string {
  const parts = filepath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] + '/' : '';
}

function titleCase(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export function friendlyToolDisplay(tool: ToolCallState): { label: string; detail: string } {
  const { toolName, input } = tool;

  switch (toolName) {
    case 'Bash': {
      const cmd = (input.command as string) || '';
      const desc = input.description as string | undefined;
      const bg = input.run_in_background ? ' ⟳' : '';
      let label: string;
      if (desc) {
        label = desc;
      } else if (cmd) {
        const firstBin = cmd.trimStart().split(/\s+/)[0] || 'command';
        label = `Running ${basename(firstBin)}`;
      } else {
        label = 'Run Command';
      }
      return { label: label + bg, detail: cmd ? `↳ ${truncate(cmd, 80)}` : '' };
    }

    case 'Read': {
      const fp = (input.file_path as string) || '';
      const label = fp ? `Reading ${basename(fp)}` : 'Reading File';
      let detail = fp ? `↳ ${parentDir(fp)}` : '';
      const offset = input.offset as number | undefined;
      const limit = input.limit as number | undefined;
      const pages = input.pages as string | undefined;
      if (offset != null && limit != null) {
        detail += ` lines ${offset}-${offset + limit}`;
      } else if (offset != null) {
        detail += ` from line ${offset}`;
      } else if (limit != null) {
        detail += ` first ${limit} lines`;
      }
      if (pages) {
        detail += ` pages ${pages}`;
      }
      return { label, detail };
    }

    case 'Write': {
      const fp = (input.file_path as string) || '';
      return {
        label: fp ? `Writing ${basename(fp)}` : 'Writing File',
        detail: fp ? `↳ ${parentDir(fp)}` : '',
      };
    }

    case 'Edit': {
      const fp = (input.file_path as string) || '';
      let detail = fp ? `↳ ${parentDir(fp)}` : '';
      const oldStr = input.old_string as string | undefined;
      if (oldStr) {
        detail += ` ${truncate(oldStr.replace(/\n/g, '⏎'), 40)}`;
      }
      return {
        label: fp ? `Editing ${basename(fp)}` : 'Editing File',
        detail,
      };
    }

    case 'Grep': {
      const pattern = (input.pattern as string) || '';
      const label = pattern ? `Searching for "${truncate(pattern, 30)}"` : 'Searching Code';
      let detail = '';
      if (input.glob) {
        detail = `↳ in ${input.glob} files`;
      } else if (input.path) {
        detail = `↳ in ${basename(input.path as string)}/`;
      } else if (input.type) {
        detail = `↳ in .${input.type} files`;
      }
      return { label, detail };
    }

    case 'Glob': {
      const pattern = (input.pattern as string) || '';
      const simplified = pattern.replace(/^\*\*\//, '');
      const label = pattern ? `Finding ${simplified} files` : 'Finding Files';
      const detail = input.path ? `↳ in ${basename(input.path as string)}/` : '';
      return { label, detail };
    }

    case 'Agent': {
      const desc = input.description as string | undefined;
      const bg = input.run_in_background ? ' ⟳' : '';
      const label = desc ? `Agent: ${desc}` : 'Running Sub-Agent';
      const detail = input.subagent_type ? `↳ ${input.subagent_type}` : '';
      return { label: label + bg, detail };
    }

    case 'WebSearch': {
      const query = input.query as string | undefined;
      return {
        label: 'Searching the Web',
        detail: query ? `↳ ${query}` : '',
      };
    }

    case 'WebFetch': {
      const url = input.url as string | undefined;
      let domain = '';
      if (url) {
        try {
          domain = new URL(url).hostname;
        } catch {
          domain = url;
        }
      }
      return {
        label: 'Fetching Webpage',
        detail: domain ? `↳ ${domain}` : '',
      };
    }

    case 'Skill': {
      const skill = input.skill as string | undefined;
      const args = input.args as string | undefined;
      // Strip the plugin namespace ("superpowers:brainstorming" -> "brainstorming")
      // so the label reads as English, not as a technical id. Past tense matches
      // the post-launch state — by the time the card renders, the skill has
      // already been invoked.
      const bareName = skill?.includes(':') ? skill.split(':').slice(-1)[0] : skill;
      return {
        label: bareName ? `Invoked skill: ${bareName}` : 'Invoked skill',
        detail: args ? `↳ ${args}` : '',
      };
    }

    case 'TaskCreate': {
      const subject = (input.subject as string) || '';
      return {
        label: subject ? `New Task: ${truncate(subject, 50)}` : 'New Task',
        detail: '',
      };
    }

    case 'TaskUpdate': {
      const status = input.status as string | undefined;
      let label: string;
      switch (status) {
        case 'completed':
          label = 'Task Completed';
          break;
        case 'in_progress':
          label = 'Task Started';
          break;
        case 'deleted':
          label = 'Task Deleted';
          break;
        default:
          label = 'Updating Task';
      }
      const taskId = input.taskId as string | undefined;
      return { label, detail: taskId ? `↳ #${taskId}` : '' };
    }

    case 'AskUserQuestion': {
      // Show the first question's header/text as the tool label
      const questions = input.questions as any[];
      const header = questions?.[0]?.header || questions?.[0]?.question || 'Question';
      return { label: truncate(String(header), 40), detail: '' };
    }

    case 'ExitPlanMode': {
      return { label: 'Plan ready — would you like to proceed?', detail: '' };
    }

    // Native runtime budget gates — synthetic "tools" the harness raises as
    // permission asks (harness-session.ts). They have no real tool call; render
    // plain-language "Continue?" copy, NOT the raw internal name.
    case 'max_steps': {
      const steps = Number(input.steps) || 0;
      return {
        label: 'Continue?',
        detail: `↳ Claude has taken ${steps} steps on this task without stopping`,
      };
    }

    case 'doom_loop': {
      const repeated = typeof input.repeated === 'string' ? input.repeated : '';
      return {
        label: 'Continue?',
        detail: repeated
          ? `↳ Claude keeps repeating the same action (${repeated})`
          : '↳ Claude appears to be repeating the same action',
      };
    }

    default: {
      // MCP tools: mcp__{server}__{action}
      if (toolName.startsWith('mcp__')) {
        const parts = toolName.slice(5).split('__');
        const server = parts[0] ? titleCase(parts[0]) : toolName;
        const action = parts[1] ? titleCase(parts[1]) : '';
        const label = action ? `${server}: ${action}` : server;
        // Show the most interesting input value as detail
        let detail = '';
        const values = Object.values(input).filter(v => typeof v === 'string' && v.length > 0) as string[];
        if (values.length > 0) {
          detail = `↳ ${truncate(values[0], 60)}`;
        }
        return { label, detail };
      }

      // Unknown tool — show name as-is
      return { label: toolName, detail: '' };
    }
  }
}

// Synthetic updatedPermissions payload for a native "Always allow". The native
// broker's respond() reads "always" purely from a non-empty updatedPermissions
// array + behavior:allow (it ignores the array's CONTENTS — the host derives the
// remembered rule from the tool call itself), so any single-element marker works.
// CC asks keep sending their real suggestion string. Task 13.
const NATIVE_ALWAYS_ALLOW = 'native:always-allow';

function PermissionButtons({ requestId, suggestions, denyListed, command, folderName, suppressAlwaysAllow, onResponded, onFailed }: {
  requestId: string;
  suggestions?: string[];
  /** Deny-listed native ask → gate "Always allow" behind a consequence confirm. */
  denyListed?: boolean;
  /** The exact command the remembered rule will store, echoed in the confirm so
   *  the user can see precisely what they're granting. Deny-listed asks are
   *  Bash-only (DESTRUCTIVE_DENY_LIST has no non-Bash entries), so this is
   *  `input.command` — the same string harness-session.ts:562 persists. */
  command?: string;
  /** Basename of the session cwd. The rule is scoped to that directory's slug
   *  (permission-store.ts:35-43), so naming the folder is what makes the grant's
   *  scope checkable — a worktree does NOT inherit its parent repo's rules. */
  folderName?: string;
  /** Budget gates (max_steps / doom_loop) are a binary "Continue?" — never offer
   *  "Always Allow" (it'd persist a rule that permanently disables the guard). */
  suppressAlwaysAllow?: boolean;
  onResponded?: () => void;
  onFailed?: () => void;
}) {
  const [responding, setResponding] = useState(false);
  // Native asks carry NO CC permission_suggestions, but Always-allow must still
  // be offered (Task 8 carry-forward). The broker mints `native-${uuid}` request
  // ids, so the prefix is the cleanest native discriminator — no extra state to
  // thread. CC keeps its suggestions-gated behavior unchanged.
  const isNative = requestId.startsWith('native-');
  const hasSuggestions = !!(suggestions?.length);
  const canAlwaysAllow = (hasSuggestions || isNative) && !suppressAlwaysAllow;
  // Consequence-gated confirm strip (deny-listed asks) — mirrors the delete-model
  // confirm in LocalModelsSection: replace the button row with a plain-language
  // warning + Cancel / confirm.
  const [confirmingAlways, setConfirmingAlways] = useState(false);
  const [focusIdx, setFocusIdx] = useState(canAlwaysAllow ? 1 : 0);
  const buttonsRef = useRef<(HTMLButtonElement | null)[]>([]);

  const handleRespond = useCallback(async (decision: object) => {
    setResponding(true);
    try {
      const delivered = await (window as any).claude.session.respondToPermission(requestId, decision);
      if (delivered === false) {
        console.warn('Permission response not delivered — socket already closed');
        setResponding(false);
        if (onFailed) onFailed();
        return;
      }
      if (onResponded) onResponded();
    } catch (err) {
      console.error('Failed to respond to permission:', err);
      setResponding(false);
      if (onFailed) onFailed();
    }
  }, [requestId, onResponded, onFailed]);

  // The "Always allow" decision: CC sends its first real suggestion; native sends
  // the synthetic marker the broker reads as always.
  const alwaysAllowDecision = () =>
    hasSuggestions
      ? { decision: { behavior: 'allow' }, updatedPermissions: [suggestions![0]] }
      : { decision: { behavior: 'allow' }, updatedPermissions: [NATIVE_ALWAYS_ALLOW] };

  // Deny-listed asks show the consequence confirm first; otherwise respond directly.
  const onAlwaysAllow = useCallback(() => {
    if (denyListed) { setConfirmingAlways(true); return; }
    handleRespond(alwaysAllowDecision());
  }, [denyListed, handleRespond, hasSuggestions, suggestions]);

  // Build actions list so keyboard handler can index into it
  const actions = useRef<(() => void)[]>([]);
  actions.current = [
    () => handleRespond({ decision: { behavior: 'allow' } }),
    ...(canAlwaysAllow ? [onAlwaysAllow] : []),
    () => handleRespond({ decision: { behavior: 'deny' } }),
  ];
  const count = actions.current.length;

  // Global keyboard navigation: arrows cycle, Enter activates. Suspended while
  // the consequence confirm is open so arrow/Enter don't drive the hidden row.
  useEffect(() => {
    if (responding || confirmingAlways) return;
    const handler = (e: KeyboardEvent) => {
      // Don't steal keyboard events when user is typing in an input
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setFocusIdx(prev => {
          const next = e.key === 'ArrowRight' ? (prev + 1) % count : (prev - 1 + count) % count;
          buttonsRef.current[next]?.focus();
          return next;
        });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        actions.current[focusIdx]?.();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [responding, confirmingAlways, focusIdx, count]);

  const pad = isAndroid() ? 'py-2' : 'py-1';
  const ring = 'ring-2 ring-white/40';

  // Consequence-gated confirm — plain-language warning before persisting a rule
  // for a deny-listed action. Cancel returns to the card (the buttons re-render).
  if (confirmingAlways) {
    return (
      <div className="px-3 py-2 space-y-2 border-t border-edge bg-inset/30">
        {/* The header carries the ask so the body only has to carry the risk.
            Naming the folder keeps the promise checkable — the remembered rule is
            cwd-scoped, so "in this folder" alone would be unverifiable. */}
        <p className="text-xs font-medium text-fg-2">
          Always allow this exact command{folderName ? ` in ${folderName}` : ''}?
        </p>
        {command && (
          <p className="text-[11px] leading-relaxed text-fg-2 bg-inset/70 px-2 py-1.5 rounded-sm break-all">
            {command}
          </p>
        )}
        <p className="text-[11px] text-fg-dim leading-relaxed">
          It can delete files or change published code, and you won't be asked again.
        </p>
        <div className="flex items-center gap-2">
          {/* "Allow once" IS the plain-allow decision, so it wears the same green
              as Yes. Previously this slot was Cancel, which dead-ended back on the
              button row and still left the user owing an answer. */}
          <button
            disabled={responding}
            onClick={() => handleRespond({ decision: { behavior: 'allow' } })}
            className={`px-3 ${pad} text-xs font-medium rounded-sm bg-green-600/60 hover:bg-green-600/80 text-green-100 transition-colors disabled:opacity-50`}
          >
            Nevermind, allow once
          </button>
          <button
            disabled={responding}
            onClick={() => handleRespond(alwaysAllowDecision())}
            className={`px-3 ${pad} text-xs font-medium rounded-sm bg-red-600/60 hover:bg-red-600/80 text-red-100 transition-colors disabled:opacity-50`}
          >
            Always allow
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-t border-edge bg-inset/30">
      <button
        ref={el => { buttonsRef.current[0] = el; }}
        disabled={responding}
        onClick={() => handleRespond({ decision: { behavior: 'allow' } })}
        className={`px-3 ${pad} text-xs font-medium rounded-sm bg-green-600/60 hover:bg-green-600/80 text-green-100 transition-colors disabled:opacity-50 ${focusIdx === 0 ? ring : ''}`}
      >
        Yes
      </button>
      {canAlwaysAllow ? (
        <button
          ref={el => { buttonsRef.current[1] = el; }}
          disabled={responding}
          onClick={onAlwaysAllow}
          className={`px-3 ${pad} text-xs font-medium rounded-sm bg-blue-600/60 hover:bg-blue-600/80 text-blue-100 transition-colors disabled:opacity-50 ${focusIdx === 1 ? ring : ''}`}
        >
          Always Allow
        </button>
      ) : null}
      <button
        ref={el => { buttonsRef.current[canAlwaysAllow ? 2 : 1] = el; }}
        disabled={responding}
        onClick={() => handleRespond({ decision: { behavior: 'deny' } })}
        className={`px-3 ${pad} text-xs font-medium rounded-sm bg-red-600/60 hover:bg-red-600/80 text-red-100 transition-colors disabled:opacity-50 ${focusIdx === (canAlwaysAllow ? 2 : 1) ? ring : ''}`}
      >
        No
      </button>
    </div>
  );
}

// --- ExitPlanMode UI ---
// The CLI shows a 4-option Ink menu for plan approval, not a standard Yes/No
// permission prompt. We render the real options and send PTY input (arrow keys
// + Enter) to select the chosen option in the Ink menu, then close the hook
// socket so the relay exits cleanly.

const PLAN_INTENT_STYLES = {
  accept: 'bg-green-600/60 hover:bg-green-600/80 text-green-100',
  reject: 'bg-red-600/60 hover:bg-red-600/80 text-red-100',
  neutral: 'bg-blue-600/60 hover:bg-blue-600/80 text-blue-100',
};

const PLAN_OPTIONS = [
  { label: 'Yes, and bypass permissions', intent: 'accept' as const },
  { label: 'Yes, manually approve edits', intent: 'accept' as const },
  { label: 'No, refine plan', intent: 'reject' as const },
  { label: 'Tell Claude what to change', intent: 'neutral' as const },
];

function PlanApprovalButtons({ requestId, sessionId, onResponded }: {
  requestId: string;
  sessionId: string;
  onResponded?: () => void;
}) {
  const [responding, setResponding] = useState(false);
  const DOWN = '\u001b[B';

  const handleSelect = useCallback((optionIndex: number) => {
    setResponding(true);
    // Send arrow-down keys to navigate from option 1 (default) to the target,
    // then Enter to confirm the selection in the Ink menu
    const input = DOWN.repeat(optionIndex) + '\r';
    window.claude.session.sendInput(sessionId, input);
    // Close the hook socket — the Ink menu handles the decision, so we don't
    // need to send a hook response. Closing prevents the relay from timing out.
    (window as any).claude.session.respondToPermission(requestId, { decision: { behavior: 'deny' } }).catch(() => {});
    if (onResponded) onResponded();
  }, [requestId, sessionId, onResponded, DOWN]);

  const pad = isAndroid() ? 'py-2' : 'py-1';

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-edge bg-inset/30">
      {PLAN_OPTIONS.map((opt, idx) => (
        <button
          key={opt.label}
          disabled={responding}
          onClick={() => handleSelect(idx)}
          className={`px-3 ${pad} text-xs font-medium rounded-sm transition-colors disabled:opacity-50 ${PLAN_INTENT_STYLES[opt.intent]}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// --- AskUserQuestion UI ---
// Claude Code's AskUserQuestion tool sends 1-4 multiple-choice questions.
// Unlike regular tools (allow/deny), we must collect the user's selections
// and return them via updatedInput.answers so Claude gets the actual answer.

interface AskQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

function isValidQuestions(input: Record<string, unknown>): input is { questions: AskQuestion[] } {
  const q = input.questions;
  return Array.isArray(q) && q.length > 0 && typeof q[0]?.question === 'string';
}

function AskUserQuestionCard({ tool, requestId, onResponded, onFailed }: {
  tool: ToolCallState;
  requestId: string;
  onResponded?: () => void;
  onFailed?: () => void;
}) {
  const questions = (tool.input as any).questions as AskQuestion[];
  // answers: map from question text → selected label(s)
  const [answers, setAnswers] = useState<Record<string, Set<string>>>({});
  const [responding, setResponding] = useState(false);
  // Track which question is "active" for keyboard nav, and which option is focused
  const [focusedOption, setFocusedOption] = useState(0);

  const allAnswered = questions.every(q => {
    const sel = answers[q.question];
    return sel && sel.size > 0;
  });

  const handleSelect = useCallback((question: string, label: string, multiSelect: boolean) => {
    setAnswers(prev => {
      const current = prev[question] || new Set<string>();
      const next = new Set(current);
      if (multiSelect) {
        // Toggle for multi-select
        if (next.has(label)) next.delete(label);
        else next.add(label);
      } else {
        // Replace for single-select
        next.clear();
        next.add(label);
      }
      return { ...prev, [question]: next };
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!allAnswered || responding) return;
    setResponding(true);
    // Build answers object: question text → "Label" or "Label1, Label2"
    const answersObj: Record<string, string> = {};
    for (const q of questions) {
      const sel = answers[q.question];
      answersObj[q.question] = sel ? Array.from(sel).join(', ') : '';
    }
    try {
      const delivered = await (window as any).claude.session.respondToPermission(requestId, {
        decision: {
          behavior: 'allow',
          updatedInput: {
            questions,       // Echo back original questions array
            answers: answersObj,
          },
        },
      });
      if (delivered === false) {
        setResponding(false);
        if (onFailed) onFailed();
        return;
      }
      if (onResponded) onResponded();
    } catch (err) {
      console.error('Failed to respond to AskUserQuestion:', err);
      setResponding(false);
      if (onFailed) onFailed();
    }
  }, [allAnswered, responding, questions, answers, requestId, onResponded, onFailed]);

  const handleDeny = useCallback(async () => {
    setResponding(true);
    try {
      const delivered = await (window as any).claude.session.respondToPermission(requestId, {
        decision: { behavior: 'deny' },
      });
      if (delivered === false) {
        setResponding(false);
        if (onFailed) onFailed();
        return;
      }
      if (onResponded) onResponded();
    } catch {
      setResponding(false);
      if (onFailed) onFailed();
    }
  }, [requestId, onResponded, onFailed]);

  // Total flat list of all options across questions (for keyboard nav)
  const allOptions = questions.flatMap(q => q.options.map(o => ({ q, o })));
  const optionCount = allOptions.length;

  // Keyboard: Arrow Up/Down cycles options, Enter toggles selection, Ctrl+Enter submits
  useEffect(() => {
    if (responding) return;
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusedOption(prev =>
          e.key === 'ArrowDown' ? (prev + 1) % optionCount : (prev - 1 + optionCount) % optionCount
        );
      } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        // Select the focused option
        if (optionCount > 0) {
          const { q, o } = allOptions[focusedOption];
          handleSelect(q.question, o.label, q.multiSelect);
        }
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        // Ctrl/Cmd+Enter to submit
        e.preventDefault();
        handleSubmit();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [responding, focusedOption, optionCount, allOptions, handleSelect, handleSubmit]);

  const pad = isAndroid() ? 'py-2' : 'py-1.5';
  let flatIdx = 0; // Running index across all questions' options for keyboard focus

  return (
    <div className="border-t border-edge px-3 py-2 space-y-3">
      {questions.map((q, qi) => (
        <div key={qi}>
          <div className="text-xs font-medium text-fg-2 mb-1">
            {q.header && <span className="text-fg-muted mr-1">{q.header}:</span>}
            {q.question}
          </div>
          <div className="space-y-1">
            {q.options.map((opt, oi) => {
              const idx = flatIdx++;
              const selected = answers[q.question]?.has(opt.label) ?? false;
              const focused = idx === focusedOption;
              return (
                <button
                  key={oi}
                  disabled={responding}
                  onClick={() => handleSelect(q.question, opt.label, q.multiSelect)}
                  className={`w-full text-left px-2.5 ${pad} rounded-sm text-xs transition-colors
                    ${selected
                      ? 'bg-accent/20 border border-accent/50 text-fg'
                      : 'bg-inset/40 border border-transparent hover:bg-inset/70 text-fg-dim'}
                    ${focused ? 'ring-1 ring-white/30' : ''}
                    disabled:opacity-50`}
                >
                  <div className="flex items-center gap-2">
                    {/* Selection indicator */}
                    <span className={`w-3 h-3 shrink-0 rounded-${q.multiSelect ? 'sm' : 'full'} border
                      ${selected ? 'bg-accent border-accent' : 'border-edge'}`}
                    />
                    <span className="font-medium">{opt.label}</span>
                  </div>
                  {opt.description && (
                    <div className="text-fg-muted ml-5 mt-0.5">{opt.description}</div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {/* Submit + Deny buttons */}
      <div className="flex items-center gap-2 pt-1">
        <button
          disabled={!allAnswered || responding}
          onClick={handleSubmit}
          className={`px-3 ${pad} text-xs font-medium rounded-sm transition-colors disabled:opacity-40
            ${allAnswered ? 'bg-accent/70 hover:bg-accent/90 text-on-accent' : 'bg-inset/50 text-fg-muted'}`}
        >
          Submit
        </button>
        <button
          disabled={responding}
          onClick={handleDeny}
          className={`px-3 ${pad} text-xs font-medium rounded-sm bg-inset/40 hover:bg-red-600/40 text-fg-muted hover:text-red-200 transition-colors disabled:opacity-50`}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

interface Props {
  tool: ToolCallState;
  sessionId?: string;
  // inGroup: true when rendered inside a CollapsedToolGroup. Gates bg-inset so
  // the "lifted card" color only shows inside groups; standalone cards stay
  // transparent and inherit the bubble color.
  inGroup?: boolean;
}

export default React.memo(function ToolCard({ tool, sessionId, inGroup = false }: Props) {
  // Seed from the module-level mode so a card that mounts AFTER Ctrl+O fired
  // (e.g. when its parent tool group just opened) starts in the right state.
  const [expanded, setExpanded] = useState(() => getInitialExpanded());
  useExpandAllToggle(() => setExpanded(true), () => setExpanded(false));
  const dispatch = useChatDispatch();
  // Optional: the tool sandbox (?mode=tool-sandbox) renders ToolCard outside the
  // ArtifactProvider. Missing cwd just drops the folder name from the confirm
  // header rather than crashing the card.
  const artifacts = useArtifactOptional();
  const sessionCwd = sessionId ? artifacts?.state.sessionCwd?.[sessionId] : undefined;
  const display = friendlyToolDisplay(tool);
  // Skill tool calls always return "Launching skill: X" with success — the body
  // is pure ceremony. Render header only, no chevron, non-interactive, with a
  // lighter dashed border so it reads as an annotation, not an expandable card.
  const isCompactSkill = tool.toolName === 'Skill';

  const cardBorder = isCompactSkill
    ? 'border border-dashed border-edge-dim/60'
    : 'border border-edge';
  const headerClass = isCompactSkill
    ? 'w-full flex items-center gap-1.5 px-3 py-1.5 text-left'
    : 'w-full flex items-center gap-1.5 px-3 py-1.5 text-left hover:bg-inset/50 transition-colors';
  const headerContent = (
    <>
      {/* Status indicator */}
      {tool.status === 'running' && (
        <BrailleSpinner size="sm" />
      )}
      {tool.status === 'awaiting-approval' && (
        <QuestionIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
      )}
      {tool.status === 'complete' && (
        // Skills get the note glyph on success — visually distinct from
        // the generic check used by every other tool, since "skill ran"
        // carries different meaning ("Claude consulted instructions/notes")
        // than "command finished." Failed skills still use the FailIcon.
        isCompactSkill ? (
          <NoteIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        ) : (
          <CheckIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        )
      )}
      {tool.status === 'failed' && (
        <FailIcon className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
      )}
      <span className="text-fg-faint text-xs select-none">|</span>
      <span className="text-xs font-medium text-fg-2">{display.label}</span>
      {display.detail && (
        <span className="text-xs text-fg-muted truncate flex-1 min-w-0">{display.detail}</span>
      )}
      {!isCompactSkill && (
        <span data-testid="tool-card-chevron" className="shrink-0 inline-flex">
          <ChevronIcon className="w-3.5 h-3.5 text-fg-muted" expanded={expanded} />
        </span>
      )}
    </>
  );

  return (
    <div className={`${cardBorder} rounded-lg overflow-hidden ${inGroup ? 'bg-inset' : ''}`}>
      {/* Header */}
      {isCompactSkill ? (
        <div className={headerClass}>{headerContent}</div>
      ) : (
        <button onClick={() => setExpanded(!expanded)} className={headerClass}>
          {headerContent}
        </button>
      )}


      {/* Permission / AskUserQuestion / ExitPlanMode UI */}
      {tool.status === 'awaiting-approval' && tool.requestId && (() => {
        // AskUserQuestion needs its own UI with option selection instead of Yes/No
        const isAskUser = tool.toolName === 'AskUserQuestion' && isValidQuestions(tool.input);
        // ExitPlanMode has a 4-option Ink menu in the CLI (bypass/manual/refine/feedback),
        // not a standard Yes/No permission — render the real options
        const isPlanApproval = tool.toolName === 'ExitPlanMode';
        const onRespondedCb = () => {
          if (sessionId && tool.requestId) {
            const action = { type: 'PERMISSION_RESPONDED' as const, sessionId, requestId: tool.requestId };
            dispatch(action);
            (window as any).claude?.remote?.broadcastAction(action);
          }
        };
        const onFailedCb = () => {
          if (sessionId && tool.requestId) {
            const action = { type: 'PERMISSION_EXPIRED' as const, sessionId, requestId: tool.requestId };
            dispatch(action);
            (window as any).claude?.remote?.broadcastAction(action);
          }
        };
        return isAskUser ? (
          <AskUserQuestionCard
            tool={tool}
            requestId={tool.requestId}
            onResponded={onRespondedCb}
            onFailed={onFailedCb}
          />
        ) : isPlanApproval && sessionId ? (
          <PlanApprovalButtons
            requestId={tool.requestId}
            sessionId={sessionId}
            onResponded={onRespondedCb}
          />
        ) : (
          <PermissionButtons
            requestId={tool.requestId}
            suggestions={tool.permissionSuggestions}
            denyListed={tool.denyListed}
            command={typeof (tool.input as any)?.command === 'string' ? (tool.input as any).command : undefined}
            folderName={sessionCwd ? basename(sessionCwd) : undefined}
            // Budget gates are a plain Yes/No "Continue?" — no "Always Allow".
            suppressAlwaysAllow={tool.toolName === 'max_steps' || tool.toolName === 'doom_loop'}
            onResponded={onRespondedCb}
            onFailed={onFailedCb}
          />
        );
      })()}

      {/* Expanded details — per-tool parsed views, raw fallback otherwise.
          Skill cards never render a body (the only response is the redundant
          "Launching skill: X" line). */}
      {!isCompactSkill && expanded && (
        <div data-testid="tool-card-body">
          <ToolBody tool={tool} sessionId={sessionId} />
        </div>
      )}
    </div>
  );
})
