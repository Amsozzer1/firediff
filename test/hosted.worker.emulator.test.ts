// Needs a running Firestore emulator and the built bundle (pnpm build): runs under `pnpm test:emulator`.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RulesParseError } from '../src/parse/index.js';
import { runDiff } from '../src/playground/server.js';
import { TooManyRequestsError, workerRunDiff } from '../src/playground/worker.js';
import { emulatorFromEnv } from '../src/run/harness.js';

const bundle = resolve('dist/cli/index.js');
const trap = (n: string) => [readFileSync(`corpus/${n}/base.rules`, 'utf8'), readFileSync(`corpus/${n}/head.rules`, 'utf8')] as const;

/** Rules that are cheap to send and slow to parse and plan: big list literals, called many times. */
function slowRules(): string {
  const list = Array.from({ length: 7000 }, (_, i) => `'${i}'`).join(',');
  const calls = Array.from({ length: 12 }, (_, k) => `!blocked(id + '${k}')`).join(' && ');
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function blocked(p) { return [${list}].hasAny([p]); }
    match /c0/{id} { allow read, write: if request.auth != null && ${calls}; }
  }
}`;
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST || !existsSync(bundle))('hosted comparisons in a worker (emulator)', () => {
  it('gives the same result as running in-process', async () => {
    const [b, h] = trap('trap-01');
    let touched = false;
    const r = await workerRunDiff(bundle, 150)(emulatorFromEnv(), b, h, {}, undefined, () => (touched = true));
    expect(r).toEqual(await runDiff(emulatorFromEnv(), b, h, {}));
    expect(touched).toBe(true);
  }, 60_000);

  it('keeps the worker loaded between runs, and replaces it after an abort', async () => {
    const [b, h] = trap('trap-01');
    const run = workerRunDiff(bundle, 150);
    await run.ready();
    const first = await run(emulatorFromEnv(), b, h, {});
    expect(await run(emulatorFromEnv(), b, h, {})).toEqual(first);
    const ac = new AbortController();
    const aborted = run(emulatorFromEnv(), slowRules(), slowRules(), {}, ac.signal);
    setTimeout(() => ac.abort(new Error('stop')), 200);
    await expect(aborted).rejects.toThrow('stop');
    expect(await run(emulatorFromEnv(), b, h, {})).toEqual(first);
    await run.close();
  }, 60_000);

  it('recycles the worker every N comparisons', async () => {
    const [b, h] = trap('trap-02');
    const run = workerRunDiff(bundle, 150, { recycleEvery: 2 });
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await run(emulatorFromEnv(), b, h, {}));
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    await run.close();
  }, 60_000);

  it('reports parse errors with line and column', async () => {
    const [b] = trap('trap-01');
    const err = await workerRunDiff(bundle, 150)(emulatorFromEnv(), b, 'rules_version = ', {}).catch((e) => e);
    expect(err).toBeInstanceOf(RulesParseError);
    expect(err.file).toBe('head.rules');
    expect(err.line).toBe(1);
  }, 60_000);

  it('turns away a matrix over the cap before touching the emulator', async () => {
    const [b, h] = trap('trap-01');
    let touched = false;
    const err = await workerRunDiff(bundle, 3)(emulatorFromEnv(), b, h, {}, undefined, () => (touched = true)).catch((e) => e);
    expect(err).toBeInstanceOf(TooManyRequestsError);
    expect(err.requests).toBe(32);
    expect(touched).toBe(false);
  }, 60_000);

  it('kills a slow parse on abort, and the main thread never stalls', async () => {
    const slow = slowRules();
    const ac = new AbortController();
    let last = performance.now();
    let worst = 0;
    const tick = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 20);
    let abortedAt = 0;
    setTimeout(() => {
      abortedAt = performance.now();
      ac.abort(new Error('time is up'));
    }, 1_000);
    const err = await workerRunDiff(bundle, 150)(emulatorFromEnv(), slow, slow, {}, ac.signal).catch((e) => e);
    clearInterval(tick);
    expect(err.message).toBe('time is up');
    expect(performance.now() - abortedAt).toBeLessThan(500);
    expect(worst).toBeLessThan(250);
  }, 60_000);
});
