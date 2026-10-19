import type { Unexercised } from '../coverage/coverage.js';
import { canText, groupFlips, whoText, type Group, type Whose } from '../diff/group.js';
import { OWNER_UID, type Skip } from '../generate/index.js';
import { extract, guardedFields } from '../generate/extract.js';
import { matchDocument, print, type RuleModel } from '../parse/index.js';
import type { PairResult } from '../run/pipeline.js';
import { allowRanges, allowsAt, changedAllows } from './spans.js';
import type { TimeLimitChange } from '../run/time.js';
import { lowCoverage, type LowCoverage } from './coverage-guard.js';
import { isDataShapeOnly, missingPiece } from './classify.js';
import { groupTarget, requestTarget, type DocData, type Outcome, type Request, type Row, type Seed } from '../run/types.js';

/** A request someone can replay against the emulator to see the flip. */
export interface Proof {
  principal: string;
  auth: { uid: string; token?: Record<string, unknown> } | null;
  op: Request['op'];
  path: string;
  query?: { where: Array<[string, '==', unknown]> };
  data?: DocData;
  /** Docs that exist when the request is sent. A create's target doc is absent. */
  seed: Seed[];
}

export interface ReportRow {
  direction: 'gained' | 'lost';
  who: string;
  can: string;
  on: string;
  tier: number;
  group: Group;
  proof: Proof;
  /** Why the side that denied did so, e.g. "denied by L13 `isOwner(uid)` (false)". */
  denial: string;
}

export interface NotExercisedItem {
  line: number | null;
  text: string;
}

/** A Not-exercised entry inside an allow whose text changed in this PR. */
export interface ChangedUntested {
  line: number;
  /** Source text of the expression that never evaluated true. */
  text: string;
  why: 'never evaluated' | 'never true' | string;
  /** The changed allow statement(s) it belongs to, when different from `line`. */
  allowLines: number[];
}

export interface Report {
  base: string;
  head: string;
  requests: number;
  gained: ReportRow[];
  lost: ReportRow[];
  /** Create/update flips that only change which payloads are accepted, not who has access. */
  dataChanged: ReportRow[];
  /** Flips firediff can't judge: head needs something it couldn't provide (named in `missing`). */
  couldntTest: Array<ReportRow & { missing: string }>;
  /** Ranked above everything else: what this PR changed that no request ever tested. */
  changedUntested: ChangedUntested[];
  /** Time-limited rules whose window changed. */
  timeChanges: TimeLimitChange[];
  /** Set when fewer than half of head's allows evaluated true for any request. */
  lowCoverage: LowCoverage | null;
  notExercised: NotExercisedItem[];
  errors: Row[];
}

const ENTRY = /([^,]*?) for '(\w+)' @ L(\d+)/g;

/** Turn the emulator's denial message into "denied by L13 `isOwner(uid)` (false)" using the model. */
export function denialText(outcome: Outcome, op: Request['op'], model: RuleModel): string {
  if (outcome.result !== 'deny') return outcome.result === 'error' ? `error: ${outcome.message}` : 'allowed';
  const raw = (outcome.reason ?? '').trim();
  if (/No matching allow statements/i.test(raw)) return 'denied: no allow statement matches this request';
  const entries = [...raw.matchAll(ENTRY)].map((m) => ({ reason: m[1]!.trim().replace(/\.$/, ''), op: m[2]!, line: Number(m[3]) }));
  if (!entries.length) return raw ? `denied: ${raw}` : 'denied';
  const forOp = entries.filter((e) => e.op === op);
  const byLine = new Map<number, string[]>();
  for (const e of forOp.length ? forOp : entries) {
    const reasons = byLine.get(e.line) ?? [];
    if (!reasons.includes(e.reason)) reasons.push(e.reason);
    byLine.set(e.line, reasons);
  }
  const allows = model.matches.flatMap((b) => b.allows);
  const parts = [...byLine].map(([line, reasons]) => {
    const allow = allows.find((a) => a.loc.line === line);
    const cond = allow ? ` \`${shorten(print(allow.condition), 100)}\`` : '';
    return `L${line}${cond} (${reasons.join('; ')})`;
  });
  return `denied by ${parts.join(', ')}`;
}

function shorten(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function proofFor(row: Row, seeds: Seed[]): Proof {
  const { principal, request: req } = row.case;
  const target = requestTarget(req);
  const uid = principal.auth?.uid;
  const relevant = seeds.filter((s) => {
    if (req.op === 'create' && s.path === target) return false;
    if (uid && s.path.split('/').includes(uid) && !s.path.startsWith(`${target}/`)) return true;
    if (req.op === 'list') return s.path.split('/').slice(0, -1).join('/') === target;
    return req.op !== 'create' && s.path === target;
  });
  return {
    principal: principal.name,
    auth: principal.auth,
    op: req.op,
    path: target,
    ...(req.op === 'list' && req.where?.length ? { query: { where: req.where } } : {}),
    ...(req.op === 'create' || req.op === 'update' ? { data: req.data } : {}),
    seed: relevant,
  };
}

/** The match-block pattern a concrete path falls under (most specific block first), e.g. users/{uid}. */
export function patternFor(path: string, isCollection: boolean, model: RuleModel): string {
  const PLACEHOLDER = '__firediff_doc__';
  const hits = matchDocument(model, isCollection ? `${path}/${PLACEHOLDER}` : path).map((h) => h.block);
  const best = hits.sort((a, b) => {
    const rec = (x: typeof a) => (x.segments.some((s) => s.kind === 'recursive') ? 1 : 0);
    return rec(a) - rec(b) || b.segments.length - a.segments.length;
  })[0];
  if (!best?.documentPath) return path;
  if (!isCollection) return best.documentPath;
  const segs = best.documentPath.split('/');
  // A list under {x=**} keeps the recursive pattern; otherwise drop the doc-id segment.
  return segs.at(-1)?.endsWith('=**}') || segs.length < 2 ? best.documentPath : segs.slice(0, -1).join('/');
}

/**
 * Whose doc the group's proof touches. "Their own" when every class is the owner, or when the
 * proof's path, payload or target seed carries the caller's uid or one of their string claims
 * (e.g. an email-keyed doc, or a create that must name the caller as submittedBy).
 */
function whoseDoc(g: Group, seeds: Seed[]): Whose {
  if (g.who.every((w) => w.kind === 'owner' || (w.kind === 'principal' && w.principal.ownsTarget))) return 'own';
  const { principal, request: req } = g.proof.case;
  const ids = new Set<string>();
  if (principal.auth) {
    ids.add(principal.auth.uid);
    for (const v of Object.values(principal.auth.token ?? {})) if (typeof v === 'string' && v.length > 1) ids.add(v);
  }
  const carries = (v: unknown): boolean => (typeof v === 'string' && ids.has(v)) || (Array.isArray(v) && v.some(carries));
  const target = requestTarget(req);
  if (target.split('/').some((s) => ids.has(s))) return 'own';
  if ((req.op === 'create' || req.op === 'update') && Object.values(req.data).some(carries)) return 'own';
  if (req.op !== 'create' && Object.values(seeds.find((s) => s.path === target)?.data ?? {}).some(carries)) return 'own';
  return isOwned(groupTarget(req), seeds) ? 'other' : 'any';
}

/** Does the doc belong to someone: owner slot in its path, or an owner field in its seed? */
function isOwned(path: string, seeds: Seed[]): boolean {
  if (path.split('/').includes(OWNER_UID)) return true;
  const data = seeds.find((s) => s.path === path)?.data ?? {};
  return Object.values(data).some((v) => v === OWNER_UID || (Array.isArray(v) && v.includes(OWNER_UID)));
}

function countConditions(model: RuleModel): number {
  return model.matches.flatMap((b) => b.allows).filter((a) => a.conditionLoc && a.condition.kind !== 'literal').length;
}

/**
 * Split Not-exercised entries: those inside an allow whose text changed between base and head go to
 * "changed but never tested"; the rest stay in the Not-exercised list.
 */
function splitUntested(unexercised: Unexercised[] | null, skips: Skip[], base: RuleModel, head: RuleModel) {
  const changed = changedAllows(base, head);
  const ranges = allowRanges(head);
  const changedUntested: ChangedUntested[] = [];
  const rest = { unexercised: [] as Unexercised[], skips: [] as Skip[] };
  const changedAt = (line: number) => allowsAt(ranges, line).filter((r) => changed.has(r.allow)).map((r) => r.allow.loc.line);
  for (const u of unexercised ?? []) {
    const lines = changedAt(u.line);
    if (lines.length) changedUntested.push({ line: u.line, text: u.text, why: u.kind === 'never-evaluated' ? 'never evaluated' : 'never true', allowLines: lines.filter((l) => l !== u.line) });
    else rest.unexercised.push(u);
  }
  for (const sk of skips) {
    const lines = changedAt(sk.line);
    if (lines.length) changedUntested.push({ line: sk.line, text: '', why: `not tried: ${sk.message}`, allowLines: lines.filter((l) => l !== sk.line) });
    else rest.skips.push(sk);
  }
  changedUntested.sort((a, b) => a.line - b.line);
  return { changedUntested, rest };
}

function notExercisedItems(unexercised: Unexercised[] | null, skips: Skip[], errors: Row[], head: RuleModel, hadChangedUntested: boolean): NotExercisedItem[] {
  const items: NotExercisedItem[] = [];
  if (unexercised === null) items.push({ line: null, text: 'Coverage was unavailable, so expressions that never evaluated true are not listed.' });
  else if (unexercised.length === 0 && !hadChangedUntested) {
    const n = countConditions(head);
    items.push({
      line: null,
      text: n
        ? `All ${n} allow condition${n === 1 ? '' : 's'} in head ${n === 1 ? 'was' : 'were'} reached by at least one request.`
        : 'Head has no allow conditions other than literal true or false.',
    });
  }
  for (const u of unexercised ?? []) {
    items.push({ line: u.line, text: `\`${u.text}\` ${u.kind === 'never-evaluated' ? 'was never evaluated' : 'never evaluated true'}` });
  }
  for (const s of skips) items.push({ line: s.line, text: `not tried: ${s.message}` });
  items.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  if (errors.length) {
    items.push({ line: null, text: `${errors.length} request${errors.length === 1 ? '' : 's'} failed to run on one side and ${errors.length === 1 ? 'was' : 'were'} not compared.` });
  }
  return items;
}

export function buildReport(r: PairResult): Report {
  const { gained, lost } = groupFlips(r.rows, r.plan.principals);
  const toRow = (g: Group): ReportRow => {
    const denying = g.direction === 'gained' ? g.proof.base : g.proof.head;
    return {
      direction: g.direction,
      who: whoText(g.who),
      can: canText(g, whoseDoc(g, r.plan.seeds)),
      on: patternFor(g.path, g.proof.case.request.op === 'list', g.direction === 'gained' ? r.head : r.base),
      tier: g.tier,
      group: g,
      proof: proofFor(g.proof, r.plan.seeds),
      denial: denialText(denying, g.proof.case.request.op, g.direction === 'gained' ? r.base : r.head),
    };
  };
  const errors = r.rows.filter((x) => x.base.result === 'error' || x.head.result === 'error');
  const { changedUntested, rest } = splitUntested(r.notExercised, r.skips, r.base, r.head);
  const keptGained: ReportRow[] = [];
  const keptLost: ReportRow[] = [];
  const dataChanged: ReportRow[] = [];
  const couldntTest: Array<ReportRow & { missing: string }> = [];
  const facts = extract([r.base, r.head]);
  const guardCache = new Map<string, Set<string>>();
  const guarded = (path: string) => {
    let s = guardCache.get(path);
    if (!s) guardCache.set(path, (s = guardedFields([r.base, r.head], path, facts)));
    return s;
  };
  for (const g of gained) (isDataShapeOnly(g, r.rows, guarded) ? dataChanged : keptGained).push(toRow(g));
  for (const g of lost) {
    // Untestable only if every flip in the group is explained by something firediff couldn't provide.
    const pieces = g.rows.map((row) => missingPiece(row, r.head, r.plan.seeds));
    const missing = pieces.every((p) => p !== null) ? [...new Set(pieces)].join('; and ') : null;
    if (missing) couldntTest.push({ ...toRow(g), missing });
    else (isDataShapeOnly(g, r.rows, guarded) ? dataChanged : keptLost).push(toRow(g));
  }
  return {
    base: r.base.file,
    head: r.head.file,
    requests: r.cases.length,
    gained: keptGained,
    lost: keptLost,
    dataChanged,
    couldntTest,
    changedUntested,
    timeChanges: r.timeChanges ?? [],
    lowCoverage: lowCoverage(r),
    notExercised: notExercisedItems(
      r.notExercised === null ? null : rest.unexercised,
      rest.skips,
      errors,
      r.head,
      changedUntested.some((c) => !c.why.startsWith('not tried')),
    ),
    errors,
  };
}
