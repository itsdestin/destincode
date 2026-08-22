import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createConversationStore } from '../src/main/conversations/conversation-store';

describe('repro: metadata-only lastUsedModel upsert', () => {
  it('updates the model when a record already exists with an old model', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-repro-'));
    const store = createConversationStore(root);

    // First: a turn-complete upsert records the session running an old model,
    // with a real lastActive.
    await store.upsert({
      id: 'sess-1', provider: 'claude', projectName: 'proj',
      lastActive: '2026-08-01T00:00:00.000Z',
      lastUsedModel: { modelId: 'claude-sonnet-4-5', providerType: 'claude-code', providerLabel: 'Claude Code' },
    });
    const before = await store.get('claude', 'sess-1');
    console.log('BEFORE model =', before?.lastUsedModel?.modelId);

    // Then noteModelUsed fires on the next turn (opus now), which does an upsert
    // with NO lastActive (EPOCH) and the new model.
    await store.upsert({
      id: 'sess-1', provider: 'claude',
      lastUsedModel: { modelId: 'claude-opus-4-7', providerType: 'claude-code', providerLabel: 'Claude Code' },
    });

    const after = await store.get('claude', 'sess-1');
    console.log('AFTER  model =', after?.lastUsedModel?.modelId);
    expect(after?.lastUsedModel?.modelId).toBe('claude-opus-4-7');
  });
});
