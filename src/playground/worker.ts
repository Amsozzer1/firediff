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

// A worker loads the module, says it's ready, then runs the one job it's sent.
if (!isMainThread && workerData?.[MARK]) {
  parentPort!.once('message', (job: Job) => void serve(job, (m) => parentPort!.postMessage(m)));
  parentPort!.postMessage({ kind: 'ready' });
}

export type WorkerRunDiff = RunDiff & {
  /** Resolves once a loaded worker is waiting for the next comparison. */
  ready(): Promise<void>;
  /** Terminate the waiting worker. */
  close(): Promise<void>;
};

/**
 * A RunDiff that runs each comparison in a fresh worker thread, loaded from `entry`: the firediff
 * bundle, or src/cli.ts under tsx. Loading takes most of a second on a slow machine, so after each
 * comparison the next worker is started and left waiting. Aborting terminates the worker wherever it
 * is. Rules over `maxRequests` are turned away (TooManyRequestsError) before the emulator is touched.
 */
export function workerRunDiff(entry: string, maxRequests: number, maxHeapMb = 384): WorkerRunDiff {
  const spawn = () => {
    const worker = new Worker(entry, { workerData: { [MARK]: true }, resourceLimits: { maxOldGenerationSizeMb: maxHeapMb } });
    // A waiting worker shouldn't keep the process alive.
    worker.unref();
    const ready = new Promise<void>((resolve) => {
      worker.once('message', () => resolve());
      worker.once('error', () => resolve());
      worker.once('exit', () => resolve());
    });
    const w = { worker, ready, dead: false };
    worker.once('exit', () => (w.dead = true));
    return w;
  };
  let spare: ReturnType<typeof spawn> | null = null;
  let closed = false;
  const take = () => {
    const w = spare && !spare.dead ? spare : spawn();
    spare = null;
    return w;
  };
  // After a comparison, not during one: loading competes with the run for CPU.
  const restock = () => {
    if (!closed && (!spare || spare.dead)) spare = spawn();
  };

  const run = ((emulator, base, head, config, signal, onEmulator) =>
    new Promise<DiffResult>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const { worker, ready } = take();
      worker.ref();
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        void worker.terminate();
        restock();
        settle();
      };
      const onAbort = () => finish(() => reject(signal!.reason));
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.on('message', (m: Message | { kind: 'ready' }) => {
        if (m.kind === 'ready') return;
        if (m.kind === 'emulator') onEmulator?.();
        else if (m.kind === 'done') finish(() => resolve(m.result));
        else if (m.kind === 'too-many') finish(() => reject(new TooManyRequestsError(m.requests, maxRequests)));
        else if (m.kind === 'parse-error') finish(() => reject(new RulesParseError(m.file, m.line, m.column, m.reason)));
        else finish(() => reject(new Error(m.message)));
      });
      worker.on('error', (e: NodeJS.ErrnoException) =>
        finish(() => reject(e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new Error('these rules need more memory than the hosted playground allows') : e)),
      );
      worker.on('exit', (code) => finish(() => reject(new Error(`comparison worker exited (${code})`))));
      const job: Job = { emulator, base, head, config, maxRequests };
      void ready.then(() => worker.postMessage(job));
    })) as WorkerRunDiff;

  run.ready = async () => {
    restock();
    await spare?.ready;
  };
  run.close = async () => {
    closed = true;
    const s = spare;
    spare = null;
    if (s) await s.worker.terminate();
  };
  return run;
}
