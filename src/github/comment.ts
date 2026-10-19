import { readFileSync } from 'node:fs';

/** Hidden marker that identifies firediff's comment, so each run updates it instead of adding another. */
export const MARKER = '<!-- firediff:sticky -->';

export class GitHubError extends Error {
  override name = 'GitHubError';
}

export interface PullRequestContext {
  apiUrl: string;
  token: string;
  /** owner/name */
  repo: string;
  number: number;
}

type Fetch = typeof fetch;

/** The pull request this Actions run is for, from GITHUB_EVENT_PATH and friends. */
export function pullRequestFromEnv(env: NodeJS.ProcessEnv = process.env): PullRequestContext {
  const token = env.FIREDIFF_GITHUB_TOKEN || env.GITHUB_TOKEN;
  if (!token) throw new GitHubError('--comment needs GITHUB_TOKEN (or FIREDIFF_GITHUB_TOKEN)');
  const repo = env.GITHUB_REPOSITORY;
  if (!repo) throw new GitHubError('--comment needs GITHUB_REPOSITORY (run it inside GitHub Actions)');
  let number = Number(env.FIREDIFF_PR_NUMBER);
  if (!number && env.GITHUB_EVENT_PATH) {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as { pull_request?: { number?: number }; number?: number };
    number = Number(event.pull_request?.number ?? event.number);
  }
  if (!number) throw new GitHubError('--comment needs a pull_request event (or FIREDIFF_PR_NUMBER)');
  return { apiUrl: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, ''), token, repo, number };
}

async function api(ctx: PullRequestContext, fetchImpl: Fetch, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetchImpl(`${ctx.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ctx.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const hint = res.status === 403 ? ' (does the workflow grant `permissions: pull-requests: write`?)' : '';
    throw new GitHubError(`GitHub API ${method} ${path} → ${res.status}${hint}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Create firediff's comment on the PR, or update it in place if an earlier run left one. */
export async function upsertComment(
  ctx: PullRequestContext,
  markdown: string,
  fetchImpl: Fetch = fetch,
): Promise<{ action: 'created' | 'updated'; url: string }> {
  const body = `${MARKER}\n${markdown}`;
  for (let page = 1; page <= 20; page++) {
    const comments: Array<{ id: number; body?: string; html_url: string }> = await api(
      ctx,
      fetchImpl,
      'GET',
      `/repos/${ctx.repo}/issues/${ctx.number}/comments?per_page=100&page=${page}`,
    );
    const mine = comments.find((c) => c.body?.includes(MARKER));
    if (mine) {
      const updated = await api(ctx, fetchImpl, 'PATCH', `/repos/${ctx.repo}/issues/comments/${mine.id}`, { body });
      return { action: 'updated', url: updated?.html_url ?? mine.html_url };
    }
    if (comments.length < 100) break;
  }
  const created = await api(ctx, fetchImpl, 'POST', `/repos/${ctx.repo}/issues/${ctx.number}/comments`, { body });
  return { action: 'created', url: created.html_url };
}
