// update-installer.ts — In-app download-and-launch lifecycle for YouCoded updates.
// Spec: docs/superpowers/specs/2026-04-22-in-app-update-installer-design.md
// Shared types: desktop/src/shared/update-install-types.ts
//
// Responsibilities (added incrementally across tasks):
//   Task 2: URL validation + filename derivation (this file currently)
//   Task 3: startDownload / cancelDownload / progress throttling
//   Task 4: cleanupStaleDownloads
//   Task 5: launchInstaller (platform branches)
//   Task 6: getCachedDownload

import type { UpdateInstallErrorCode } from '../shared/update-install-types';

// Domains we'll accept release-asset downloads from. GitHub Releases sometimes
// redirects the download URL from github.com -> objects.githubusercontent.com;
// both need to be allowed. A malicious metadata response that tried to point
// us elsewhere (e.g. an attacker-controlled CDN) would be rejected here.
const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com']);

// Whitelist of extensions we know how to launch. Prevents path-traversal payloads
// that smuggle arbitrary file types into userData/update-cache/.
const ALLOWED_EXTENSIONS_BY_PLATFORM: Record<string, readonly string[]> = {
  win32:  ['.exe'],
  darwin: ['.dmg'],
  linux:  ['.AppImage', '.deb'],
};

export class UpdateInstallError extends Error {
  constructor(public readonly code: UpdateInstallErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'UpdateInstallError';
  }
}

/**
 * Throws UpdateInstallError('url-rejected') if `url` is not HTTPS or its host
 * is outside the GitHub allowlist. Returns the parsed URL on success.
 */
export function validateDownloadUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UpdateInstallError('url-rejected', `malformed url: ${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new UpdateInstallError('url-rejected', `non-https: ${parsed.protocol}`);
  }
  if (!ALLOWED_HOSTS.has(parsed.host)) {
    throw new UpdateInstallError('url-rejected', `host not allowed: ${parsed.host}`);
  }
  return parsed;
}

/**
 * Extracts a safe basename from the URL path (strips query/hash), rejects any
 * path-traversal payload, and enforces a per-platform extension whitelist.
 */
export function deriveDownloadFilename(url: string, platform: NodeJS.Platform): string {
  const parsed = validateDownloadUrl(url);
  // URL pathname is always absolute (leading '/'); last segment after '/' is the filename.
  const rawName = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
  if (!rawName || rawName.includes('..') || rawName.includes('\\')) {
    throw new UpdateInstallError('url-rejected', `unsafe filename: ${rawName}`);
  }
  const allowed = ALLOWED_EXTENSIONS_BY_PLATFORM[platform] ?? [];
  const match = allowed.find(ext => rawName.endsWith(ext));
  if (!match) {
    throw new UpdateInstallError('url-rejected', `extension not allowed for ${platform}: ${rawName}`);
  }
  return rawName;
}
