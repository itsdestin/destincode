import React from 'react';

/**
 * Whether a `conversations` fence in markdown becomes a live reference block
 * (rows with Preview/Resume) or stays plain text.
 *
 * Off by default. ONLY AssistantTurnBubble's live text bubble turns it on: a
 * previewed PAST conversation can contain the same fence, and its ids came from
 * whatever device wrote it, so resolving them inside a read-only transcript
 * would render a card of dead rows.
 *
 * WHY its own module rather than an export of MarkdownContent: five test files
 * mock MarkdownContent to count renders, and a partial mock silently drops any
 * export it does not restate — adding this export there took 23 tests down at
 * once, and would have done so again for every future test that mocks it.
 */
export const SessionRefsEnabled = React.createContext(false);
