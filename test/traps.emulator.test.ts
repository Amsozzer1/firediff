// Needs a running Firestore emulator: `pnpm test:emulator`. Skipped otherwise.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReport, renderMarkdown } from '../src/report/index.js';
import { emulatorFromEnv } from '../src/run/harness.js';
import { changedRows, errorRows, fromFile, runPair } from '../src/run/pipeline.js';
import { expectedKey, toExpectedRow, type ExpectedRow } from '../src/run/types.js';

const traps = readdirSync('corpus').filter((d) => d.startsWith('trap-')).sort();
const sorted = (rows: ExpectedRow[]) => [...rows].sort((a, b) => expectedKey(a).localeCompare(expectedKey(b)));

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('traps (emulator)', () => {
  for (const trap of traps) {
    it(`${trap}: flips exactly expected.json, and report.md matches its golden file`, async () => {
      // Relative labels keep the golden report portable.
      const dir = `corpus/${trap}`;
      const expected: ExpectedRow[] = JSON.parse(readFileSync(`${dir}/expected.json`, 'utf8'));
      const r = await runPair(fromFile(`${dir}/base.rules`), fromFile(`${dir}/head.rules`), emulatorFromEnv());
      expect(errorRows(r.rows).map(toExpectedRow)).toEqual([]);
      expect(sorted(changedRows(r.rows).map(toExpectedRow))).toEqual(sorted(expected));

      const md = renderMarkdown(buildReport(r));
      if (process.env.UPDATE_GOLDEN) writeFileSync(`${dir}/report.md`, md);
      expect(md).toBe(readFileSync(`${dir}/report.md`, 'utf8'));
    }, 120_000);
  }

  it('the report is identical across runs (coverage does not accumulate)', async () => {
    const run = async () => renderMarkdown(buildReport(await runPair(fromFile('corpus/trap-03/base.rules'), fromFile('corpus/trap-03/head.rules'), emulatorFromEnv())));
    expect(await run()).toBe(await run());
  }, 120_000);

  it('`firediff --since <ref>` compares git show <ref>:<rules> with the working tree', () => {
    const repo = mkdtempSync(join(tmpdir(), 'firediff-since-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    try {
      git('init', '-q');
      writeFileSync(join(repo, 'firebase.json'), JSON.stringify({ firestore: { rules: 'rules/firestore.rules' } }));
      execFileSync('mkdir', ['-p', join(repo, 'rules')]);
      writeFileSync(join(repo, 'rules/firestore.rules'), readFileSync('corpus/trap-02/base.rules'));
      git('add', '.');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
      writeFileSync(join(repo, 'rules/firestore.rules'), readFileSync('corpus/trap-02/head.rules'));

      const cli = (...args: string[]) =>
        spawnSync(resolve('node_modules/.bin/tsx'), [resolve('src/bin.ts'), ...args], { cwd: repo, encoding: 'utf8', env: process.env });
      const r = cli('--since', 'HEAD');
      expect(r.status, r.stderr).toBe(1);
      expect(r.stdout).toMatch(/^### firediff · 1 access change\n/);
      expect(r.stdout).toContain('| any signed-in user | write any doc | `config/{key}` |');

      expect(cli('--since', 'HEAD', '--fail-on', 'never').status).toBe(0);
      const json = JSON.parse(cli('--since', 'HEAD', '--format', 'json').stdout);
      expect(json.base.file).toBe('HEAD:rules/firestore.rules');
      expect(json.counts).toMatchObject({ gained: 1, lost: 0 });
      expect(json.matrix).toHaveLength(json.counts.requests);

      const missing = cli('--since', 'no-such-ref');
      expect(missing.status).toBe(2);
      expect(missing.stderr).toMatch(/^firediff: git show no-such-ref:\.\/rules\/firestore\.rules failed/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 180_000);

  it('exit 0 and the no-changes title when nothing flips', () => {
    const r = spawnSync('node_modules/.bin/tsx', ['src/bin.ts', 'corpus/trap-01/head.rules', 'corpus/trap-01/head.rules'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^### firediff · no access changes in \d+ requests\n/);
  }, 120_000);
});
