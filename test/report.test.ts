import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { notExercised } from '../src/coverage/coverage.js';
import { canText, collapse, groupFlips, whoText, type Group } from '../src/diff/group.js';
import { buildPlan, findSkips } from '../src/generate/index.js';
import { parseRules } from '../src/parse/index.js';
import { buildReport, denialText, renderMarkdown, renderText, truncate, MAX_CHARS } from '../src/report/index.js';
import { patternFor } from '../src/report/build.js';
import type { PairResult } from '../src/run/pipeline.js';
import { rulesPathFromFirebaseJson } from '../src/run/firebase-json.js';
import type { Outcome, Principal, Request, Row } from '../src/run/types.js';

const P = {
  anon: { name: 'signed out', auth: null },
  stranger: { name: 'stranger', auth: { uid: 'u_stranger' } },
  owner: { name: 'owner', auth: { uid: 'u_owner' } },
  other: { name: 'other user', auth: { uid: 'u_other' } },
  admin: { name: 'token.admin=true', label: 'a user whose token has admin == true', auth: { uid: 'u_tok', token: { admin: true } } },
  editor: { name: 'members.role=editor', label: 'a user whose doc at teams/t1/members/{uid} has role == \'editor\'', auth: { uid: 'u_m' } },
} satisfies Record<string, Principal>;
const ORDER: Principal[] = [P.anon, P.stranger, P.owner, P.other, P.admin, P.editor];

const allow: Outcome = { result: 'allow' };
const deny: Outcome = { result: 'deny', reason: "false for 'get' @ L3" };
const req = {
  get: (path: string): Request => ({ op: 'get', path }),
  list: (collection: string): Request => ({ op: 'list', collection }),
  create: (path: string, fields?: string[]): Request => ({ op: 'create', path, data: { a: 1 }, ...(fields ? { fields } : {}) }),
  update: (path: string, field: string): Request => ({ op: 'update', path, data: { [field]: 'x' }, fields: [field] }),
  delete: (path: string): Request => ({ op: 'delete', path }),
};
const gained = (principal: Principal, request: Request): Row => ({ case: { principal, request }, base: deny, head: allow });
const lost = (principal: Principal, request: Request): Row => ({ case: { principal, request }, base: allow, head: deny });
const same = (principal: Principal, request: Request): Row => ({ case: { principal, request }, base: allow, head: allow });
const opsText = (g: Group) => canText(g, g.who.every((w) => w.kind === 'owner') ? 'own' : 'any');

describe('collapse', () => {
  const who = (...ps: Principal[]) => whoText(collapse(ps, ORDER));
  it('signed out → anyone, covering everyone else', () => expect(who(P.anon, P.stranger, P.owner, P.admin)).toBe('anyone'));
  it('stranger → any signed-in user, covering owner, other user and claims', () =>
    expect(who(P.stranger, P.owner, P.other, P.admin)).toBe('any signed-in user'));
  it('other user without stranger → other users (claims covered, owner kept)', () => {
    expect(who(P.other, P.admin)).toBe('other users');
    // Other users plus the owner is every signed-in user, unless a stranger still lacks the access.
    expect(who(P.other, P.owner)).toBe('any signed-in user');
    expect(whoText(collapse([P.other, P.owner], ORDER, new Set([P.stranger.name])))).toBe('other users, the owner');
  });
  it('otherwise names the claim and role principals, in plan order', () =>
    expect(who(P.editor, P.admin)).toBe("users whose token has admin == true, users whose doc at teams/t1/members/{uid} has role == 'editor'"));
  it('owner alone', () => expect(who(P.owner)).toBe('the owner'));
  it('drops a principal whose requirements include a broader one', () => {
    const verified = { name: 'token.email_verified=true', label: 'a user whose token has email_verified == true', auth: { uid: 'u_v' }, requires: ['claim:email_verified=true'] };
    const verifiedOwner = { name: 'synth-1', label: 'verified owner', auth: { uid: 'u_s1' }, requires: ['claim:email_verified=true', 'own'] };
    const other = { name: 'synth-2', label: 'user with token role = \'x\'', auth: { uid: 'u_s2' }, requires: ['claim:role=x'] };
    expect(whoText(collapse([verified, verifiedOwner, other], [verified, verifiedOwner, other]))).toBe("users whose token has email_verified == true, user with token role = 'x'");
  });
});

describe('groupFlips', () => {
  it('groups by (path, op, direction) and ignores unchanged rows and errors', () => {
    const rows = [
      gained(P.stranger, req.get('a/1')),
      gained(P.owner, req.get('a/1')),
      same(P.anon, req.get('a/1')),
      lost(P.admin, req.get('a/1')),
      { case: { principal: P.anon, request: req.get('a/1') }, base: deny, head: { result: 'error', message: 'x' } } as Row,
    ];
    const g = groupFlips(rows, ORDER);
    expect(g.gained.map((x) => [x.path, x.ops, whoText(x.who), x.rows.length])).toEqual([['a/1', ['get'], 'any signed-in user', 2]]);
    expect(g.lost.map((x) => [x.path, x.ops, whoText(x.who)])).toEqual([['a/1', ['get'], 'users whose token has admin == true']]);
  });

  it('merges create, update and delete with the same class into "write"', () => {
    const rows = [
      gained(P.stranger, req.create('c/1')),
      gained(P.stranger, req.update('c/1', 'firediff_probe')),
      gained(P.stranger, req.delete('c/1')),
      gained(P.owner, req.delete('c/1')),
      gained(P.admin, req.get('c/1')),
    ];
    const g = groupFlips(rows, ORDER).gained;
    expect(g.map((x) => [opsText(x), whoText(x.who)])).toEqual([
      ['write any doc', 'any signed-in user'],
      ['read any doc', 'users whose token has admin == true'],
    ]);
  });

  it("doesn't merge ops whose classes differ, and names changed fields", () => {
    const rows = [gained(P.stranger, req.create('c/1')), gained(P.owner, req.update('c/1', 'role'))];
    expect(groupFlips(rows, ORDER).gained.map((x) => [opsText(x), whoText(x.who)])).toEqual([
      ['create any doc', 'any signed-in user'],
      ['update their own doc (role)', 'the owner'],
    ]);
  });

  it('ranks anyone > signed-in > other users > claim/role > owner-only, then write > list > get', () => {
    const rows = [
      gained(P.owner, req.update('u/u_owner', 'role')),
      gained(P.admin, req.get('x/1')),
      gained(P.admin, req.list('x')),
      gained(P.other, req.get('p/1')),
      gained(P.stranger, req.get('s/1')),
      gained(P.stranger, req.list('s')),
      gained(P.stranger, req.create('w/1')),
      gained(P.stranger, req.update('w/1', 'f')),
      gained(P.stranger, req.delete('w/1')),
      gained(P.anon, req.get('pub/1')),
    ];
    expect(groupFlips(rows, ORDER).gained.map((x) => `${whoText(x.who)} | ${opsText(x)} | ${x.path}`)).toEqual([
      'anyone | read any doc | pub/1',
      'any signed-in user | write any doc | w/1',
      'any signed-in user | list all docs | s',
      'any signed-in user | read any doc | s/1',
      'other users | read any doc | p/1',
      'users whose token has admin == true | list all docs | x',
      'users whose token has admin == true | read any doc | x/1',
      'the owner | update their own doc (role) | u/u_owner',
    ]);
  });

  it("says whose doc: another user's, their own, any; and all docs vs their own for lists", () => {
    const [read] = groupFlips([gained(P.stranger, req.get('users/u_owner'))], ORDER).gained;
    expect(canText(read!, 'other')).toBe("read another user's doc");
    const [own] = groupFlips([gained(P.owner, req.update('users/u_owner', 'role'))], ORDER).gained;
    expect(canText(own!, 'own')).toBe('update their own doc (role)');
    const filtered: Request = { op: 'list', collection: 'posts', where: [['author', '==', 'u_stranger']] };
    expect(canText(groupFlips([gained(P.stranger, filtered)], ORDER).gained[0]!, 'other')).toBe('list their own docs');
  });

  it('never merges filtered and unfiltered list flips into one row', () => {
    const filtered: Request = { op: 'list', collection: 'posts', where: [['author', '==', 'u_stranger']] };
    const g = groupFlips([gained(P.stranger, filtered), gained(P.admin, req.list('posts'))], ORDER).gained;
    expect(g.map((x) => [whoText(x.who), canText(x, 'other')])).toEqual([
      ['any signed-in user', 'list their own docs'],
      ['users whose token has admin == true', 'list all docs'],
    ]);
  });

  it('merges other users and the owner into any signed-in user only when no stranger still lacks the access', () => {
    const probe = (path: string): Request => ({ op: 'get', path, probe: 'missing' });
    // The stranger's probe hit their own doc, which they could already read: they don't count against it.
    const own = groupFlips([gained(P.other, probe('w/u_s')), gained(P.owner, probe('w/u_s')), same(P.stranger, probe('w/u_s'))], ORDER).gained;
    expect(whoText(own[0]!.who)).toBe('any signed-in user');
    // A stranger still denied the same request: not everyone signed in gained it.
    const denied = { case: { principal: P.stranger, request: probe('w/u_s') }, base: deny, head: deny };
    const not = groupFlips([gained(P.other, probe('w/u_s')), gained(P.owner, probe('w/u_s')), denied], ORDER).gained;
    expect(whoText(not[0]!.who)).toBe('other users, the owner');
  });

  it('picks the proof request from the broadest principal, most severe op first', () => {
    const rows = [
      gained(P.owner, req.delete('w/1')),
      gained(P.admin, req.create('w/1')),
      gained(P.other, req.update('w/1', 'f')),
      gained(P.other, req.delete('w/1')),
    ];
    const [g] = groupFlips(rows, ORDER).gained;
    expect(whoText(g!.who)).toBe('any signed-in user'); // no stranger sent these, so other users + owner = everyone signed in
    expect([g!.proof.case.principal.name, g!.proof.case.request.op]).toEqual(['other user', 'delete']);
  });
});

describe('patternFor', () => {
  const m = parseRules(readFileSync('corpus/parse/deep-nesting.rules', 'utf8'));
  it('shows the most specific match-block pattern for docs and collections', () => {
    expect(patternFor('orgs/o1/projects/p1/tasks/t1', false, m)).toBe('orgs/{orgId}/projects/{projectId}/tasks/{taskId}');
    expect(patternFor('orgs/o1/projects/p1/tasks', true, m)).toBe('orgs/{orgId}/projects/{projectId}/tasks');
    expect(patternFor('orgs', true, m)).toBe('orgs');
    expect(patternFor('public/d1/c1/d2', false, m)).toBe('public/{path=**}');
    expect(patternFor('public', true, m)).toBe('public/{path=**}');
  });
});

describe('denialText', () => {
  const model = parseRules(readFileSync('corpus/trap-01/base.rules', 'utf8'));
  const d = (reason: string, op: Request['op']) => denialText({ result: 'deny', reason }, op, model);
  it('maps the line to the allow statement and keeps the emulator reason', () => {
    expect(d("false for 'get' @ L13", 'get')).toBe('denied by L13 `isOwner(uid)` (false)');
    expect(d("Null value error. for 'list' @ L13", 'list')).toBe('denied by L13 `isOwner(uid)` (Null value error)');
  });
  it('keeps only entries for the request op and merges reasons per line', () => {
    expect(d("evaluation error at L15:24 for 'update' @ L15, false for 'update' @ L15", 'update')).toMatch(
      /^denied by L15 `isOwner\(uid\) && !request.*` \(evaluation error at L15:24; false\)$/,
    );
    expect(d("false for 'create' @ L14, false for 'update' @ L15", 'create')).toMatch(/^denied by L14 `isOwner\(uid\) && request\.resource\.data\.role == 'member'` \(false\)$/);
  });
  it('explains "no matching allow"', () => expect(d('No matching allow statements', 'get')).toBe('denied: no allow statement matches this request'));
});

describe('coverage', () => {
  const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /a/{id} {
      allow get: if request.auth != null || isAdmin(request.auth);
      allow list: if request.auth.uid == id;
      allow create: if false;
    }
  }
}`;
  const model = parseRules(src.replace('isAdmin(request.auth)', 'request.auth.token.admin == true'));
  const text = model.matches.length && src.replace('isAdmin(request.auth)', 'request.auth.token.admin == true');
  const at = (needle: string) => {
    const off = Buffer.from(text as string).indexOf(needle);
    const before = (text as string).slice(0, off);
    return { line: before.split('\n').length, column: off - before.lastIndexOf('\n'), currentOffset: off, endOffset: off + needle.length - 1 };
  };
  const node = (needle: string, values: Array<[Record<string, unknown>, number]>, children: unknown[] = []) => ({
    sourcePosition: at(needle),
    values: values.map(([value, count]) => ({ value, count })),
    children,
  });
  const T = { boolValue: true };
  const F = { boolValue: false };

  it('lists the outermost never-true boolean, skips true ones, flags never-evaluated allows, ignores literals', () => {
    const coverage = {
      rules: { files: [{ content: text }] },
      report: [
        node('request.auth != null || request.auth.token.admin == true', [[T, 2]], [
          node('request.auth != null', [[T, 2], [F, 1]], [node('request.auth', [[{ mapValue: {} }, 3]])]),
          node('request.auth.token.admin == true', [[F, 1]], [node('request.auth.token.admin', [[{}, 1]])]),
        ]),
      ],
    };
    expect(notExercised(coverage, model)).toEqual([
      { line: 5, column: 45, text: 'request.auth.token.admin == true', kind: 'never-true' },
      { line: 6, column: 22, text: 'request.auth.uid == id', kind: 'never-evaluated' },
    ]);
  });

  it('re-closes the parens the emulator leaves off call expressions', () => {
    const m = parseRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /a/{id} { allow get: if id.matches('x.*'); }
  }
}`);
    const content = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /a/{id} { allow get: if id.matches('x.*'); }
  }
}`;
    const off = content.indexOf("id.matches('x.*')");
    const coverage = {
      rules: { files: [{ content }] },
      report: [{ sourcePosition: { line: 4, column: 35, currentOffset: off, endOffset: off + "id.matches('x.*'".length - 1 }, values: [{ value: F, count: 1 }] }],
    };
    expect(notExercised(coverage, m)[0]!.text).toBe("id.matches('x.*')");
  });
});

describe('skips', () => {
  it('flags combined principals, lookups keyed on document data, and list rules on the doc id', () => {
    const m = parseRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{postId} {
      allow update: if request.auth.token.role == 'writer' && resource.data.author == request.auth.uid;
      allow read: if get(/databases/$(database)/documents/orgs/$(resource.data.org)/members/$(request.auth.uid)).data.ok == true;
      allow list: if postId == 'x';
      allow delete: if request.auth.token.admin == true || resource.data.author == request.auth.uid;
    }
  }
}`);
    expect(findSkips(m).map((s) => [s.line, s.kind])).toEqual([
      [5, 'combined-principals'],
      [6, 'lookup-on-document-data'],
      [7, 'list-depends-on-doc-id'],
    ]);
  });

  it('applies to the parse fixtures where expected', () => {
    const claims = parseRules(readFileSync('corpus/parse/claims.rules', 'utf8'));
    expect(findSkips(claims).filter((s) => s.kind === 'combined-principals').map((s) => s.line)).toEqual([22]);
  });
});

describe('markdown', () => {
  const base = parseRules(readFileSync('corpus/trap-01/base.rules', 'utf8'), 'base.rules');
  const head = parseRules(readFileSync('corpus/trap-01/head.rules', 'utf8'), 'head.rules');
  const plan = buildPlan(base, head);
  const result = (rows: Row[]): PairResult => ({ base, head, plan, cases: rows.map((r) => r.case), rows, notExercised: [], coverage: null, skips: [], timeChanges: [], ms: { plan: 0, open: 0, run: 0 } });

  it('puts title, gained table, lost details, not exercised, proof details in that order', () => {
    const r = result([gained(P.stranger, req.get('users/u_owner')), lost(P.owner, req.delete('users/u_owner'))]);
    const md = renderMarkdown(buildReport({ ...r, notExercised: [{ line: 14, column: 23, text: 'isOwner(uid)', kind: 'never-true' }] }));
    const at = (s: string) => md.indexOf(s);
    expect(md.startsWith('### firediff · 2 access changes\n')).toBe(true);
    expect(at('| Who | Can now | On |')).toBeGreaterThan(0);
    expect(at('<details><summary>Lost access (1)</summary>')).toBeGreaterThan(at('| Who | Can now | On |'));
    expect(at('**Not exercised**')).toBeGreaterThan(at('Lost access'));
    expect(at('<details><summary>Proof (2)</summary>')).toBeGreaterThan(at('**Not exercised**'));
    expect(md).not.toMatch(/\| Proof/);
  });

  it('leaves out Not exercised when every allow condition was reached and nothing was skipped', () => {
    const report = buildReport(result([gained(P.stranger, req.get('users/u_owner'))]));
    expect(report.notExercised).toEqual([]);
    expect(renderMarkdown(report)).not.toContain('Not exercised');
    expect(renderText(report)).not.toContain('Not exercised');
    // Coverage it couldn't read is still worth saying.
    const unknown = buildReport({ ...result([]), notExercised: null });
    expect(renderMarkdown(unknown)).toContain('**Not exercised**');
  });

  it('says how many requests ran when nothing changed, and never claims safety', () => {
    const md = renderMarkdown(buildReport(result([same(P.owner, req.get('users/u_owner'))])));
    expect(md.startsWith('### firediff · no access changes in 1 requests\n')).toBe(true);
    expect(md).not.toMatch(/\bsafe\b|\bsecure\b|no issues/i);
  });

  it('escapes HTML in rule-derived text', () => {
    const evil = { name: 'token.role=<img src=x>', label: 'a user whose token has role == \'<img src=x onerror=alert(1)>\'', auth: { uid: 'u_e', token: { role: '<img src=x>' } } };
    const r = result([gained(evil, req.get('users/u_owner'))]);
    r.plan = { ...plan, principals: [...plan.principals, evil] };
    const md = renderMarkdown(buildReport(r));
    // Fenced code blocks (the proof JSON) are never rendered as HTML; everything else must be escaped.
    const prose = md.replace(/```[\s\S]*?```/g, '');
    expect(prose).not.toContain('<img');
    expect(prose).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('truncates at 60,000 chars, closing fences and <details>', () => {
    const long = ['### t', '<details><summary>Proof</summary>', '```json', ...Array.from({ length: 5000 }, (_, i) => `"line ${i} ${'x'.repeat(20)}",`)].join('\n');
    const out = truncate(long);
    expect(out.length).toBeLessThanOrEqual(MAX_CHARS);
    expect((out.match(/^```/gm) ?? []).length % 2).toBe(0);
    expect(out).toContain('</details>');
    expect(out).toMatch(/Report truncated at 60,000 characters/);
    expect(truncate('short')).toBe('short');
  });
});

describe('changed but never tested', () => {
  const rules = (cond: string) => `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isEditor() { return request.auth.token.editor == true; }
    match /a/{id} {
      allow read: if request.auth != null;
      allow write: if ${cond};
    }
    match /b/{id} {
      allow read: if request.auth.token.admin == true;
    }
  }
}`;
  const base = parseRules(rules('false'), 'base.rules');
  const head = parseRules(rules('isEditor()'), 'head.rules');
  const plan = buildPlan(base, head);
  const report = (unexercised: PairResult['notExercised']) =>
    buildReport({ base, head, plan, cases: [], rows: [], notExercised: unexercised, coverage: null, skips: [], timeChanges: [], ms: { plan: 0, open: 0, run: 0 } });

  it('moves entries inside a changed allow (or a function it calls) to the top section', () => {
    const r = report([
      { line: 4, column: 32, text: 'request.auth.token.editor == true', kind: 'never-true' },
      { line: 10, column: 22, text: 'request.auth.token.admin == true', kind: 'never-true' },
    ]);
    expect(r.changedUntested).toEqual([{ line: 4, text: 'request.auth.token.editor == true', why: 'never true', allowLines: [7] }]);
    expect(r.notExercised.map((n) => n.line)).toEqual([10]);
    const md = renderMarkdown(r);
    expect(md.indexOf('**Changed in this PR, but never tested**')).toBeLessThan(md.indexOf('**Not exercised**'));
    expect(md).toContain('- L4 `request.auth.token.editor == true`: never true (in the rule at L7)');
  });

  it('leaves the section out when nothing changed was untested', () => {
    const r = report([{ line: 10, column: 22, text: 'request.auth.token.admin == true', kind: 'never-true' }]);
    expect(r.changedUntested).toEqual([]);
    expect(renderMarkdown(r)).not.toContain('Changed in this PR');
  });
});

describe('firebase.json', () => {
  it('reads firestore.rules or the single rules file of the firestore array', () => {
    expect(rulesPathFromFirebaseJson('{"firestore":{"rules":"firestore.rules"}}')).toBe('firestore.rules');
    expect(rulesPathFromFirebaseJson('{"firestore":[{"database":"(default)","rules":"a.rules"},{"database":"x","rules":"a.rules"}]}')).toBe('a.rules');
  });
  it('errors when ambiguous or missing', () => {
    expect(() => rulesPathFromFirebaseJson('{"firestore":[{"rules":"a.rules"},{"rules":"b.rules"}]}')).toThrowError(/several Firestore rules files \(a\.rules, b\.rules\)/);
    expect(() => rulesPathFromFirebaseJson('{"hosting":{}}')).toThrowError(/no "firestore" section/);
  });
});

describe('cli without an emulator', () => {
  const cli = (...args: string[]) => spawnSync('node_modules/.bin/tsx', ['src/bin.ts', ...args], { encoding: 'utf8', env: { ...process.env, FIRESTORE_EMULATOR_HOST: '' } });
  it('exits 2 on a parse error before starting the emulator', () => {
    const r = cli('corpus/trap-01/base.rules', 'package.json');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^firediff: package\.json:1:1: /);
  });
  it('exits 2 on bad flags and missing files', () => {
    expect(cli('a', 'b', '--format', 'pdf').status).toBe(2);
    expect(cli('a', 'b', '--fail-on', 'sometimes').status).toBe(2);
    expect(cli('nope.rules', 'corpus/trap-01/head.rules').status).toBe(2);
  });
});
