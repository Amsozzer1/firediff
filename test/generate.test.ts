import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPlan, ConfigError, expandCases, extract, formatPlan, parseConfig, type Plan } from '../src/generate/index.js';
import { parseRules, type RuleModel } from '../src/parse/index.js';
import type { Request } from '../src/run/types.js';

const corpus = new URL('../corpus/', import.meta.url);
const model = (rel: string) => parseRules(readFileSync(new URL(rel, corpus), 'utf8'), `corpus/${rel}`);
const v2 = (body: string, file = 'inline.rules') =>
  parseRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${body}
  }
}`, file);
const same = (m: RuleModel) => buildPlan(m, m);

/** Shared requests (not a synthesized owner's requests on its own copies). */
const requests = (plan: Plan, path: string, op?: Request['op']) =>
  plan.requests
    .filter((r) => !r.only)
    .map((r) => r.request)
    .filter((r) => (r.op === 'list' ? r.collection : r.path) === path && (!op || r.op === op));

describe('extract', () => {
  it('finds owner slots from wildcard == request.auth.uid, keyed by path shape', () => {
    expect([...extract([model('trap-01/base.rules')]).ownerSlots]).toEqual(['users/*']);
    expect([...extract([model('trap-03/base.rules')]).ownerSlots]).toEqual(['teams/*/members/*']);
  });

  it('finds owner fields and owner list fields', () => {
    const f = extract([model('parse/deep-nesting.rules')]).fields;
    const at = (p: string, name: string) => f.get(`/databases/{database}/documents/${p}`)!.get(name)!;
    expect(at('orgs/{orgId}', 'members')).toMatchObject({ owner: false, ownerList: true });
    expect(at('orgs/{orgId}/projects/{projectId}/tasks/{taskId}', 'assignee')).toMatchObject({ owner: true });
    expect(at('orgs/{orgId}/projects/{projectId}', 'orgId')).toMatchObject({ wildcard: 'orgId' });
  });

  it('finds claims compared to literals, in lists, used as bools, and nested under firebase', () => {
    const facts = extract([
      model('parse/claims.rules'),
      v2(`match /x/{id} { allow read: if request.auth.token.beta && !request.auth.token.banned; }`),
    ]);
    const claims = Object.fromEntries([...facts.claims].map(([k, s]) => [k, s.values]));
    expect(claims).toEqual({
      admin: [true],
      role: ['editor', 'writer'],
      email_verified: [true],
      'firebase.sign_in_provider': ['anonymous'],
      plan: ['pro', 'enterprise'],
      beta: [true],
      banned: [true],
    });
    expect(facts.claimWildcards.map((c) => [c.key, c.wildcard])).toEqual([['tenant', 'tenantId']]);
  });

  it('finds field names in data refs, key-set methods and `in` on the data map', () => {
    const m = v2(`match /x/{id} {
      allow update: if !request.resource.data.diff(resource.data).affectedKeys().hasAny(['role', 'plan'])
        && request.resource.data.keys().hasOnly(['name', 'role', 'plan'])
        && !('secret' in request.resource.data) && resource.data['nick'] != null && resource.data.a.b == 1;
    }`);
    const fields = extract([m]).fields.get('/databases/{database}/documents/x/{id}')!;
    expect([...fields.keys()].sort()).toEqual(['a', 'name', 'nick', 'plan', 'role', 'secret']);
  });

  it('records allowed (== / in) and forbidden (!=) literals per field', () => {
    const m = v2(`match /x/{id} {
      allow create: if request.resource.data.status in ['draft', 'review'] && request.resource.data.kind == 'post'
        && request.resource.data.state != 'locked';
    }`);
    const fields = extract([m]).fields.get('/databases/{database}/documents/x/{id}')!;
    expect(fields.get('status')!.allowed.values).toEqual(['draft', 'review']);
    expect(fields.get('kind')!.allowed.values).toEqual(['post']);
    expect(fields.get('state')!.forbidden.values).toEqual(['locked']);
  });
});

describe('principals', () => {
  it('always has the four base principals, then claims, then lookups', () => {
    const plan = same(model('parse/claims.rules'));
    expect(plan.principals.map((p) => p.name).filter((n) => !n.startsWith('synth-'))).toEqual([
      'signed out', 'stranger', 'owner', 'other user',
      'token.admin=true',
      'token.email_verified=true',
      'token.firebase.sign_in_provider=anonymous',
      'token.plan=pro', 'token.plan=enterprise',
      'token.role=editor', 'token.role=writer',
      'token.tenant=t1',
    ]);
    expect(plan.principals.find((p) => p.name === 'token.firebase.sign_in_provider=anonymous')!.auth).toEqual({
      uid: 'u_tok_firebase_sign_in_provider_anonymous',
      token: { firebase: { sign_in_provider: 'anonymous', identities: {} } },
    });
    expect(plan.principals.find((p) => p.name === 'stranger')!.label).toBe('any signed-in user');
  });

  it('makes a member principal per uid lookup, plus one per role literal, and seeds their docs', () => {
    const plan = same(model('parse/lookups.rules'));
    expect(plan.principals.slice(4).map((p) => [p.name, p.auth?.uid])).toEqual([
      ['admins doc', 'u_admins_doc'],
      ['members doc', 'u_members_doc'],
      ['members.role=viewer', 'u_members_role_viewer'],
      ['members.role=editor', 'u_members_role_editor'],
      ['members.role=owner', 'u_members_role_owner'],
      ['users doc', 'u_users_doc'],
      ['users.role=staff', 'u_users_role_staff'],
      ['users.role=auditor', 'u_users_role_auditor'],
    ]);
    const seeds = Object.fromEntries(plan.seeds.map((s) => [s.path, s.data]));
    expect(seeds['admins/u_admins_doc']).toEqual({});
    expect(seeds['teams/t1/members/u_members_role_owner']).toEqual({ role: 'owner' });
    expect(seeds['users/u_users_role_staff']).toEqual({ role: 'staff' });
  });

  it('disambiguates lookups that share a collection name by full template', () => {
    const plan = same(v2(`
      match /a/{id} { allow read: if get(/databases/$(database)/documents/orgs/o1/members/$(request.auth.uid)).data.role == 'x'; }
      match /b/{id} { allow read: if exists(/databases/$(database)/documents/teams/t9/members/$(request.auth.uid)); }`));
    expect(plan.principals.slice(4).map((p) => p.name)).toEqual([
      'orgs/o1/members/{uid} doc',
      'orgs/o1/members/{uid}.role=x',
      'teams/t9/members/{uid} doc',
    ]);
  });
});

describe('combined principals', () => {
  it('builds one principal per OR-branch that needs several things at once', () => {
    const plan = same(model('parse/claims.rules'));
    expect(plan.principals.filter((p) => p.name.startsWith('synth-')).map((p) => [p.label, p.auth?.token, p.ownsTarget])).toEqual([
      ["verified user with token role = 'editor'", { email_verified: true, role: 'editor' }, false],
      ["verified user with token role = 'writer'", { email_verified: true, role: 'writer' }, false],
      ["owner with token role = 'writer'", { role: 'writer' }, true],
      ["user with token tenant = 't1' and token plan = 'pro'", { tenant: 't1', plan: 'pro' }, false],
      ['user with token admin = true and email a@example.com', { admin: true, email: 'a@example.com' }, false],
    ]);
  });

  it("gives a synthesized owner its own copy of the doc, and only that principal acts on it", () => {
    const plan = same(model('parse/claims.rules'));
    const owner = plan.principals.find((p) => p.label === "owner with token role = 'writer'")!;
    expect(plan.seeds).toContainEqual({ path: `articles/a1-${owner.auth!.uid}`, data: { author: owner.auth!.uid, published: true } });
    const own = plan.requests.filter((r) => r.only?.includes(owner.name));
    expect(own.map((r) => [r.request.op, r.request.canonical])).toContainEqual(['update', 'articles/a1']);
    expect(own.every((r) => r.only!.length === 1)).toBe(true);
    const cases = expandCases(plan);
    expect(cases.filter((c) => c.principal.name === owner.name).every((c) => own.some((r) => r.request === c.request || r.request.op === c.request.op))).toBe(true);
  });

  it('seeds lookup docs together, numeric bounds and nested fields included', () => {
    const plan = same(v2(`match /games/{gameId} {
      allow create: if request.auth.token.email_verified == true
        && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.readOnly.writeRate <= 1
        && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.created == true;
    }`));
    const p = plan.principals.find((x) => x.name.startsWith('synth-'))!;
    expect(p.label).toBe('verified user with a users doc (readOnly.writeRate = 1, created = true)');
    expect(plan.seeds).toContainEqual({ path: `users/${p.auth!.uid}`, data: { readOnly: { writeRate: 1 }, created: true } });
    expect(p.scope).toEqual(['games/g1', 'games']);
  });

  it('keys a lookup on document data by the target seed value', () => {
    const plan = same(v2(`match /posts/{postId} {
      allow read: if get(/databases/$(database)/documents/orgs/$(resource.data.org)/members/$(request.auth.uid)).data.role == 'admin'
        && request.auth.token.email_verified == true;
    }`));
    const p = plan.principals.find((x) => x.name.startsWith('synth-'))!;
    expect(plan.seeds).toContainEqual({ path: `orgs/org-1/members/${p.auth!.uid}`, data: { role: 'admin' } });
  });

  it("doesn't overwrite fields of docs other principals use", () => {
    const plan = same(model('parse/lookups.rules'));
    expect(Object.fromEntries(plan.seeds.map((s) => [s.path, s.data]))['reports/r1']).toEqual({});
  });
});

describe('paths and seeds', () => {
  it('uses u_owner for owner slots and first-letter ids elsewhere', () => {
    expect(same(model('trap-03/base.rules')).seeds.map((s) => s.path)).toEqual([
      'teams/t1',
      'teams/t1/members/u_members_doc',
      'teams/t1/members/u_members_role_admin',
      'teams/t1/members/u_other',
      'teams/t1/members/u_owner',
    ]);
  });

  it('expands recursive wildcards to depth 1 and depth 2 document paths', () => {
    const plan = same(v2(`
      match /public/{path=**} { allow read; }
      match /{document=**} { allow read: if false; }`));
    expect(plan.seeds.map((s) => s.path)).toEqual(['c1/d1', 'c1/d1/c2/d2', 'public/d1', 'public/d1/c1/d2']);
  });

  it('fills owner fields, owner lists, wildcard-tied fields and literals', () => {
    const seeds = Object.fromEntries(same(model('parse/deep-nesting.rules')).seeds.map((s) => [s.path, s.data]));
    expect(seeds['orgs/o1']).toEqual({ members: ['u_owner'] });
    expect(seeds['orgs/o1/projects/p1']).toEqual({ orgId: 'o1' });
    expect(seeds['orgs/o1/projects/p1/tasks/t1']).toEqual({ assignee: 'u_owner' });
    expect(Object.fromEntries(same(model('trap-04/base.rules')).seeds.map((s) => [s.path, s.data]))['users/u_owner']).toEqual({ role: 'member' });
  });

  it('seeds a twin doc owned by the other user for owner-slot paths', () => {
    const seeds = same(model('trap-01/base.rules')).seeds;
    expect(seeds).toEqual([
      { path: 'users/u_other', data: { role: 'member' } },
      { path: 'users/u_owner', data: { role: 'member' } },
    ]);
  });
});

describe('requests', () => {
  it('lists with where(ownerField == caller uid) plus an unfiltered list; signed-out skips the filtered one', () => {
    const plan = same(model('parse/claims.rules'));
    expect(requests(plan, 'articles', 'list')).toEqual([
      { op: 'list', collection: 'articles', where: [['author', '==', '$uid']] },
      { op: 'list', collection: 'articles' },
    ]);
    const filtered = expandCases(plan).filter((c) => c.request.op === 'list' && c.request.where);
    expect(filtered.map((c) => c.principal.name)).not.toContain('signed out');
    expect(filtered.find((c) => c.principal.name === 'owner')!.request).toEqual({
      op: 'list', collection: 'articles', where: [['author', '==', 'u_owner']],
    });
  });

  it('creates with the allowed payload, each disallowed value, and impersonating', () => {
    expect(requests(same(model('parse/claims.rules')), 'articles/a1', 'create')).toEqual([
      { op: 'create', path: 'articles/a1', data: { author: 'u_other', published: true }, fields: ['author'] },
      { op: 'create', path: 'articles/a1', data: { author: 'u_owner', published: false }, fields: ['published'] },
      { op: 'create', path: 'articles/a1', data: { author: 'u_owner', published: true } },
    ]);
  });

  it('updates one field at a time, changing only that field', () => {
    expect(requests(same(model('parse/claims.rules')), 'articles/a1', 'update')).toEqual([
      { op: 'update', path: 'articles/a1', data: { author: 'u_other' }, fields: ['author'] },
      { op: 'update', path: 'articles/a1', data: { firediff_probe: 'changed' }, fields: ['firediff_probe'] },
      { op: 'update', path: 'articles/a1', data: { published: false }, fields: ['published'] },
    ]);
  });

  it('always sends a probe-only update that keeps every read field at its seed value', () => {
    expect(requests(same(model('trap-04/base.rules')), 'users/u_owner', 'update')).toEqual([
      { op: 'update', path: 'users/u_owner', data: { firediff_probe: 'changed' }, fields: ['firediff_probe'] },
      { op: 'update', path: 'users/u_owner', data: { role: 'admin' }, fields: ['role'] },
    ]);
  });

  it('falls back to a probe field when the rules read no fields', () => {
    expect(requests(same(model('trap-02/base.rules')), 'config/k1', 'update')).toEqual([
      { op: 'update', path: 'config/k1', data: { firediff_probe: 'changed' }, fields: ['firediff_probe'] },
    ]);
  });

  describe('disallowed values', () => {
    const create = (rules: string) =>
      same(v2(`match /x/{id} { ${rules} }`)).requests.find((r) => r.request.op === 'create' && r.why.includes('outside the allowed values'))!.request;
    const pick = (rules: string) => (create(rules) as { data: Record<string, unknown> }).data.f;

    it('prefers another literal seen elsewhere in the rules', () => {
      expect(requests(same(model('trap-04/base.rules')), 'users/u_owner', 'create')).toContainEqual({
        op: 'create', path: 'users/u_owner', data: { role: 'admin' }, fields: ['role'],
      });
      expect(pick(`allow create: if request.resource.data.f == 'a' && request.auth.token.tier == 'gold';`)).toBe('gold');
    });
    it("skips literals that are field names, falling back to 'admin'", () => {
      expect(pick(`allow create: if request.resource.data.f == 'a' && !request.resource.data.keys().hasAny(['f']);`)).toBe('admin');
    });
    it('prefers a != literal', () => {
      expect(pick(`allow create: if request.resource.data.f in ['a', 'b'] && request.resource.data.f != 'z' && 'q' == 'q';`)).toBe('z');
    });
    it('negates bools and goes past the largest number', () => {
      expect(pick(`allow create: if request.resource.data.f == true;`)).toBe(false);
      expect(pick(`allow create: if request.resource.data.f in [1, 5, 3];`)).toBe(6);
    });
  });

  it('works from the union of both models', () => {
    const base = v2(`match /x/{id} { allow read; }`);
    const head = v2(`match /x/{id} { allow update: if request.resource.data.title is string; }
      match /y/{id} { allow read; }`);
    const plan = buildPlan(base, head);
    const updates = requests(plan, 'x/i1', 'update');
    expect(updates).toContainEqual({ op: 'update', path: 'x/i1', data: { firediff_probe: 'changed' }, fields: ['firediff_probe'] });
    expect(updates).toContainEqual({ op: 'update', path: 'x/i1', data: { title: 'title-1-changed' }, fields: ['title'] });
    expect(plan.seeds.map((s) => s.path)).toEqual(['x/i1', 'y/i1']);
  });
});

describe('firediff.yml', () => {
  it('adds docs, claims, principals and payloads', () => {
    const config = parseConfig(`
docs:
  - path: users/u_owner
    data: { plan: pro }
  - path: orgs/acme
    data: { name: Acme }
claims:
  tier: [gold]
principals:
  - name: support
    uid: u_support
    claims: { support: true }
  - name: robot
payloads:
  - op: update
    path: users/u_owner
    data: { role: superadmin }
`);
    const plan = buildPlan(model('trap-01/base.rules'), model('trap-01/head.rules'), config);
    expect(plan.seeds).toContainEqual({ path: 'users/u_owner', data: { role: 'member', plan: 'pro' } });
    expect(plan.seeds).toContainEqual({ path: 'orgs/acme', data: { name: 'Acme' } });
    expect(plan.principals.map((p) => p.name).slice(4)).toEqual(['token.tier=gold', 'support', 'robot']);
    expect(plan.principals.at(-2)!.auth).toEqual({ uid: 'u_support', token: { support: true } });
    expect(plan.principals.at(-1)!.auth).toBeNull();
    expect(requests(plan, 'users/u_owner', 'update')).toContainEqual({
      op: 'update', path: 'users/u_owner', data: { role: 'superadmin' }, fields: ['role'],
    });
  });

  it('rejects configs that do not match the schema, naming each problem', () => {
    expect(() => parseConfig(`docs: [{ path: /bad/, data: 1 }]\nprincipal: []\n`, 'f.yml')).toThrowError(ConfigError);
    try {
      parseConfig(`docs: [{ path: /bad/, data: 1 }]\nprincipal: []\npayloads: [{ op: delete, path: a/b, data: {} }]\n`, 'f.yml');
    } catch (e) {
      expect((e as Error).message).toBe(`f.yml: invalid config
  - (root) must NOT have additional properties: principal
  - /docs/0/path must match pattern "^[^/]+(/[^/]+)*$"
  - /docs/0/data must be object
  - /payloads/0/op must be equal to one of the allowed values`);
    }
  });

  it('rejects malformed YAML', () => {
    expect(() => parseConfig('docs: [', 'f.yml')).toThrowError(/^f\.yml: invalid config/);
  });
});

describe('plan output', () => {
  const traps = ['trap-01', 'trap-02', 'trap-03', 'trap-04'];
  for (const t of traps) {
    it(`matches the golden file for ${t} (UPDATE_GOLDEN=1 to rewrite)`, () => {
      const base = model(`${t}/base.rules`);
      const head = model(`${t}/head.rules`);
      const text = formatPlan(buildPlan(base, head), base, head);
      const golden = new URL(`${t}/plan.txt`, corpus);
      if (process.env.UPDATE_GOLDEN) writeFileSync(golden, text);
      expect(text).toBe(readFileSync(golden, 'utf8'));
    });
  }

  it('is deterministic', () => {
    const base = model('parse/lookups.rules');
    const head = model('parse/claims.rules');
    expect(formatPlan(buildPlan(base, head), base, head)).toBe(formatPlan(buildPlan(base, head), base, head));
  });

  it('`firediff plan` exits 2 with line:col on a parse error', () => {
    const r = spawnSync('node_modules/.bin/tsx', ['src/bin.ts', 'plan', 'corpus/trap-01/base.rules', 'package.json'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^firediff: package\.json:1:1: /);
  });
});
