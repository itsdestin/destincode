// Text helpers shared by the shell tools (Bash, BashOutput, KillShell) and the
// ShellRegistry. Why its own module: bash.ts imports the registry's helpers and
// the registry must strip the probe sentinels bash.ts prints — a runtime
// import in both directions would leave one side undefined at load time.

/** Marker the shell prints after the user's command so bash.ts can read the
 *  final $PWD back out of stdout. Scoped-persistence (ROADMAP 2026-07-17):
 *  before this, every Bash call spawned fresh at the session root and `cd`
 *  silently evaporated, costing ~6 wasted tool calls in one observed session. */
export const CWD_SENTINEL = '__YC_CWD__';

/** Marker for the opt-in env-persistence probe (17/17 harness reviews, four
 *  rounds 2026-08-01 through 2026-08-09): announces the path of a bash-generated
 *  temp file holding the child's post-command exported vars. Only emitted when a
 *  call passes `persistent_env: true` — see withCwdProbe(). */
export const ENV_SENTINEL = '__YC_ENVFILE__';

/** Strip CSI (colour, cursor) and OSC (window title, hyperlink) sequences.
 *
 *  WHY both an env hint AND a strip: NO_COLOR/FORCE_COLOR cover most tools, but
 *  not all honour them — a vitest run rendered as
 *  `[1m[30m[46m RUN [49m[39m[22m` in the 2026-08-01 review. That is noise in every
 *  test result the model reads, and it looks like corruption to a non-developer
 *  reading the transcript. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

/** Turn a redrawing progress bar into ordinary lines.
 *
 *  WHY: npm, gradle, pip and docker redraw one status line with a carriage
 *  return and NO newline. Left alone, the registry's line splitter never sees a
 *  break, so a whole run collects into one endless "unfinished line" that the
 *  200-line ring can never trim and the on-disk log grows with — the
 *  2026-08-28 review's unbounded-memory case. CRLF collapses to LF first so
 *  Windows line endings do not double up. */
export function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** Drop the probe's own sentinel lines from text the model or the card sees.
 *
 *  WHY filter on READ and not in the file: a handed-off command prints its
 *  sentinels when it finally exits, minutes after adoption, by which time the
 *  on-disk log is already streaming — the raw log keeps them (review I6). */
export function stripSentinelLines(text: string): string {
  if (!text.includes(CWD_SENTINEL) && !text.includes(ENV_SENTINEL)) return text;
  return text
    .split('\n')
    .filter((line) => !line.startsWith(CWD_SENTINEL) && !line.startsWith(ENV_SENTINEL))
    .join('\n');
}
