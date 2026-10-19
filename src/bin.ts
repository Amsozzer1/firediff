#!/usr/bin/env node
// The `firediff` command. Kept apart from cli.ts so the Action can import main() without running it.
import { isMainThread } from 'node:worker_threads';
import { main } from './cli.js';

// The hosted playground loads this same file in worker threads (see playground/worker.ts).
if (isMainThread) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
