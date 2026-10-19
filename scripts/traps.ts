// Run corpus traps through plan + harness and compare flips with each trap's hand-written expected.json.
// Usage (under the emulator): tsx scripts/traps.ts [corpus/trap-01 ...]   (default: every corpus/trap-*)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { emulatorFromEnv } from '../src/run/harness.js';
import { changedRows, errorRows, fromFile, runPair } from '../src/run/pipeline.js';
import { expectedKey, toExpectedRow, type ExpectedRow } from '../src/run/types.js';

const dirs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync('corpus').filter((d) => d.startsWith('trap-')).sort().map((d) => join('corpus', d));

const fmt = (e: ExpectedRow) =>
  `${e.who.padEnd(22)} ${(e.op + (e.fields ? ` [${e.fields.join(',')}]` : '') + (e.where ? ` where ${e.where.join(',')}` : '')).padEnd(26)} ${e.path.padEnd(22)} ${e.base} -> ${e.head}`;

let failed = false;
for (const dir of dirs) {
  const r = await runPair(fromFile(join(dir, 'base.rules')), fromFile(join(dir, 'head.rules')), emulatorFromEnv());
  const got = changedRows(r.rows).map(toExpectedRow);
  const errors = errorRows(r.rows);
  console.log(`\n## ${dir}`);
  console.log(
    `matrix: ${r.plan.requests.length} requests x ${r.plan.principals.length} principals = ${r.cases.length} cases, ${r.plan.seeds.length} seed docs; ` +
      `plan ${r.ms.plan.toFixed(0)} ms, open ${r.ms.open.toFixed(0)} ms, run ${r.ms.run.toFixed(0)} ms`,
  );
  console.log(`flipped (${got.length}):`);
  for (const e of got) console.log(`  ${fmt(e)}`);
  for (const e of errors) {
    const msg = [e.base, e.head].map((o) => (o.result === 'error' ? o.message : o.result)).join(' / ');
    console.log(`  ERROR ${fmt(toExpectedRow(e))}: ${msg}`);
  }
  const file = join(dir, 'expected.json');
  if (!existsSync(file)) continue;
  const expected: ExpectedRow[] = JSON.parse(readFileSync(file, 'utf8'));
  const want = new Set(expected.map(expectedKey));
  const have = new Set(got.map(expectedKey));
  const missing = expected.filter((e) => !have.has(expectedKey(e)));
  const extra = got.filter((e) => !want.has(expectedKey(e)));
  if (!missing.length && !extra.length && !errors.length) {
    console.log(`expected.json: all ${expected.length} rows match`);
    continue;
  }
  failed = true;
  console.log(`expected.json: MISMATCH`);
  for (const e of missing) console.log(`  expected, not seen: ${fmt(e)}`);
  for (const e of extra) console.log(`  seen, not expected: ${fmt(e)}`);
}
process.exitCode = failed ? 1 : 0;
