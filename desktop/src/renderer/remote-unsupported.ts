// Shared vocabulary for "this feature isn't bridged to remote access yet".
//
// Deliberately its own module with NO imports. remote-shim.ts is loaded only
// via a dynamic import() on the remote/browser path (see index.tsx) — pulling
// these constants directly from it would drag the whole shim into the main
// bundle and evaluate it on desktop, where it is never used.

export const REMOTE_UNSUPPORTED_EVENT = 'youcoded:remote-unsupported';

export interface RemoteUnsupportedDetail {
  channel: string;
  feature: string;
  message: string;
}

// Namespace → what the user would call it. Longest-prefix-first so
// 'theme-marketplace:' wins over 'theme:'.
const FEATURE_NAMES: Array<[string, string]> = [
  ['theme-marketplace:', 'Theme browsing'],
  ['marketplace:', 'The skill marketplace'],
  ['social:', 'Friends and challenges'],
  ['integrations:', 'Integrations'],
  ['artifacts:', 'Project files'],
  ['project:', 'Project details'],
  ['dialog:', 'File pickers'],
  ['theme:', 'Theme editing'],
  ['skills:', 'Skills'],
  ['dev:', 'Developer tools'],
];

/** Plain-language name for the feature a channel belongs to. Falls back to the
 *  raw channel so an unmapped namespace still says something specific. */
export function remoteFeatureName(channel: string): string {
  for (const [prefix, label] of FEATURE_NAMES) {
    if (channel.startsWith(prefix)) return label;
  }
  return channel;
}

export function remoteUnsupportedMessage(channel: string): string {
  return `${remoteFeatureName(channel)} isn't available via remote access yet.`;
}
