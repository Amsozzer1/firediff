import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { marked } from 'marked';
import { ConfigError, parseConfig, type Config } from '../generate/index.js';
import { parseRules, RulesParseError } from '../parse/index.js';
import { buildReport, renderMarkdown } from '../report/index.js';
import type { EmulatorAddress } from '../run/harness.js';
import { runPair } from '../run/pipeline.js';
import { playgroundPage } from './page.js';

/** What the page gets back for one comparison. */
export interface DiffResult {
  markdown: string;
  counts: { gained: number; lost: number; requests: number };
}

export type DiffFn = (base: string, head: string, config: Config) => Promise<DiffResult>;

const MAX_BODY = 512 * 1024;

/** Run one comparison against the shared emulator (the real DiffFn). */
export function emulatorDiff(emulator: EmulatorAddress): DiffFn {
  return async (base, head, config) => {
    const result = await runPair({ label: 'base.rules', source: base }, { label: 'head.rules', source: head }, emulator, config);
    const report = buildReport(result);
    return { markdown: renderMarkdown(report), counts: { gained: report.gained.length, lost: report.lost.length, requests: report.requests } };
  };
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * HTTP handler for the playground: GET / serves the page, POST /api/diff runs one comparison.
 * Comparisons share one emulator, so they run one at a time.
 */
export function playgroundHandler(diff: DiffFn) {
  let queue: Promise<unknown> = Promise.resolve();
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', playgroundPage());
    if (url.pathname !== '/api/diff') return send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }));
    if (req.method !== 'POST') return send(res, 405, 'application/json', JSON.stringify({ error: 'use POST' }));

    let input: { base?: unknown; head?: unknown; config?: unknown };
    try {
      input = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, 'application/json', JSON.stringify({ error: `Send JSON {base, head, config?} under ${MAX_BODY / 1024} KB.` }));
    }
    if (typeof input.base !== 'string' || typeof input.head !== 'string') {
      return send(res, 400, 'application/json', JSON.stringify({ error: 'base and head must be rules text' }));
    }
    const base = input.base;
    const head = input.head;
    try {
      // Parse first: syntax errors come back with line:col without touching the emulator.
      parseRules(base, 'base.rules');
      parseRules(head, 'head.rules');
      const config = typeof input.config === 'string' && input.config.trim() ? parseConfig(input.config, 'firediff.yml') : {};
      const run = queue.then(() => diff(base, head, config));
      queue = run.catch(() => undefined);
      const result = await run;
      const html = await marked.parse(result.markdown, { gfm: true });
      return send(res, 200, 'application/json', JSON.stringify({ ...result, html }));
    } catch (e) {
      if (e instanceof RulesParseError || e instanceof ConfigError) {
        return send(res, 400, 'application/json', JSON.stringify({ error: e.message, ...(e instanceof RulesParseError ? { line: e.line, column: e.column } : {}) }));
      }
      return send(res, 500, 'application/json', JSON.stringify({ error: `firediff failed: ${(e as Error).message}` }));
    }
  };
}

/** Listen on host:port; resolves once listening. */
export function listen(diff: DiffFn, port: number, host: string): Promise<Server> {
  const handler = playgroundHandler(diff);
  const server = createServer((req, res) => void handler(req, res));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
