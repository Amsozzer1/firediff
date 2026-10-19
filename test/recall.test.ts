import { describe, expect, it } from 'vitest';
import { buildPlan } from '../src/generate/index.js';
import { parseRules, type RuleModel } from '../src/parse/index.js';
import { buildReport, renderMarkdown } from '../src/report/index.js';
import { dataText } from '../src/report/markdown.js';
import { lowCoverage } from '../src/report/coverage-guard.js';
import type { PairResult } from '../src/run/pipeline.js';
import { findTimeLimits, neutralizeTimeLimits, timeLimitChanges } from '../src/run/time.js';
import { SERVER_TIME, type Outcome, type Principal, type Request, type Row } from '../src/run/types.js';

const v2 = (body: string, file = 'x.rules') =>
  parseRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${body}
  }
}`, file);
const src = (body: string) => `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${body}
  }
}`;
const shared = (m: RuleModel, path: string, op: Request['op']) =>
  buildPlan(m, m).requests.filter((r) => !r.only && r.request.op === op && (r.request.op === 'list' ? r.request.collection : r.request.path) === path);

describe('BOM', () => {
  it('parses a file that starts with a UTF-8 byte-order mark', () => {
    expect(parseRules(`﻿${src('match /a/{id} { allow read; }')}`).matches).toHaveLength(2);
  });
});

describe('time limits', () => {
  const base = src(`match /{document=**} {
      allow read, write: if request.time < timestamp.date(2025, 11, 7);
    }`);
  it('neutralizes the comparison to a same-length `true`, keeping lines', () => {
    const out = neutralizeTimeLimits(base);
    expect(out.length).toBe(base.length);
    expect(out.split('\n').length).toBe(base.split('\n').length);
    expect(out).toContain('allow read, write: if true');
    expect(parseRules(out).matches[1]!.allows[0]!.condition).toEqual({ kind: 'literal', type: 'bool', value: true });
  });
  it('ignores comparisons in comments', () => {
    expect(findTimeLimits(`// allow read: if request.time < timestamp.date(2020, 1, 1);\n${base}`, parseRules(base))).toHaveLength(1);
  });
  it('reports a removed or moved end date as gained, a new one as lost', () => {
    const b = parseRules(base);
    const removed = src(`match /{document=**} {
      allow read, write;
    }`);
    const moved = base.replace('2025, 11, 7', '2030, 1, 1');
    const changes = (head: string) => timeLimitChanges(findTimeLimits(base, b), findTimeLimits(head, parseRules(head)), parseRules(head));
    expect(changes(removed)).toEqual([{ direction: 'gained', line: 5, text: 'L5 `{document=**}` get,list,create,update,delete: was open until 2025-11-07 (base L5); head has no date limit' }]);
    expect(changes(moved)).toEqual([{ direction: 'gained', line: 5, text: 'L5 `{document=**}` get,list,create,update,delete: open until 2030-01-01, was 2025-11-07 (base L5)' }]);
    expect(timeLimitChanges([], findTimeLimits(base, b), b).map((c) => c.direction)).toEqual(['lost']);
  });
});

describe('whose doc', () => {
  const m = v2(`match /new_stations/{docId} {
      allow create: if request.resource.data.submittedBy == request.auth.uid;
    }
    match /settings/{email} {
      allow read: if request.auth.token.email == email;
    }`);
  const plan = buildPlan(m, m);
  const deny: Outcome = { result: 'deny', reason: "false for 'create' @ L5" };
  const row = (principal: Principal, request: Request): Row => ({ case: { principal, request }, base: deny, head: { result: 'allow' } });
  const report = (rows: Row[]) =>
    buildReport({ base: m, head: m, plan, cases: rows.map((r) => r.case), rows, notExercised: [], coverage: null, skips: [], timeChanges: [], ms: { plan: 0, open: 0, run: 0 } });
  const other: Principal = { name: 'other user', auth: { uid: 'u_other' } };
  it('says "their own doc" when the payload must name the caller', () => {
    const r = report([row(other, { op: 'create', path: 'new_stations/d1', data: { submittedBy: 'u_other' }, fields: ['submittedBy'] })]);
    expect(r.gained[0]!.can).toBe('create their own doc (submittedBy)');
  });
  it('says "their own doc" for an email-keyed doc the caller owns by claim', () => {
    const p: Principal = { name: 'token.email=e1', auth: { uid: 'u_tok', token: { email: 'e1' } } };
    expect(report([row(p, { op: 'get', path: 'settings/e1' })]).gained[0]!.can).toBe('read their own doc');
  });
  it("still says another user's doc for impersonation", () => {
    const r = report([row(other, { op: 'create', path: 'new_stations/d1', data: { submittedBy: 'u_owner' }, fields: ['submittedBy'] })]);
    expect(r.gained[0]!.can).toBe("create another user's doc (submittedBy)");
  });
});

describe('low-coverage guard', () => {
  const head = v2(`match /posts/{id} {
      allow write: if request.auth.token.email_verified == true
        && get(/databases/$(database)/documents/userProperties/$(request.auth.uid)).data.enabled == true;
      allow read: if request.auth != null;
      allow delete: if request.auth.token.admin == true;
    }`);
  const result = (reached: number, unreachedLines: number[]) =>
    ({ head, coverage: { total: 3, reached, unreachedLines } }) as unknown as PairResult;
  it('stays quiet when at least half the rules were reached', () => expect(lowCoverage(result(2, [7]))).toBeNull());
  it('warns below half and suggests a firediff.yml principal + docs', () => {
    const c = lowCoverage(result(1, [5, 8]))!;
    expect([c.reached, c.total]).toEqual([1, 3]);
    expect(c.hint!.why).toMatch(/^Rules at L5, L8 never allowed any request/);
    expect(c.hint!.yaml).toBe(`principals:
  - name: tester
    uid: u_tester
    claims:
      email_verified: true
      admin: true
docs:
  - path: userProperties/u_tester
    data:
      enabled: true`);
  });
});

describe('payload variety and cheap gaps', () => {
  it('sends every allowed value, each checked type plus one unchecked, and lengths around size() bounds', () => {
    const m = v2(`match /posts/{id} {
      allow create: if request.resource.data.status in ['draft', 'review', 'published']
        && request.resource.data.title is string && request.resource.data.title.size() <= 5;
    }`);
    const creates = shared(m, 'posts/i1', 'create').map((r) => (r.request as { data: Record<string, unknown> }).data);
    expect(creates.map((d) => d.status)).toEqual(expect.arrayContaining(['review', 'published']));
    expect(creates.map((d) => d.title)).toEqual(expect.arrayContaining([7, 'xxxx', 'xxxxx', 'xxxxxx']));
  });
  it('seeds and sends request.time for fields compared with it', () => {
    const m = v2(`match /posts/{id} { allow create: if request.resource.data.createdAt == request.time; }`);
    const plan = buildPlan(m, m);
    expect(plan.seeds.find((s) => s.path === 'posts/i1')!.data).toEqual({ createdAt: SERVER_TIME });
    expect(shared(m, 'posts/i1', 'update').map((r) => (r.request as { data: Record<string, unknown> }).data)).toContainEqual({ createdAt: SERVER_TIME });
  });
  it('adds a path for doc ids the rules single out, and a get on a missing doc', () => {
    const m = v2(`match /config/{docId} { allow write: if docId != 'astra_vehicle_stats'; allow read: if resource == null; }`);
    const plan = buildPlan(m, m);
    expect(plan.seeds.map((s) => s.path)).toEqual(expect.arrayContaining(['config/d1', 'config/astra_vehicle_stats']));
    expect(shared(m, 'config/missing-doc', 'get')).toHaveLength(1);
  });
  it('makes a copy of a doc in each state a rule distinguishes', () => {
    const m = v2(`match /subs/{email} {
      allow update: if resource.data.status == 'pending' && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['status'])
        || resource.data.status == 'confirmed' && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['resubscribe_pending']);
    }`);
    const plan = buildPlan(m, m);
    expect(plan.seeds.find((s) => s.path === 'subs/e1')!.data.status).toBe('pending');
    expect(plan.seeds.find((s) => s.path === 'subs/e1-state1')!.data.status).toBe('confirmed');
    const onState = plan.requests.filter((r) => r.request.op !== 'list' && r.request.path === 'subs/e1-state1');
    expect(onState.map((r) => [r.request.op, r.request.canonical, 'fields' in r.request ? r.request.fields : undefined])).toContainEqual(['update', 'subs/e1', ['resubscribe_pending']]);
  });
  it('turns lookups used as a bool or through a map index into principals', () => {
    const m = v2(`match /a/{id} {
      allow write: if get(/databases/$(database)/documents/users/$(request.auth.uid)).data.admin;
      allow delete: if get(/databases/$(database)/documents/users/$(request.auth.uid)).data.roles['editor'] == true;
    }`);
    const plan = buildPlan(m, m);
    expect(plan.principals.map((p) => p.name)).toEqual(expect.arrayContaining(['users.admin=true', 'users.roles.editor=true']));
    expect(plan.seeds).toContainEqual({ path: 'users/u_users_roles_editor_true', data: { roles: { editor: true } } });
  });
});

describe('report sections for probes, untestable flips and data changes', () => {
  const m = v2(`match /users/{uid} {
      allow get: if request.auth != null && (resource == null || request.auth.uid == uid);
      allow create: if request.auth.uid == uid && request.appcheck.token != null;
      allow update: if request.auth.uid == uid && get(/databases/$(database)/documents/profiles/$(request.auth.uid)).data.ok == true;
    }`);
  const plan = buildPlan(m, m);
  const allow: Outcome = { result: 'allow' };
  const deny = (op: string, line: number): Outcome => ({ result: 'deny', reason: `false for '${op}' @ L${line}` });
  const owner: Principal = { name: 'owner', auth: { uid: 'u_owner' } };
  const stranger: Principal = { name: 'stranger', auth: { uid: 'u_stranger' } };
  const report = (rows: Row[]) =>
    buildReport({ base: m, head: m, plan, cases: rows.map((r) => r.case), rows, notExercised: [], coverage: null, skips: [], timeChanges: [], ms: { plan: 0, open: 0, run: 0 } });

  it('reports missing-doc probes on their own row, worded as such, below every other gained row', () => {
    const r = report([
      { case: { principal: stranger, request: { op: 'get', path: 'users/u_other', probe: 'missing' } }, base: deny('get', 5), head: allow },
      { case: { principal: owner, request: { op: 'update', path: 'users/u_owner', data: { a: 1 }, fields: ['a'] } }, base: deny('update', 7), head: allow },
    ]);
    expect(r.gained.map((g) => [g.who, g.can])).toEqual([
      ['the owner', 'update their own doc (a)'],
      ['any signed-in user', "read docs that don't exist yet"],
    ]);
  });

  it("moves a loss that needs an App Check token or an unseeded lookup doc to Couldn't test", () => {
    const r = report([
      { case: { principal: owner, request: { op: 'create', path: 'users/u_owner', data: {} } }, base: allow, head: deny('create', 6) },
      { case: { principal: owner, request: { op: 'update', path: 'users/u_owner', data: { a: 1 }, fields: ['a'] } }, base: allow, head: deny('update', 7) },
    ]);
    expect(r.lost).toEqual([]);
    expect(r.couldntTest.map((c) => [c.can, c.missing])).toEqual([
      ['create, update their own doc (a)', "an App Check token (firediff requests never carry one); and a doc at profiles/{uid} for this user (firediff didn't seed one)"],
    ]);
    expect(renderMarkdown(r)).toContain("**Couldn't test**");
  });

  it('keeps a group as lost when any flip in it is a real loss', () => {
    const r = report([
      { case: { principal: owner, request: { op: 'create', path: 'users/u_owner', data: {} } }, base: allow, head: deny('create', 6) },
      { case: { principal: owner, request: { op: 'update', path: 'users/u_owner', data: { a: 1 }, fields: ['a'] } }, base: allow, head: { result: 'deny', reason: 'No matching allow statements' } },
    ]);
    expect(r.couldntTest).toEqual([]);
    expect(r.lost).toHaveLength(1);
    expect(renderMarkdown(r)).not.toContain("**Couldn't test**");
  });

  it('keeps a newly writable guarded field (owner can now set their role) in gained', () => {
    const g = v2(`match /users/{uid} {
      allow update: if request.auth.uid == uid && !request.resource.data.diff(resource.data).affectedKeys().hasAny(['role']);
    }`);
    const variant: Request = { op: 'update', path: 'users/u_owner', data: { role: 'admin' }, fields: ['role'] };
    const probe: Request = { op: 'update', path: 'users/u_owner', data: { firediff_probe: 'changed' }, fields: ['firediff_probe'] };
    const rows: Row[] = [
      { case: { principal: owner, request: variant }, base: deny('update', 5), head: allow },
      { case: { principal: owner, request: probe }, base: allow, head: allow },
    ];
    const r = buildReport({ base: g, head: g, plan: buildPlan(g, g), cases: rows.map((x) => x.case), rows, notExercised: [], coverage: null, skips: [], timeChanges: [], ms: { plan: 0, open: 0, run: 0 } });
    expect(r.dataChanged).toEqual([]);
    expect(r.gained.map((x) => x.can)).toEqual(['update their own doc (role)']);
  });

  it('moves payload-only flips to Accepted data changed when another payload was already accepted', () => {
    const variant: Request = { op: 'update', path: 'users/u_owner', data: { nickname: 'x' }, fields: ['nickname'] };
    const probe: Request = { op: 'update', path: 'users/u_owner', data: { firediff_probe: 'changed' }, fields: ['firediff_probe'] };
    const r = report([
      { case: { principal: owner, request: variant }, base: deny('update', 7), head: allow },
      { case: { principal: owner, request: probe }, base: allow, head: allow },
    ]);
    expect(r.gained).toEqual([]);
    expect(r.dataChanged.map((d) => [d.who, dataText(d)])).toEqual([['the owner', "update now accepts values for nickname it didn't before"]]);
    const md = renderMarkdown(r);
    expect(md.startsWith('### firediff · no access changes')).toBe(true);
    expect(md).toContain('<details><summary>Accepted data changed (1)</summary>');
  });
});

describe('synthesized principals', () => {
  it("don't duplicate a standalone claim principal (email compared with a wildcard)", () => {
    const m = v2(`match /settings/{userEmail} { allow read, write: if request.auth.token.email == userEmail; }`);
    const names = buildPlan(m, m).principals.map((p) => p.name);
    expect(names.filter((n) => n.startsWith('synth-'))).toEqual([]);
    expect(names).toContain('token.email=u1');
  });
});
