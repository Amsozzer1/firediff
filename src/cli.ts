import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { buildPlan, ConfigError, expandCases, formatPlan, loadConfig, type Config } from './generate/index.js';
import { parseRules, RulesParseError, type RuleModel } from './parse/index.js';
import { GitHubError, pullRequestFromEnv, upsertComment } from './github/comment.js';
import { emulatorDiff, listen } from './playground/server.js';
import { buildReport, renderJson, renderMarkdown, renderText } from './report/index.js';
import { EmulatorError, withEmulator } from './run/emulator.js';
import { FirebaseJsonError, rulesPathFromFirebaseJson } from './run/firebase-json.js';
import { fromFile, runPair, type RulesSource } from './run/pipeline.js';

const USAGE = `usage:
  firediff <base.rules> <head.rules> [options]
  firediff --since <git-ref> [options]           compare <ref>:<rules> with the working tree
  firediff plan <base.rules> <head.rules> [--config firediff.yml] [--format text|json]
  firediff playground [--port 8787] [--host 127.0.0.1]   paste two rules files in a local web page

options:
  --format md|json|text      output format (default md)
  --fail-on gained|any|never exit 1 when access was gained (default), on any change, or never
  --config <file>            generator inputs (default ./firediff.yml if present)
  --strict                   exit 2 when firediff could test fewer than half of head's rules
  --rules <path>             with --since: the rules file (default: from firebase.json)
  --json-out <file>          also write the JSON report to <file>
  --md-out <file>            also write the markdown report to <file>
  --comment                  post the markdown report as a sticky comment on the GitHub PR
                             (in Actions: needs GITHUB_TOKEN and a pull_request event)

exit codes: 0 no gained access, 1 gained access (see --fail-on), 2 couldn't run
`;

class UsageError extends Error {}
class GitError extends Error {}

function config(path: string | undefined): Config {
  if (path) return loadConfig(path);
  return existsSync('firediff.yml') ? loadConfig('firediff.yml') : {};
}

function plan(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { config: { type: 'string' }, format: { type: 'string', default: 'text' } },
  });
  if (positionals.length !== 2) throw new UsageError('plan needs <base.rules> <head.rules>');
  const [base, head] = positionals.map((f) => parseRules(readFileSync(f, 'utf8'), f)) as [RuleModel, RuleModel];
  const p = buildPlan(base, head, config(values.config));
  if (values.format === 'json') {
    process.stdout.write(JSON.stringify({ base: base.file, head: head.file, ...p, cases: expandCases(p).length }, null, 2) + '\n');
  } else if (values.format === 'text') {
    process.stdout.write(formatPlan(p, base, head));
  } else {
    throw new UsageError(`unknown --format ${values.format}`);
  }
  return 0;
}

function sinceSources(ref: string, rules?: string): [RulesSource, RulesSource] {
  if (!rules && !existsSync('firebase.json')) throw new UsageError('--since needs a firebase.json in the current directory, or --rules <path>');
  const path = rules ?? rulesPathFromFirebaseJson(readFileSync('firebase.json', 'utf8'));
  let old: string;
  try {
    old = execFileSync('git', ['show', `${ref}:./${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const stderr = String((e as { stderr?: string }).stderr ?? '').trim();
    throw new GitError(`git show ${ref}:./${path} failed${stderr ? `: ${stderr}` : ''}`);
  }
  return [{ label: `${ref}:${path}`, source: old }, fromFile(path)];
}

async function run(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      since: { type: 'string' },
      rules: { type: 'string' },
      'json-out': { type: 'string' },
      'md-out': { type: 'string' },
      comment: { type: 'boolean', default: false },
      format: { type: 'string', default: 'md' },
      'fail-on': { type: 'string', default: 'gained' },
      config: { type: 'string' },
      strict: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const format = values.format!;
  const failOn = values['fail-on']!;
  if (!['md', 'json', 'text'].includes(format)) throw new UsageError(`unknown --format ${format}`);
  if (!['gained', 'any', 'never'].includes(failOn)) throw new UsageError(`unknown --fail-on ${failOn}`);

  let sources: [RulesSource, RulesSource];
  if (values.since !== undefined) {
    if (positionals.length) throw new UsageError('--since takes no rules files');
    sources = sinceSources(values.since, values.rules);
  } else {
    if (positionals.length !== 2) throw new UsageError('need <base.rules> <head.rules>, or --since <git-ref>');
    sources = [fromFile(positionals[0]!), fromFile(positionals[1]!)];
  }
  // Parse before starting the emulator so syntax errors fail fast.
  for (const s of sources) parseRules(s.source, s.label);
  const cfg = config(values.config);

  const result = await withEmulator((emulator) => runPair(sources[0], sources[1], emulator, cfg));
  if (result.rows.length && result.rows.every((r) => r.base.result === 'error' || r.head.result === 'error')) {
    const first = result.rows[0]!;
    const msg = first.base.result === 'error' ? first.base.message : first.head.result === 'error' ? first.head.message : '';
    throw new EmulatorError(`every request failed to run (first: ${msg})`);
  }
  const report = buildReport(result);
  const markdown = renderMarkdown(report);
  const out = format === 'json' ? renderJson(report, result) + '\n' : format === 'text' ? renderText(report) : markdown;
  process.stdout.write(out);
  if (values['json-out']) writeFileSync(values['json-out'], renderJson(report, result) + '\n');
  if (values['md-out']) writeFileSync(values['md-out'], markdown);
  if (values.comment) {
    const posted = await upsertComment(pullRequestFromEnv(), markdown);
    process.stderr.write(`firediff: ${posted.action} PR comment ${posted.url}\n`);
  }

  if (values.strict && report.lowCoverage) {
    process.stderr.write(`firediff: --strict: only ${report.lowCoverage.reached} of ${report.lowCoverage.total} rules could be tested\n`);
    return 2;
  }
  const gained = report.gained.length > 0 || report.timeChanges.some((t) => t.direction === 'gained');
  const any = gained || report.lost.length > 0 || report.timeChanges.length > 0;
  return failOn === 'never' ? 0 : failOn === 'any' ? Number(any) : Number(gained);
}

async function playground(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { port: { type: 'string', default: '8787' }, host: { type: 'string', default: '127.0.0.1' } } });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`bad --port ${values.port}`);
  await withEmulator(async (emulator) => {
    const server = await listen(emulatorDiff(emulator), port, values.host!);
    const { port: actual } = server.address() as { port: number };
    process.stderr.write(`firediff playground: http://${values.host}:${actual}/  (Ctrl-C to stop)\n`);
    await new Promise<void>((resolve) => {
      const stop = () => server.close(() => resolve());
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  });
  return 0;
}

/** Run firediff with CLI arguments; resolves to the exit code. */
export async function main(argv: string[]): Promise<number> {
  try {
    if (argv[0] === 'plan') return plan(argv.slice(1));
    if (argv[0] === 'playground') return await playground(argv.slice(1));
    return await run(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`firediff: ${e.message}\n${USAGE}`);
    } else if (e instanceof RulesParseError || e instanceof ConfigError || e instanceof EmulatorError || e instanceof GitError || e instanceof FirebaseJsonError || e instanceof GitHubError) {
      process.stderr.write(`firediff: ${e.message}\n`);
    } else if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as { code?: string }).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      process.stderr.write(`firediff: ${(e as Error).message}\n`);
    } else {
      process.stderr.write(`firediff: ${(e as Error).stack ?? String(e)}\n`);
    }
    return 2;
  }
}
