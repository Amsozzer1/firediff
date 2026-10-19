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

if (!isMainThread && workerData?.[MARK]) void serve(workerData.job as Job, (m) => parentPort!.postMessage(m));

/**
 * A RunDiff that runs each comparison in a fresh worker thread, loaded from `entry`: the firediff
 * bundle, or src/cli.ts under tsx. Aborting terminates the worker wherever it is. Rules over
 * `maxRequests` are turned away (TooManyRequestsError) before the emulator is touched.
 */
export function workerRunDiff(entry: string, maxRequests: number, maxHeapMb = 384): RunDiff {
  return (emulator, base, head, config, signal, onEmulator) =>
    new Promise<DiffResult>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const job: Job = { emulator, base, head, config, maxRequests };
      const worker = new Worker(entry, { workerData: { [MARK]: true, job }, resourceLimits: { maxOldGenerationSizeMb: maxHeapMb } });
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        void worker.terminate();
        settle();
      };
      const onAbort = () => finish(() => reject(signal!.reason));
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.on('message', (m: Message) => {
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
    });
}
