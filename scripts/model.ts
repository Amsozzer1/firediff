// Print the rule model of a rules file as JSON (objects that fit on one line are kept inline).
import { readFileSync } from 'node:fs';
import { parseRules, RulesParseError } from '../src/parse/index.js';

const WIDTH = 100;

function format(v: unknown, indent = ''): string {
  const flat = JSON.stringify(v);
  if (flat === undefined || typeof v !== 'object' || v === null || indent.length + flat.length <= WIDTH) return flat ?? 'null';
  const inner = indent + '  ';
  if (Array.isArray(v)) return `[\n${v.map((x) => inner + format(x, inner)).join(',\n')}\n${indent}]`;
  const entries = Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${format(x, inner)}`);
  return `{\n${entries.join(',\n')}\n${indent}}`;
}

const file = process.argv[2]!;
try {
  console.log(format(parseRules(readFileSync(file, 'utf8'), file)));
} catch (e) {
  if (!(e instanceof RulesParseError)) throw e;
  console.error(e.message);
  process.exit(2);
}
