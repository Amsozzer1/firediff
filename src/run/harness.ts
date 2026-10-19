import { createHash, randomUUID } from 'node:crypto';
import {
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import firebase from 'firebase/compat/app';
import 'firebase/compat/firestore';
import { setLogLevel } from 'firebase/firestore';
import { isWrite, type Case, type DocData, type Outcome, type Principal, type Request, type Row, type Seed } from './types.js';

/** fd-base-<hash> / fd-head-<hash>, unique per run so ruleCoverage never accumulates across runs. */
export function projectIds(baseRules: string, headRules: string): { base: string; head: string } {
  const hash = createHash('sha256').update(baseRules).update('\0').update(headRules).update(randomUUID()).digest('hex').slice(0, 12);
  return { base: `fd-base-${hash}`, head: `fd-head-${hash}` };
}

type Firestore = ReturnType<RulesTestContext['firestore']>;

export interface EmulatorAddress {
  host: string;
  port: number;
}

/** Reads FIRESTORE_EMULATOR_HOST (set by `firebase emulators:exec`). */
export function emulatorFromEnv(): EmulatorAddress {
  const raw = process.env.FIRESTORE_EMULATOR_HOST;
  if (!raw) throw new Error('FIRESTORE_EMULATOR_HOST is not set; run under `firebase emulators:exec`');
  const i = raw.lastIndexOf(':');
  return { host: raw.slice(0, i), port: Number(raw.slice(i + 1)) };
}

class Side {
  private contexts = new Map<string, Firestore>();

  constructor(readonly env: RulesTestEnvironment) {}

  db(p: Principal): Firestore {
    let db = this.contexts.get(p.name);
    if (!db) {
      const ctx = p.auth
        ? this.env.authenticatedContext(p.auth.uid, p.auth.token)
        : this.env.unauthenticatedContext();
      db = ctx.firestore();
      this.contexts.set(p.name, db);
    }
    return db;
  }

  async seed(seeds: Seed[]): Promise<void> {
    await this.env.clearFirestore();
    await this.env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await Promise.all(seeds.map((s) => db.doc(s.path).set(data(s.data))));
    });
  }

  /** Put a doc back to its seeded state (or remove it if it wasn't seeded). */
  async restore(path: string, seed: Seed | undefined): Promise<void> {
    await this.env.withSecurityRulesDisabled(async (ctx) => {
      const ref = ctx.firestore().doc(path);
      await (seed ? ref.set(data(seed.data)) : ref.delete());
    });
  }
}

const TIMEOUT_MS = 10_000;

// rules-unit-testing hands out compat Firestore instances, so writes need compat sentinels.
const compat = (firebase as unknown as {
  firestore: { FieldValue: { serverTimestamp(): unknown }; Timestamp: { fromDate(d: Date): unknown } };
}).firestore;

/** Turn SERVER_TIME / timestampAt placeholders into Firestore values. */
export function materialize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(materialize);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (o.__firediff === 'serverTimestamp') return compat.FieldValue.serverTimestamp();
    if (o.__firediff === 'timestamp') return compat.Timestamp.fromDate(new Date(String(o.iso)));
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, materialize(x)]));
  }
  return v;
}
const data = (d: DocData) => materialize(d) as DocData;

async function execute(db: Firestore, req: Request): Promise<Outcome> {
  const run = async () => {
    switch (req.op) {
      case 'get':
        return void (await db.doc(req.path).get());
      case 'list': {
        let q: ReturnType<Firestore['collection']> | ReturnType<ReturnType<Firestore['collection']>['where']> =
          db.collection(req.collection);
        for (const [field, op, value] of req.where ?? []) q = q.where(field, op, value);
        return void (await q.get());
      }
      case 'create':
        return void (await db.doc(req.path).set(data(req.data)));
      case 'update':
        return void (await db.doc(req.path).update(data(req.data)));
      case 'delete':
        return void (await db.doc(req.path).delete());
    }
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
      }),
    ]);
    return { result: 'allow' };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code === 'permission-denied') {
      return { result: 'deny', reason: (err.message ?? '').replace(/^\d+ PERMISSION_DENIED: /, '').trim() };
    }
    return { result: 'error', message: `${err.code ?? 'error'}: ${err.message ?? String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Base and head rules loaded as two projects in one emulator. */
export class RulesPair {
  private constructor(
    private readonly base: Side,
    private readonly head: Side,
    private readonly emulator: EmulatorAddress,
    readonly ids: { base: string; head: string },
  ) {}

  static async open(baseRules: string, headRules: string, emulator: EmulatorAddress): Promise<RulesPair> {
    // Every expected deny otherwise logs a GrpcConnection warning.
    setLogLevel('silent');
    const ids = projectIds(baseRules, headRules);
    const [base, head] = await Promise.all([
      initializeTestEnvironment({ projectId: ids.base, firestore: { ...emulator, rules: baseRules } }),
      initializeTestEnvironment({ projectId: ids.head, firestore: { ...emulator, rules: headRules } }),
    ]);
    return new RulesPair(new Side(base), new Side(head), emulator, ids);
  }

  /** The emulator's ruleCoverage report for one side (see src/coverage). */
  async coverage(side: 'base' | 'head'): Promise<unknown> {
    const url = `http://${this.emulator.host}:${this.emulator.port}/emulator/v1/projects/${this.ids[side]}:ruleCoverage`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ruleCoverage ${res.status} for ${this.ids[side]}`);
    return res.json();
  }

  /** Sends every case to both projects in lockstep, starting from the same seeded state. Stops between cases once `signal` aborts. */
  async run(cases: Case[], seeds: Seed[], signal?: AbortSignal): Promise<Row[]> {
    const seedByPath = new Map(seeds.map((s) => [s.path, s]));
    await Promise.all([this.base.seed(seeds), this.head.seed(seeds)]);

    const rows: Row[] = [];
    for (const c of cases) {
      signal?.throwIfAborted();
      const req = c.request;
      // A create has to target a doc that doesn't exist (set() on an existing doc is an update).
      if (req.op === 'create' && seedByPath.has(req.path)) {
        await Promise.all([this.base.restore(req.path, undefined), this.head.restore(req.path, undefined)]);
      }
      const [base, head] = await Promise.all([
        execute(this.base.db(c.principal), req),
        execute(this.head.db(c.principal), req),
      ]);
      if (isWrite(req)) {
        const path = (req as { path: string }).path;
        const seed = seedByPath.get(path);
        const removed = req.op === 'create' && seed !== undefined;
        await Promise.all([
          base.result === 'allow' || removed ? this.base.restore(path, seed) : undefined,
          head.result === 'allow' || removed ? this.head.restore(path, seed) : undefined,
        ]);
      }
      rows.push({ case: c, base, head });
    }
    return rows;
  }

  /** Drop this run's documents too: without it, a long-lived emulator slows down as projects pile up. */
  async close(): Promise<void> {
    await Promise.allSettled([this.base.env.clearFirestore(), this.head.env.clearFirestore()]);
    await Promise.all([this.base.env.cleanup(), this.head.env.cleanup()]);
  }
}
