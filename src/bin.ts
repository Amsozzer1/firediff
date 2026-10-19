#!/usr/bin/env node
// The `firediff` command. Kept apart from cli.ts so the Action can import main() without running it.
import { main } from './cli.js';

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
