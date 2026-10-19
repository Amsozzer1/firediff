import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  clientKey,
  DiffTimeoutError,
  EmulatorSupervisor,
  healthReport,
  HOSTED_LIMITS,
  QueueFullError,
  RateLimiter,
  RunQueue,
  type EmulatorHandle,
  type RunDiff,
} from '../src/playground/hosted.js';
import { emulatorArgs } from '../src/run/emulator.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const result = (port: number) => ({ markdown: `ran on ${port}`, counts: { gained: 0, lost: 0, requests: 1 } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('hosted limits', () => {
  it('match the decided defaults', () => {
    expect(HOSTED_LIMITS).toEqual({
      rulesBytes: 64 * 1024,
      configBytes: 8 * 1024,
      maxRequests: 600,
      timeoutMs: 5_000,
      perMinute: 10,
      perDay: 100,
      queue: 5,
      restartEvery: 500,
      restartRssBytes: 1.5 * 1024 ** 3,
    });
  });

  it('keep the emulator on localhost', () => {
    const args = emulatorArgs('/x.jar', 9000, 9001);
    expect(args[args.indexOf('--host') + 1]).toBe('127.0.0.1');
    expect(args).not.toContain('0.0.0.0');
  });
});

describe('RateLimiter', () => {
  it('allows 10 a minute per address, then says when to come back', () => {
    let t = 1_000_000;
    const rl = new RateLimiter(10, 100, () => t);
    for (let i = 0; i < 10; i++) {
      expect(rl.take('a').ok).toBe(true);
      t += 1_000;
    }
    const no = rl.take('a');
    expect(no).toMatchObject({ ok: false, retryAfterSec: 50 });
    expect(rl.take('b').ok).toBe(true);
    t += 50_000;
    expect(rl.take('a').ok).toBe(true);
  });

  it('allows 100 a day per address', () => {
    let t = 0;
    const rl = new RateLimiter(10, 100, () => t);
    for (let i = 0; i < 100; i++) {
      expect(rl.take('a').ok).toBe(true);
      t += 10_000;
    }
    const no = rl.take('a');
    expect(no.ok).toBe(false);
    if (!no.ok) expect(no.message).toMatch(/100 comparisons a day/);
    t = DAY;
    expect(rl.take('a').ok).toBe(true);
  });

  it('forgets old addresses, so the table stays small', () => {
    let t = 0;
    const rl = new RateLimiter(10, 100, () => t);
    for (let i = 0; i < 50; i++) rl.take(`ip${i}`);
    t = DAY + 1;
    rl.sweep();
    expect(rl.size).toBe(0);
  });
});

describe('clientKey', () => {
  const req = (remoteAddress: string, xff?: string) =>
    ({ socket: { remoteAddress }, headers: xff ? { 'x-forwarded-for': xff } : {} }) as unknown as IncomingMessage;

  it('uses the socket address unless told to trust the proxy', () => {
    expect(clientKey(req('203.0.113.7', '198.51.100.1'), false)).toBe('203.0.113.7');
    expect(clientKey(req('::ffff:203.0.113.7'), false)).toBe('203.0.113.7');
  });

  it('behind the proxy, takes the address the proxy added (the last one), not one the client sent', () => {
    expect(clientKey(req('172.18.0.3', '6.6.6.6, 198.51.100.1'), true)).toBe('198.51.100.1');
    expect(clientKey(req('172.18.0.3', '198.51.100.1'), true)).toBe('198.51.100.1');
    expect(clientKey(req('172.18.0.3'), true)).toBe('172.18.0.3');
  });

  it('with an IP header (Cloudflare: cf-connecting-ip), uses that and ignores X-Forwarded-For', () => {
    const cf = (ip: string | undefined, xff?: string) =>
      ({ socket: { remoteAddress: '172.18.0.3' }, headers: { ...(ip ? { 'cf-connecting-ip': ip } : {}), ...(xff ? { 'x-forwarded-for': xff } : {}) } }) as unknown as IncomingMessage;
    expect(clientKey(cf('198.51.100.1', '6.6.6.6'), false, 'cf-connecting-ip')).toBe('198.51.100.1');
    expect(clientKey(cf('2001:db8:1:2::9'), false, 'cf-connecting-ip')).toBe('2001:db8:1:2::/64');
    expect(clientKey(cf(undefined, '6.6.6.6'), false, 'cf-connecting-ip')).toBe('172.18.0.3');
  });

  it('groups IPv6 by /64, since one user gets a whole /64', () => {
    expect(clientKey(req('2001:db8:1:2:aaaa::1'), false)).toBe('2001:db8:1:2::/64');
    expect(clientKey(req('2001:db8:1:2:ffff:ffff:ffff:ffff'), false)).toBe('2001:db8:1:2::/64');
    expect(clientKey(req('2001:db8::1'), false)).toBe('2001:db8:0:0::/64');
    expect(clientKey(req('::1'), false)).toBe('0:0:0:0::/64');
  });
});

describe('RunQueue', () => {
  it('runs one at a time, holds 5 more, and turns away the rest', async () => {
    const q = new RunQueue(5);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const releases: Array<() => void> = [];
    const job = (i: number) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise<void>((r) => releases.push(r));
      order.push(i);
      running--;
      return i;
    };
    const accepted = [0, 1, 2, 3, 4, 5].map((i) => q.run(job(i)));
    expect(q.size).toBe(6);
    await expect(q.run(job(6))).rejects.toBeInstanceOf(QueueFullError);
    for (let i = 0; i < 6; i++) {
      await sleep(1);
      releases.shift()!();
    }
    expect(await Promise.all(accepted)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(1);
    expect(q.size).toBe(0);
  });

  it('keeps going after a job fails', async () => {
    const q = new RunQueue(5);
    await expect(q.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await q.run(async () => 'next')).toBe('next');
  });
});

/** Fake emulators: each start() hands out the next port. */
function fakeEmulators(opts: { startDelayMs?: number[]; failStarts?: number[] } = {}) {
  const started: Array<EmulatorHandle & { stopped: boolean; dead: boolean; rss: number; kill(): void }> = [];
  let calls = 0;
  const start = async () => {
    const n = calls++;
    await sleep(opts.startDelayMs?.[n] ?? 0);
    if (opts.failStarts?.includes(n)) throw new Error(`start ${n} failed`);
    let died = () => {};
    const em = {
      address: { host: '127.0.0.1', port: 9000 + started.length },
      stopped: false,
      dead: false,
      rss: 100e6,
      exit: new Promise<void>((r) => (died = r)),
      kill() {
        this.dead = true;
        died();
      },
      exited() {
        return this.dead;
      },
      rssBytes() {
        return this.rss;
      },
      async stop() {
        this.stopped = true;
        this.kill();
      },
    };
    started.push(em);
    return em;
  };
  return { started, start };
}

const limits = { timeoutMs: 50, restartEvery: 500, restartRssBytes: 1.5 * 1024 ** 3 };
const quick: RunDiff = async (em) => result(em.port);

describe('EmulatorSupervisor', () => {
  it('runs comparisons on the emulator it started', async () => {
    const f = fakeEmulators();
    const sup = new EmulatorSupervisor(f.start, quick, limits);
    await sup.start();
    expect(await sup.diff('b', 'h', {})).toEqual(result(9000));
    expect(sup.status()).toMatchObject({ emulator: 'up', runs: 1, restarts: 0 });
    await sup.stop();
    expect(f.started[0]!.stopped).toBe(true);
  });

  it('gives up after the timeout, aborts the run, and restarts the emulator in the background', async () => {
    const f = fakeEmulators();
    let signal: AbortSignal | undefined;
    const hang: RunDiff = async (em, _b, _h, _c, s, onEmulator) => {
      if (em.port !== 9000) return result(em.port);
      signal = s;
      onEmulator?.();
      return new Promise(() => {});
    };
    const sup = new EmulatorSupervisor(f.start, hang, limits);
    await sup.start();
    const t0 = Date.now();
    await expect(sup.diff('b', 'h', {})).rejects.toBeInstanceOf(DiffTimeoutError);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(signal!.aborted).toBe(true);
    expect(await sup.diff('b', 'h', {})).toEqual(result(9001));
    expect(f.started[0]!.stopped).toBe(true);
    expect(sup.status().restarts).toBe(1);
  });

  it("doesn't restart the emulator when the run timed out before using it (e.g. while parsing)", async () => {
    const f = fakeEmulators();
    const parsing: RunDiff = async () => new Promise(() => {});
    const sup = new EmulatorSupervisor(f.start, parsing, limits);
    await sup.start();
    await expect(sup.diff('b', 'h', {})).rejects.toBeInstanceOf(DiffTimeoutError);
    expect(sup.status()).toMatchObject({ emulator: 'up', restarts: 0 });
    expect(f.started).toHaveLength(1);
  });

  it("doesn't count the restart against the next comparison's timeout", async () => {
    const f = fakeEmulators({ startDelayMs: [0, 200] });
    const first: RunDiff = async (em, _b, _h, _c, _s, onEmulator) => (em.port === 9000 ? (onEmulator?.(), new Promise(() => {})) : result(em.port));
    const sup = new EmulatorSupervisor(f.start, first, limits);
    await sup.start();
    await expect(sup.diff('b', 'h', {})).rejects.toBeInstanceOf(DiffTimeoutError);
    expect(await sup.diff('b', 'h', {})).toEqual(result(9001));
  });

  it('restarts every N runs', async () => {
    const f = fakeEmulators();
    const sup = new EmulatorSupervisor(f.start, quick, { ...limits, restartEvery: 3 });
    await sup.start();
    const ports: number[] = [];
    for (let i = 0; i < 7; i++) ports.push(Number((await sup.diff('b', 'h', {})).markdown.split(' ').pop()));
    expect(ports).toEqual([9000, 9000, 9000, 9001, 9001, 9001, 9002]);
    expect(f.started[0]!.stopped && f.started[1]!.stopped).toBe(true);
  });

  it('restarts when the emulator grows past the memory limit', async () => {
    const f = fakeEmulators();
    const sup = new EmulatorSupervisor(f.start, quick, limits);
    await sup.start();
    await sup.diff('b', 'h', {});
    f.started[0]!.rss = 1.6 * 1024 ** 3;
    await sup.diff('b', 'h', {});
    expect((await sup.diff('b', 'h', {})).markdown).toBe('ran on 9001');
  });

  it('replaces an emulator that died, without waiting for a comparison', async () => {
    const f = fakeEmulators();
    const sup = new EmulatorSupervisor(f.start, quick, limits);
    await sup.start();
    f.started[0]!.kill();
    await sleep(5);
    expect(f.started).toHaveLength(2);
    expect(sup.status()).toMatchObject({ emulator: 'up', restarts: 1 });
    expect((await sup.diff('b', 'h', {})).markdown).toBe('ran on 9001');
  });

  it('reports a failed start, then tries again on the next comparison', async () => {
    const f = fakeEmulators({ failStarts: [1] });
    const sup = new EmulatorSupervisor(f.start, quick, { ...limits, restartEvery: 1 });
    await sup.start();
    await sup.diff('b', 'h', {});
    await expect(sup.diff('b', 'h', {})).rejects.toThrow(/start 1 failed/);
    expect(sup.status().emulator).toBe('down');
    expect((await sup.diff('b', 'h', {})).markdown).toBe('ran on 9001');
  });
});

describe('healthReport', () => {
  const up = { emulator: 'up' as const, runs: 3, restarts: 0, rssBytes: 600 * 1024 ** 2 };
  it('is ok while the emulator is up and memory is fine', () => {
    expect(healthReport(up, { availableRatio: 0.5 }, HOSTED_LIMITS)).toMatchObject({ ok: true });
    expect(healthReport({ ...up, emulator: 'starting' }, { availableRatio: null }, HOSTED_LIMITS).ok).toBe(true);
  });
  it('fails when the emulator is down, the machine is low on memory, or the emulator is too big', () => {
    expect(healthReport({ ...up, emulator: 'down' }, { availableRatio: 0.5 }, HOSTED_LIMITS)).toMatchObject({ ok: false, problems: ['emulator down'] });
    expect(healthReport(up, { availableRatio: 0.05 }, HOSTED_LIMITS)).toMatchObject({ ok: false, problems: ['low memory: 5% available'] });
    expect(healthReport({ ...up, rssBytes: 2 * 1024 ** 3 }, { availableRatio: 0.5 }, HOSTED_LIMITS).ok).toBe(false);
  });
});
