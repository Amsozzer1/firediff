import { print, type RuleModel } from '../parse/index.js';

/** Shape of GET /emulator/v1/projects/{id}:ruleCoverage (the parts we read). */
interface CoverageNode {
  sourcePosition: { line: number; column: number; currentOffset: number; endOffset: number };
  values?: Array<{ value: Record<string, unknown>; count: number }>;
  children?: CoverageNode[];
}
interface CoverageReport {
  rules?: { files?: Array<{ content: string }> };
  report?: CoverageNode[];
}

export interface Unexercised {
  line: number;
  column: number;
  /** Source text of the expression, whitespace collapsed. */
  text: string;
  kind: 'never-true' | 'never-evaluated';
}

const MAX_TEXT = 100;

function shorten(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat;
}

/**
 * Source text for a coverage node. endOffset is inclusive, and for calls it stops before the
 * closing paren, so re-close any brackets the slice leaves open.
 */
function nodeText(src: Buffer, pos: CoverageNode['sourcePosition']): string {
  let end = pos.endOffset + 1;
  const open = () => {
    const s = src.subarray(pos.currentOffset, end).toString('utf8');
    return (s.match(/[([]/g)?.length ?? 0) - (s.match(/[)\]]/g)?.length ?? 0);
  };
  while (open() > 0 && end < src.length && /[\s)\]]/.test(String.fromCharCode(src[end]!))) end++;
  return src.subarray(pos.currentOffset, end).toString('utf8');
}

const trueCount = (n: CoverageNode) =>
  (n.values ?? []).reduce((sum, v) => sum + (v.value.boolValue === true ? v.count : 0), 0);
const isBoolean = (n: CoverageNode) => (n.values ?? []).some((v) => 'boolValue' in v.value);
const key = (line: number, column: number) => `${line}:${column}`;

/**
 * Expressions in `model` that never evaluated true during the run: the outermost boolean
 * expression that was never true in each subtree, plus allow conditions the emulator never
 * evaluated at all (they don't appear in the report). Literal conditions are skipped.
 */
export function notExercised(coverage: unknown, model: RuleModel, source?: string): Unexercised[] {
  const report = coverage as CoverageReport;
  // `source`: the original text, when the emulator ran a same-length rewrite (time limits neutralized).
  const src = Buffer.from(source ?? report.rules?.files?.[0]?.content ?? '', 'utf8');
  const out = new Map<string, Unexercised>();
  const seen = new Set<string>();

  const conditions = new Map<string, string>();
  for (const block of model.matches) {
    for (const a of block.allows) {
      if (!a.conditionLoc || a.condition.kind === 'literal') continue;
      conditions.set(key(a.conditionLoc.line, a.conditionLoc.column), print(a.condition));
    }
  }

  const walk = (n: CoverageNode) => {
    const p = n.sourcePosition;
    const k = key(p.line, p.column);
    // A condition's sub-expressions can start at the same line:col; only the outermost node is the condition.
    const isCondition = conditions.has(k) && !seen.has(k);
    seen.add(k);
    if ((isBoolean(n) || isCondition) && trueCount(n) === 0) {
      if (!out.has(k)) out.set(k, { line: p.line, column: p.column, text: shorten(nodeText(src, p)), kind: 'never-true' });
      return;
    }
    for (const c of n.children ?? []) walk(c);
  };
  for (const n of report.report ?? []) walk(n);

  for (const [k, text] of conditions) {
    if (seen.has(k)) continue;
    const [line, column] = k.split(':').map(Number) as [number, number];
    out.set(k, { line, column, text: shorten(text), kind: 'never-evaluated' });
  }
  return [...out.values()].sort((a, b) => a.line - b.line || a.column - b.column);
}

export interface AllowCoverage {
  /** Allows with a non-literal condition. */
  total: number;
  /** Of those, how many evaluated true for at least one request. */
  reached: number;
  /** Lines of the allows that never evaluated true. */
  unreachedLines: number[];
}

/** How many of the model's allow conditions evaluated true at least once. */
export function allowCoverage(coverage: unknown, model: RuleModel): AllowCoverage {
  const report = coverage as CoverageReport;
  const outermost = new Map<string, CoverageNode>();
  const walk = (n: CoverageNode) => {
    const k = key(n.sourcePosition.line, n.sourcePosition.column);
    if (!outermost.has(k)) outermost.set(k, n);
    for (const c of n.children ?? []) walk(c);
  };
  for (const n of report.report ?? []) walk(n);
  const allows = model.matches.flatMap((b) => b.allows).filter((a) => a.conditionLoc && a.condition.kind !== 'literal');
  const unreached = allows.filter((a) => {
    const n = outermost.get(key(a.conditionLoc!.line, a.conditionLoc!.column));
    return !n || trueCount(n) === 0;
  });
  return { total: allows.length, reached: allows.length - unreached.length, unreachedLines: unreached.map((a) => a.loc.line) };
}
