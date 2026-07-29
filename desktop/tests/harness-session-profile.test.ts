// The CapabilityProfile the host resolves must actually STEER the driver: the
// doom-loop window comes from profile.doomLoopThreshold, and a plain-chat model
// (supportsTools:false) attaches NO tools to the SDK.
import { describe, it, expect } from 'vitest';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';
import { makeSession, scriptModel, drainTurn } from './helpers/harness-fakes';

describe('profile-driven driver behavior', () => {
  it('a doomLoopThreshold of 2 trips after 2 identical calls (not 3)', async () => {
    let asks = 0;
    const session = makeSession({
      profile: { ...CLOUD_DEFAULT, doomLoopThreshold: 2 },
      askUser: async () => { asks++; return { behavior: 'deny' } as any; },
      model: scriptModel([
        { toolCalls: [{ name: 'Glob', input: { pattern: '*.ts' } }] },
        { toolCalls: [{ name: 'Glob', input: { pattern: '*.ts' } }] },
      ]),
    });
    await drainTurn(session, 'go');
    expect(asks).toBe(1);
  });

  it('supportsTools:false attaches NO tools to the model', () => {
    const session = makeSession({ profile: { ...CLOUD_DEFAULT, supportsTools: false } });
    expect(Object.keys((session as any).buildAiTools())).toHaveLength(0);
  });
});
