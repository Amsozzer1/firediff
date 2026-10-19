import type { PairResult } from '../run/pipeline.js';
import type { Report, ReportRow } from './build.js';

const group = (r: ReportRow) => ({
  direction: r.direction,
  who: r.who,
  can: r.can,
  on: r.on,
  tier: r.tier,
  ops: r.group.ops,
  fields: r.group.fields,
  classes: r.group.who.map((w) => (w.kind === 'principal' ? { kind: w.kind, principal: w.principal.name } : { kind: w.kind })),
  principals: [...new Set(r.group.rows.map((x) => x.case.principal.name))],
  proof: r.proof,
  denial: r.denial,
});

/** Everything, for scripts (Step 5): groups plus the full ungrouped matrix. */
export function renderJson(report: Report, result: PairResult): string {
  return JSON.stringify(
    {
      base: { file: report.base, version: result.base.version },
      head: { file: report.head, version: result.head.version },
      counts: {
        requests: report.requests,
        gained: report.gained.length,
        lost: report.lost.length,
        flipped: result.rows.filter((r) => r.base.result !== r.head.result).length,
        errors: report.errors.length,
      },
      gained: report.gained.map(group),
      lost: report.lost.map(group),
      dataChanged: report.dataChanged.map(group),
      couldntTest: report.couldntTest.map((c) => ({ ...group(c), missing: c.missing })),
      changedUntested: report.changedUntested,
      timeChanges: report.timeChanges,
      lowCoverage: report.lowCoverage,
      notExercised: report.notExercised,
      coverage: result.coverage,
      skips: result.skips,
      principals: result.plan.principals,
      seeds: result.plan.seeds,
      matrix: result.rows.map((r) => ({ principal: r.case.principal.name, request: r.case.request, base: r.base, head: r.head })),
      ms: result.ms,
    },
    null,
    2,
  );
}
