// What `firediff playground --hosted` adds for a public server: size and matrix caps, per-address
// rate limits, a bounded queue, a time limit per comparison, and an emulator that gets replaced
// when a run times out, every N runs, when it grows too big, or when it dies.
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { isIPv6 } from 'node:net';
import type { Config } from '../generate/index.js';
import type { EmulatorProcess } from '../run/emulator.js';
import type { EmulatorAddress } from '../run/harness.js';
import type { DiffFn, DiffResult } from './server.js';

export const HOSTED_LIMITS = {
  /** Per rules file. */
  rulesBytes: 64 * 1024,
  configBytes: 8 * 1024,
  /** Generated requests per comparison; bigger matrices are turned away before they run. */
  maxRequests: 600,
  timeoutMs: 5_000,
  /** Comparisons per client address (IPv6: per /64). */
  perMinute: 10,
  perDay: 100,
  /** Comparisons waiting behind the one that's running. */
  queue: 5,
  /** Replace the emulator after this many comparisons, or once it uses more memory than this. */
  restartEvery: 500,
  restartRssBytes: 1.5 * 1024 ** 3,
};

export type HostedLimits = typeof HOSTED_LIMITS;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Past this many tracked addresses, expired ones are dropped, then the oldest. */
const MAX_KEYS = 100_000;

export type Take = { ok: true } | { ok: false; retryAfterSec: number; message: string };

/** Per-key limits: a sliding minute and a day that starts at the key's first request. */
export class RateLimiter {
  private readonly hits = new Map<string, { recent: number[]; dayStart: number; day: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly perDay: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.hits.size;
  }

  take(key: string): Take {
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || t - e.dayStart >= DAY) {
      if (!e && this.hits.size >= MAX_KEYS) this.sweep();
      e = { recent: [], dayStart: t, day: 0 };
      this.hits.set(key, e);
    }
    e.recent = e.recent.filter((x) => t - x < MINUTE);
    if (e.day >= this.perDay) {
      return {
        ok: false,
        retryAfterSec: Math.ceil((e.dayStart + DAY - t) / 1000),
        message: `The hosted playground allows ${this.perDay} comparisons a day per address. Run it locally: npx @amsozzer/firediff playground`,
      };
    }
    if (e.recent.length >= this.perMinute) {
      const wait = Math.ceil((e.recent[0]! + MINUTE - t) / 1000);
      return { ok: false, retryAfterSec: wait, message: `The hosted playground allows ${this.perMinute} comparisons a minute per address. Try again in ${wait} s.` };
    }
    e.recent.push(t);
    e.day++;
    return { ok: true };
  }

  sweep(): void {
    const t = this.now();
    for (const [k, e] of this.hits) if (t - e.dayStart >= DAY) this.hits.delete(k);
    for (const k of this.hits.keys()) {
      if (this.hits.size < MAX_KEYS) break;
      this.hits.delete(k);
    }
  }
}

function ipv6Groups(ip: string): string[] {
  const [head, tail] = ip.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  if (tail === undefined) return h;
  const t = tail ? tail.split(':') : [];
  return [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t];
}

/**
 * The address to rate-limit on. With `ipHeader` (e.g. cf-connecting-ip behind a Cloudflare Tunnel),
 * that header. Behind a reverse proxy (`trustProxy`), the last X-Forwarded-For entry: the one the
 * proxy added, not one the client sent. Otherwise the socket's. IPv6 is grouped by /64.
 */
export function clientKey(req: IncomingMessage, trustProxy: boolean, ipHeader?: string): string {
  let ip = req.socket.remoteAddress ?? '';
  const xff = req.headers['x-forwarded-for'];
  const fromHeader = ipHeader ? req.headers[ipHeader.toLowerCase()] : undefined;
  if (typeof fromHeader === 'string' && fromHeader.trim()) ip = fromHeader.split(',')[0]!.trim();
  else if (trustProxy && typeof xff === 'string' && xff.trim()) ip = xff.split(',').at(-1)!.trim();
  ip = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '').replace(/%.*$/, '');
  if (!isIPv6(ip)) return ip;
  const groups = ipv6Groups(ip).map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16).toString(16) : '0'));
  return `${groups.slice(0, 4).join(':')}::/64`;
}

export class QueueFullError extends Error {
  override name = 'QueueFullError';
}

/** Runs jobs one at a time, with at most `maxWaiting` behind the running one. */
export class RunQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(private readonly maxWaiting: number) {}

  /** Running plus waiting. */
  get size(): number {
    return this.pending;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.pending > this.maxWaiting) return Promise.reject(new QueueFullError(`queue full (${this.pending})`));
    this.pending++;
    const p = this.tail.then(fn).finally(() => {
      this.pending--;
    });
    this.tail = p.catch(() => undefined);
    return p;
  }
}

export class DiffTimeoutError extends Error {
  override name = 'DiffTimeoutError';
  constructor(readonly timeoutMs: number) {
    super(`comparison took longer than ${timeoutMs / 1000} s`);
  }
}

export type EmulatorHandle = Pick<EmulatorProcess, 'address' | 'exit' | 'exited' | 'rssBytes' | 'stop'>;

/** One comparison on a given emulator; it should stop early once `signal` aborts. */
export type RunDiff = (emulator: EmulatorAddress, base: string, head: string, config: Config, signal?: AbortSignal) => Promise<DiffResult>;

export interface SupervisorStatus {
  emulator: 'up' | 'starting' | 'down';
  runs: number;
  restarts: number;
  rssBytes: number | null;
}

/**
 * Owns the emulator behind the hosted playground. A comparison that runs past `timeoutMs` is
 * aborted and its emulator replaced in the background; the next comparison waits for the new one
 * before its own clock starts. Callers serialize comparisons (see RunQueue).
 */
export class EmulatorSupervisor {
  private current: Promise<EmulatorHandle> | null = null;
  private handle: EmulatorHandle | null = null;
  private state: SupervisorStatus['emulator'] = 'down';
  private runsOnThis = 0;
  private runs = 0;
  private restarts = 0;
  private stopping = false;

  constructor(
    private readonly startEmulator: () => Promise<EmulatorHandle>,
    private readonly runDiff: RunDiff,
    private readonly limits: Pick<HostedLimits, 'timeoutMs' | 'restartEvery' | 'restartRssBytes'>,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** Start the first emulator (otherwise the first comparison does). */
  async start(): Promise<void> {
    await this.ready();
  }

  readonly diff: DiffFn = async (base, head, config) => {
    const em = await this.ready();
    const ac = new AbortController();
    const run = this.runDiff(em.address, base, head, config, ac.signal);
    run.catch(() => undefined); // an abandoned run may still reject later
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DiffTimeoutError(this.limits.timeoutMs)), this.limits.timeoutMs);
    });
    try {
      return await Promise.race([run, timedOut]);
    } catch (e) {
      if (e instanceof DiffTimeoutError) {
        ac.abort(e);
        if (this.handle === em) this.restart('a comparison timed out');
      }
      throw e;
    } finally {
      clearTimeout(timer);
      this.runs++;
      this.runsOnThis++;
      if (this.handle === em && !em.exited()) {
        const rss = em.rssBytes();
        if (this.runsOnThis >= this.limits.restartEvery) this.restart(`${this.runsOnThis} comparisons`);
        else if (rss !== null && rss > this.limits.restartRssBytes) this.restart(`emulator at ${Math.round(rss / 2 ** 20)} MB`);
      }
    }
  };

  status(): SupervisorStatus {
    const up = this.handle !== null && !this.handle.exited();
    return {
      emulator: up ? 'up' : this.state === 'down' ? 'down' : 'starting',
      runs: this.runs,
      restarts: this.restarts,
      rssBytes: up ? this.handle!.rssBytes() : null,
    };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.handle = null;
    await this.current?.then(
      (h) => h.stop(),
      () => undefined,
    );
  }

  private ready(): Promise<EmulatorHandle> {
    if (this.handle?.exited()) this.restart('the emulator exited');
    else if (!this.current || this.state === 'down') this.current = this.launch();
    return this.current!;
  }

  private launch(): Promise<EmulatorHandle> {
    this.state = 'starting';
    const p = this.startEmulator().then(
      (h) => {
        this.handle = h;
        this.runsOnThis = 0;
        this.state = 'up';
        void h.exit.then(() => {
          if (this.handle === h && !this.stopping) this.restart('the emulator exited');
        });
        return h;
      },
      (e: unknown) => {
        this.state = 'down';
        this.log(`emulator failed to start: ${(e as Error).message}`);
        throw e;
      },
    );
    p.catch(() => undefined); // reported to the comparison waiting on it
    return p;
  }

  private restart(reason: string): void {
    if (this.stopping) return;
    const old = this.handle;
    this.handle = null;
    this.restarts++;
    this.state = 'starting';
    this.log(`restarting the emulator: ${reason}`);
    const p = (old ? old.stop().catch(() => undefined) : Promise.resolve()).then(() => this.launch());
    p.catch(() => undefined);
    this.current = p;
  }
}

/** The host's available memory as a share of the total (Linux; null elsewhere). In a container this is the VM's. */
export function hostMemory(): { availableRatio: number | null } {
  try {
    const info = readFileSync('/proc/meminfo', 'utf8');
    const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(info)?.[1]);
    const ratio = kb('MemAvailable') / kb('MemTotal');
    return { availableRatio: Number.isFinite(ratio) ? ratio : null };
  } catch {
    return { availableRatio: null };
  }
}

export interface Health {
  ok: boolean;
  problems: string[];
  [k: string]: unknown;
}

/** What /healthz reports: not ok when the emulator is down, the machine is low on memory, or the emulator is too big. */
export function healthReport(s: SupervisorStatus, mem: { availableRatio: number | null }, limits: Pick<HostedLimits, 'restartRssBytes'>): Health {
  const problems: string[] = [];
  if (s.emulator === 'down') problems.push('emulator down');
  if (mem.availableRatio !== null && mem.availableRatio < 0.1) problems.push(`low memory: ${Math.round(mem.availableRatio * 100)}% available`);
  if (s.rssBytes !== null && s.rssBytes > limits.restartRssBytes) problems.push(`emulator at ${Math.round(s.rssBytes / 2 ** 20)} MB`);
  return {
    ok: problems.length === 0,
    problems,
    emulator: s.emulator,
    runs: s.runs,
    restarts: s.restarts,
    emulatorMB: s.rssBytes === null ? null : Math.round(s.rssBytes / 2 ** 20),
    memoryAvailablePct: mem.availableRatio === null ? null : Math.round(mem.availableRatio * 100),
  };
}
