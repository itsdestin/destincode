// Rebuild ModelMessages from persisted transcript events (spec §2.5). This is
// the RESUME path's history reconstruction — it turns the on-disk transcript
// (as SessionStore.readEvents returns it, i.e. streaming deltas already
// coalesced to one assistant-text/assistant-thinking event per partId) back
// into the ModelMessage[] the driver would have accumulated live.
//
// Grouping MUST mirror the driver's live pushes EXACTLY (harness-session.ts:
// send()/assistantMessage()/toolResultPart()) — the deep-equal test in
// tests/harness-history-rebuild.test.ts is the ARBITER of every grouping choice:
//   - consecutive assistant-text events + the tool-use events that follow them
//     form ONE assistant message ({role:'assistant', content:[text?, ...calls]}），
//   - the tool-results that follow form ONE tool message,
//   - a user-message flushes everything before it.
// A tool-result arriving flushes the open assistant message (this is what keeps
// step 2's text from merging into step 1's assistant message); an assistant-text
// or tool-use arriving flushes any open tool-results.
//
// Deliberately NOT reconstructed: readRegistry (read-before-edit mtimes) and the
// todo list — those are per-session RUNTIME state, never persisted, and
// seedHistory() clears them on resume (the reset-on-resume ruling, spec §2.5).
// assistant-thinking / compact-summary / session-error never entered model
// history live either, so they're skipped here too.
import type { TranscriptEvent } from '../../shared/types';
import type { ModelMessage } from 'ai';

export function rebuildHistory(events: TranscriptEvent[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  let assistantParts: any[] = [];
  let toolResults: any[] = [];
  const flushAssistant = () => {
    if (assistantParts.length) { out.push({ role: 'assistant', content: assistantParts }); assistantParts = []; }
  };
  const flushResults = () => {
    if (toolResults.length) { out.push({ role: 'tool', content: toolResults }); toolResults = []; }
  };
  for (const e of events) {
    switch (e.type) {
      case 'user-message':
        flushAssistant(); flushResults();
        out.push({ role: 'user', content: String(e.data?.text ?? '') });
        break;
      case 'assistant-text':
        // A pending tool-result block closes before new assistant text opens.
        flushResults();
        assistantParts.push({ type: 'text', text: String(e.data?.text ?? '') });
        break;
      case 'tool-use':
        flushResults();
        assistantParts.push({ type: 'tool-call', toolCallId: e.data?.toolUseId, toolName: e.data?.toolName, input: e.data?.toolInput ?? {} });
        break;
      case 'tool-result':
        // Close the assistant(tool-call) message this result answers — this
        // flush is what prevents the NEXT step's text from merging into it.
        flushAssistant();
        toolResults.push({ type: 'tool-result', toolCallId: e.data?.toolUseId, toolName: e.data?.toolName, output: { type: 'text', value: String(e.data?.toolResult ?? '') } });
        break;
      case 'turn-complete':
      case 'user-interrupt':
        flushAssistant(); flushResults();
        break;
      default:
        // assistant-thinking, compact-summary, session-error, and any unknown
        // future type never enter model history in Plan A.
        break;
    }
  }
  flushAssistant(); flushResults();
  return out;
}
