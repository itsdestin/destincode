/**
 * github-fork-publish.ts — the shared fork → branch → upload → PR pipeline
 * behind "Publish to marketplace" (skills) and "Publish theme".
 *
 * WHY THIS MODULE EXISTS (Phase 3, 2026-07-22 sync-setup overhaul)
 * ----------------------------------------------------------------
 * Both publishers used to shell out to the `gh` CLI with near-identical
 * fork/branch/contents/PR sequences — which dead-ended on any machine without
 * gh (at the product's social pillar), and passed file content as `-f
 * content=<base64>` argv on the skill path, silently breaking on Windows's
 * ~32 KB command-line limit for any file past a few KB. Going through the
 * shared github-client REST surface fixes both classes at once: no gh
 * required (app token or gh token via the client's acquisition order), and
 * request bodies have no argv limit.
 *
 * The client owns all token handling — this module never sees the token, so
 * the hygiene wall (never in errors/logs/argv) holds by construction.
 */

import { getGithubClient, type GithubClient } from './github-client';

export interface PublishFile {
  /** Path inside the repo, e.g. `themes/<slug>/manifest.json`. */
  repoPath: string;
  /** File content, already base64-encoded (the Contents API contract). */
  contentBase64: string;
}

export interface ForkPublishArgs {
  /** e.g. 'itsdestin/wecoded-themes' */
  upstreamRepo: string;
  branchName: string;
  files: PublishFile[];
  prTitle: string;
  /** A string, or a builder receiving the resolved authed login — both
   *  publishers default their Author line to it (old `gh api user` parity). */
  prBody: string | ((username: string) => string);
  client?: GithubClient | null;
  /** Injectable for tests — real default waits between fork-readiness retries. */
  sleepFn?: (ms: number) => Promise<void>;
}

export interface ForkPublishResult {
  prUrl: string;
  prNumber: number;
  /** The authed login — callers reuse it for author fields / cache busting. */
  username: string;
}

/** PR number from a GitHub PR URL; 0 when unparsable (display-only field). */
export function extractPRNumber(prUrl: string): number {
  const m = prUrl.match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : 0;
}

const FORK_READY_RETRIES = 5;
const FORK_READY_DELAY_MS = 2000;

export async function forkPublish(args: ForkPublishArgs): Promise<ForkPublishResult> {
  const client = args.client ?? getGithubClient();
  const sleep = args.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!client) {
    // main.ts registers the client at startup; null here is a wiring
    // regression — but the user still needs an actionable message.
    throw new Error('Not connected to GitHub — connect your GitHub account in the Sync settings');
  }

  // 1. Who are we? (Also the fork owner.) Throws the coded not-connected /
  // sign-in-expired errors — shown verbatim by the publish UIs.
  const username = await client.fetchAuthedLogin();

  const upstream = args.upstreamRepo;
  const forkRepo = `${username}/${upstream.split('/')[1]}`;

  // 2. Ensure the fork exists. POST /forks is idempotent (an existing fork
  // returns 202 with the fork object, same as creation) and ASYNC — a brand
  // new fork can take a few seconds to materialize, which is why branch
  // creation below retries on 404 instead of trusting this response.
  const fork = await client.api('POST', `/repos/${upstream}/forks`);
  if (fork.status >= 400) {
    const detail = fork.json?.message ? `: ${String(fork.json.message)}` : '';
    throw new Error(`Could not fork ${upstream} (HTTP ${fork.status})${detail}`);
  }

  // 3. Upstream default-branch head — the base for our branch.
  const ref = await client.api('GET', `/repos/${upstream}/git/ref/heads/main`);
  const baseSha = ref.json?.object?.sha ? String(ref.json.object.sha) : null;
  if (!baseSha) {
    throw new Error(`Could not read ${upstream} (HTTP ${ref.status}) — check your internet connection and that the repository exists`);
  }

  // 4. Create (or force-reset) the branch on the fork. 404 = the fork from
  // step 2 hasn't finished materializing — retry briefly. 422 = branch
  // already exists (a previous publish attempt) — force it back to base so
  // the upload starts from a clean slate.
  let branchReady = false;
  for (let attempt = 0; attempt < FORK_READY_RETRIES && !branchReady; attempt++) {
    const create = await client.api('POST', `/repos/${forkRepo}/git/refs`, {
      ref: `refs/heads/${args.branchName}`,
      sha: baseSha,
    });
    if (create.status === 201) { branchReady = true; break; }
    if (create.status === 422) {
      const patch = await client.api('PATCH', `/repos/${forkRepo}/git/refs/heads/${args.branchName}`, {
        sha: baseSha,
        force: true,
      });
      if (patch.status === 200) { branchReady = true; break; }
      const detail = patch.json?.message ? `: ${String(patch.json.message)}` : '';
      throw new Error(`Could not prepare the publish branch (HTTP ${patch.status})${detail}`);
    }
    if (create.status === 404) { await sleep(FORK_READY_DELAY_MS); continue; }
    const detail = create.json?.message ? `: ${String(create.json.message)}` : '';
    throw new Error(`Could not create the publish branch (HTTP ${create.status})${detail}`);
  }
  if (!branchReady) {
    throw new Error(`Your fork of ${upstream} is still being created on GitHub — wait a few seconds and try again`);
  }

  // 5. Upload every file via the Contents API. Bodies ride the HTTP request —
  // no argv, no Windows command-line limit. A 422 usually means the file
  // already exists on the branch (previous attempt) → fetch its sha, update.
  for (const file of args.files) {
    const put = await client.api('PUT', `/repos/${forkRepo}/contents/${file.repoPath}`, {
      message: `Add ${file.repoPath}`,
      content: file.contentBase64,
      branch: args.branchName,
    });
    if (put.status === 200 || put.status === 201) continue;
    const existing = await client.api('GET', `/repos/${forkRepo}/contents/${encodeURI(file.repoPath)}?ref=${encodeURIComponent(args.branchName)}`);
    const sha = existing.json?.sha ? String(existing.json.sha) : null;
    if (sha) {
      const update = await client.api('PUT', `/repos/${forkRepo}/contents/${file.repoPath}`, {
        message: `Update ${file.repoPath}`,
        content: file.contentBase64,
        sha,
        branch: args.branchName,
      });
      if (update.status === 200 || update.status === 201) continue;
    }
    const detail = put.json?.message ? ` (${String(put.json.message)})` : '';
    throw new Error(`Failed to upload ${file.repoPath}${detail}`);
  }

  // 6. Open the PR against upstream. 422 "already exists" = a previous
  // attempt's PR is still open — find and return it (success, not failure).
  const pr = await client.api('POST', `/repos/${upstream}/pulls`, {
    title: args.prTitle,
    body: typeof args.prBody === 'function' ? args.prBody(username) : args.prBody,
    head: `${username}:${args.branchName}`,
    base: 'main',
  });
  if (pr.status === 201 && pr.json?.html_url) {
    const prUrl = String(pr.json.html_url);
    return { prUrl, prNumber: typeof pr.json.number === 'number' ? pr.json.number : extractPRNumber(prUrl), username };
  }
  if (pr.status === 422) {
    const list = await client.api('GET', `/repos/${upstream}/pulls?head=${encodeURIComponent(`${username}:${args.branchName}`)}&state=open`);
    const first = Array.isArray(list.json) ? list.json[0] : null;
    if (first?.html_url) {
      return { prUrl: String(first.html_url), prNumber: typeof first.number === 'number' ? first.number : 0, username };
    }
  }
  const detail = pr.json?.message ? `: ${String(pr.json.message)}` : '';
  throw new Error(`Failed to create the pull request (HTTP ${pr.status})${detail}`);
}
