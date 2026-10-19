import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { EmulatorAddress } from './harness.js';

export class EmulatorError extends Error {
  override name = 'EmulatorError';
}

const READY_TIMEOUT_MS = 90_000;

function isJava21(home: string): boolean {
  try {
    return existsSync(join(home, 'bin', 'java')) && /^JAVA_VERSION="21[."]/m.test(readFileSync(join(home, 'release'), 'utf8'));
  } catch {
    return false;
  }
}

/** Same search as scripts/java21.sh: JAVA_HOME, java_home -v 21 (verified), Homebrew, /usr/lib/jvm. */
export function findJava21(): string {
  const candidates: string[] = [];
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);
  try {
    // java_home -v 21 falls back to the default JVM when no 21 is registered, so isJava21 checks it.
    candidates.push(execFileSync('/usr/libexec/java_home', ['-v', '21'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    // not macOS, or no JVMs registered
  }
  candidates.push('/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home', '/opt/homebrew/opt/openjdk@21', '/usr/local/opt/openjdk@21');
  try {
    for (const d of readdirSync('/usr/lib/jvm')) candidates.push(join('/usr/lib/jvm', d));
  } catch {
    // no /usr/lib/jvm
  }
  const found = candidates.find(isJava21);
  if (!found) throw new EmulatorError('Java 21 not found (the Firestore emulator needs it). Install it with: brew install openjdk@21');
  return found;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function waitReady(url: string, child: { exitCode: number | null }, output: () => string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new EmulatorError(`Firestore emulator exited (${child.exitCode}):\n${output()}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new EmulatorError(`Firestore emulator not ready after ${READY_TIMEOUT_MS / 1000}s:\n${output()}`);
}

/** The Firestore emulator firediff runs (the one firebase-tools 15.34 uses). */
export const EMULATOR_JAR = {
  version: '1.22.0',
  url: 'https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.22.0.jar',
  size: 136_707_194,
  sha256: '9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c',
  /** Same place firebase-tools caches it, so either tool reuses the other's download. */
  path: join(homedir(), '.cache', 'firebase', 'emulators', 'cloud-firestore-emulator-v1.22.0.jar'),
};

/** The emulator jar, downloaded and checksum-verified on first use. */
export async function emulatorJar(): Promise<string> {
  const jar = process.env.FIREDIFF_EMULATOR_JAR || EMULATOR_JAR.path;
  if (existsSync(jar) && statSync(jar).size === EMULATOR_JAR.size) return jar;
  if (process.env.FIREDIFF_EMULATOR_JAR) throw new EmulatorError(`FIREDIFF_EMULATOR_JAR ${jar} is missing or the wrong size`);
  process.stderr.write(`firediff: downloading the Firestore emulator v${EMULATOR_JAR.version} (${Math.round(EMULATOR_JAR.size / 1e6)} MB, once)\n`);
  mkdirSync(dirname(jar), { recursive: true });
  const res = await fetch(EMULATOR_JAR.url);
  if (!res.ok || !res.body) throw new EmulatorError(`downloading ${EMULATOR_JAR.url} failed: HTTP ${res.status}`);
  const tmp = `${jar}.${process.pid}.part`;
  const hash = createHash('sha256');
  const out = createWriteStream(tmp);
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    const digest = hash.digest('hex');
    if (digest !== EMULATOR_JAR.sha256) throw new EmulatorError(`emulator download checksum mismatch (${digest})`);
    renameSync(tmp, jar);
  } finally {
    rmSync(tmp, { force: true });
  }
  return jar;
}

/**
 * Run `fn` against a Firestore emulator: the one in FIRESTORE_EMULATOR_HOST if set, otherwise a
 * fresh one (Java 21, multi-project mode) on a free port, stopped afterwards.
 */
export async function withEmulator<T>(fn: (emulator: EmulatorAddress) => Promise<T>): Promise<T> {
  const fromEnv = process.env.FIRESTORE_EMULATOR_HOST;
  if (fromEnv) {
    const i = fromEnv.lastIndexOf(':');
    return fn({ host: fromEnv.slice(0, i), port: Number(fromEnv.slice(i + 1)) });
  }

  const javaHome = findJava21();
  const jar = await emulatorJar();
  const [port, websocketPort] = await Promise.all([freePort(), freePort()]);
  const args = [
    '-Dgoogle.cloud_firestore.debug_log_level=FINE',
    '-Duser.language=en',
    '-jar', jar,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--websocket_port', String(websocketPort),
    '--project_id', 'demo-firediff',
    // Several projects (fd-base-*, fd-head-*) in one emulator, each with its own rules.
    '--single_project_mode', 'false',
  ];

  let log = '';
  const child = spawn(join(javaHome, 'bin', 'java'), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = (b: Buffer) => {
    log = (log + b.toString()).slice(-4000);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  try {
    await waitReady(`http://127.0.0.1:${port}/`, child, () => log);
    return await fn({ host: '127.0.0.1', port });
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    }
  }
}
