import type { Expr, MatchBlock, Op, PathSegment, RuleModel } from './model.js';

const FALSE: Expr = { kind: 'literal', type: 'bool', value: false };
const DOCUMENTS_PREFIX = 3;

/** OR together a list of conditions; an empty list is `false` (nothing allows it). */
export function or(conditions: Expr[]): Expr {
  if (conditions.length === 0) return FALSE;
  return conditions.reduce((left, right) => ({ kind: 'binary', op: '||', left, right }));
}

/** All allow statements in one block for an op, ORed. */
export function blockCondition(block: MatchBlock, op: Op): Expr {
  return or(block.allows.filter((a) => a.ops.includes(op)).map((a) => a.inlined));
}

export interface PathMatch {
  block: MatchBlock;
  /** Wildcard name → bound value. Recursive wildcards bind 'a/b/c' (a path in v2, a string in v1). */
  bindings: Record<string, string>;
}

/**
 * Every match block whose path matches a concrete document path (relative to
 * /databases/(default)/documents, e.g. 'users/u1'). Under v2, {x=**} matches zero or more
 * segments; under v1 it needs at least one.
 */
export function matchDocument(model: RuleModel, docPath: string): PathMatch[] {
  const parts = docPath.split('/').filter(Boolean);
  const minRecursive = model.version.effective === '2' ? 0 : 1;
  const out: PathMatch[] = [];
  for (const block of model.matches) {
    if (block.documentPath === null) continue;
    const bindings: Record<string, string> = {};
    const db = block.segments[1]!;
    if (db.kind === 'wildcard') bindings[db.name] = '(default)';
    const found = matchSegments(block.segments.slice(DOCUMENTS_PREFIX), parts, minRecursive, bindings);
    if (found) out.push({ block, bindings: found });
  }
  return out;
}

function matchSegments(
  segs: PathSegment[],
  parts: string[],
  minRecursive: number,
  bindings: Record<string, string>,
): Record<string, string> | null {
  const [seg, ...rest] = segs;
  if (!seg) return parts.length === 0 ? bindings : null;
  if (seg.kind === 'literal') {
    return parts[0] === seg.value ? matchSegments(rest, parts.slice(1), minRecursive, bindings) : null;
  }
  if (seg.kind === 'wildcard') {
    return parts.length ? matchSegments(rest, parts.slice(1), minRecursive, { ...bindings, [seg.name]: parts[0]! }) : null;
  }
  for (let n = parts.length; n >= minRecursive; n--) {
    const m = matchSegments(rest, parts.slice(n), minRecursive, { ...bindings, [seg.name]: parts.slice(0, n).join('/') });
    if (m) return m;
  }
  return null;
}

/** Replace wildcard variables with the values they're bound to. */
export function bind(e: Expr, bindings: Record<string, string>): Expr {
  const b = (x: Expr) => bind(x, bindings);
  switch (e.kind) {
    case 'literal':
      return e;
    case 'var':
      return e.name in bindings ? { kind: 'literal', type: 'string', value: bindings[e.name]! } : e;
    case 'member':
      return { ...e, object: b(e.object) };
    case 'index':
      return { ...e, object: b(e.object), index: b(e.index) };
    case 'range':
      return { ...e, object: b(e.object), start: e.start && b(e.start), end: e.end && b(e.end) };
    case 'call':
      return { ...e, args: e.args.map(b) };
    case 'method':
      return { ...e, object: b(e.object), args: e.args.map(b) };
    case 'unary':
      return { ...e, operand: b(e.operand) };
    case 'binary':
      return { ...e, left: b(e.left), right: b(e.right) };
    case 'is':
      return { ...e, operand: b(e.operand) };
    case 'ternary':
      return { ...e, test: b(e.test), then: b(e.then), else: b(e.else) };
    case 'list':
      return { ...e, items: e.items.map(b) };
    case 'map':
      return { ...e, entries: e.entries.map((x) => ({ key: b(x.key), value: b(x.value) })) };
    case 'path':
      return { ...e, parts: e.parts.map((p) => (p.kind === 'interp' ? { ...p, expr: b(p.expr) } : p)) };
  }
}

/**
 * The condition Firestore evaluates for `op` on a document: every allow for that op in every
 * matching block, ORed, with wildcards bound to the path's values.
 */
export function effectiveCondition(model: RuleModel, op: Op, docPath: string): Expr {
  return or(
    matchDocument(model, docPath).flatMap(({ block, bindings }) =>
      block.allows.filter((a) => a.ops.includes(op)).map((a) => bind(a.inlined, bindings)),
    ),
  );
}
