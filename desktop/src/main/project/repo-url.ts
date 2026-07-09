// Pure normalizer: a git remote URL → GitHub owner/name/webUrl, or null when
// the remote is not a recognizable GitHub repo. No I/O — unit-testable.
export interface RepoUrlInfo { owner: string; name: string; webUrl: string; }

export function normalizeRepoUrl(remote: string): RepoUrlInfo | null {
  const trimmed = (remote || '').trim();
  // ssh: git@github.com:owner/name(.git)
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  // https: https://github.com/owner/name(.git)
  const https = /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  const m = ssh || https;
  if (!m) return null;
  const owner = m[1];
  const name = m[2];
  if (!owner || !name) return null;
  return { owner, name, webUrl: `https://github.com/${owner}/${name}` };
}
