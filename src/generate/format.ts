import type { RuleModel } from '../parse/index.js';
import { expandCases, type Plan } from './build.js';

function table(rows: string[][], indent = '  '): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => indent + r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ').trimEnd());
}

const json = (v: unknown) => JSON.stringify(v);

/** Human-readable, deterministic plan (suitable as a golden file). */
export function formatPlan(plan: Plan, base: RuleModel, head: RuleModel): string {
  const cases = expandCases(plan);
  const out: string[] = [
    'firediff plan',
    `  base: ${base.file} (rules_version ${base.version.declared ?? `undeclared, v${base.version.effective} semantics`})`,
    `  head: ${head.file} (rules_version ${head.version.declared ?? `undeclared, v${head.version.effective} semantics`})`,
    '',
    `principals (${plan.principals.length})`,
    ...table(
      plan.principals.map((p) => [
        p.name,
        p.auth?.uid ?? '-',
        p.auth?.token ? json(p.auth.token) : '',
        p.label ?? '',
      ]),
    ),
    '',
    `seed docs (${plan.seeds.length}), identical in base and head`,
    ...table(plan.seeds.map((s) => [s.path, json(s.data)])),
    '',
    `requests (${plan.requests.length}) x principals = ${cases.length} cases`,
    ...table(
      plan.requests.map(({ request: r, why, only }) => {
        if (r.op === 'list') {
          const filter = r.where?.length ? `where ${r.where.map(([f, o, v]) => `${f} ${o} ${v === '$uid' ? "caller's uid" : json(v)}`).join(' and ')}` : '';
          return [r.op, r.collection, filter, only ? only.join(', ') : r.where?.length ? 'signed-in principals' : 'all principals', why];
        }
        const data = r.op === 'create' || r.op === 'update' ? json(r.data) : '';
        return [r.op, r.path, data, only ? only.join(', ') : 'all principals', why];
      }),
    ),
  ];
  if (plan.notes.length) out.push('', 'notes', ...plan.notes.map((n) => `  - ${n}`));
  return out.join('\n') + '\n';
}
