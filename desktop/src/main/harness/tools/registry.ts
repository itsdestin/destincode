// defineTool(): the ONE pipeline every tool runs through (spec §2.3) —
// validation and permission gating happen in the DRIVER (it owns pause/resume);
// this wrapper owns execution + uniform truncation + actionable errors.
import { truncateOutput, type TruncateOpts } from './truncate';
import type { NativeTool, ToolContext, ToolResultPayload } from './types';

const DEFAULT_CAPS: TruncateOpts = { maxChars: 30_000 };

export function defineTool<A>(
  def: NativeTool<A> & { caps?: TruncateOpts },
): NativeTool<A> {
  const caps = def.caps ?? DEFAULT_CAPS;
  return {
    ...def,
    async execute(args: A, ctx: ToolContext): Promise<ToolResultPayload> {
      try {
        const raw = await def.execute(args, ctx);
        return { ...raw, text: truncateOutput(raw.text, caps).text };
      } catch (err: any) {
        // Abort is only surfaced here when the tool THREW — the driver (Task 9)
        // owns interrupt semantics (it aborts the signal and stops the turn);
        // this branch just labels an in-flight throw as a cancellation, not a bug.
        if (ctx.signal.aborted) return { text: 'Canceled: the user interrupted this operation.', isError: true };
        // Actionable error string, never a bare code (research R§3).
        return { text: `${def.name} failed: ${err?.message ?? String(err)}`, isError: true };
      }
    },
  };
}
