// Docker HEALTHCHECK for the hosted playground (see the Dockerfile).
//
// Docker only reports "unhealthy"; outside Swarm it never restarts a container for it. A crash already
// restarts the container (restart: unless-stopped), but a server that hangs would stay down. So:
// after MISSES checks in a row with no HTTP answer at all, kill the server. The container exits and
// the restart policy starts a fresh one.
//
// A 503 is an answer: firediff is degraded (emulator restarting, low memory) and recovers by itself,
// so it shows as unhealthy without counting as a miss. Misses only count once the server has
// answered since the container started, so a slow start can't cause a restart loop.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const URL = `http://127.0.0.1:${process.env.FIREDIFF_PORT ?? 8787}/healthz`;
const STATE = '/tmp/firediff-health.json';
const MISSES = 3;

let state = { answered: false, misses: 0 };
try {
  state = { ...state, ...JSON.parse(readFileSync(STATE, 'utf8')) };
} catch {
  // first check since the container started (/tmp is a fresh tmpfs)
}
const save = () => writeFileSync(STATE, JSON.stringify(state));

try {
  const res = await fetch(URL, { signal: AbortSignal.timeout(4_000) });
  state = { answered: true, misses: 0 };
  save();
  process.exit(res.ok ? 0 : 1);
} catch {
  if (state.answered) state.misses++;
  save();
  if (state.answered && state.misses >= MISSES) {
    // PID 1 is docker-init, which ignores signals sent from inside the container; kill the server it runs.
    for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
      try {
        const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
        if (cmd.includes('/opt/firediff/cli/index.js') && cmd.includes('playground')) process.kill(Number(pid), 'SIGKILL');
      } catch {
        // gone already, or not ours
      }
    }
  }
  process.exit(1);
}
