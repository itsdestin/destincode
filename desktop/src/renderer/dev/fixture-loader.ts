// Dev-only fixture parser: converts a 2-line JSONL snippet (tool_use + tool_result)
// into real ToolCallState objects by running it through the actual chat reducer.
// This keeps the sandbox honest — any reducer drift surfaces here automatically.

import { chatReducer } from '../state/chat-reducer';
import type { ChatState, ChatAction, ToolCallState } from '../state/chat-types';

const SANDBOX_SESSION_ID = 'sandbox';

// ChatState is a Map<string, SessionChatState> (chat-types.ts:357), so an
// empty Map is the initial state. SESSION_INIT seeds the sandbox session —
// without it, TRANSCRIPT_TOOL_USE/RESULT bail out because `session` is missing.
function makeInitialState(): ChatState {
  return chatReducer(new Map(), {
    type: 'SESSION_INIT',
    sessionId: SANDBOX_SESSION_ID,
  });
}

interface LoadResult {
  tools: ToolCallState[];
  error?: string;
}

export function loadFixture(name: string, raw: string): LoadResult {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

  try {
    let state = makeInitialState();

    for (const line of lines) {
      const parsed = JSON.parse(line);

      if (parsed.type === 'tool_use') {
        const action: ChatAction = {
          type: 'TRANSCRIPT_TOOL_USE',
          sessionId: SANDBOX_SESSION_ID,
          uuid: `${name}-use-${parsed.id}`,
          toolUseId: parsed.id,
          toolName: parsed.name,
          toolInput: parsed.input ?? {},
        };
        state = chatReducer(state, action);
      } else if (parsed.type === 'tool_result') {
        // tool_result.content is usually a string in Claude Code transcripts,
        // but can be a structured array (e.g. for Agent results) — stringify
        // those so the reducer's `result: string` field stays consistent.
        const content = typeof parsed.content === 'string'
          ? parsed.content
          : JSON.stringify(parsed.content);
        const action: ChatAction = {
          type: 'TRANSCRIPT_TOOL_RESULT',
          sessionId: SANDBOX_SESSION_ID,
          uuid: `${name}-res-${parsed.tool_use_id}`,
          toolUseId: parsed.tool_use_id,
          result: content,
          isError: parsed.is_error === true,
        };
        state = chatReducer(state, action);
      }
    }

    const session = state.get(SANDBOX_SESSION_ID);
    const tools = session ? Array.from(session.toolCalls.values()) : [];
    return { tools };
  } catch (err) {
    return {
      tools: [],
      error: `parse error in ${name}: ${(err as Error).message}`,
    };
  }
}
