import type { MatchBlock, PathPart, RuleModel } from '../parse/index.js';
import { timestampAt, type DocData, type Principal, type Seed } from '../run/types.js';
import { isAuthUid, dataField } from './extract.js';
import { branches, isInteresting, needsFor, type BranchNeeds, type Sym } from './synth.js';

/** What the plan builder lends the synthesizer. */
export interface SynthContext {
  models: RuleModel[];
  ownerUid: string;
  /** Concrete doc paths for a block (empty for collection-only blocks). */
  pathsFor(block: MatchBlock): string[];
  /** Wildcard name → concrete id for a block. */
  idsFor(block: MatchBlock): Map<string, string>;
  /** Seed data for a concrete path with the given uid in owner fields. */
  seedFor(path: string, owner: string): DocData;
  /** Seed already planned for a path (base docs, standalone lookup docs), if any. */
  existingSeed(path: string): DocData | undefined;
  /** The generated requests for a doc path (get, lists, creates, updates, delete). */
  requestsFor(path: string, owner: string): Array<{ request: import('../run/types.js').Request; why: string }>;
}

export interface SynthPlannedRequest {
  doc: string;
  request: import('../run/types.js').Request;
  why: string;
  only: string[];
}

export interface Synthesized {
  principals: Principal[];
  seeds: Seed[];
  requests: SynthPlannedRequest[];
  notes: string[];
}

const MAX_PRINCIPALS = 40;
const PAST = timestampAt('2000-01-01T00:00:00.000Z');
const FUTURE = timestampAt('2100-01-01T00:00:00.000Z');

const parent = (p: string) => p.split('/').slice(0, -1).join('/');
const show = (v: unknown) => (typeof v === 'string' ? `'${v}'` : JSON.stringify(v));

function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj;
  path.forEach((k, i) => {
    if (i === path.length - 1) cur[k] = value;
    else {
      if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
      cur = cur[k] as Record<string, unknown>;
    }
  });
}

export function mergeDeep(a: DocData, b: DocData): DocData {
  const out: DocData = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && prev && typeof prev === 'object' && !Array.isArray(prev) && !('__firediff' in v)
        ? mergeDeep(prev as DocData, v as DocData)
        : v;
  }
  return out;
}

function claimObject(key: string, value: unknown, token: Record<string, unknown>): void {
  const parts = key.split('.');
  if (parts[0] === 'firebase' && !token.firebase) token.firebase = { sign_in_provider: 'custom', identities: {} };
  setPath(token, parts, value);
}

/**
 * One principal per interesting OR-branch of every allow in either version: the claims, ownership
 * and lookup docs that branch needs, all together. Owners get their own copies of the block's
 * docs so their seeds never change what the base principals see.
 */
export function synthesize(ctx: SynthContext): Synthesized {
  const out: Synthesized = { principals: [], seeds: [], requests: [], notes: [] };
  const seen = new Set<string>();
  const seeds = new Map<string, DocData>();
  const addSeed = (path: string, data: DocData) => seeds.set(path, mergeDeep(seeds.get(path) ?? {}, data));

  for (const model of ctx.models) {
    for (const block of model.matches) {
      if (!block.documentPath) continue;
      const paths = ctx.pathsFor(block);
      if (!paths.length) continue;
      const ids = ctx.idsFor(block);
      const db = block.segments[1]?.kind === 'wildcard' ? block.segments[1].name : null;
      const wildcards = new Set(ids.keys());

      for (const allow of block.allows) {
        for (const branch of branches(allow.inlined)) {
          const needs = needsFor(branch, wildcards);
          if (!needs || !isInteresting(needs)) continue;
          if (out.principals.length >= MAX_PRINCIPALS) {
            out.notes.push(`${model.file}: more than ${MAX_PRINCIPALS} combined principals; the rest were not tried`);
            break;
          }
          const n = out.principals.length + 1;
          const uid = needs.uidLiteral ?? `u_s${n}`;
          const own = needs.ownsTarget && !needs.uidLiteral;
          const target = paths[0]!;
          const targetSeed = ctx.seedFor(target, own ? uid : ctx.ownerUid);

          const resolve = (s: Sym): unknown => {
            if ('lit' in s) return s.lit;
            if ('uid' in s) return uid;
            if ('wildcard' in s) {
              const id = ids.get(s.wildcard);
              return own && id === ctx.ownerUid ? uid : id;
            }
            if ('field' in s) return targetSeed[s.field];
            if ('listOf' in s) return [resolve(s.listOf)];
            return s.time === 'past' ? PAST : FUTURE;
          };

          const token: Record<string, unknown> = {};
          for (const [k, s] of needs.token) claimObject(k, resolve(s), token);

          const lookupDocs: Seed[] = [];
          let unresolvable = false;
          let conflict = false;
          for (const l of needs.lookups) {
            const path = resolvePath(l.parts, { uid, ids, db, own, ownerUid: ctx.ownerUid, seed: targetSeed });
            if (!path) {
              unresolvable = true;
              continue;
            }
            const data: Record<string, unknown> = {};
            for (const f of l.fields) setPath(data, f.path, resolve(f.value));
            // A doc other principals also read (not keyed on this principal's uid) may only gain fields.
            const shared = path.split('/').includes(uid) ? undefined : ctx.existingSeed(path) ?? seeds.get(path);
            if (shared && Object.entries(data).some(([k, v]) => k in shared && JSON.stringify(shared[k]) !== JSON.stringify(v))) {
              conflict = true;
              continue;
            }
            lookupDocs.push({ path, data });
          }
          if (conflict) continue;
          if (unresolvable && !lookupDocs.length && !needs.token.size) continue;
          if (coveredByStandalone(needs, own, lookupDocs, uid)) continue;

          const signature = JSON.stringify({
            block: block.documentPath,
            own,
            uidLiteral: needs.uidLiteral,
            token,
            lookups: lookupDocs.map((d) => ({ path: d.path.split(uid).join('{uid}'), data: d.data })).sort((a, b) => a.path.localeCompare(b.path)),
          });
          if (seen.has(signature)) continue;
          seen.add(signature);

          const name = `synth-${n}`;
          const flat = (o: Record<string, unknown>, prefix = ''): Array<[string, unknown]> =>
            Object.entries(o).flatMap(([k, v]) =>
              v && typeof v === 'object' && !Array.isArray(v) && !('__firediff' in v) ? flat(v as Record<string, unknown>, `${prefix}${k}.`) : [[`${prefix}${k}`, v] as [string, unknown]],
            );
          const str = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v));
          const requires = [
            ...flat(token)
              .filter(([k, v]) => k !== 'firebase.identities' && !(k === 'firebase.sign_in_provider' && v === 'custom'))
              .map(([k, v]) => `claim:${k}=${str(v)}`),
            ...(own ? ['own'] : []),
            ...(needs.uidLiteral ? [`uid:${needs.uidLiteral}`] : []),
            ...lookupDocs.flatMap((d) => {
              const tmpl = d.path.split('/').map((s) => (s === uid ? '{uid}' : s)).join('/');
              return [`doc:${tmpl}`, ...flat(d.data as Record<string, unknown>).map(([k, v]) => `doc:${tmpl}#${k}=${str(v)}`)];
            }),
          ];
          const principal: Principal = {
            name,
            requires,
            label: labelFor(needs, own, token, lookupDocs, uid),
            auth: { uid, ...(Object.keys(token).length ? { token } : {}) },
            ownsTarget: own,
            scope: own ? [] : [...new Set([...paths, ...paths.map(parent)])],
          };
          out.principals.push(principal);
          for (const d of lookupDocs) addSeed(d.path, d.data as DocData);

          if (own) {
            for (const p of paths) {
              const copy = p.includes(ctx.ownerUid)
                ? p.split('/').map((s) => (s === ctx.ownerUid ? uid : s)).join('/')
                : `${p}-${uid}`;
              addSeed(copy, ctx.seedFor(p, uid));
              for (const r of ctx.requestsFor(copy, uid)) {
                const canonical = r.request.op === 'list' ? parent(p) : p;
                out.requests.push({ doc: p, request: { ...r.request, canonical }, why: `${r.why} (as ${principal.label})`, only: [name] });
              }
            }
          }
        }
      }
    }
  }
  out.seeds = [...seeds].map(([path, data]) => ({ path, data }));
  return out;
}

/**
 * The standalone claim and lookup principals already cover a branch that needs exactly one claim
 * (a literal or a wildcard's id; not a regex sample), or exactly one uid-keyed lookup doc with at
 * most one field, and no ownership.
 */
function coveredByStandalone(needs: BranchNeeds, own: boolean, lookups: Seed[], uid: string): boolean {
  if (own || needs.uidLiteral) return false;
  const claims = [...needs.token.entries()];
  if (claims.length === 1 && !lookups.length) {
    const [key, sym] = claims[0]!;
    return !needs.regexClaims.has(key) && ('lit' in sym || 'wildcard' in sym);
  }
  if (!claims.length && lookups.length === 1) {
    const d = lookups[0]!;
    const uidKeyed = d.path.split('/').at(-1) === uid;
    return uidKeyed && Object.keys(d.data).length <= 1 && Object.values(d.data).every((v) => typeof v !== 'object' || v === null);
  }
  return false;
}

function resolvePath(
  parts: PathPart[],
  c: { uid: string; ids: Map<string, string>; db: string | null; own: boolean; ownerUid: string; seed: DocData },
): string | null {
  const segs: string[] = [];
  for (const p of parts) {
    if (p.kind === 'text') {
      segs.push(p.value);
      continue;
    }
    const e = p.expr;
    if (isAuthUid(e)) segs.push(c.uid);
    else if (e.kind === 'var' && e.name === c.db) segs.push('(default)');
    else if (e.kind === 'var' && c.ids.has(e.name)) {
      const id = c.ids.get(e.name)!;
      segs.push(c.own && id === c.ownerUid ? c.uid : id);
    } else {
      // Lookup keyed on document data: use the target doc's seeded value as the id.
      const f = dataField(e);
      const v = f !== null ? c.seed[f] : undefined;
      if (typeof v !== 'string' || !v) return null;
      segs.push(v);
    }
  }
  if (segs[0] !== 'databases' || segs[2] !== 'documents') return null;
  const docPath = segs.slice(3).join('/');
  return docPath.split('/').length % 2 === 0 ? docPath : null;
}

function labelFor(needs: BranchNeeds, own: boolean, token: Record<string, unknown>, lookups: Seed[], uid: string): string {
  const adj = token.email_verified === true ? 'verified ' : '';
  const parts: string[] = [];
  const flat = (o: Record<string, unknown>, prefix = ''): Array<[string, unknown]> =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === 'object' && !Array.isArray(v) && !('__firediff' in v) ? flat(v as Record<string, unknown>, `${prefix}${k}.`) : [[`${prefix}${k}`, v] as [string, unknown]],
    );
  for (const [k, v] of flat(token)) {
    if (k === 'email_verified' || k === 'firebase.identities' || (k === 'firebase.sign_in_provider' && v === 'custom')) continue;
    parts.push(k === 'email' ? `email ${v}` : `token ${k} = ${show(v)}`);
  }
  for (const d of lookups) {
    const segs = d.path.split('/');
    const i = segs.indexOf(uid);
    const coll = segs[(i > 0 ? i : segs.length - 1) - 1] ?? d.path;
    const fields = flat(d.data as Record<string, unknown>).map(([k, v]) => `${k} = ${typeof v === 'object' && v && '__firediff' in v ? 'a timestamp' : show(v)}`);
    parts.push(`${/^[aeio]/i.test(coll) ? 'an' : 'a'} ${coll} doc${fields.length ? ` (${fields.join(', ')})` : ''}`);
  }
  if (needs.uidLiteral) parts.push(`uid ${needs.uidLiteral}`);
  return `${adj}${own ? 'owner' : 'user'}${parts.length ? ` with ${parts.join(' and ')}` : ''}`;
}
