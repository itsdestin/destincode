// SSRF guard for the web tools (spec §3.1): private/localhost/RFC-1918 blocked
// by default, http/https only, and — because redirects are followed MANUALLY —
// EVERY hop is re-validated (a public URL 302ing to http://192.168.1.1/ is the
// classic bypass). Same guard family as the secret-path denial in guards.ts.
//
// HONESTY LIMIT (PITFALLS): we validate the DNS answer, then fetch by hostname,
// so a TOCTOU DNS-rebind between check and fetch is theoretically possible.
// Honest friction, not a security boundary — the accepted Phase 2 posture.
import { isIP } from 'net';
import { lookup as dnsLookup } from 'dns/promises';

export class NetGuardError extends Error {}

type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true });

const PRIVATE_V4: ReadonlyArray<readonly [RegExp, string]> = [
  [/^0\./, '0.0.0.0/8'], [/^10\./, '10/8'], [/^127\./, 'loopback'],
  [/^169\.254\./, 'link-local'], [/^192\.168\./, '192.168/16'],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, 'CGNAT 100.64/10'],
];

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    if (PRIVATE_V4.some(([re]) => re.test(ip))) return true;
    const second = Number(ip.split('.')[1]);
    return ip.startsWith('172.') && second >= 16 && second <= 31;
  }
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;    // fc00::/7 ULA
  if (/^fe[89ab]/.test(lower)) return true;                             // fe80::/10 link-local
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);          // v4-mapped
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

/** Scheme + address validation for ONE URL. Throws NetGuardError with an honest,
 *  specific message (docs/error-message-standards.md). Returns the parsed URL. */
export async function assertPublicHttpUrl(raw: string, lookup: LookupFn = defaultLookup): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new NetGuardError(`"${raw}" is not a valid URL.`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetGuardError(`Only http and https URLs can be fetched (got ${url.protocol.replace(':', '')}).`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip v6 brackets
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new NetGuardError(`${host} is a private/internal address — fetching it is blocked.`);
    return url;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new NetGuardError(`${host} is a local address — fetching it is blocked.`);
  }
  let addrs: Array<{ address: string }>;
  try { addrs = await lookup(host); } catch {
    throw new NetGuardError(`Could not resolve ${host} — check the URL or the network connection.`);
  }
  if (addrs.length === 0) throw new NetGuardError(`Could not resolve ${host}.`);
  const bad = addrs.find((a) => isPrivateIp(a.address));
  if (bad) throw new NetGuardError(`${host} resolves to the private/internal address ${bad.address} — fetching it is blocked.`);
  return url;
}

const MAX_REDIRECTS = 5;

export interface GuardedFetchOpts {
  signal: AbortSignal;
  timeoutMs?: number;              // per-request; default 30s
  lookup?: LookupFn;               // test injection
  fetchImpl?: typeof fetch;        // test injection
  headers?: Record<string, string>;
}

/** Fetch with MANUAL redirect following: every hop re-runs assertPublicHttpUrl. */
export async function guardedFetch(rawUrl: string, opts: GuardedFetchOpts): Promise<{ res: Response; finalUrl: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lookup = opts.lookup ?? defaultLookup;
  let current = rawUrl;
  for (let hop = 0; ; hop++) {
    const url = await assertPublicHttpUrl(current, lookup);
    const res = await fetchImpl(url.toString(), {
      redirect: 'manual',
      headers: { 'User-Agent': 'YouCoded', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8', ...opts.headers },
      signal: AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 30_000)]),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new NetGuardError(`${url.hostname} answered ${res.status} with no Location header.`);
      if (hop >= MAX_REDIRECTS) throw new NetGuardError(`Gave up after ${MAX_REDIRECTS} redirects (last: ${current}).`);
      current = new URL(location, url).toString(); // relative Location supported
      continue;
    }
    return { res, finalUrl: current };
  }
}

/** Stream the body up to maxBytes; flag truncation instead of buffering unbounded. */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: await res.text(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0; let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(value.slice(0, value.byteLength - (total - maxBytes)));
      truncated = true;
      await reader.cancel().catch(() => { /* stream already closed */ });
      break;
    }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}
