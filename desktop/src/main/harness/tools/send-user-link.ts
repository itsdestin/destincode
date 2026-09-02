// SendUserLink — the link-side mirror of SendUserFile (spec 2026-09-02,
// slice A). Same shape and philosophy as send-user-file.ts: stateless, it
// validates the URLs and reports; the RENDERER owns the Deliverables card and
// the auto-open rule (renderer/state/deliverable-auto-open.ts). Enforcing a
// one-open-per-reply rule here would need per-turn state plus a flag threaded
// through the result event — exactly what deliverable-auto-open.ts already does
// for files, and intentionally not duplicated here.
//
// WHY a separate tool rather than a "links:" field on SendUserFile: the two
// produce different TILES in the Deliverables card (a link has no artifact
// preview and opens in the browser, never the artifact viewer), and a mixed
// call would blur one card's status/error handling. One tool per deliverable
// KIND keeps "is this a file tile or a link tile" a property of the tool name,
// exactly like Claude Code's own send-file/URL split.
import { z } from 'zod';
import { defineTool } from './registry';

export const SEND_USER_LINK_DESCRIPTION = [
  'Send finished URLs to the user — a deployed page, a preview, a localhost dev server, an API — as a "Deliverables" card with links they can open in the browser.',
  'Use it for links the user will want to visit, not for every URL mentioned in passing; do not re-send a link that has not changed.',
  'Only http:// and https:// URLs are accepted (use an absolute URL — localhost and LAN IPs are fine, e.g. http://localhost:5173).',
  'display: "render" asks to show ONE link immediately; only the first such request in a reply is honored. Everything else attaches to the card.',
].join(' ');

/** Narrow an unknown catch value to an Error message without a blind cast —
 *  `new URL()` throws TypeError/URIError with a `message` we can surface, but
 *  the catch type is `unknown`, so check shape before reading it. */
function messageOf(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return 'not a URL';
}

export const SendUserLinkTool = defineTool({
  name: 'SendUserLink',
  description: SEND_USER_LINK_DESCRIPTION,
  // Compact form for small local models (same reasoning as SendUserFile's).
  shortDescription: 'Hand finished URLs to the user as a Deliverables card. display: "render" shows one link now (first request per reply).',
  inputSchema: z.object({
    links: z.array(z.object({
      url: z.string().describe('The full URL to open — http:// or https://. localhost and LAN IPs are allowed.'),
      label: z.string().optional().describe('Optional short label shown on the tile instead of the bare URL.'),
    })).min(1),
    caption: z.string().optional().describe('One line of context for the links.'),
    status: z.enum(['normal', 'proactive']).optional().describe('Accepted for parity with SendUserFile; ignored.'),
    display: z.enum(['render', 'attach']).optional().describe('"render": show the first link immediately (first request per reply only). "attach" or omitted: just the card.'),
  }).strict(), // .strict(): an unknown parameter is an error the model can fix, never silently dropped (ledger D-2)
  // Opens nothing — it names URLs the user should visit; the click is user-
  // initiated and goes through shell.openExternal's own scheme allowlist.
  // No path subject, so checkPathGuard's cwd jail does not apply.
  permissionSubject: () => undefined,
  async execute(args, ctx) {
    const problems: string[] = [];
    for (const link of args.links) {
      const raw = link.url;
      // new URL() is the parser: it accepts relative-looking strings as
      // "file:" (or "" scheme) URLs, so we must BOTH parse AND require an
      // explicit http/https scheme — bare "localhost:5173" is not a URL and
      // can't be opened safely.
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch (err) {
        // Surface the REAL parse reason, never a guessed cause
        // (docs/error-message-standards.md): a malformed URL fails differently
        // from an unsupported scheme and the model has to be able to tell which.
        problems.push(`${raw}: ${messageOf(err)}`);
        continue;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        problems.push(`${raw}: only http:// and https:// URLs can be sent`);
        continue;
      }
    }
    if (problems.length) {
      // The WHOLE call fails: half-delivering would leave the model believing
      // the bad link reached the user (mirrors SendUserFile's whole-call rule).
      return { text: `SendUserLink failed — nothing was sent:\n${problems.map((p) => `- ${p}`).join('\n')}`, isError: true };
    }
    const n = args.links.length;
    return { text: `Sent ${n} link${n === 1 ? '' : 's'} to the user.` };
  },
});