import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitHubError, MARKER, pullRequestFromEnv, upsertComment, type PullRequestContext } from '../src/github/comment.js';

const ctx: PullRequestContext = { apiUrl: 'https://api.example', token: 't0k', repo: 'acme/app', number: 7 };

/** A fake GitHub issues-comments API that records calls. */
function fakeGitHub(existing: Array<{ id: number; body: string }>, opts: { status?: number } = {}) {
  const calls: Array<{ method: string; url: string; body?: any; auth?: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined, auth: (init.headers as Record<string, string>).authorization });
    if (opts.status) return new Response('nope', { status: opts.status });
    if (method === 'GET') {
      const page = Number(new URL(url).searchParams.get('page'));
      const slice = existing.slice((page - 1) * 100, page * 100).map((c) => ({ ...c, html_url: `https://gh/c/${c.id}` }));
      return Response.json(slice);
    }
    if (method === 'PATCH') return Response.json({ html_url: `https://gh/c/${url.split('/').pop()}` });
    return Response.json({ html_url: 'https://gh/c/new' }, { status: 201 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe('sticky comment', () => {
  it('creates the comment, with the marker, when there is none', async () => {
    const gh = fakeGitHub([{ id: 1, body: 'LGTM' }]);
    expect(await upsertComment(ctx, '### firediff · 1 access change', gh.fetchImpl)).toEqual({ action: 'created', url: 'https://gh/c/new' });
    const post = gh.calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('https://api.example/repos/acme/app/issues/7/comments');
    expect(post.body.body).toBe(`${MARKER}\n### firediff · 1 access change`);
    expect(post.auth).toBe('Bearer t0k');
  });

  it('updates the existing comment in place, even past the first page', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, body: i === 120 ? `${MARKER}\nold` : 'chatter' }));
    const gh = fakeGitHub(many);
    expect(await upsertComment(ctx, 'new report', gh.fetchImpl)).toEqual({ action: 'updated', url: 'https://gh/c/121' });
    expect(gh.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'PATCH']);
    expect(gh.calls.at(-1)!.url).toBe('https://api.example/repos/acme/app/issues/comments/121');
  });

  it('explains a 403 (missing pull-requests: write)', async () => {
    await expect(upsertComment(ctx, 'x', fakeGitHub([], { status: 403 }).fetchImpl)).rejects.toThrow(/pull-requests: write/);
  });

  it('reads the PR from the Actions environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'firediff-gh-'));
    writeFileSync(join(dir, 'event.json'), JSON.stringify({ pull_request: { number: 42 } }));
    expect(pullRequestFromEnv({ GITHUB_TOKEN: 'a', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: join(dir, 'event.json') })).toEqual({
      apiUrl: 'https://api.github.com', token: 'a', repo: 'o/r', number: 42,
    });
    expect(() => pullRequestFromEnv({ GITHUB_REPOSITORY: 'o/r' })).toThrow(GitHubError);
    expect(() => pullRequestFromEnv({ GITHUB_TOKEN: 'a', GITHUB_REPOSITORY: 'o/r' })).toThrow(/pull_request event/);
  });
});
