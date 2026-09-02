import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createSkillCatalog } from '../src/main/harness/skills/skill-catalog';
// eslint-disable-next-line no-template-curly-in-string -- the literal text `${CLAUDE_PLUGIN_ROOT}` IS the subject of this test.
it('substitutes ${CLAUDE_PLUGIN_ROOT} with the plugin root two levels above the skill dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-skillroot-'));
  const skillDir = path.join(root, 'plugins', 'youcoded-chatsearch', 'skills', 'chatsearch');
  fs.mkdirSync(skillDir, { recursive: true });
  // eslint-disable-next-line no-template-curly-in-string -- ditto: this writes the un-substituted placeholder the catalog must replace.
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: chatsearch\n---\nrun node "${CLAUDE_PLUGIN_ROOT}/skills/chatsearch/scripts/chatsearch.js"');
  const cat = createSkillCatalog([{ id: 'chatsearch', displayName: 'x', description: 'y', skillDir } as any]);
  const body = cat.load('chatsearch').body;
  expect(body).toContain(`node "${path.join(root, 'plugins', 'youcoded-chatsearch')}/skills/chatsearch/scripts/chatsearch.js"`);
  expect(body).not.toContain('${');
});
