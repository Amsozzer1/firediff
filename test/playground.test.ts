import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listen, type DiffFn } from '../src/playground/server.js';

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
