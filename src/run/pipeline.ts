import { readFileSync } from 'node:fs';
import { allowCoverage, notExercised, type AllowCoverage, type Unexercised } from '../coverage/coverage.js';
import { buildPlan, expandCases, findSkips, type Config, type Plan, type Skip } from '../generate/index.js';
import { parseRules, stripBom, type RuleModel } from '../parse/index.js';
import { RulesPair, type EmulatorAddress } from './harness.js';
import { findTimeLimits, neutralizeTimeLimits, timeLimitChanges, type TimeLimitChange } from './time.js';
import type { Case, Row } from './types.js';

export interface RulesSource {
  /** Shown in reports: a file path, or e.g. "HEAD~1:firestore.rules". */
  label: string;
  source: string;
}

export const fromFile = (file: string): RulesSource => ({ label: file, source: stripBom(readFileSync(file, 'utf8')) });

export interface PairResult {
  base: RuleModel;
  head: RuleModel;
  plan: Plan;
  cases: Case[];
  rows: Row[];
  /** Head expressions that never evaluated true (null if coverage couldn't be read). */
  notExercised: Unexercised[] | null;
  /** How many head allows evaluated true for some request (null if coverage couldn't be read). */
  coverage: AllowCoverage | null;
  /** Known generator skips that apply to the head file. */
  skips: Skip[];
  /** Time-limited rules whose window changed (evaluated as if inside the window, so runs don't depend on the date). */
  timeChanges: TimeLimitChange[];
  ms: { plan: number; open: number; run: number };
}

/**
 * Parse both sides, generate the matrix, and run it against fd-base-<hash> and fd-head-<hash>.
 * Once `signal` aborts, it stops before the next request and rejects with its reason.
 */
export async function runPair(
  base: RulesSource,
  head: RulesSource,
  emulator: EmulatorAddress,
  config: Config = {},
  signal?: AbortSignal,
): Promise<PairResult> {
  const t0 = performance.now();
  const baseModel = parseRules(base.source, base.label);
  const headModel = parseRules(head.source, head.label);
  const plan = buildPlan(baseModel, headModel, config);
  const cases = expandCases(plan);
  const t1 = performance.now();
  const baseSrc = stripBom(base.source);
  const headSrc = stripBom(head.source);
  const timeChanges = timeLimitChanges(findTimeLimits(baseSrc, baseModel), findTimeLimits(headSrc, headModel), headModel);
  signal?.throwIfAborted();
  const pair = await RulesPair.open(neutralizeTimeLimits(baseSrc), neutralizeTimeLimits(headSrc), emulator);
  const t2 = performance.now();
  try {
    const rows = await pair.run(cases, plan.seeds, signal);
    const t3 = performance.now();
    let unexercised: Unexercised[] | null = null;
    let cov: AllowCoverage | null = null;
    try {
      const raw = await pair.coverage('head');
      unexercised = notExercised(raw, headModel, headSrc);
      cov = allowCoverage(raw, headModel);
    } catch {
      unexercised = null;
    }
    return {
      base: baseModel,
      head: headModel,
      plan,
      cases,
      rows,
      notExercised: unexercised,
      coverage: cov,
      skips: findSkips(headModel),
      timeChanges,
      ms: { plan: t1 - t0, open: t2 - t1, run: t3 - t2 },
    };
  } finally {
    await pair.close();
  }
}

export const changedRows = (rows: Row[]) => rows.filter((r) => r.base.result !== r.head.result);
export const errorRows = (rows: Row[]) => rows.filter((r) => r.base.result === 'error' || r.head.result === 'error');
