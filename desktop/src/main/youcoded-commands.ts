// YouCoded-handled slash commands. Each has native UI implemented in
// `src/renderer/state/slash-command-dispatcher.ts`. Keep this list in
// sync with the `switch` cases in that file.

import type { CommandEntry } from '../shared/types';

export const YOUCODED_COMMANDS: CommandEntry[] = [
  { name: '/compact', description: 'Compact conversation with native spinner card', source: 'youcoded', clickable: true },
  { name: '/clear',   description: 'Clear conversation timeline with native marker', source: 'youcoded', clickable: true, aliases: ['/reset', '/new'] },
  { name: '/model',   description: 'Open native model picker',                        source: 'youcoded', clickable: true },
  { name: '/fast',    description: 'Toggle fast mode',                                source: 'youcoded', clickable: true },
  { name: '/effort',  description: 'Open effort-level picker',                        source: 'youcoded', clickable: true },
  { name: '/copy',    description: 'Copy assistant response to clipboard',            source: 'youcoded', clickable: true },
  { name: '/resume',  description: 'Open native Resume Browser',                      source: 'youcoded', clickable: true },
  { name: '/config',  description: 'Open Preferences popup',                          source: 'youcoded', clickable: true, aliases: ['/settings'] },
  { name: '/cost',    description: 'Show native Usage card',                          source: 'youcoded', clickable: true, aliases: ['/usage'] },
];

// Flatten primary entries + aliases so each is an independently
// searchable row in the drawer. Aliases inherit description + click
// behavior from the primary.
export function expandWithAliases(entries: CommandEntry[]): CommandEntry[] {
  const out: CommandEntry[] = [];
  for (const entry of entries) {
    out.push({ ...entry, aliases: undefined });
    for (const alias of entry.aliases ?? []) {
      out.push({ ...entry, name: alias, aliases: undefined });
    }
  }
  return out;
}
