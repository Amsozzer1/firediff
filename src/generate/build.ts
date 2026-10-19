import { matchDocument, type MatchBlock, type PathSegment, type RuleModel } from '../parse/index.js';
import { requestTarget, SERVER_TIME, timestampAt, type Case, type DocData, type Principal, type Request, type Seed } from '../run/types.js';
import { branches } from './synth.js';
import type { Config } from './config.js';
import { DOC_PREFIX, extract, LiteralSet, shapeKey, type Facts, type Literal, type Lookup } from './extract.js';
import { mergeDeep, synthesize } from './synthesize.js';

export const OWNER_UID = 'u_owner';
export const OTHER_UID = 'u_other';
export const PROBE_FIELD = 'firediff_probe';
const UID_PLACEHOLDER = '$uid';

export interface PlannedRequest {
  /** The document this request was generated for (lists sort with their doc). */
  doc: string;
  request: Request;
  /** Short description of why this request exists. */
  why: string;
  /** Sent only by these principals (a synthesized owner's requests on its own copies). */
  only?: string[];
}

export interface Plan {
  principals: Principal[];
  seeds: Seed[];
  requests: PlannedRequest[];
  notes: string[];
}

const OP_ORDER: Request['op'][] = ['get', 'list', 'create', 'update', 'delete'];

const BASE_PRINCIPALS: Principal[] = [
  { name: 'signed out', label: 'anyone, without signing in', auth: null },
  { name: 'stranger', label: 'any signed-in user', auth: { uid: 'u_stranger' } },
  { name: 'owner', label: 'the user who owns the doc', auth: { uid: OWNER_UID } },
  { name: 'other user', label: 'another signed-in user who owns docs of their own', auth: { uid: OTHER_UID } },
];

const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
const show = (v: unknown) => (typeof v === 'string' ? `'${v}'` : JSON.stringify(v));

/** One wildcard binding per name for a block: owner slot → u_owner, others → first letter + 1. */
function wildcardIds(block: MatchBlock, facts: Facts): Map<string, string> {
  const ids = new Map<string, string>();
  const segs = block.segments.slice(DOC_PREFIX);
  segs.forEach((s, i) => {
    if (s.kind === 'literal') return;
    const owner = facts.ownerSlots.has(shapeKey(segs.slice(0, i + 1)));
    ids.set(s.name, owner ? OWNER_UID : `${(s.name[0] ?? 'x').toLowerCase().replace(/[^a-z]/, 'x')}1`);
  });
  return ids;
}

/** Concrete document paths for a block: recursive wildcards expand to depth 1 and depth 2. */
function concretePaths(block: MatchBlock, facts: Facts, override?: Map<string, string>): string[] {
  const segs = block.segments.slice(DOC_PREFIX);
  const ids = new Map([...wildcardIds(block, facts), ...(override ?? [])]);
  const r = segs.findIndex((s) => s.kind === 'recursive');
  const fixed = (s: PathSegment) => (s.kind === 'literal' ? s.value : ids.get(s.name)!);
  if (r === -1) return segs.length % 2 === 0 && segs.length > 0 ? [segs.map(fixed).join('/')] : [];
  const before = segs.slice(0, r).map(fixed);
  const after = segs.slice(r + 1).map(fixed);
  const out: string[] = [];
  let k = (before.length + after.length) % 2 === 0 ? 2 : 1;
  for (let depth = 0; depth < 2; depth++, k += 2) {
    const filler = Array.from({ length: k }, (_, j) => {
      const pos = before.length + j;
      return `${pos % 2 === 0 ? 'c' : 'd'}${Math.floor(j / 2) + 1}`;
    });
    out.push([...before, ...filler, ...after].join('/'));
  }
  return out;
}

interface FieldInfo {
  owner: boolean;
  ownerList: boolean;
  allowed: Literal[];
  forbidden: Literal[];
  wildcardValue?: string;
  types: string[];
  sizes: Array<{ op: '<' | '<=' | '>' | '>=' | '=='; n: number }>;
  serverTime: boolean;
}

/** Per-field cap on extra payload variants (types, sizes, alternative values). */
const MAX_VARIANTS = 12;
/** Per-block cap on doc-state copies and on doc ids taken from literals. */
const MAX_STATES = 3;
const MAX_DOC_ID_LITERALS = 3;

/** A sample value of a rules type. */
function sampleOf(type: string, name: string): unknown {
  switch (type) {
    case 'string':
      return `${name}-text`;
    case 'int':
    case 'number':
      return 7;
    case 'float':
      return 1.5;
    case 'bool':
      return true;
    case 'map':
      return { k: 'v' };
    case 'list':
      return ['a'];
    case 'timestamp':
      return timestampAt('2020-01-01T00:00:00.000Z');
    default:
      return null;
  }
}

/** A length inside every size bound (or null if they contradict). */
function validLength(sizes: FieldInfo['sizes']): number | null {
  let lo = 0;
  let hi = Infinity;
  for (const { op, n } of sizes) {
    if (op === '<') hi = Math.min(hi, n - 1);
    else if (op === '<=') hi = Math.min(hi, n);
    else if (op === '>') lo = Math.max(lo, n + 1);
    else if (op === '>=') lo = Math.max(lo, n);
    else {
      lo = Math.max(lo, n);
      hi = Math.min(hi, n);
    }
  }
  if (lo > hi) return null;
  return Math.max(lo, Math.min(hi, Math.max(lo, 3)));
}

/** Facts for every field read on a concrete path, merged across all blocks (base and head) matching it. */
function fieldsFor(path: string, models: RuleModel[], facts: Facts): Map<string, FieldInfo> {
  const out = new Map<string, FieldInfo>();
  for (const m of models) {
    for (const { block, bindings } of matchDocument(m, path)) {
      for (const [name, f] of facts.fields.get(block.path) ?? []) {
        let info = out.get(name);
        if (!info) out.set(name, (info = { owner: false, ownerList: false, allowed: [], forbidden: [], types: [], sizes: [], serverTime: false }));
        info.owner ||= f.owner;
        info.ownerList ||= f.ownerList;
        info.serverTime ||= f.serverTime;
        for (const t of f.types) if (!info.types.includes(t)) info.types.push(t);
        for (const b of f.sizes) if (!info.sizes.some((x) => x.op === b.op && x.n === b.n)) info.sizes.push(b);
        for (const v of f.allowed.values) if (!info.allowed.includes(v)) info.allowed.push(v);
        for (const v of f.forbidden.values) if (!info.forbidden.includes(v)) info.forbidden.push(v);
        if (f.wildcard && bindings[f.wildcard] !== undefined) info.wildcardValue ??= bindings[f.wildcard];
      }
    }
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

class Builder {
  readonly facts: Facts;
  readonly notes: string[] = [];
  private readonly fieldNames = new Set<string>();

  constructor(
    private readonly models: RuleModel[],
    private readonly config: Config,
  ) {
    this.facts = extract(models);
    for (const byField of this.facts.fields.values()) for (const f of byField.keys()) this.fieldNames.add(f);
    for (const m of models) for (const w of m.warnings) this.notes.push(`${m.file}: ${w.message}`);
  }

  /** A value outside the allowed set: a != literal, else another literal of the same type from the rules. */
  disallowed(f: FieldInfo): Literal {
    const allowed = f.allowed;
    const forbidden = f.forbidden.find((v) => !allowed.includes(v));
    if (forbidden !== undefined) return forbidden;
    const sample = allowed[0];
    const type = typeof sample;
    const pool = this.facts.literals.values.filter(
      (v) => typeof v === type && !allowed.includes(v) && !(typeof v === 'string' && this.fieldNames.has(v)),
    );
    if (pool[0] !== undefined) return pool[0];
    if (type === 'boolean') return !sample;
    if (type === 'number') return Math.max(...(allowed as number[])) + 1;
    return allowed.includes('admin') ? 'not-allowed' : 'admin';
  }

  docData(fields: Map<string, FieldInfo>, owner: string): DocData {
    const data: DocData = {};
    for (const [name, f] of fields) {
      if (f.owner) data[name] = owner;
      else if (f.ownerList) data[name] = [owner];
      else if (f.wildcardValue !== undefined) data[name] = f.wildcardValue;
      else if (f.serverTime) data[name] = SERVER_TIME;
      else if (f.allowed[0] !== undefined) data[name] = f.allowed[0];
      else if (f.types.length && f.types[0] !== 'string') data[name] = sampleOf(f.types[0]!, name) ?? `${name}-1`;
      else if (f.sizes.length) {
        const n = validLength(f.sizes);
        data[name] = n === null ? `${name}-1` : 'x'.repeat(n);
      } else data[name] = `${name}-1`;
    }
    return data;
  }

  changed(name: string, f: FieldInfo, current: unknown): unknown {
    if (f.owner) return OTHER_UID;
    if (f.ownerList) return [OWNER_UID, OTHER_UID];
    if (f.wildcardValue !== undefined) return `${f.wildcardValue}-other`;
    if (f.allowed.length) return this.disallowed(f);
    if (f.forbidden[0] !== undefined) return f.forbidden[0];
    return typeof current === 'string' ? `${current}-changed` : `${name}-changed`;
  }

  paths(): string[] {
    const set = new Set<string>();
    for (const m of this.models) {
      for (const b of m.matches) {
        if (b.documentPath === null || b.documentPath === '') continue;
        const ps = concretePaths(b, this.facts);
        if (!ps.length) this.notes.push(`${m.file}: ${b.path} is a collection path, not a document; no requests generated`);
        for (const p of ps) set.add(p);
        // Ids the rules single out (docId != 'stats', docId in ['a', 'b']) get their own path.
        for (const [wildcard, lits] of this.facts.docIdLiterals.get(b.path) ?? []) {
          for (const v of lits.values.slice(0, MAX_DOC_ID_LITERALS)) {
            for (const p of concretePaths(b, this.facts, new Map([[wildcard, String(v)]]))) set.add(p);
          }
        }
      }
    }
    return [...set].sort();
  }

  requestsFor(path: string, fields: Map<string, FieldInfo>, seed: DocData): PlannedRequest[] {
    const collection = path.split('/').slice(0, -1).join('/');
    const out: PlannedRequest[] = [
      { doc: path, request: { op: 'get', path }, why: 'read the doc' },
      { doc: path, request: { op: 'list', collection }, why: 'list the whole collection' },
      { doc: path, request: { op: 'delete', path }, why: 'delete the doc' },
      { doc: path, request: { op: 'create', path, data: seed }, why: 'create with a payload the rules allow' },
    ];
    const ownerFields = [...fields].filter(([, f]) => f.owner || f.ownerList).map(([n]) => n);
    for (const [name, f] of fields) {
      if (f.owner) {
        out.push({
          doc: path,
          request: { op: 'list', collection, where: [[name, '==', UID_PLACEHOLDER]] },
          why: `list docs where ${name} is the caller`,
        });
      }
      const bad = new LiteralSet();
      if (f.allowed.length) bad.add(this.disallowed(f));
      for (const v of f.forbidden) bad.add(v);
      for (const v of bad.values) {
        out.push({
          doc: path,
          request: { op: 'create', path, data: { ...seed, [name]: v }, fields: [name] },
          why: `create with ${name} = ${show(v)}, outside the allowed values`,
        });
      }
    }
    if (ownerFields.length) {
      const data = { ...seed };
      for (const n of ownerFields) data[n] = fields.get(n)!.ownerList ? [OTHER_UID] : OTHER_UID;
      out.push({
        doc: path,
        request: { op: 'create', path, data, fields: ownerFields },
        why: `create naming someone else (${OTHER_UID}) as ${ownerFields.join(', ')}`,
      });
    }
    for (const [name, f] of fields) {
      const value = this.changed(name, f, seed[name]);
      out.push({
        doc: path,
        request: { op: 'update', path, data: { [name]: value }, fields: [name] },
        why: `change only ${name} (to ${show(value)})`,
      });
    }
    // Change nothing the rules read, so a condition like role == resource.data.role can pass.
    out.push({
      doc: path,
      request: { op: 'update', path, data: { [PROBE_FIELD]: 'changed' }, fields: [PROBE_FIELD] },
      why: fields.size ? 'change only a probe field; every field the rules read keeps its seed value' : 'the rules read no fields here; change a probe field',
    });
    out.push(...this.payloadVariants(path, fields, seed));
    // A doc that doesn't exist: the caller's own (for owner-slot paths) or a fresh id.
    const segs = path.split('/');
    const missing = segs.includes(OWNER_UID) ? segs.map((x) => (x === OWNER_UID ? 'u_stranger' : x)).join('/') : `${collection}/missing-doc`;
    out.push({ doc: path, request: { op: 'get', path: missing, probe: 'missing' }, why: "read a doc that doesn't exist" });
    return out;
  }

  /**
   * Payload variety per field the rules read: every allowed value (not just the first), each type
   * the rules check plus one they don't, lengths around each size() bound, and request.time for
   * fields compared with it. Each variant is sent as a create (seed + that field) and an update.
   */
  payloadVariants(path: string, fields: Map<string, FieldInfo>, seed: DocData): PlannedRequest[] {
    const out: PlannedRequest[] = [];
    for (const [name, f] of fields) {
      if (f.owner || f.ownerList) continue;
      const variants: Array<{ value: unknown; why: string }> = [];
      for (const v of f.allowed.slice(1)) variants.push({ value: v, why: `${name} = ${show(v)} (another allowed value)` });
      if (f.types.length) {
        const types = [...f.types, f.types.includes('string') ? 'int' : 'string'];
        for (const t of types) {
          const v = sampleOf(t, name);
          if (v !== null) variants.push({ value: v, why: `${name} as ${t}${f.types.includes(t) ? '' : ' (a type the rules don\'t accept)'}` });
        }
      }
      for (const { n } of f.sizes) {
        for (const len of [n - 1, n, n + 1]) {
          if (len < 0) continue;
          const v = f.types.includes('list') ? Array.from({ length: len }, (_, i) => `i${i}`) : 'x'.repeat(len);
          variants.push({ value: v, why: `${name} with size ${len} (bound ${n})` });
        }
      }
      if (f.serverTime) {
        variants.push({ value: SERVER_TIME, why: `${name} = request.time` });
        variants.push({ value: timestampAt('2000-01-01T00:00:00.000Z'), why: `${name} = a timestamp that isn't request.time` });
      }
      // An update to request.time is a real test even when the seed already holds a server timestamp.
      if (f.serverTime) out.push({ doc: path, request: { op: 'update', path, data: { [name]: SERVER_TIME }, fields: [name] }, why: `update ${name} = request.time` });
      const seen = new Set<string>([JSON.stringify(seed[name])]);
      let count = 0;
      for (const { value, why } of variants) {
        const k = JSON.stringify(value);
        if (seen.has(k) || count >= MAX_VARIANTS) continue;
        seen.add(k);
        count++;
        out.push({ doc: path, request: { op: 'create', path, data: { ...seed, [name]: value }, fields: [name] }, why: `create with ${why}` });
        out.push({ doc: path, request: { op: 'update', path, data: { [name]: value }, fields: [name] }, why: `update ${why}` });
      }
    }
    return out;
  }

  /**
   * Copies of a doc in the states an allow branch requires (resource.data.F == literal), so a rule
   * that only applies to e.g. status == 'confirmed' docs gets exercised. Owner-slot docs are skipped:
   * a copy would need a different id, which breaks ownership.
   */
  docStates(block: MatchBlock, path: string, fields: Map<string, FieldInfo>, seed: DocData): { seeds: Seed[]; requests: PlannedRequest[] } {
    const states: DocData[] = [];
    const isResourceField = (e: import('../parse/index.js').Expr): string | null =>
      e.kind === 'member' && e.object.kind === 'member' && e.object.property === 'data' && e.object.object.kind === 'var' && e.object.object.name === 'resource' ? e.property : null;
    for (const allow of block.allows) {
      for (const br of branches(allow.inlined)) {
        const want: DocData = {};
        for (const { e, neg } of br) {
          if (neg || e.kind !== 'binary' || e.op !== '==') continue;
          for (const [a, b] of [[e.left, e.right], [e.right, e.left]] as const) {
            const f = isResourceField(a);
            if (f !== null && b.kind === 'literal' && b.type !== 'null' && b.type !== 'bytes') want[f] = b.value;
          }
        }
        const differs = Object.entries(want).some(([k, v]) => JSON.stringify(seed[k]) !== JSON.stringify(v));
        if (differs && !states.some((s) => JSON.stringify(s) === JSON.stringify(want))) states.push(want);
      }
    }
    const segs = path.split('/');
    if (segs.at(-1) === OWNER_UID) return { seeds: [], requests: [] };
    const out = { seeds: [] as Seed[], requests: [] as PlannedRequest[] };
    states.slice(0, MAX_STATES).forEach((want, i) => {
      const copy = `${path}-state${i + 1}`;
      const data = { ...seed, ...want };
      out.seeds.push({ path: copy, data });
      const desc = Object.entries(want).map(([k, v]) => `${k} = ${show(v)}`).join(', ');
      const add = (request: Request, why: string) => out.requests.push({ doc: path, request: { ...request, canonical: path }, why: `${why} (doc with ${desc})` });
      add({ op: 'get', path: copy }, 'read the doc');
      add({ op: 'delete', path: copy }, 'delete the doc');
      for (const [name, f] of fields) {
        const value = this.changed(name, f, data[name]);
        add({ op: 'update', path: copy, data: { [name]: value }, fields: [name] }, `change only ${name} (to ${show(value)})`);
      }
      add({ op: 'update', path: copy, data: { [PROBE_FIELD]: 'changed' }, fields: [PROBE_FIELD] }, 'change only a probe field');
    });
    return out;
  }

  claimPrincipals(): Principal[] {
    const claims = new Map<string, LiteralSet>();
    const add = (key: string, v: Literal) => {
      let s = claims.get(key);
      if (!s) claims.set(key, (s = new LiteralSet()));
      s.add(v);
    };
    for (const [k, s] of this.facts.claims) for (const v of s.values) add(k, v);
    for (const { key, block, wildcard } of this.facts.claimWildcards) {
      const id = wildcardIds(block, this.facts).get(wildcard);
      if (id) add(key, id);
    }
    for (const [k, vs] of Object.entries(this.config.claims ?? {})) for (const v of vs) add(k, v);

    const out: Principal[] = [];
    for (const key of [...claims.keys()].sort()) {
      for (const v of claims.get(key)!.values) {
        out.push({
          name: `token.${key}=${String(v)}`,
          requires: [`claim:${key}=${String(v)}`],
          label: `a user whose token has ${key} == ${show(v)}`,
          auth: { uid: `u_tok_${slug(key)}_${slug(String(v))}`, token: claimToken(key, v) },
        });
      }
    }
    return out;
  }

  lookupPrincipals(): { principals: Principal[]; seeds: Seed[] } {
    interface Resolved {
      template: string;
      /** The template with the rule's wildcard names, for labels: teams/{teamId}/members/{uid}. */
      display: string;
      collection: string;
      values: Map<string, LiteralSet>;
    }
    const byTemplate = new Map<string, Resolved>();
    for (const l of this.facts.lookups.values()) {
      const found = this.resolveLookup(l);
      if (!found) continue;
      const { template, display } = found;
      const segs = template.split('/');
      const collection = segs[segs.indexOf('{uid}') - 1] ?? template;
      let r = byTemplate.get(template);
      if (!r) byTemplate.set(template, (r = { template, display, collection, values: new Map() }));
      for (const [f, s] of l.values) {
        let set = r.values.get(f);
        if (!set) r.values.set(f, (set = new LiteralSet()));
        for (const v of s.values) set.add(v);
      }
    }
    const resolved = [...byTemplate.values()].sort((a, b) => a.template.localeCompare(b.template));
    const collectionCount = new Map<string, number>();
    for (const r of resolved) collectionCount.set(r.collection, (collectionCount.get(r.collection) ?? 0) + 1);

    const principals: Principal[] = [];
    const seeds: Seed[] = [];
    for (const r of resolved) {
      const tag = collectionCount.get(r.collection)! > 1 ? r.template : r.collection;
      const add = (name: string, label: string, data: DocData) => {
        const uid = `u_${slug(name)}`;
        const requires = [`doc:${r.template}`, ...Object.entries(data).map(([k, v]) => `doc:${r.template}#${k}=${String(v)}`)];
        principals.push({ name, label, auth: { uid }, requires });
        // Nested lookup fields (readOnly.isAdmin, roles['editor']) become nested maps.
        const nested: DocData = {};
        for (const [k, v] of Object.entries(data)) {
          const keys = k.split('.');
          let cur = nested as Record<string, unknown>;
          keys.forEach((key, i) => {
            if (i === keys.length - 1) cur[key] = v;
            else cur = (cur[key] ??= {}) as Record<string, unknown>;
          });
        }
        seeds.push({ path: r.template.replace('{uid}', uid), data: nested });
      };
      add(`${tag} doc`, `a user who has a doc at ${r.display}`, {});
      for (const [field, set] of [...r.values].sort(([a], [b]) => a.localeCompare(b))) {
        for (const v of set.values) {
          add(`${tag}.${field}=${String(v)}`, `a user whose doc at ${r.display} has ${field} == ${show(v)}`, { [field]: v });
        }
      }
    }
    return { principals, seeds };
  }

  /** get(/databases/$(database)/documents/teams/$(teamId)/members/$(request.auth.uid)) → teams/t1/members/{uid} */
  private resolveLookup(l: Lookup): { template: string; display: string } | null {
    const ids = wildcardIds(l.block, this.facts);
    const db = l.block.segments[1];
    const parts: string[] = [];
    const shown: string[] = [];
    let usesUid = false;
    for (const p of l.parts) {
      if (p.kind === 'text') {
        parts.push(p.value);
        shown.push(p.value);
        continue;
      }
      const e = p.expr;
      if (e.kind === 'member' && e.property === 'uid' && e.object.kind === 'member' && e.object.property === 'auth' && e.object.object.kind === 'var' && e.object.object.name === 'request') {
        parts.push('{uid}');
        shown.push('{uid}');
        usesUid = true;
      } else if (e.kind === 'var' && db?.kind === 'wildcard' && e.name === db.name) {
        parts.push('(default)');
        shown.push('(default)');
      } else if (e.kind === 'var' && ids.has(e.name)) {
        parts.push(ids.get(e.name)!);
        shown.push(`{${e.name}}`);
      } else {
        return null;
      }
    }
    if (parts[0] !== 'databases' || parts[2] !== 'documents' || !usesUid) return null;
    return { template: parts.slice(3).join('/'), display: shown.slice(3).join('/') };
  }

  build(): Plan {
    const seeds = new Map<string, DocData>();
    const requests: PlannedRequest[] = [];
    for (const path of this.paths()) {
      const fields = fieldsFor(path, this.models, this.facts);
      const seed = this.docData(fields, OWNER_UID);
      seeds.set(path, seed);
      if (path.split('/').includes(OWNER_UID)) {
        seeds.set(path.split('/').map((s) => (s === OWNER_UID ? OTHER_UID : s)).join('/'), this.docData(fields, OTHER_UID));
      }
      requests.push(...this.requestsFor(path, fields, seed));
    }
    // Doc states the rules distinguish (resource.data.status == 'confirmed', ...).
    for (const m of this.models) {
      for (const b of m.matches) {
        if (!b.documentPath) continue;
        for (const path of concretePaths(b, this.facts)) {
          const fields = fieldsFor(path, this.models, this.facts);
          const st = this.docStates(b, path, fields, seeds.get(path) ?? this.docData(fields, OWNER_UID));
          for (const x of st.seeds) if (!seeds.has(x.path)) seeds.set(x.path, x.data);
          requests.push(...st.requests);
        }
      }
    }
    const lookups = this.lookupPrincipals();
    for (const s of lookups.seeds) seeds.set(s.path, s.data);
    for (const d of this.config.docs ?? []) seeds.set(d.path, { ...(seeds.get(d.path) ?? {}), ...d.data });
    for (const p of this.config.payloads ?? []) {
      requests.push({
        doc: p.path,
        request: { op: p.op, path: p.path, data: p.data, fields: Object.keys(p.data).sort() },
        why: 'payload from firediff.yml',
      });
    }

    // Combined principals: one per OR-branch of each allow, with everything that branch needs at once.
    const synth = synthesize({
      models: this.models,
      ownerUid: OWNER_UID,
      pathsFor: (b) => concretePaths(b, this.facts),
      idsFor: (b) => wildcardIds(b, this.facts),
      seedFor: (p, owner) => this.docData(fieldsFor(p, this.models, this.facts), owner),
      existingSeed: (p) => seeds.get(p),
      requestsFor: (p, owner) => {
        const fields = fieldsFor(p, this.models, this.facts);
        return this.requestsFor(p, fields, this.docData(fields, owner));
      },
    });
    for (const s of synth.seeds) seeds.set(s.path, mergeDeep(seeds.get(s.path) ?? {}, s.data));
    requests.push(...synth.requests);
    this.notes.push(...synth.notes);

    const principals = [...BASE_PRINCIPALS, ...this.claimPrincipals(), ...lookups.principals, ...synth.principals];
    for (const p of this.config.principals ?? []) {
      principals.push({
        name: p.name,
        label: p.label ?? `${p.name} (from firediff.yml)`,
        auth: p.uid ? { uid: p.uid, ...(p.claims ? { token: p.claims } : {}) } : null,
      });
    }
    const seen = new Set<string>();
    for (const p of principals) {
      if (seen.has(p.name)) throw new Error(`two principals named '${p.name}'`);
      seen.add(p.name);
    }

    return {
      principals,
      seeds: [...seeds].map(([path, data]) => ({ path, data })).sort((a, b) => a.path.localeCompare(b.path)),
      requests: dedupe(requests).sort(compareRequests),
      notes: this.notes,
    };
  }
}

function claimToken(key: string, value: Literal): Record<string, unknown> {
  const parts = key.split('.');
  const token: Record<string, unknown> = {};
  let cur = token;
  parts.forEach((p, i) => {
    if (i === parts.length - 1) cur[p] = value;
    else cur = (cur[p] = p === 'firebase' && i === 0 ? { sign_in_provider: 'custom', identities: {} } : {}) as Record<string, unknown>;
  });
  return token;
}

function requestKey(r: Request): string {
  return JSON.stringify(r);
}

function dedupe(rs: PlannedRequest[]): PlannedRequest[] {
  const seen = new Set<string>();
  return rs.filter((r) => {
    // The same request sent twice tells us nothing new, whichever doc it's grouped under.
    const { canonical: _c, ...bare } = r.request;
    const k = requestKey(bare as Request) + (r.only ? `|${r.only.join(',')}` : '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function compareRequests(a: PlannedRequest, b: PlannedRequest): number {
  return (
    a.doc.localeCompare(b.doc) ||
    OP_ORDER.indexOf(a.request.op) - OP_ORDER.indexOf(b.request.op) ||
    requestKey(a.request).localeCompare(requestKey(b.request)) ||
    (a.only ?? []).join(',').localeCompare((b.only ?? []).join(','))
  );
}

/** Generate the request matrix from both rule models (union of what either reads). */
export function buildPlan(base: RuleModel, head: RuleModel, config: Config = {}): Plan {
  return new Builder([base, head], config).build();
}

/**
 * Every request × every principal, except: `only` requests go to the named principals, and a
 * principal with a scope only gets shared requests on those targets. A uid-filtered list is sent
 * with the caller's own uid; signed-out callers skip it.
 */
export function expandCases(plan: Plan): Case[] {
  const cases: Case[] = [];
  for (const { request, only } of plan.requests) {
    for (const principal of plan.principals) {
      if (only ? !only.includes(principal.name) : principal.scope && !principal.scope.includes(requestTarget(request))) continue;
      if (request.op === 'list' && request.where?.some(([, , v]) => v === UID_PLACEHOLDER)) {
        if (!principal.auth) continue;
        const uid = principal.auth.uid;
        cases.push({ principal, request: { ...request, where: request.where.map(([f, o, v]) => [f, o, v === UID_PLACEHOLDER ? uid : v]) } });
      } else {
        cases.push({ principal, request });
      }
    }
  }
  return cases;
}
