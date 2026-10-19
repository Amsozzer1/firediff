import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RulesParseError } from '../src/parse/index.js';
import { DiffTimeoutError } from '../src/playground/hosted.js';
import { TooManyRequestsError } from '../src/playground/worker.js';
import { listen, type DiffFn, type PlaygroundOptions } from '../src/playground/server.js';

const rules = (cond: string) => `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} { allow read: if ${cond}; }
  }
}`;

let server: Server;
let base = '';
const calls: Array<[string, string, unknown]> = [];
// Stand-in for the emulator run: one fake gained row, so the page logic is tested without Java.
const diff: DiffFn = async (b, h, config) => {
  calls.push([b, h, config]);
  return { markdown: '### firediff · 1 access change\n\n| Who | Can now | On |\n|---|---|---|\n| any signed-in user | read another user\'s doc | `users/{uid}` |\n', counts: { gained: 1, lost: 0, requests: 12 } };
};

beforeAll(async () => {
  server = await listen(diff, 0, '127.0.0.1');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (body: unknown) => fetch(`${base}/api/diff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('playground', () => {
  it('serves the page with both editors and no external resources', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<textarea id="base"');
    expect(html).toContain('<textarea id="head"');
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)="https?:/);
  });

  it('runs a comparison and returns markdown, rendered HTML and counts', async () => {
    const res = await post({ base: rules('request.auth.uid == uid'), head: rules('request.auth != null'), config: 'claims:\n  plan: [pro]\n' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toEqual({ gained: 1, lost: 0, requests: 12 });
    expect(body.html).toContain('<table>');
    expect(body.html).toContain('<code>users/{uid}</code>');
    expect(calls.at(-1)![2]).toEqual({ claims: { plan: ['pro'] } });
  });

  it('explains a failed comparison from its status when a proxy replaced the body (Cloudflare does for 504)', async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("if (code === 504) return 'This comparison took longer than the time limit.");
    expect(html).toContain('try { body = await res.json(); } catch {}');
  });

  it('returns parse errors with line:col, before running anything', async () => {
    const before = calls.length;
    const res = await post({ base: rules('request.auth.uid == '), head: rules('true') });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/^base\.rules:4:\d+: /);
    expect(body.line).toBe(4);
    expect(calls.length).toBe(before);
  });

  it('rejects bad input and config', async () => {
    expect((await post({ base: 1, head: 'x' })).status).toBe(400);
    expect((await fetch(`${base}/api/diff`, { method: 'POST', body: 'not json' })).status).toBe(400);
    const bad = await post({ base: rules('true'), head: rules('true'), config: 'nope: 1\n' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/invalid config/);
    expect((await fetch(`${base}/api/diff`)).status).toBe(405);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe('playground --hosted', () => {
  const servers: Server[] = [];
  afterAll(() => Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))));

  async function start(d: DiffFn, hosted: PlaygroundOptions['hosted']) {
    const s = await listen(d, 0, '127.0.0.1', { hosted });
    servers.push(s);
    const url = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    return {
      url,
      post: (body: unknown, headers: Record<string, string> = {}) =>
        fetch(`${url}/api/diff`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    };
  }
  const ok: DiffFn = async () => ({ markdown: 'ok', counts: { gained: 0, lost: 0, requests: 1 } });
  const small = { base: rules('false'), head: rules('true') };

  it('says on the page that it runs on a server and stores nothing', async () => {
    const s = await start(ok, {});
    const html = await (await fetch(`${s.url}/`)).text();
    expect(html).toMatch(/nothing is stored/i);
    expect(html).not.toMatch(/local emulator/);
  });

  it('rejects rules over 64 KB and config over 8 KB with 413, before running', async () => {
    let ran = 0;
    const s = await start(async (...a) => (ran++, ok(...a)), {});
    const big = rules('true') + '\n//' + 'x'.repeat(64 * 1024);
    const r1 = await s.post({ base: big, head: small.head });
    expect(r1.status).toBe(413);
    expect((await r1.json()).error).toMatch(/base\.rules is 65 KB.*up to 64 KB.*npx @amsozzer\/firediff/);
    const r2 = await s.post({ ...small, config: '#' + 'x'.repeat(8 * 1024) });
    expect(r2.status).toBe(413);
    expect((await r2.json()).error).toMatch(/firediff\.yml.*up to 8 KB/);
    expect(ran).toBe(0);
    expect((await s.post(small)).status).toBe(200);
  });

  it('answers 413 when the comparison reports a matrix over the request cap', async () => {
    const s = await start(async () => Promise.reject(new TooManyRequestsError(32, 3)), { limits: { maxRequests: 3 } });
    const r = await s.post(small);
    expect(r.status).toBe(413);
    expect((await r.json()).error).toMatch(/need 32 requests; the hosted playground runs up to 3\. Run it locally: npx @amsozzer\/firediff/);
  });

  it("doesn't parse rules on the main thread (the comparison does, off it), but reports its parse errors as 400", async () => {
    const s = await start(async () => Promise.reject(new RulesParseError('head.rules', 4, 7, "mismatched input")), {});
    const r = await s.post({ base: 'not rules', head: 'not rules either' });
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: "head.rules:4:7: mismatched input", line: 4, column: 7 });
  });

  it('rate limits per address: 10 a minute, with Retry-After', async () => {
    let t = 0;
    const s = await start(ok, { now: () => t });
    for (let i = 0; i < 10; i++) expect((await s.post(small)).status).toBe(200);
    const r = await s.post(small);
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('60');
    expect((await r.json()).error).toMatch(/10 comparisons a minute/);
    t += 60_000;
    expect((await s.post(small)).status).toBe(200);
  });

  it('keys the limit on X-Forwarded-For only with --trust-proxy', async () => {
    const s = await start(ok, { limits: { perMinute: 1 }, trustProxy: true });
    expect((await s.post(small, { 'x-forwarded-for': '198.51.100.1' })).status).toBe(200);
    expect((await s.post(small, { 'x-forwarded-for': '198.51.100.2' })).status).toBe(200);
    expect((await s.post(small, { 'x-forwarded-for': '198.51.100.1' })).status).toBe(429);
    const u = await start(ok, { limits: { perMinute: 1 } });
    expect((await u.post(small, { 'x-forwarded-for': '198.51.100.1' })).status).toBe(200);
    expect((await u.post(small, { 'x-forwarded-for': '198.51.100.2' })).status).toBe(429);
  });

  it('keys the limit on --ip-header when given', async () => {
    const s = await start(ok, { limits: { perMinute: 1 }, ipHeader: 'cf-connecting-ip' });
    expect((await s.post(small, { 'cf-connecting-ip': '198.51.100.1' })).status).toBe(200);
    expect((await s.post(small, { 'cf-connecting-ip': '198.51.100.2', 'x-forwarded-for': '198.51.100.1' })).status).toBe(200);
    expect((await s.post(small, { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.3' })).status).toBe(429);
  });

  it('runs one comparison at a time with 5 waiting, and answers 429 past that', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let running = 0;
    let peak = 0;
    const slow: DiffFn = async (...a) => {
      running++;
      peak = Math.max(peak, running);
      await gate;
      running--;
      return ok(...a);
    };
    const s = await start(slow, {});
    const all = Array.from({ length: 7 }, () => s.post(small));
    const first = await Promise.race(all);
    expect(first.status).toBe(429);
    expect((await first.json()).error).toMatch(/busy/);
    release();
    const statuses = (await Promise.all(all)).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 429]);
    expect(peak).toBe(1);
  });

  it('answers 504 when the comparison runs past the time limit', async () => {
    const s = await start(async () => Promise.reject(new DiffTimeoutError(5_000)), {});
    const r = await s.post(small);
    expect(r.status).toBe(504);
    expect((await r.json()).error).toMatch(/longer than 5 s.*npx @amsozzer\/firediff/);
  });

  it('serves /healthz from the health check, 503 when it fails', async () => {
    let healthy = true;
    const s = await start(ok, { health: () => ({ ok: healthy, problems: healthy ? [] : ['emulator down'] }) });
    const good = await fetch(`${s.url}/healthz`);
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ok: true, problems: [] });
    healthy = false;
    expect((await fetch(`${s.url}/healthz`)).status).toBe(503);
  });

  it('sends a content security policy that only allows the page itself', async () => {
    const s = await start(ok, {});
    const csp = (await fetch(`${s.url}/`)).headers.get('content-security-policy')!;
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toMatch(/unsafe-inline'[^;]*script|script-src[^;]*unsafe-inline/);
    expect(csp).toMatch(/connect-src 'self'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
  });
});
