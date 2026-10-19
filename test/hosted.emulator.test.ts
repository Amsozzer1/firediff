// Needs Java 21 and the emulator jar: runs under `pnpm test:emulator`. Skipped otherwise.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { DiffTimeoutError, EmulatorSupervisor, HOSTED_LIMITS, type RunDiff } from '../src/playground/hosted.js';
import { runDiff, startWarmEmulator } from '../src/playground/server.js';
import type { EmulatorProcess } from '../src/run/emulator.js';
import { emulatorFromEnv } from '../src/run/harness.js';
import { fromFile, runPair } from '../src/run/pipeline.js';

const trap = (n: string) => ({ base: readFileSync(`corpus/${n}/base.rules`, 'utf8'), head: readFileSync(`corpus/${n}/head.rules`, 'utf8') });

function listening(pid: number): string[] | null {
  try {
    return execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n').slice(1);
  } catch {
    return null; // no lsof
  }
}

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('hosted playground (emulator)', () => {
  it('stops a comparison between requests when its signal aborts', async () => {
    const pair = () => runPair(fromFile('corpus/trap-03/base.rules'), fromFile('corpus/trap-03/head.rules'), emulatorFromEnv(), {}, ac.signal);
    let ac = new AbortController();
    await pair(); // warm up: a cold first run spends its first few hundred ms opening the projects
    const t0 = performance.now();
    await pair();
    const full = performance.now() - t0;

    ac = new AbortController();
    let abortedAt = 0;
    setTimeout(() => {
      abortedAt = performance.now();
      ac.abort();
    }, full / 4);
    await expect(pair()).rejects.toThrow(/abort/i);
    // Only the request in flight finishes, then the projects are cleared.
    expect(performance.now() - abortedAt).toBeLessThan(full / 2);
  }, 60_000);

  const handles: EmulatorProcess[] = [];
  let hangNext = false;
  const run: RunDiff = (em, b, h, c, signal, onEmulator) =>
    hangNext ? ((hangNext = false), onEmulator?.(), new Promise(() => {})) : runDiff(em, b, h, c, signal, onEmulator);
  const sup = new EmulatorSupervisor(
    async () => {
      const p = await startWarmEmulator();
      handles.push(p);
      return p;
    },
    run,
    HOSTED_LIMITS,
  );
  afterAll(() => sup.stop());

  it('runs trap-01 on its own emulator, bound to localhost, well inside 5 s', async () => {
    await sup.start();
    const t0 = performance.now();
    const r = await sup.diff(trap('trap-01').base, trap('trap-01').head, {});
    expect(r.counts.gained).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(HOSTED_LIMITS.timeoutMs);
    const ports = listening(handles[0]!.pid);
    if (ports) {
      expect(ports.length).toBeGreaterThan(0);
      for (const line of ports) expect(line).toMatch(/127\.0\.0\.1:\d+ \(LISTEN\)/);
    }
  }, 120_000);

  it('after a timeout, kills that emulator and runs the next comparison on a fresh one', async () => {
    hangNext = true;
    await expect(sup.diff('x', 'y', {})).rejects.toBeInstanceOf(DiffTimeoutError);
    const r = await sup.diff(trap('trap-02').base, trap('trap-02').head, {});
    expect(r.counts.requests).toBeGreaterThan(0);
    expect(handles).toHaveLength(2);
    expect(handles[0]!.exited()).toBe(true);
    expect(sup.status()).toMatchObject({ emulator: 'up', restarts: 1 });
  }, 120_000);
});
