// Plays a reply fixture back as the same events a real backend would send —
// `on.transcriptEvent` for the timeline and `on.hookEvent` for a permission
// ask — so a message typed into the workbench gets an answer. This is the
// "phase 2 live play-through" the workbench spec deferred; the landing-page
// embed needs it because a composer that swallows input reads as broken.
//
// Fixture lines reuse the conversation-fixture vocabulary (fixture-loader.ts)
// plus `delay` (ms before the line) and two new kinds:
//   permission_request — emits a PermissionRequest hook event and PAUSES until
//                        session.respondToPermission(id) (mock-shim) resolves it
//   turn_complete      — ends the turn
// No Date.now(): timestamps are a counter so a replay is byte-identical.

export type ReplyLine =
  | { type: 'assistant_text'; text: string; delay?: number; model?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; delay?: number }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean; delay?: number }
  | { type: 'permission_request'; id: string; name: string; input: Record<string, unknown>; delay?: number }
  | { type: 'turn_complete'; delay?: number; model?: string };

export interface ReplySinks {
  transcript: (event: unknown) => void;
  hook: (event: unknown) => void;
  /** characters per second for streamed text; tests pass a large number */
  cps?: number;
}

export function parseReplyScript(raw: string): ReplyLine[] {
  return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ReplyLine);
}

const pending = new Map<string, () => void>();
export function resolvePermission(requestId: string): boolean {
  const r = pending.get(requestId);
  if (!r) return false;
  pending.delete(requestId);
  r();
  return true;
}

let counter = 0;
const uid = () => `wb-ev-${++counter}`;
const stamp = () => 1_753_800_000_000 + counter * 1000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True for the control bytes App/useSubmitConfirmation send to a PTY session
 *  ('\r' submit, '\x1b' interrupt, '\x1b[Z' shift-tab). Those must never start
 *  a scripted reply. */
function isControl(text: string): boolean {
  return text.trim().length === 0 || text.startsWith('\x1b') || text === '\r';
}

export async function playReply(sessionId: string, text: string, script: ReplyLine[], sinks: ReplySinks): Promise<void> {
  if (isControl(text)) return;
  const t = (type: string, data: Record<string, unknown>) =>
    sinks.transcript({ type, sessionId, uuid: uid(), timestamp: stamp(), data });
  const perChar = 1000 / (sinks.cps ?? 40);

  t('user-message', { text });
  for (const line of script) {
    await sleep(line.delay ?? 400);
    switch (line.type) {
      case 'assistant_text': {
        // One partId across the chunks: App.tsx merges same-partId deltas into
        // the last text segment, which is what makes it look like streaming.
        const partId = uid();
        const words = line.text.split(' ');
        for (let i = 0; i < words.length; i++) {
          t('assistant-text', { text: (i ? ' ' : '') + words[i], partId, model: line.model });
          await sleep(perChar * (words[i].length + 1));
        }
        break;
      }
      case 'tool_use':
        t('tool-use', { toolUseId: line.id, toolName: line.name, toolInput: line.input });
        break;
      case 'tool_result':
        t('tool-result', { toolUseId: line.tool_use_id, toolResult: line.content, isError: !!line.is_error });
        break;
      case 'permission_request': {
        sinks.hook({
          type: 'PermissionRequest', sessionId,
          payload: { tool_name: line.name, tool_input: line.input, _requestId: line.id, permissionMode: 'ask' },
        });
        await new Promise<void>((resolve) => pending.set(line.id, resolve));
        // The ask was for this tool call; a tool-use with the same id makes the
        // card show the work happening after approval.
        t('tool-use', { toolUseId: line.id, toolName: line.name, toolInput: line.input });
        break;
      }
      case 'turn_complete':
        t('turn-complete', { stopReason: 'end_turn', model: line.model ?? null });
        break;
      default:
        // A typo in a fixture must be loud, not a silently skipped beat.
        console.warn(`[workbench] reply script: unknown line type ${JSON.stringify((line as { type?: string }).type)} — skipped`);
    }
  }
}
