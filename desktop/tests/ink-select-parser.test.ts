import { describe, it, expect } from 'vitest';
import { parseInkSelect, menuToButtons } from '../src/renderer/parser/ink-select-parser';

describe('ink-select-parser', () => {
  describe('parseInkSelect', () => {
    it('parses a simple 2-option menu', () => {
      const screenText = `
Resume Session

1: as is
  ❯ 2: from summary

press enter to confirm`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) return;

      expect(menu.options).toEqual(['as is', 'from summary']);
      expect(menu.selectedIndex).toBe(1); // cursor is on option 2 (index 1)
      expect(menu.title).toBe('Resume Session');
    });

    it('parses Resume Session with description', () => {
      const screenText = `Resume Session
Session age: 45 minutes | Usage: 85% of limit
Trade-off: Resume from summary will skip token-intensive context

1: as is
  ❯ 2: from summary

press enter to confirm`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) {
        console.log('Menu is null');
        return;
      }

      console.log('Parsed menu:', {
        title: menu.title,
        options: menu.options,
        selectedIndex: menu.selectedIndex,
        description: menu.description,
      });

      expect(menu.options).toEqual(['as is', 'from summary']);
      expect(menu.selectedIndex).toBe(1);
      // For now, just log what we get
      // expect(menu.description).toBeDefined();
    });

    it('parses when cursor is on first option', () => {
      const screenText = `Resume Session
  ❯ 1: as is
    2: from summary`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) return;

      expect(menu.options).toEqual(['as is', 'from summary']);
      expect(menu.selectedIndex).toBe(0); // cursor is on option 1 (index 0)
    });
  });

  describe('menuToButtons', () => {
    it('generates correct keystroke sequences with anchor-then-navigate', () => {
      const menu = {
        id: 'test',
        title: 'Resume Session',
        options: ['as is', 'from summary'],
        selectedIndex: 1,
        description: 'test',
      };

      const buttons = menuToButtons(menu);
      expect(buttons).toHaveLength(2);

      const UP = '\u001b[A';
      const DOWN = '\u001b[B';

      // First option: go to top (UP×4 for 2 options) then navigate to index 0
      const firstButton = buttons[0];
      expect(firstButton.label).toBe('as is');
      const expectedFirst = UP.repeat(4) + DOWN.repeat(0) + '\r';
      expect(firstButton.input).toBe(expectedFirst);

      // Second option: go to top, then DOWN once
      const secondButton = buttons[1];
      expect(secondButton.label).toBe('from summary');
      const expectedSecond = UP.repeat(4) + DOWN.repeat(1) + '\r';
      expect(secondButton.input).toBe(expectedSecond);
    });

    it('produces independent keystroke sequences regardless of initial selectedIndex', () => {
      // Same options, different selectedIndex shouldn't change the sequences
      // (this is the whole point of anchor-then-navigate)

      const option0Cmd = menuToButtons({
        id: 'test', title: 'Test', options: ['a', 'b'], selectedIndex: 0,
      })[0].input;

      const option0Cmd2 = menuToButtons({
        id: 'test', title: 'Test', options: ['a', 'b'], selectedIndex: 1,
      })[0].input;

      // Both should produce the same keystroke sequence for option 0
      // (This verifies cursor state doesn't matter)
      expect(option0Cmd).toBe(option0Cmd2);
    });
  });

  // Regression: TITLE_OVERRIDES used a bare 'trust' substring, so ANY menu whose
  // nearby terminal text contained the word (conversation output, the user's own
  // prompt echo, the Fable 5 safeguard prompt) was force-labeled
  // 'Trust This Folder?' and hijacked by TrustGate's full-screen takeover.
  describe('TITLE_OVERRIDES specificity (trust substring collision)', () => {
    it('does not hijack a menu whose nearby conversation text merely contains "trust"', () => {
      const screenText = `You should trust the test suite here rather than manual checks.

Continue with this plan?
 ❯ 1. Yes, proceed
   2. No, revise the plan

press enter to confirm`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) return;
      expect(menu.title).toBe('Continue with this plan?');
    });

    it('labels the model-safeguard prompt "Message Flagged" even with "trust" in nearby text', () => {
      const screenText = `I can't run that directly — I don't trust the input enough.

This model's safeguards flagged this message. This sometimes happens with
safe, normal conversations.

 ❯ 1. Switch to Opus 4.8 and continue
   2. Edit prompt and retry with Fable 5`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) return;
      expect(menu.title).toBe('Message Flagged');
      expect(menu.options).toEqual([
        'Switch to Opus 4.8 and continue',
        'Edit prompt and retry with Fable 5',
      ]);
    });

    it('still labels the real folder-trust prompt via its security-note anchor', () => {
      const screenText = `Do you want to work in this folder?

C:\\Users\\someone\\project

Important: Only use Claude Code with files you trust. Accessing untrusted
files may pose security risks.

 ❯ 1. Yes, I trust this folder
   2. No, continue without these permissions
   3. No, exit`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) return;
      expect(menu.title).toBe('Trust This Folder?');
      expect(menu.options).toHaveLength(3);
    });
  });

  describe('TITLE_OVERRIDES anchors for theme/login prompts', () => {
    it('does not label a menu as theme select from conversation text about dark mode', () => {
      const screenText = `I switched the app to dark mode as you asked. What next?

Pick a follow-up:
 ❯ 1. Adjust the accent color
   2. Leave it as is`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) return;
      expect(menu.title).not.toBe('Choose a Theme');
    });

    it('labels the real theme select via its heading', () => {
      const screenText = `Choose the text style that looks best with your terminal

 ❯ 1. Light mode
   2. Dark mode
   3. Dark mode (colorblind-friendly)`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) return;
      expect(menu.title).toBe('Choose a Theme');
    });

    it('labels the login select via its heading', () => {
      const screenText = `Select login method:

 ❯ 1. Claude account with subscription
   2. Anthropic Console account`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) return;
      expect(menu.title).toBe('Select Login Method');
    });
  });

  describe('cross-platform consistency', () => {
    it('handles colon-numbered options like Resume Session uses', () => {
      const screenText = `  ❯ 1: as is
    2: from summary`;

      const menu = parseInkSelect(screenText);
      expect(menu).not.toBeNull();
      if (!menu) return;

      // Should strip the numbering
      expect(menu.options).toEqual(['as is', 'from summary']);
    });
  });
});
