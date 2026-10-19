// Hosted comparisons run in a worker thread. Parsing and planning a hostile 64 KB rules file can
// take seconds of CPU; on the main thread that would stall every other request, /healthz, and the
// time limit itself. In a worker, the main thread stays free and a timeout terminates the work.
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { buildPlan, expandCases, type Config } from '../generate/index.js';
import { parseRules, RulesParseError } from '../parse/index.js';
import type { EmulatorAddress } from '../run/harness.js';
import { TooManyRequestsError, type RunDiff } from './hosted.js';
import { runDiff, type DiffResult } from './server.js';

const MARK = 'firediffComparisonWorker';

export { TooManyRequestsError };

interface Job {
  emulator: EmulatorAddress;
  base: string;
  head: string;
  config: Config;
  maxRequests: number;
}

type Message =
  | { kind: 'emulator' }
  | { kind: 'done'; result: DiffResult }
  | { kind: 'too-many'; requests: number }
  | { kind: 'parse-error'; file: string; line: number; column: number; reason: string }
  | { kind: 'error'; message: string };

/** In the worker: parse, check the request cap, then compare. */
async function serve(job: Job, post: (m: Message) => void): Promise<void> {
  try {
    const base = parseRules(job.base, 'base.rules');
    const head = parseRules(job.head, 'head.rules');
    const requests = expandCases(buildPlan(base, head, job.config)).length;
    if (requests > job.maxRequests) return post({ kind: 'too-many', requests });
    post({ kind: 'emulator' });
    post({ kind: 'done', result: await runDiff(job.emulator, job.base, job.head, job.config) });
  } catch (e) {
    if (e instanceof RulesParseError) post({ kind: 'parse-error', file: e.file, line: e.line, column: e.column, reason: e.reason });
    else post({ kind: 'error', message: (e as Error).message });
  }
}

// A worker loads the module, says it's ready, then runs the jobs it's sent, one at a time.
if (!isMainThread && workerData?.[MARK]) {
  parentPort!.on('message', ({ id, job }: { id: number; job: Job }) => void serve(job, (m) => parentPort!.postMessage({ id, ...m })));
  parentPort!.postMessage({ id: 0, kind: 'ready' });
}

export type WorkerRunDiff = RunDiff & {
  /** Resolves once a loaded worker is waiting for the next comparison. */
  ready(): Promise<void>;
  /** Terminate the worker. */
  close(): Promise<void>;
};

/**
 * A RunDiff that runs comparisons in a worker thread loaded from `entry`: the firediff bundle, or
 * src/cli.ts under tsx. The worker stays loaded between comparisons (a fresh one costs about a
 * second of start-up and cold code on a slow machine). It's replaced when a comparison is aborted
 * (the worker is terminated wherever it is), when it fails, and every `recycleEvery` comparisons.
 * Rules over `maxRequests` are turned away (TooManyRequestsError) before the emulator is touched.
 * Callers run one comparison at a time.
 */
export function workerRunDiff(entry: string, maxRequests: number, opts: { maxHeapMb?: number; recycleEvery?: number } = {}): WorkerRunDiff {
  const { maxHeapMb = 384, recycleEvery = 100 } = opts;
  type Slot = { worker: Worker; ready: Promise<void>; dead: boolean; jobs: number };
  const spawn = (): Slot => {
    const worker = new Worker(entry, { workerData: { [MARK]: true }, resourceLimits: { maxOldGenerationSizeMb: maxHeapMb } });
    worker.unref(); // an idle worker shouldn't keep the process alive
    const slot: Slot = { worker, ready: Promise.resolve(), dead: false, jobs: 0 };
    slot.ready = new Promise<void>((resolve) => {
      worker.once('message', () => resolve());
      worker.once('exit', () => resolve());
    });
    worker.once('exit', () => (slot.dead = true));
    worker.on('error', () => undefined); // reported to the comparison through 'exit'
    return slot;
  };
  let slot: Slot | null = null;
  let closed = false;
  let nextId = 1;
  const retire = (s: Slot) => {
    s.dead = true;
    if (slot === s) slot = null;
    void s.worker.terminate();
  };
  const current = () => {
    if (!slot || slot.dead) slot = spawn();
    return slot;
  };

  const run = ((emulator, base, head, config, signal, onEmulator) =>
    new Promise<DiffResult>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const s = current();
      const id = nextId++;
      s.jobs++;
      s.worker.ref();
      let settled = false;
      const finish = (settle: () => void, keepWorker: boolean) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        s.worker.off('message', onMessage);
        s.worker.off('exit', onExit);
        s.worker.off('error', onError);
        if (!keepWorker || s.jobs >= recycleEvery) retire(s);
        else s.worker.unref();
        if (!closed) current(); // have the next one loading while idle
        settle();
      };
      const onAbort = () => finish(() => reject(signal!.reason), false);
      const onMessage = (m: Message & { id: number }) => {
        if (m.id !== id) return;
        if (m.kind === 'emulator') onEmulator?.();
        else if (m.kind === 'done') finish(() => resolve(m.result), true);
        else if (m.kind === 'too-many') finish(() => reject(new TooManyRequestsError(m.requests, maxRequests)), true);
        else if (m.kind === 'parse-error') finish(() => reject(new RulesParseError(m.file, m.line, m.column, m.reason)), true);
        else finish(() => reject(new Error(m.message)), false);
      };
      let failure: Error | null = null;
      const onError = (e: NodeJS.ErrnoException) => {
        failure = e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new Error('these rules need more memory than the hosted playground allows') : e;
      };
      const onExit = (code: number) => finish(() => reject(failure ?? new Error(`comparison worker exited (${code})`)), false);
      signal?.addEventListener('abort', onAbort, { once: true });
      s.worker.on('message', onMessage);
      s.worker.on('error', onError);
      s.worker.once('exit', onExit);
      const job: Job = { emulator, base, head, config, maxRequests };
      void s.ready.then(() => {
        if (!settled) s.worker.postMessage({ id, job });
      });
    })) as WorkerRunDiff;

  run.ready = async () => {
    if (!closed) await current().ready;
  };
  run.close = async () => {
    closed = true;
    const s = slot;
    slot = null;
    if (s) await s.worker.terminate();
  };
  return run;
}
