import { describe, it, expect } from 'vitest';
import { normalizeToolName, deriveUsage, deriveStopReason, aliasToolInputKeys } from '../src/main/opencode-session-adapter';

describe('normalizeToolName', () => {
  // Why this exists: ToolBody's view-router (tool-views/ToolBody.tsx) keys on
  // PascalCase names (Read/Write/Edit/Bash/...). OpenCode emits lowercase or
  // snake_case, so without normalization tools render via the generic
  // fallback view instead of the prettified per-tool view.

  it('PascalCases lowercase OpenCode tool names', () => {
    expect(normalizeToolName('read')).toBe('Read');
    expect(normalizeToolName('write')).toBe('Write');
    expect(normalizeToolName('edit')).toBe('Edit');
    expect(normalizeToolName('bash')).toBe('Bash');
    expect(normalizeToolName('grep')).toBe('Grep');
    expect(normalizeToolName('glob')).toBe('Glob');
  });

  it('PascalCases snake_case names', () => {
    expect(normalizeToolName('web_fetch')).toBe('WebFetch');
    expect(normalizeToolName('todo_write')).toBe('TodoWrite');
    expect(normalizeToolName('exit_plan_mode')).toBe('ExitPlanMode');
  });

  it('PascalCases kebab-case names', () => {
    expect(normalizeToolName('web-fetch')).toBe('WebFetch');
    expect(normalizeToolName('todo-write')).toBe('TodoWrite');
  });

  it('maps concatenated multi-word names via the alias map', () => {
    // OpenCode's real tool ids have NO separator (webfetch, todowrite) —
    // the split-on-[_-] logic can't recover those, so they go through the
    // explicit alias map. Without it, webfetch → "Webfetch" misses the
    // WebFetch view and renders via the raw fallback.
    expect(normalizeToolName('webfetch')).toBe('WebFetch');
    expect(normalizeToolName('todowrite')).toBe('TodoWrite');
    expect(normalizeToolName('todoread')).toBe('TodoRead');
    expect(normalizeToolName('exitplanmode')).toBe('ExitPlanMode');
    expect(normalizeToolName('multiedit')).toBe('MultiEdit');
  });

  it('passes through already-PascalCase names (idempotent)', () => {
    // Important: re-running normalize on an already-normalized name MUST be
    // a no-op. Otherwise re-emitting tool events (e.g. on resume rehydration)
    // could double-mangle.
    expect(normalizeToolName('Read')).toBe('Read');
    expect(normalizeToolName('WebFetch')).toBe('WebFetch');
    expect(normalizeToolName('TodoWrite')).toBe('TodoWrite');
  });

  it('passes through MCP tool names unchanged', () => {
    // MCP tools use a fixed mcp__<server>__<name> shape; ToolBody routes
    // those by exact match (e.g. mcp__windows-control__PowerShell), so we
    // mustn't transform them.
    expect(normalizeToolName('mcp__windows-control__PowerShell')).toBe('mcp__windows-control__PowerShell');
    expect(normalizeToolName('mcp__github__create_issue')).toBe('mcp__github__create_issue');
  });

  it('handles null/undefined/empty defensively', () => {
    expect(normalizeToolName('')).toBe('');
    expect(normalizeToolName(null)).toBe('');
    expect(normalizeToolName(undefined)).toBe('');
  });
});

describe('deriveUsage', () => {
  // Maps OpenCode AssistantMessage.tokens → YouCoded TurnUsage. Powers the
  // showTurnMetadata strip (AssistantTurnBubble.tsx). Was hard-coded null
  // before this fix, so the strip stayed empty for local sessions.

  it('maps a typical OpenCode token block', () => {
    expect(deriveUsage({
      input: 100,
      output: 250,
      cache: { read: 50, write: 10 },
    })).toEqual({
      inputTokens: 100,
      outputTokens: 250,
      cacheReadTokens: 50,
      cacheCreationTokens: 10,
    });
  });

  it('zero-fills missing fields rather than dropping them', () => {
    // YouCoded's TurnUsage type requires all four fields. OpenCode local
    // models often report 0 cache (Ollama doesn't have a prompt cache),
    // and may omit fields entirely on partial step-finish blocks.
    expect(deriveUsage({ input: 50, output: 100 })).toEqual({
      inputTokens: 50,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it('returns null on null/undefined input', () => {
    expect(deriveUsage(null)).toBeNull();
    expect(deriveUsage(undefined)).toBeNull();
  });

  it('returns null on garbage input rather than throwing', () => {
    expect(deriveUsage('not-an-object' as any)).toBeNull();
  });
});

describe('deriveStopReason', () => {
  // Mapping OpenCode's stop signals → YouCoded's stopReason vocabulary:
  // 'end_turn' (no footer), 'max_tokens', 'refusal', 'pause_turn',
  // 'interrupted', or 'error' (generic footer). Drives StopReasonFooter.

  it('maps MessageOutputLengthError → max_tokens', () => {
    const info = { error: { name: 'MessageOutputLengthError' } };
    expect(deriveStopReason(info, [])).toBe('max_tokens');
  });

  it('maps MessageAbortedError → interrupted', () => {
    // The cancel path goes through markInterrupted() not error, but if
    // OpenCode itself abort-errors mid-turn this is the fallback.
    const info = { error: { name: 'MessageAbortedError' } };
    expect(deriveStopReason(info, [])).toBe('interrupted');
  });

  it('maps any other error → error', () => {
    expect(deriveStopReason({ error: { name: 'ProviderAuthError' } }, [])).toBe('error');
    expect(deriveStopReason({ error: { name: 'ApiError' } }, [])).toBe('error');
    expect(deriveStopReason({ error: { name: 'UnknownError' } }, [])).toBe('error');
  });

  it('reads the LAST step-finish reason (intermediate steps are tool-call boundaries)', () => {
    // A turn with one tool call typically has step-finish events with
    // reason='tool-calls' (intermediate) then reason='stop' (final). We
    // care about the last one — it's the actual end-of-turn signal.
    const parts = [
      { type: 'text' },
      { type: 'step-finish', reason: 'tool-calls' },
      { type: 'tool' },
      { type: 'step-finish', reason: 'stop' },
    ];
    expect(deriveStopReason({}, parts)).toBe('end_turn');
  });

  it('maps step-finish reason="length" → max_tokens', () => {
    const parts = [{ type: 'step-finish', reason: 'length' }];
    expect(deriveStopReason({}, parts)).toBe('max_tokens');
  });

  it('maps step-finish reason="content-filter" → refusal', () => {
    const parts = [{ type: 'step-finish', reason: 'content-filter' }];
    expect(deriveStopReason({}, parts)).toBe('refusal');
  });

  it('treats tool-calls / other / unknown as end_turn (no footer)', () => {
    // None of these signal a user-actionable end condition; suppressing the
    // footer keeps the chat clean. tool-calls in particular fires when a
    // turn ends to call a tool, then resumes — not a real stop.
    expect(deriveStopReason({}, [{ type: 'step-finish', reason: 'tool-calls' }])).toBe('end_turn');
    expect(deriveStopReason({}, [{ type: 'step-finish', reason: 'other' }])).toBe('end_turn');
    expect(deriveStopReason({}, [])).toBe('end_turn');
  });

  it('error takes priority over step-finish reason', () => {
    // If the message errored, the error name is more useful than whatever
    // the model's last step-finish said before crashing.
    const info = { error: { name: 'MessageOutputLengthError' } };
    const parts = [{ type: 'step-finish', reason: 'stop' }];
    expect(deriveStopReason(info, parts)).toBe('max_tokens');
  });
});

describe('aliasToolInputKeys', () => {
  // Why this exists: OpenCode tool inputs are camelCase; YouCoded's ToolCard
  // views mostly read Claude-style snake_case. Aliasing both forms means a
  // view resolves its key regardless of convention. Bug: a Read card from an
  // OpenCode session rendered an empty body because the view read `file_path`
  // but the data had only `filePath`.

  it('adds the snake_case form of a camelCase key', () => {
    const out = aliasToolInputKeys({ filePath: '/a/b.txt' }) as Record<string, unknown>;
    expect(out.filePath).toBe('/a/b.txt');
    expect(out.file_path).toBe('/a/b.txt');
  });

  it('adds the camelCase form of a snake_case key', () => {
    const out = aliasToolInputKeys({ task_id: 'T1' }) as Record<string, unknown>;
    expect(out.task_id).toBe('T1');
    expect(out.taskId).toBe('T1');
  });

  it('handles multi-word keys (oldString / runInBackground)', () => {
    const out = aliasToolInputKeys({ oldString: 'x', runInBackground: true }) as Record<string, unknown>;
    expect(out.old_string).toBe('x');
    expect(out.run_in_background).toBe(true);
  });

  it('leaves single-word keys untouched (no spurious alias)', () => {
    const out = aliasToolInputKeys({ command: 'ls', pattern: '*.ts' }) as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(['command', 'pattern']);
  });

  it('does not overwrite an existing counterpart key', () => {
    // If both forms are already present, keep both as-is.
    const out = aliasToolInputKeys({ filePath: 'camel', file_path: 'snake' }) as Record<string, unknown>;
    expect(out.filePath).toBe('camel');
    expect(out.file_path).toBe('snake');
  });

  it('passes through non-objects unchanged', () => {
    expect(aliasToolInputKeys(null)).toBeNull();
    expect(aliasToolInputKeys(undefined)).toBeUndefined();
    expect(aliasToolInputKeys('string')).toBe('string');
    expect(aliasToolInputKeys([1, 2])).toEqual([1, 2]);
  });
});
