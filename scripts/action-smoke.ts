// Smoke-test the Action without GitHub: run dist/action/index.js against a temp repo and a fake GitHub API.
// Usage: tsx scripts/action-smoke.ts   (needs `pnpm build` first and Java 21; starts its own emulator)
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';


// A repo whose rules change opens users/{uid} to every signed-in user.
const repo = mkdtempSync(join(tmpdir(), 'firediff-action-'));
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
git('init', '-q');
writeFileSync(join(repo, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' } }));
writeFileSync(join(repo, 'firestore.rules'), readFileSync('corpus/trap-01/base.rules'));
git('add', '.');
git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
const baseSha = git('rev-parse', 'HEAD').toString().trim();
writeFileSync(join(repo, 'firestore.rules'), readFileSync('corpus/trap-01/head.rules'));

// Fake GitHub issues-comments API.
const comments: Array<{ id: number; body: string }> = [];
const calls: string[] = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer fake-token') return res.writeHead(401).end('{}');
    if (req.method === 'GET') return res.end(JSON.stringify(comments.map((c) => ({ ...c, html_url: `http://gh/c/${c.id}` }))));
    const parsed = JSON.parse(body);
    if (req.method === 'POST') {
      comments.push({ id: comments.length + 1, body: parsed.body });
      return res.writeHead(201).end(JSON.stringify({ html_url: `http://gh/c/${comments.length}` }));
    }
    const id = Number(req.url!.split('/').pop());
    comments.find((c) => c.id === id)!.body = parsed.body;
    return res.end(JSON.stringify({ html_url: `http://gh/c/${id}` }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as { port: number }).port;

const temp = mkdtempSync(join(tmpdir(), 'firediff-runner-'));
writeFileSync(join(temp, 'event.json'), JSON.stringify({ pull_request: { number: 5, base: { sha: baseSha } } }));

// What the composite step runs: the committed bundle, with its inputs in FIREDIFF_INPUT_*.
function runAction(): Promise<{ code: number; outputs: Record<string, string>; stderr: string }> {
  const outFile = join(temp, 'run.out');
  writeFileSync(outFile, '');
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve('dist/action/index.js')], {
      cwd: repo,
      env: {
        ...process.env,
        FIRESTORE_EMULATOR_HOST: '',
        GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: join(temp, 'summary.md'), RUNNER_TEMP: temp,
        GITHUB_REPOSITORY: 'acme/app', GITHUB_EVENT_PATH: join(temp, 'event.json'), GITHUB_API_URL: `http://127.0.0.1:${port}`,
        FIREDIFF_INPUT_GITHUB_TOKEN: 'fake-token', FIREDIFF_INPUT_FAIL_ON: 'gained', FIREDIFF_INPUT_COMMENT: 'true', FIREDIFF_INPUT_WORKING_DIRECTORY: '.',
      },
    });
    let stderr = '';
    child.stderr.on('data', (b) => (stderr += b));
    child.stdout.resume();
    child.on('close', (code) => {
      const outputs = Object.fromEntries(readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => l.split('=') as [string, string]));
      done({ code: code ?? -1, outputs, stderr });
    });
  });
}

for (const attempt of [1, 2]) {
  const t0 = performance.now();
  const run = await runAction();
  console.log(`run #${attempt}: exit ${run.code} in ${((performance.now() - t0) / 1000).toFixed(1)}s`, run.outputs, run.stderr.trim().split('\n').filter((l) => l.startsWith('firediff')).join(' | '));
}
console.log('API calls:', calls.join(', '));
console.log('comments on the PR:', comments.length, '| first lines:', comments[0]?.body.split('\n').slice(0, 2).join(' / '));
console.log('step summary starts:', readFileSync(join(temp, 'summary.md'), 'utf8').split('\n')[0]);
server.close();
