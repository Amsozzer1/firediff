import { matchDocument, print, type Expr, type MatchBlock, type PathPart, type PathSegment, type RuleModel } from '../parse/index.js';

export type Literal = string | number | boolean;

/** Segments of /databases/{database}/documents. */
export const DOC_PREFIX = 3;

/** Path shape below the documents prefix, wildcard names erased: users/{uid} and users/{id} → 'users/*'. */
export function shapeKey(docSegments: PathSegment[]): string {
  return docSegments.map((s) => (s.kind === 'literal' ? s.value : '*')).join('/');
}

/** Ordered set of literals (first-seen order, deduped by type + value). */
export class LiteralSet {
  readonly values: Literal[] = [];
  add(v: Literal): void {
    if (!this.values.some((x) => x === v)) this.values.push(v);
  }
}

export interface FieldFacts {
  /** Compared with request.auth.uid. */
  owner: boolean;
  /** request.auth.uid in resource.data.X */
  ownerList: boolean;
  /** == or in [...] against literals. */
  allowed: LiteralSet;
  /** != against literals. */
  forbidden: LiteralSet;
  /** Compared with a wildcard of the block (e.g. request.resource.data.orgId == orgId). */
  wildcard?: string;
  /** Types the rules check with `is` (string, int, bool, map, list, ...). */
  types: Set<string>;
  /** Bounds on F.size(), normalized to `size <op> n`. */
  sizes: Array<{ op: '<' | '<=' | '>' | '>=' | '=='; n: number }>;
  /** Compared with request.time (must be a server timestamp). */
  serverTime: boolean;
  /**
   * The rules protect this field: it's in a hasAny() key list, compared with its old value, a
   * literal, the caller's uid or a wildcard, or restricted with `in`. Changing such a field is an
   * access question, not a payload-shape one (hasOnly allow-lists, types and sizes are shape).
   */
  guarded: boolean;
}

export interface Lookup {
  fn: 'get' | 'exists' | 'getAfter' | 'existsAfter';
  /** Block the condition belongs to; its wildcards resolve the template's $(...) parts. */
  block: MatchBlock;
  parts: PathPart[];
  /** data.F literal comparisons on the looked-up doc: F → values */
  values: Map<string, LiteralSet>;
}

export interface Facts {
  /** Path shapes (see shapeKey, e.g. 'users/*') whose last wildcard is compared with request.auth.uid. */
  ownerSlots: Set<string>;
  /** Fields per match block path. */
  fields: Map<string, Map<string, FieldFacts>>;
  /** Token claim key (dotted, e.g. 'firebase.sign_in_provider') → literal values. */
  claims: Map<string, LiteralSet>;
  /** Claims compared with a wildcard: key + the wildcard's block. */
  claimWildcards: Array<{ key: string; block: MatchBlock; wildcard: string }>;
  /** Keyed by block path + printed path expression. */
  lookups: Map<string, Lookup>;
  /** Every literal in every condition, in order (for picking a disallowed value). */
  literals: LiteralSet;
  /** Literals a wildcard is compared with, per block path: docId != 'stats' → stats is worth a request. */
  docIdLiterals: Map<string, Map<string, LiteralSet>>;
}

export const LOOKUP_FNS = new Set(['get', 'exists', 'getAfter', 'existsAfter']);
const KEY_METHODS = new Set(['keys', 'affectedKeys', 'changedKeys', 'addedKeys', 'removedKeys']);
const KEY_SET_METHODS = new Set(['hasAny', 'hasAll', 'hasOnly']);

const isVar = (e: Expr, name: string) => e.kind === 'var' && e.name === name;
const isMember = (e: Expr, prop: string): e is Extract<Expr, { kind: 'member' }> => e.kind === 'member' && e.property === prop;

/** request.auth.uid */
export function isAuthUid(e: Expr): boolean {
  return isMember(e, 'uid') && isMember(e.object, 'auth') && isVar(e.object.object, 'request');
}

/** resource.data / request.resource.data */
export function isDataMap(e: Expr): boolean {
  if (!isMember(e, 'data')) return false;
  const o = e.object;
  return isVar(o, 'resource') || (isMember(o, 'resource') && isVar(o.object, 'request'));
}

/** resource.data.X, request.resource.data.X, resource.data['X'] → X */
export function dataField(e: Expr): string | null {
  if (e.kind === 'member' && isDataMap(e.object)) return e.property;
  if (e.kind === 'index' && isDataMap(e.object) && e.index.kind === 'literal' && e.index.type === 'string') {
    return e.index.value as string;
  }
  return null;
}

/** request.auth.token.a.b → 'a.b' */
export function claimKey(e: Expr): string | null {
  const props: string[] = [];
  let cur = e;
  while (cur.kind === 'member') {
    props.unshift(cur.property);
    cur = cur.object;
  }
  if (!isVar(cur, 'request') || props[0] !== 'auth' || props[1] !== 'token' || props.length < 3) return null;
  return props.slice(2).join('.');
}

/** get(path).data.F, .data.a.b, .data.roles['editor'] → { call, field: 'F' | 'a.b' | 'roles.editor' } */
function lookupField(e: Expr): { call: Extract<Expr, { kind: 'call' }>; field: string } | null {
  const path: string[] = [];
  let cur = e;
  for (;;) {
    if (cur.kind === 'member' && cur.property === 'data' && cur.object.kind === 'call') break;
    if (cur.kind === 'member') path.unshift(cur.property);
    else if (cur.kind === 'index' && cur.index.kind === 'literal' && cur.index.type === 'string') path.unshift(cur.index.value as string);
    else return null;
    cur = cur.object;
  }
  const call = (cur as Extract<Expr, { kind: 'member' }>).object as Extract<Expr, { kind: 'call' }>;
  if (!LOOKUP_FNS.has(call.callee) || !path.length) return null;
  return { call, field: path.join('.') };
}

const isRequestTime = (e: Expr) => e.kind === 'member' && e.property === 'time' && e.object.kind === 'var' && e.object.name === 'request';

function literalValue(e: Expr): Literal | null {
  if (e.kind !== 'literal' || e.type === 'null' || e.type === 'bytes') return null;
  return e.value as Literal;
}

function literalList(e: Expr): Literal[] | null {
  if (e.kind !== 'list') return null;
  const out = e.items.map(literalValue);
  return out.every((v) => v !== null) ? (out as Literal[]) : null;
}

export function emptyFacts(): Facts {
  return {
    ownerSlots: new Set(),
    fields: new Map(),
    claims: new Map(),
    claimWildcards: [],
    lookups: new Map(),
    literals: new LiteralSet(),
    docIdLiterals: new Map(),
  };
}

/** Collect facts from every inlined condition of every model (base and head → union). */
/** Fields the rules guard on a concrete doc path, in any version (see FieldFacts.guarded). */
export function guardedFields(models: RuleModel[], path: string, facts: Facts = extract(models)): Set<string> {
  const out = new Set<string>();
  for (const m of models) {
    for (const { block } of matchDocument(m, path)) {
      for (const [name, f] of facts.fields.get(block.path) ?? []) if (f.guarded || f.owner || f.ownerList) out.add(name);
    }
  }
  return out;
}

export function extract(models: RuleModel[]): Facts {
  const facts = emptyFacts();
  for (const m of models) {
    for (const block of m.matches) {
      if (block.documentPath === null) continue;
      for (const allow of block.allows) new BlockWalker(facts, block).walk(allow.inlined, true);
    }
  }
  return facts;
}

class BlockWalker {
  private readonly wildcards: Map<string, number>;

  constructor(
    private readonly facts: Facts,
    private readonly block: MatchBlock,
  ) {
    this.wildcards = new Map();
    block.segments.forEach((s, i) => {
      if (s.kind !== 'literal') this.wildcards.set(s.name, i);
    });
  }

  private wildcard(e: Expr): string | null {
    return e.kind === 'var' && this.wildcards.has(e.name) ? e.name : null;
  }

  private field(name: string): FieldFacts {
    let byBlock = this.facts.fields.get(this.block.path);
    if (!byBlock) this.facts.fields.set(this.block.path, (byBlock = new Map()));
    let f = byBlock.get(name);
    if (!f) byBlock.set(name, (f = { owner: false, ownerList: false, allowed: new LiteralSet(), forbidden: new LiteralSet(), types: new Set(), sizes: [], serverTime: false, guarded: false }));
    return f;
  }

  private docIdLiteral(wildcard: string, v: Literal): void {
    if (typeof v !== 'string' || !v || v.includes('/')) return;
    let byBlock = this.facts.docIdLiterals.get(this.block.path);
    if (!byBlock) this.facts.docIdLiterals.set(this.block.path, (byBlock = new Map()));
    let set = byBlock.get(wildcard);
    if (!set) byBlock.set(wildcard, (set = new LiteralSet()));
    set.add(v);
  }

  private claim(key: string, v: Literal): void {
    let set = this.facts.claims.get(key);
    if (!set) this.facts.claims.set(key, (set = new LiteralSet()));
    set.add(v);
  }

  private lookup(call: Extract<Expr, { kind: 'call' }>): Lookup | null {
    const arg = call.args[0];
    if (!arg || arg.kind !== 'path') return null;
    const key = `${this.block.path}|${print(arg)}`;
    let l = this.facts.lookups.get(key);
    if (!l) {
      l = { fn: call.callee as Lookup['fn'], block: this.block, parts: arg.parts, values: new Map() };
      this.facts.lookups.set(key, l);
    }
    return l;
  }

  /** Compare `a` against `b` (called for both orders). */
  private compare(op: '==' | '!=', a: Expr, b: Expr): void {
    const lit = literalValue(b);
    const wc = this.wildcard(a);
    if (wc && isAuthUid(b)) {
      const i = this.wildcards.get(wc)!;
      if (i >= DOC_PREFIX) this.facts.ownerSlots.add(shapeKey(this.block.segments.slice(DOC_PREFIX, i + 1)));
    }
    if (wc && lit !== null) this.docIdLiteral(wc, lit);
    const field = dataField(a);
    if (field !== null) {
      // Compared with its old value, a literal, the caller's uid or a wildcard: the rules protect it.
      if (lit !== null || isAuthUid(b) || this.wildcard(b) || dataField(b) === field) this.field(field).guarded = true;
      if (isAuthUid(b)) this.field(field).owner = true;
      else if (isRequestTime(b)) this.field(field).serverTime = true;
      else if (lit !== null) (op === '==' ? this.field(field).allowed : this.field(field).forbidden).add(lit);
      else {
        const w = this.wildcard(b);
        if (w) this.field(field).wildcard = w;
      }
    }
    const claim = claimKey(a);
    if (claim !== null) {
      if (lit !== null) this.claim(claim, lit);
      const w = this.wildcard(b);
      if (w) this.facts.claimWildcards.push({ key: claim, block: this.block, wildcard: w });
    }
    const lf = lookupField(a);
    if (lf && lit !== null) this.lookupValue(lf.call, lf.field, [lit]);
  }

  private lookupValue(call: Extract<Expr, { kind: 'call' }>, field: string, values: Literal[]): void {
    const l = this.lookup(call);
    if (!l) return;
    let set = l.values.get(field);
    if (!set) l.values.set(field, (set = new LiteralSet()));
    for (const v of values) set.add(v);
  }

  /** `boolPos`: the value is used as a condition (operand of &&, ||, !, ternary test, or the whole rule). */
  walk(e: Expr, boolPos: boolean): void {
    const lit = literalValue(e);
    if (lit !== null) this.facts.literals.add(lit);

    if (boolPos) {
      const claim = claimKey(e);
      if (claim !== null) this.claim(claim, true);
      // A lookup field used as a condition on its own: get(...).data.admin
      const lf = lookupField(e);
      if (lf) this.lookupValue(lf.call, lf.field, [true]);
    }
    const field = dataField(e);
    if (field !== null) this.field(field);

    switch (e.kind) {
      case 'binary': {
        const logical = e.op === '&&' || e.op === '||';
        if (e.op === '==' || e.op === '!=') {
          this.compare(e.op, e.left, e.right);
          this.compare(e.op, e.right, e.left);
        } else if (e.op === 'in') {
          this.within(e.left, e.right);
        }
        if (['<', '<=', '>', '>=', '=='].includes(e.op)) {
          const flip: Record<string, '<' | '<=' | '>' | '>=' | '=='> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==' };
          for (const [x, y, op] of [[e.left, e.right, e.op], [e.right, e.left, flip[e.op]!]] as const) {
            const n = literalValue(y);
            if (x.kind === 'method' && x.method === 'size' && typeof n === 'number') {
              const f = dataField(x.object);
              if (f !== null) {
                const bounds = this.field(f).sizes;
                if (!bounds.some((b) => b.op === op && b.n === n)) bounds.push({ op: op as '<' | '<=' | '>' | '>=' | '==', n });
              }
            }
          }
        }
        this.walk(e.left, logical);
        this.walk(e.right, logical);
        return;
      }
      case 'unary':
        return this.walk(e.operand, e.op === '!');
      case 'ternary':
        this.walk(e.test, true);
        this.walk(e.then, boolPos);
        this.walk(e.else, boolPos);
        return;
      case 'call':
        if (LOOKUP_FNS.has(e.callee)) this.lookup(e);
        for (const a of e.args) this.walk(a, false);
        return;
      case 'method': {
        if (KEY_SET_METHODS.has(e.method) && e.object.kind === 'method' && KEY_METHODS.has(e.object.method)) {
          // hasAny lists name fields that may NOT change; hasOnly/hasAll lists are allow-lists of payload keys.
          const forbids = e.method === 'hasAny';
          for (const v of e.args.flatMap((a) => literalList(a) ?? [])) {
            if (typeof v !== 'string') continue;
            const f = this.field(v);
            if (forbids) f.guarded = true;
          }
        }
        this.walk(e.object, false);
        for (const a of e.args) this.walk(a, false);
        return;
      }
      case 'member':
        return this.walk(e.object, false);
      case 'index':
        this.walk(e.object, false);
        return this.walk(e.index, false);
      case 'range':
        this.walk(e.object, false);
        if (e.start) this.walk(e.start, false);
        if (e.end) this.walk(e.end, false);
        return;
      case 'is': {
        const f = dataField(e.operand);
        if (f !== null) this.field(f).types.add(e.type);
        return this.walk(e.operand, false);
      }
      case 'list':
        for (const x of e.items) this.walk(x, false);
        return;
      case 'map':
        for (const x of e.entries) {
          this.walk(x.key, false);
          this.walk(x.value, false);
        }
        return;
      case 'path':
        for (const p of e.parts) if (p.kind === 'interp') this.walk(p.expr, false);
        return;
      case 'literal':
      case 'var':
        return;
    }
  }

  /** `x in y` */
  private within(x: Expr, y: Expr): void {
    const values = literalList(y);
    const wc = this.wildcard(x);
    if (wc && values) for (const v of values) this.docIdLiteral(wc, v);
    const field = dataField(x);
    if (field !== null && values) {
      this.field(field).guarded = true;
      for (const v of values) this.field(field).allowed.add(v);
    }
    const claim = claimKey(x);
    if (claim !== null && values) for (const v of values) this.claim(claim, v);
    const lf = lookupField(x);
    if (lf && values) this.lookupValue(lf.call, lf.field, values);
    const yField = dataField(y);
    if (yField !== null && isAuthUid(x)) this.field(yField).ownerList = true;
    if (isDataMap(y) && x.kind === 'literal' && x.type === 'string') this.field(x.value as string);
  }
}
