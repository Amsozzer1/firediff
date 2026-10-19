// GitHub Action entry (bundled to dist/action/index.mjs): resolve the base commit, run firediff,
// post the sticky comment, write the job summary and outputs, and exit with firediff's code.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from './cli.js';

const input = (name: string) => (process.env[`FIREDIFF_INPUT_${name.toUpperCase().replace(/-/g, '_')}`] ?? '').trim();

function event(): { pull_request?: { number?: number; base?: { sha?: string } }; before?: string } {
  const path = process.env.GITHUB_EVENT_PATH;
  return path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

function output(name: string, value: string | number): void {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

/** The commit to compare against, fetched if a shallow checkout doesn't have it yet. */
export function resolveBase(cwd: string): string {
  const ev = event();
  const zero = /^0+$/;
  const base = [input('base'), ev.pull_request?.base?.sha ?? '', ev.before ?? ''].find((s) => s && !zero.test(s));
  if (!base) throw new Error("no base commit (set the 'base' input, or run on pull_request/push)");
  try {
    execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], { cwd, stdio: 'ignore' });
  } catch {
    execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', base], { cwd, stdio: 'inherit' });
  }
  return base;
}

export async function runAction(): Promise<number> {
  const cwd = input('working-directory') || '.';
  process.chdir(cwd);
  const base = resolveBase('.');
  const temp = process.env.RUNNER_TEMP || '.';
  const md = join(temp, 'firediff.md');
  const json = join(temp, 'firediff.json');
  const args = ['--since', base, '--format', 'md', '--fail-on', input('fail-on') || 'gained', '--md-out', md, '--json-out', json];
  if (input('rules')) args.push('--rules', input('rules'));
  if (input('config')) args.push('--config', input('config'));
  if (input('strict') === 'true') args.push('--strict');
  if (input('comment') !== 'false' && event().pull_request?.number) args.push('--comment');
  if (input('github-token')) process.env.GITHUB_TOKEN = input('github-token');

  const code = await main(args);
  if (existsSync(md)) {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, readFileSync(md, 'utf8'));
    output('report', md);
  }
  if (existsSync(json)) {
    const { counts } = JSON.parse(readFileSync(json, 'utf8')) as { counts: { gained: number; lost: number; requests: number } };
    output('gained', counts.gained);
    output('lost', counts.lost);
    output('requests', counts.requests);
  }
  return code;
}

runAction().then(
  (code) => {
    process.exitCode = code;
  },
  (e: Error) => {
    process.stdout.write(`::error::firediff: ${e.message}\n`);
    process.exitCode = 2;
  },
);
