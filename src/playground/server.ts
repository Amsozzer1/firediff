import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { marked } from 'marked';
import { ConfigError, parseConfig, type Config } from '../generate/index.js';
import { parseRules, RulesParseError } from '../parse/index.js';
import { buildReport, renderMarkdown } from '../report/index.js';
import { startEmulator, type EmulatorProcess } from '../run/emulator.js';
import type { EmulatorAddress } from '../run/harness.js';
import { runPair } from '../run/pipeline.js';
import { clientKey, DiffTimeoutError, HOSTED_LIMITS, QueueFullError, RateLimiter, RunQueue, TooManyRequestsError, type Health, type HostedLimits, type RunDiff } from './hosted.js';
import { EXAMPLE_BASE, EXAMPLE_HEAD, playgroundPage } from './page.js';

/** What the page gets back for one comparison. */
export interface DiffResult {
  markdown: string;
  counts: { gained: number; lost: number; requests: number };
}

export type DiffFn = (base: string, head: string, config: Config) => Promise<DiffResult>;

/** `firediff playground --hosted`: limits for a public server (see hosted.ts). */
export interface HostedOptions {
  limits?: Partial<HostedLimits>;
  /** Rate-limit on the last X-Forwarded-For entry. Only behind a reverse proxy that sets it. */
  trustProxy?: boolean;
  /** Rate-limit on this header instead (cf-connecting-ip behind a Cloudflare Tunnel). Only when every request comes through that proxy. */
  ipHeader?: string;
  /** Served at /healthz: 200 when ok, 503 otherwise. */
  health?: () => Health;
  now?: () => number;
  log?: (line: string) => void;
}

export interface PlaygroundOptions {
  hosted?: HostedOptions;
}

const MAX_BODY = 512 * 1024;
const LOCALLY = 'Run it locally: npx @amsozzer/firediff base.rules head.rules';

/** One comparison on the given emulator (the real RunDiff). */
export const runDiff: RunDiff = async (emulator, base, head, config, signal, onEmulator) => {
  onEmulator?.(); // parsing happens inside runPair, so count the whole run as using the emulator
  const result = await runPair({ label: 'base.rules', source: base }, { label: 'head.rules', source: head }, emulator, config, signal);
  const report = buildReport(result);
  return { markdown: renderMarkdown(report), counts: { gained: report.gained.length, lost: report.lost.length, requests: report.requests } };
};

/**
 * Start an emulator and run the built-in example on it a few times, so real comparisons don't hit
 * a cold JVM (on a slow machine the first runs take noticeably longer, enough to time out).
 */
export async function startWarmEmulator(runs = 3): Promise<EmulatorProcess> {
  const em = await startEmulator();
  try {
    for (let i = 0; i < runs; i++) await runDiff(em.address, EXAMPLE_BASE, EXAMPLE_HEAD, {});
  } catch (e) {
    await em.stop();
    throw e;
  }
  return em;
}

/** Run one comparison against the shared emulator (the real DiffFn). */
export function emulatorDiff(emulator: EmulatorAddress): DiffFn {
  return (base, head, config) => runDiff(emulator, base, head, config);
}

function send(res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
  send(res, status, 'application/json', JSON.stringify(body), headers);

class BodyTooLarge extends Error {}

function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) reject(new BodyTooLarge());
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Only the page's own inline script (by hash) runs, and it can only talk back to this server. */
function contentSecurityPolicy(page: string): string {
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)![1]!;
  const hash = createHash('sha256').update(script).digest('base64');
  return [
    "default-src 'none'",
    `script-src 'sha256-${hash}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const kb = (bytes: number) => Math.ceil(bytes / 1024);

/**
 * HTTP handler for the playground: GET / serves the page, POST /api/diff runs one comparison,
 * GET /healthz reports health. Comparisons share one emulator, so they run one at a time.
 */
export function playgroundHandler(diff: DiffFn, options: PlaygroundOptions = {}) {
  const hosted = options.hosted;
  const limits = hosted ? { ...HOSTED_LIMITS, ...hosted.limits } : null;
  const limiter = limits ? new RateLimiter(limits.perMinute, limits.perDay, hosted!.now) : null;
  const queue = new RunQueue(limits ? limits.queue : Infinity);
  const maxBody = limits ? 2 * (2 * limits.rulesBytes + limits.configBytes) + 4096 : MAX_BODY;
  const page = playgroundPage(limits ?? undefined);
  const csp = contentSecurityPolicy(page);
  const log = hosted?.log ?? (() => {});

  async function compare(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (limiter) {
      const t = limiter.take(clientKey(req, hosted!.trustProxy ?? false, hosted!.ipHeader));
      if (!t.ok) return sendJson(res, 429, { error: t.message }, { 'retry-after': String(t.retryAfterSec) });
    }

    let input: { base?: unknown; head?: unknown; config?: unknown };
    try {
      input = JSON.parse(await readBody(req, maxBody));
    } catch (e) {
      if (e instanceof BodyTooLarge) return sendJson(res, 413, { error: `Send under ${kb(maxBody)} KB.` }, { connection: 'close' });
      return sendJson(res, 400, { error: `Send JSON {base, head, config?} under ${kb(maxBody)} KB.` });
    }
    if (typeof input.base !== 'string' || typeof input.head !== 'string') {
      return sendJson(res, 400, { error: 'base and head must be rules text' });
    }
    const base = input.base;
    const head = input.head;
    const configText = typeof input.config === 'string' ? input.config : '';
    if (limits) {
      for (const [name, text] of [['base.rules', base], ['head.rules', head]] as const) {
        const size = Buffer.byteLength(text);
        if (size > limits.rulesBytes) {
          return sendJson(res, 413, { error: `${name} is ${kb(size)} KB; the hosted playground takes up to ${kb(limits.rulesBytes)} KB per file. ${LOCALLY}` });
        }
      }
      if (Buffer.byteLength(configText) > limits.configBytes) {
        return sendJson(res, 413, { error: `firediff.yml is ${kb(Buffer.byteLength(configText))} KB; the hosted playground takes up to ${kb(limits.configBytes)} KB. ${LOCALLY}` });
      }
    }
    try {
      // Locally, parse first: syntax errors come back with line:col without touching the emulator.
      // Hosted, the comparison parses in a worker thread (worker.ts) and reports the same errors,
      // so a file that's slow to parse can't stall this thread.
      if (!limits) {
        parseRules(base, 'base.rules');
        parseRules(head, 'head.rules');
      }
      const config = configText.trim() ? parseConfig(configText, 'firediff.yml') : {};
      const t0 = performance.now();
      const result = await queue.run(() => diff(base, head, config));
      log(`compared: ${result.counts.requests} requests, ${Math.round(performance.now() - t0)} ms`);
      const html = await marked.parse(result.markdown, { gfm: true });
      return sendJson(res, 200, { ...result, html });
    } catch (e) {
      if (e instanceof RulesParseError || e instanceof ConfigError) {
        return sendJson(res, 400, { error: e.message, ...(e instanceof RulesParseError ? { line: e.line, column: e.column } : {}) });
      }
      if (e instanceof TooManyRequestsError) {
        return sendJson(res, 413, { error: `These rules need ${e.requests} requests; the hosted playground runs up to ${e.max}. ${LOCALLY}` });
      }
      if (e instanceof QueueFullError) {
        return sendJson(res, 429, { error: 'The playground is busy. Try again in a few seconds.' }, { 'retry-after': '5' });
      }
      if (e instanceof DiffTimeoutError) {
        log(`timed out after ${e.timeoutMs} ms`);
        return sendJson(res, 504, { error: `This comparison took longer than ${e.timeoutMs / 1000} s, the hosted playground's limit. ${LOCALLY}` });
      }
      log(`failed: ${(e as Error).message}`);
      return sendJson(res, 500, { error: `firediff failed: ${(e as Error).message}` });
    }
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', page, { 'content-security-policy': csp });
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const h = hosted?.health?.() ?? { ok: true, problems: [] };
      return sendJson(res, h.ok ? 200 : 503, h);
    }
    if (url.pathname !== '/api/diff') return sendJson(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'use POST' });
    return compare(req, res);
  };
}

/** Listen on host:port; resolves once listening. */
export function listen(diff: DiffFn, port: number, host: string, options: PlaygroundOptions = {}): Promise<Server> {
  const handler = playgroundHandler(diff, options);
  const server = createServer((req, res) => void handler(req, res));
  if (options.hosted) {
    // Slow clients shouldn't hold sockets open (the proxy in front buffers requests anyway).
    server.headersTimeout = 10_000;
    server.requestTimeout = 15_000;
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
