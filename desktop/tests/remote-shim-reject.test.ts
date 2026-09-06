import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { REJECT_ON_NOT_OK, responseOutcome } from '../src/renderer/remote-shim';

// WHY this file exists: remote-server.ts answers `{ ok:false, error }` when a
// handler throws, and the shim RESOLVES that for any channel not on this list —
// handing the caller a failure object dressed as a success. Deleting an entry
// silently restores a screen that lies to the user, and until this test existed
// the whole suite stayed green while it did.
const shim = fs.readFileSync(path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '../src/main/remote-server.ts'), 'utf8');

/** Every channel remote-server can answer `{ ok:false, error }` to: a `case`
 *  whose body reaches the `{ ok: false, error: … }` responder before the next
 *  case begins. Derived, not hand-listed, so it tracks the server. */
function channelsThatCanAnswerNotOk(): Set<string> {
  const out = new Set<string>();
  const caseRe = /^\s*case '([^']+)': \{$/gm;
  const starts: Array<[string, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(server)) !== null) starts.push([m[1], m.index]);
  for (let i = 0; i < starts.length; i++) {
    const body = server.slice(starts[i][1], starts[i + 1]?.[1] ?? server.length);
    if (body.includes('{ ok: false, error:')) out.add(starts[i][0]);
  }
  return out;
}

describe('the shim rejects a failure instead of resolving it', () => {
  // Sanity: if the scan below silently found nothing, the subset check would
  // pass vacuously and prove nothing at all.
  it('the remote-server scan actually resolves known channels', () => {
    const canFail = channelsThatCanAnswerNotOk();
    expect(canFail.has('models:set-settings')).toBe(true);
    expect(canFail.has('engine:set-config')).toBe(true);
    // A channel that responds with no try/catch is genuinely not in the set.
    expect(canFail.has('engine:status')).toBe(false);
  });

  // The membership itself. Pinned exactly: this is the assertion that goes red
  // when someone tidies an entry away, which is the failure mode this guards.
  it('lists every channel of this feature whose success shape is a plain object', () => {
    expect([...REJECT_ON_NOT_OK].sort()).toEqual([
      'engine:prereqs',
      'engine:run-in-terminal',
      'engine:set-config',
      'models:add-vision',
      'models:set-settings',
      'models:settings',
    ]);
  });

  // A channel here that the server can never answer `{ ok:false }` to would be
  // dead weight pretending to protect something.
  it('every listed channel is one remote-server can actually fail', () => {
    const canFail = channelsThatCanAnswerNotOk();
    expect([...REJECT_ON_NOT_OK].filter((ch) => !canFail.has(ch))).toEqual([]);
  });

  // The BEHAVIOUR, not just the list. Membership alone left the real hole open:
  // making the dispatcher stop consulting the set at all kept every test green.
  it('turns a listed channel\u2019s failure into a rejection, and leaves others alone', () => {
    // A refused save must reach the dialog's error line…
    expect(responseOutcome('models:set-settings', { ok: false, error: 'nope' })).toBe('failure');
    expect(responseOutcome('engine:set-config', { ok: false, error: 'nope' })).toBe('failure');
    // …while a channel that MEANS { ok:false } as data keeps its answer. This is
    // why the list exists rather than a blanket rule.
    expect(responseOutcome('sync:force', { ok: false, error: 'nope' })).toBe('value');
    // A real answer is never mistaken for a failure.
    expect(responseOutcome('models:settings', { contextLength: 8_192, keepLoaded: true })).toBe('value');
    // And "the host does not implement this" stays its own case, so the user
    // gets the plain-language notice rather than a raw error string.
    expect(responseOutcome('models:settings', { ok: false, unsupported: true })).toBe('unsupported');
  });

  // The decision has to be the one the dispatcher actually runs. Extracting it
  // and then not calling it would pass every assertion above.
  it('the dispatcher uses that decision', () => {
    expect(shim).toContain('switch (responseOutcome(channel, payload))');
  });

  // And each is a REQUEST the shim makes — a push channel has no caller to
  // reject, so an entry for one would never fire.
  it('every listed channel is invoked by the shim', () => {
    expect([...REJECT_ON_NOT_OK].filter((ch) => !shim.includes(`invoke('${ch}'`))).toEqual([]);
  });
});
