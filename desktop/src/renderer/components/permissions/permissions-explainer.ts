import type { ExplainerSection } from '../SettingsExplainer';

// The "What is this?" content behind the (i) on Settings → Permissions.
//
// Layman's terms on purpose — this doubles as in-app help (see the
// SettingsExplainer module header). No tool ids, no rule syntax, nothing a
// non-developer would have to look up.
//
// WHY this is data rather than markup: SettingsExplainer owns every bit of the
// rendering, so the copy can be reviewed (and later translated) without reading
// a component. It also keeps SettingsPanel.tsx, already 2,600+ lines, from
// growing another screen of prose.
//
// The intro deliberately does NOT restate what the list itself says. The
// section's own first line already tells the user what the entries ARE and what
// removing one does; this tells them where the entries come from and points at
// the settings that decide how often they get asked in the first place.
export const PERMISSIONS_EXPLAINER_INTRO =
  'The assistant asks you first before it does anything that changes your computer — running a command, editing a file. Choosing “Always allow” when it asks is what puts something on this list. How often it checks with you in the first place is a separate setting, explained below.';

export const PERMISSIONS_EXPLAINER_SECTIONS: ExplainerSection[] = [
  {
    // Wording follows the chip at the bottom of the chat exactly (StatusBar's
    // PERMISSION_DISPLAY: ASK FIRST / AUTO EDIT / FULL AUTO), so the help text
    // names the same three things the user can see and click.
    heading: 'How much it asks',
    paragraphs: [
      'Each conversation has a setting for how often it checks with you. You can change it at any time from the chat.',
    ],
    bullets: [
      { term: 'Ask first', text: 'checks with you before anything that changes your files or runs a command. Reading and searching never ask.' },
      { term: 'Auto edit', text: 'edits files without asking, but still checks before running commands.' },
      { term: 'Full auto', text: 'does not check with you at all. Use it when you are watching.' },
    ],
  },
  {
    // "Preset" is the label on the new-session form (RuntimeBinding's preset
    // picker). The code calls these personality profiles; the user never sees
    // that word, so the heading uses the one on screen.
    heading: 'Presets',
    paragraphs: [
      'When you start a conversation you pick a preset, and that decides where it starts out.',
    ],
    bullets: [
      { term: 'Assistant', text: 'starts out cautious and asks about most things.' },
      { term: 'Coder', text: 'starts out able to edit files without asking, since that is most of the work.' },
    ],
  },
  {
    // The single most likely source of confusion: a screen called "Permissions"
    // implies it covers everything, and it does not — Claude Code keeps its own
    // allow list in its own settings, which nothing here reads or writes.
    heading: 'Approvals you gave Claude Code',
    paragraphs: [
      "Conversations running on Claude Code keep their own separate list of approvals, which this screen does not manage. You can change those in Claude Code's own settings.",
    ],
  },
];
