import fs from 'fs';
import path from 'path';
import { normalizeRepoUrl, RepoUrlInfo } from './project/repo-url';

export interface RepoInfo extends Partial<RepoUrlInfo> { hasRepo: boolean; remoteUrl?: string }

// WHY: read .git/config directly (no git spawn) and reuse the pure normalizer.
// Returns hasRepo:false when there is no .git, no origin remote, or the remote
// is not a GitHub URL we can build a webUrl for.
export async function getRepoInfo(projectPath: string): Promise<RepoInfo> {
  try {
    const cfg = await fs.promises.readFile(path.join(projectPath, '.git', 'config'), 'utf8');
    // Find [remote "origin"] ... url = <value>
    const block = /\[remote "origin"\][^[]*/s.exec(cfg)?.[0] ?? '';
    const url = /url\s*=\s*(.+)/.exec(block)?.[1]?.trim();
    if (!url) return { hasRepo: false };
    const info = normalizeRepoUrl(url);
    if (!info) return { hasRepo: true, remoteUrl: url };
    return { hasRepo: true, remoteUrl: url, ...info };
  } catch {
    return { hasRepo: false };
  }
}
