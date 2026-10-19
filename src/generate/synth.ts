import type { Expr, PathPart } from '../parse/index.js';
import { claimKey, dataField, isAuthUid, LOOKUP_FNS, type Literal } from './extract.js';
import { sampleFor } from './regex.js';

/**
 * A value a synthesized principal or seed must hold, before it's resolved against a concrete path:
 * a literal, the principal's own uid, a wildcard's id, a field of the target doc's seed, a list
 * containing a value, or a timestamp before/after now.
 */
export type Sym =
  | { lit: Literal }
  | { uid: true }
  | { wildcard: string }
  | { field: string }
  | { listOf: Sym }
  | { time: 'past' | 'future' };

export interface LookupNeed {
  parts: PathPart[];
  /** Field path inside the looked-up doc (['readOnly', 'writeRate'], ['roles', 'editor']) → value. */
  fields: Array<{ path: string[]; value: Sym }>;
}

export interface BranchNeeds {
  /** uid compared with a wildcard or an owner field: the principal must own the target doc. */
  ownsTarget: boolean;
  uidLiteral?: string;
  /** Dotted claim key → value. */
  token: Map<string, Sym>;
  /** Claims whose value is a sample string for a regex (no standalone principal has those). */
  regexClaims: Set<string>;
  lookups: LookupNeed[];
  /** Constraints this pass couldn't satisfy (reported, not fatal). */
  unresolved: string[];
}

interface Atom {
  e: Expr;
  neg: boolean;
}

const MAX_BRANCHES = 8;

/** Disjunctive normal form, capped: each branch is a list of (possibly negated) atoms that must all hold. */
export function branches(e: Expr, cap = MAX_BRANCHES): Atom[][] {
  const go = (x: Expr, neg: boolean): Atom[][] => {
    if (x.kind === 'unary' && x.op === '!') return go(x.operand, !neg);
    if (x.kind === 'binary' && (x.op === '&&' || x.op === '||')) {
      const and = (x.op === '&&') !== neg;
      const l = go(x.left, neg);
      const r = go(x.right, neg);
      if (!and) return [...l, ...r].slice(0, cap);
      const out: Atom[][] = [];
      for (const a of l) for (const b of r) if (out.length < cap) out.push([...a, ...b]);
      return out;
    }
    if (x.kind === 'ternary') {
      return go({ kind: 'binary', op: '||', left: { kind: 'binary', op: '&&', left: x.test, right: x.then }, right: { kind: 'binary', op: '&&', left: { kind: 'unary', op: '!', operand: x.test }, right: x.else } }, neg);
    }
    return [[{ e: x, neg }]];
  };
  return go(e, false).slice(0, cap);
}

const isVar = (e: Expr, n: string) => e.kind === 'var' && e.name === n;
const isAuth = (e: Expr) => e.kind === 'member' && e.property === 'auth' && isVar(e.object, 'request');
const isRequestTime = (e: Expr): boolean =>
  (e.kind === 'member' && e.property === 'time' && isVar(e.object, 'request')) ||
  (e.kind === 'binary' && (isRequestTime(e.left) || isRequestTime(e.right))) ||
  (e.kind === 'method' && isRequestTime(e.object));

/** get(P).data.a.b['c'] → { call, path: ['a','b','c'] } */
function lookupChain(e: Expr): { call: Extract<Expr, { kind: 'call' }>; path: string[] } | null {
  const path: string[] = [];
  let cur = e;
  while (cur.kind === 'member' || (cur.kind === 'index' && cur.index.kind === 'literal' && cur.index.type === 'string')) {
    if (cur.kind === 'member') {
      if (cur.property === 'data' && cur.object.kind === 'call') break;
      path.unshift(cur.property);
    } else path.unshift((cur as Extract<Expr, { kind: 'index' }>).index.kind === 'literal' ? String(((cur as Extract<Expr, { kind: 'index' }>).index as { value: unknown }).value) : '');
    cur = cur.object;
  }
  if (cur.kind !== 'member' || cur.property !== 'data' || cur.object.kind !== 'call') return null;
  const call = cur.object;
  // getAfter/existsAfter read the post-write state, which seeding can't set up.
  if (!LOOKUP_FNS.has(call.callee) || call.callee.endsWith('After') || call.args[0]?.kind !== 'path' || !path.length) return null;
  return { call, path };
}

function literalOf(e: Expr): Literal | null {
  if (e.kind === 'literal' && e.type !== 'null' && e.type !== 'bytes') return e.value as Literal;
  if (e.kind === 'unary' && e.op === '-' && e.operand.kind === 'literal' && typeof e.operand.value === 'number') return -e.operand.value;
  return null;
}

/**
 * What a principal (and its seeds) needs for every atom in a branch to hold. Returns null for
 * branches that require being signed out (the base "signed out" principal covers those) or that
 * contradict themselves.
 */
export function needsFor(branch: Atom[], wildcards: Set<string>): BranchNeeds | null {
  const needs: BranchNeeds = { ownsTarget: false, token: new Map(), regexClaims: new Set(), lookups: [], unresolved: [] };
  const lookupFor = (call: Extract<Expr, { kind: 'call' }>): LookupNeed => {
    const parts = (call.args[0] as Extract<Expr, { kind: 'path' }>).parts;
    const key = JSON.stringify(parts);
    let l = needs.lookups.find((x) => JSON.stringify(x.parts) === key);
    if (!l) needs.lookups.push((l = { parts, fields: [] }));
    return l;
  };
  /** Turn the other side of a comparison into a Sym. */
  const symOf = (e: Expr): Sym | null => {
    const lit = literalOf(e);
    if (lit !== null) return { lit };
    if (isAuthUid(e)) return { uid: true };
    if (e.kind === 'var' && wildcards.has(e.name)) return { wildcard: e.name };
    const f = dataField(e);
    if (f !== null) return { field: f };
    return null;
  };

  for (const { e, neg } of branch) {
    // Signed-in / signed-out
    if (e.kind === 'binary' && (e.op === '==' || e.op === '!=') && (isAuth(e.left) || isAuthUid(e.left)) && e.right.kind === 'literal' && e.right.type === 'null') {
      const wantsNull = (e.op === '==') !== neg;
      if (wantsNull) return null;
      continue;
    }
    if (neg) continue; // negated constraints are satisfied by leaving things unset

    if (e.kind === 'binary' && e.op === '==') {
      for (const [a, b] of [[e.left, e.right], [e.right, e.left]] as const) {
        if (isAuthUid(a)) {
          const lit = literalOf(b);
          if (typeof lit === 'string') needs.uidLiteral = lit;
          else if ((b.kind === 'var' && wildcards.has(b.name)) || dataField(b) !== null) needs.ownsTarget = true;
          continue;
        }
        const claim = claimKey(a);
        if (claim !== null) {
          const s = symOf(b);
          if (s && !('uid' in s)) needs.token.set(claim, s);
          continue;
        }
        const chain = lookupChain(a);
        if (chain) {
          const s = symOf(b);
          if (s) lookupFor(chain.call).fields.push({ path: chain.path, value: s });
          else if (isRequestTime(b)) needs.unresolved.push('lookup field compared with request.time');
        }
      }
      continue;
    }
    if (e.kind === 'binary' && ['<', '<=', '>', '>='].includes(e.op)) {
      const flip = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' } as Record<string, string>;
      for (const [a, b, op] of [[e.left, e.right, e.op], [e.right, e.left, flip[e.op]!]] as const) {
        const chain = lookupChain(a);
        if (!chain) continue;
        const lit = literalOf(b);
        if (typeof lit === 'number') {
          const v = op === '<' ? lit - 1 : op === '>' ? lit + 1 : lit;
          lookupFor(chain.call).fields.push({ path: chain.path, value: { lit: v } });
        } else if (isRequestTime(b)) {
          lookupFor(chain.call).fields.push({ path: chain.path, value: { time: op === '<' || op === '<=' ? 'past' : 'future' } });
        }
      }
      continue;
    }
    if (e.kind === 'binary' && e.op === 'in') {
      const values = e.right.kind === 'list' ? e.right.items.map(literalOf) : null;
      const first = values?.find((v) => v !== null);
      const claim = claimKey(e.left);
      if (claim !== null && first !== undefined && first !== null) needs.token.set(claim, { lit: first });
      const chain = lookupChain(e.left);
      if (chain && first !== undefined && first !== null) lookupFor(chain.call).fields.push({ path: chain.path, value: { lit: first } });
      if (isAuthUid(e.left) && dataField(e.right) !== null) needs.ownsTarget = true;
      const rightChain = lookupChain(e.right);
      if (rightChain) {
        const s = symOf(e.left);
        if (s) lookupFor(rightChain.call).fields.push({ path: rightChain.path, value: { listOf: s } });
      }
      continue;
    }
    if (e.kind === 'method' && e.method === 'matches' && e.args[0]?.kind === 'literal' && typeof e.args[0].value === 'string') {
      const target = e.object.kind === 'method' && e.object.method === 'lower' ? e.object.object : e.object;
      const claim = claimKey(target);
      if (claim !== null) {
        const sample = sampleFor(e.args[0].value);
        if (sample !== null) {
          needs.token.set(claim, { lit: sample });
          needs.regexClaims.add(claim);
        }
        else needs.unresolved.push(`no sample string for /${e.args[0].value}/`);
      }
      continue;
    }
    if (e.kind === 'method' && (e.method === 'hasAny' || e.method === 'hasAll') && e.args[0]?.kind === 'list') {
      const chain = lookupChain(e.object);
      const first = e.args[0].items.map(literalOf).find((v) => v !== null);
      if (chain && first !== undefined && first !== null) lookupFor(chain.call).fields.push({ path: chain.path, value: { listOf: { lit: first } } });
      continue;
    }
    if (e.kind === 'call' && e.callee === 'exists' && e.args[0]?.kind === 'path') {
      lookupFor(e);
      continue;
    }
    // Bare use as a boolean.
    const claim = claimKey(e);
    if (claim !== null) {
      needs.token.set(claim, { lit: true });
      continue;
    }
    const chain = lookupChain(e);
    if (chain) lookupFor(chain.call).fields.push({ path: chain.path, value: { lit: true } });
  }
  return needs;
}

/** True when a branch needs more than the base principals already provide. */
export function isInteresting(n: BranchNeeds): boolean {
  return n.token.size > 0 || n.lookups.length > 0 || n.uidLiteral !== undefined;
}

