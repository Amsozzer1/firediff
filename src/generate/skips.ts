import { print, type Allow, type Expr, type MatchBlock, type RuleModel } from '../parse/index.js';
import { claimKey, dataField, isAuthUid, isDataMap, LOOKUP_FNS } from './extract.js';

/** Things the generator knowingly doesn't exercise, located in a rules file. */
export interface Skip {
  kind: 'combined-principals' | 'lookup-on-document-data' | 'list-depends-on-doc-id';
  line: number;
  message: string;
}

function children(e: Expr): Expr[] {
  switch (e.kind) {
    case 'literal':
    case 'var':
      return [];
    case 'member':
      return [e.object];
    case 'index':
      return [e.object, e.index];
    case 'range':
      return [e.object, ...(e.start ? [e.start] : []), ...(e.end ? [e.end] : [])];
    case 'call':
      return e.args;
    case 'method':
      return [e.object, ...e.args];
    case 'unary':
    case 'is':
      return [e.operand];
    case 'binary':
      return [e.left, e.right];
    case 'ternary':
      return [e.test, e.then, e.else];
    case 'list':
      return e.items;
    case 'map':
      return e.entries.flatMap((x) => [x.key, x.value]);
    case 'path':
      return e.parts.flatMap((p) => (p.kind === 'interp' ? [p.expr] : []));
  }
}

const some = (e: Expr, pred: (x: Expr) => boolean): boolean => pred(e) || children(e).some((c) => some(c, pred));
const all = (e: Expr): Expr[] => [e, ...children(e).flatMap(all)];

const isResourceRef = (e: Expr) =>
  (e.kind === 'var' && e.name === 'resource') ||
  (e.kind === 'member' && e.property === 'resource' && e.object.kind === 'var' && e.object.name === 'request') ||
  isDataMap(e);

function isUidLookup(e: Expr): boolean {
  return e.kind === 'call' && LOOKUP_FNS.has(e.callee) && e.args[0]?.kind === 'path' && some(e.args[0], isAuthUid);
}

function ownership(e: Expr, wildcards: Set<string>): boolean {
  return some(e, (x) => {
    if (x.kind !== 'binary') return false;
    if (x.op === '==' || x.op === '!=') {
      const [a, b] = [x.left, x.right];
      const owned = (y: Expr) => (y.kind === 'var' && wildcards.has(y.name)) || dataField(y) !== null;
      return (isAuthUid(a) && owned(b)) || (isAuthUid(b) && owned(a));
    }
    return x.op === 'in' && isAuthUid(x.left) && dataField(x.right) !== null;
  });
}

const roleCheck = (e: Expr) => some(e, (x) => claimKey(x) !== null || isUidLookup(x));

function shorten(s: string, max = 100): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function allowSkips(block: MatchBlock, allow: Allow): Skip[] {
  const out: Skip[] = [];
  const line = allow.loc.line;
  const wildcards = new Set(block.segments.flatMap((s) => (s.kind === 'literal' ? [] : [s.name])));

  // A claim/role and ownership required together (&&), e.g. hasRole('writer') && resource.data.author == uid.
  const combined = all(allow.inlined).some(
    (x) =>
      x.kind === 'binary' && x.op === '&&' &&
      ((roleCheck(x.left) && ownership(x.right, wildcards)) || (roleCheck(x.right) && ownership(x.left, wildcards))),
  );
  if (combined) {
    out.push({
      kind: 'combined-principals',
      line,
      message: `needs a claim or role and ownership at once (\`${shorten(print(allow.condition))}\`); firediff doesn't try principals that have both`,
    });
  }

  for (const x of all(allow.inlined)) {
    if (x.kind !== 'call' || !LOOKUP_FNS.has(x.callee) || x.args[0]?.kind !== 'path') continue;
    const dataPart = x.args[0].parts.find((p) => p.kind === 'interp' && some(p.expr, isResourceRef));
    if (dataPart && dataPart.kind === 'interp') {
      out.push({
        kind: 'lookup-on-document-data',
        line,
        message: `\`${x.callee}(${shorten(print(x.args[0]), 80)})\` is keyed on \`${print(dataPart.expr)}\`; firediff doesn't seed lookups that depend on document data`,
      });
    }
  }

  const last = block.segments.at(-1);
  if (allow.ops.includes('list') && last?.kind === 'wildcard' && some(allow.inlined, (x) => x.kind === 'var' && x.name === last.name)) {
    out.push({
      kind: 'list-depends-on-doc-id',
      line,
      message: `list rule reads \`{${last.name}}\`, the document id; a collection query can't satisfy that, so only the deny side of list is tested here`,
    });
  }
  return out;
}

/** Known generator skips that apply to a rules file, ordered by line. */
export function findSkips(model: RuleModel): Skip[] {
  const out: Skip[] = [];
  const seen = new Set<string>();
  for (const block of model.matches) {
    if (block.documentPath === null) continue;
    for (const allow of block.allows) {
      for (const s of allowSkips(block, allow)) {
        const key = `${s.line}|${s.kind}|${s.message}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(s);
        }
      }
    }
  }
  return out.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
}
