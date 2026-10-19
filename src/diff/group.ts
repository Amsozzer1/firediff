import { PROBE_FIELD } from '../generate/index.js';
import { groupTarget, requestFields, type Principal, type Request, type Row } from '../run/types.js';

export type Direction = 'gained' | 'lost';
type Op = Request['op'];

/** Who gained (or lost) access, collapsed to the broadest class. */
export type Who =
  | { kind: 'anyone' }
  | { kind: 'signed-in' }
  | { kind: 'other-users' }
  | { kind: 'principal'; principal: Principal }
  | { kind: 'owner' };

export interface Group {
  direction: Direction;
  /** For list groups: an unfiltered collection query, or one filtered to the caller's own docs. Never mixed. */
  listKind?: 'all' | 'own';
  /** Requests on docs that don't exist yet: never grouped with real-doc rows. */
  probe?: 'missing';
  /** Doc path, or collection path for list. */
  path: string;
  ops: Op[];
  who: Who[];
  /** 0 anyone · 1 any signed-in user · 2 other users · 3 a claim or role · 4 owner-only; missing-doc probes 10+. */
  tier: number;
  /** Fields involved in create/update flips (probe field excluded). */
  fields: string[];
  /** Every flipped row in the group. */
  rows: Row[];
  /** The request for the broadest principal: what the proof shows. */
  proof: Row;
}

const SIGNED_OUT = 'signed out';
const STRANGER = 'stranger';
const OTHER = 'other user';
const OWNER = 'owner';
const BASE_NAMES = new Set([SIGNED_OUT, STRANGER, OTHER, OWNER]);

const TIER: Record<Who['kind'], number> = { anyone: 0, 'signed-in': 1, 'other-users': 2, principal: 3, owner: 4 };
/** Missing-doc probes rank below every real-doc row. */
const PROBE_TIER = 10;

/** Within a tier: write above list above get (merged write first, then delete, update, create). */
const OP_RANK: Record<Op, number> = { delete: 1, update: 2, create: 3, list: 4, get: 5 };
const WRITES: Op[] = ['create', 'update', 'delete'];
const OP_ORDER: Op[] = ['get', 'list', 'create', 'update', 'delete'];

export function direction(r: Row): Direction | null {
  if (r.base.result === 'deny' && r.head.result === 'allow') return 'gained';
  if (r.base.result === 'allow' && r.head.result === 'deny') return 'lost';
  return null;
}

/** Collapse the principals that flipped to the broadest classes, never listing one a broader class covers. */
export function collapse(principals: Principal[], order: Principal[]): Who[] {
  const names = new Set(principals.map((p) => p.name));
  if (names.has(SIGNED_OUT)) return [{ kind: 'anyone' }];
  if (names.has(STRANGER)) return [{ kind: 'signed-in' }];
  const owner: Who[] = names.has(OWNER) ? [{ kind: 'owner' }] : [];
  if (names.has(OTHER)) return [{ kind: 'other-users' }, ...owner];
  const flipped = order.filter((p) => names.has(p.name) && !BASE_NAMES.has(p.name));
  // Drop a principal whose requirements strictly include another flipped principal's: it's narrower.
  const narrower = (p: Principal) =>
    flipped.some((q) => q !== p && q.requires && p.requires && q.requires.length < p.requires.length && q.requires.every((x) => p.requires!.includes(x)));
  const named = flipped
    .filter((p) => !narrower(p))
    .map((p): Who => (p.auth ? { kind: 'principal', principal: p } : { kind: 'anyone' }));
  if (named.some((w) => w.kind === 'anyone')) return [{ kind: 'anyone' }];
  return [...named, ...owner];
}

const whoKey = (who: Who[]) => who.map((w) => (w.kind === 'principal' ? `principal:${w.principal.name}` : w.kind)).join('|');

/** Merged-op rank: a full create+update+delete set counts as "write" (rank 0). */
export function opRank(ops: Op[]): number {
  if (WRITES.every((o) => ops.includes(o))) return 0;
  return Math.min(...ops.map((o) => OP_RANK[o]));
}

/** Order principals broadest-first for picking the proof row. */
function principalRank(p: Principal, order: Principal[]): number {
  const fixed = [SIGNED_OUT, STRANGER, OTHER].indexOf(p.name);
  if (fixed !== -1) return fixed;
  if (p.name === OWNER) return 10_000;
  return 3 + order.findIndex((o) => o.name === p.name);
}

/**
 * Group flips by (path, op, direction), collapse principals to the broadest class, then merge ops
 * on the same path whose classes match. Gained and lost are each ranked: tier, then op, then path.
 */
export function groupFlips(rows: Row[], principals: Principal[]): { gained: Group[]; lost: Group[] } {
  const buckets = new Map<string, { direction: Direction; path: string; op: Op; listKind?: 'all' | 'own'; probe?: 'missing'; rows: Row[] }>();
  for (const r of rows) {
    const d = direction(r);
    if (!d) continue;
    const path = groupTarget(r.case.request);
    const req = r.case.request;
    const listKind = req.op === 'list' ? (req.where?.length ? 'own' : 'all') : undefined;
    const k = JSON.stringify([d, path, req.op, listKind, req.probe]);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = { direction: d, path, op: req.op, ...(listKind ? { listKind } : {}), ...(req.probe ? { probe: req.probe } : {}), rows: [] }));
    b.rows.push(r);
  }

  const merged = new Map<string, Group>();
  for (const b of buckets.values()) {
    const flipped = [...new Map(b.rows.map((r) => [r.case.principal.name, r.case.principal])).values()];
    const who = collapse(flipped, principals);
    const k = JSON.stringify([b.direction, b.path, whoKey(who), b.listKind, b.probe]);
    let g = merged.get(k);
    if (!g) {
      const tier = Math.min(...who.map((w) => TIER[w.kind])) + (b.probe ? PROBE_TIER : 0);
      merged.set(k, (g = { direction: b.direction, path: b.path, ...(b.listKind ? { listKind: b.listKind } : {}), ...(b.probe ? { probe: b.probe } : {}), ops: [], who, tier, fields: [], rows: [], proof: b.rows[0]! }));
    }
    g.ops.push(b.op);
    g.rows.push(...b.rows);
  }

  const groups = [...merged.values()].map((g) => {
    g.ops.sort((a, b) => OP_ORDER.indexOf(a) - OP_ORDER.indexOf(b));
    const fields = new Set<string>();
    for (const r of g.rows) for (const f of requestFields(r.case.request) ?? []) if (f !== PROBE_FIELD) fields.add(f);
    g.fields = [...fields].sort();
    g.proof = [...g.rows].sort(
      (a, b) =>
        principalRank(a.case.principal, principals) - principalRank(b.case.principal, principals) ||
        OP_RANK[a.case.request.op] - OP_RANK[b.case.request.op],
    )[0]!;
    return g;
  });

  const rank = (a: Group, b: Group) =>
    a.tier - b.tier || opRank(a.ops) - opRank(b.ops) || a.path.localeCompare(b.path) || whoKey(a.who).localeCompare(whoKey(b.who));
  return {
    gained: groups.filter((g) => g.direction === 'gained').sort(rank),
    lost: groups.filter((g) => g.direction === 'lost').sort(rank),
  };
}

// ---- wording ----

function plural(label: string): string {
  return label.replace(/^a user (who|whose)\b/, 'users $1').replace(/^a user\b/, 'users');
}

export function whoText(who: Who[]): string {
  return who
    .map((w) => {
      switch (w.kind) {
        case 'anyone':
          return 'anyone';
        case 'signed-in':
          return 'any signed-in user';
        case 'other-users':
          return 'other users';
        case 'owner':
          return 'the owner';
        case 'principal':
          return plural(w.principal.label ?? w.principal.name);
      }
    })
    .join(', ');
}

/** Whose doc the proof request touches: the caller's own, someone else's, or one nobody owns. */
export type Whose = 'own' | 'other' | 'any';

/** "list all docs", "read another user's doc", "write any doc", "update their own doc (role)". */
export function canText(g: Pick<Group, 'ops' | 'fields' | 'who' | 'listKind' | 'probe'>, whose: Whose): string {
  const ops = g.ops;
  if (ops.length === 1 && ops[0] === 'list') return g.listKind === 'own' ? 'list their own docs' : 'list all docs';
  if (g.probe === 'missing') {
    const verbs = [...new Set(ops.map((o) => (o === 'get' || o === 'list' ? 'read' : 'write')))].join('/');
    return `${verbs} docs that don't exist yet`;
  }
  const words: string[] = [];
  const allWrites = WRITES.every((o) => ops.includes(o));
  if (ops.includes('get')) words.push('read');
  if (ops.includes('list')) words.push('list');
  if (allWrites) words.push('write');
  else for (const o of WRITES) if (ops.includes(o)) words.push(o);
  const object = whose === 'own' ? 'their own doc' : whose === 'other' ? "another user's doc" : 'any doc';
  const writes = ops.some((o) => o === 'create' || o === 'update');
  const shown = g.fields.slice(0, 3).join(', ') + (g.fields.length > 3 ? `, +${g.fields.length - 3} more` : '');
  const fields = writes && g.fields.length && !allWrites ? ` (${shown})` : '';
  return `${words.join(', ')} ${object}${fields}`;
}
