import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  blockCondition,
  effectiveCondition,
  matchDocument,
  parseRules,
  print,
  RulesParseError,
  type RuleModel,
} from '../src/parse/index.js';

const corpus = new URL('../corpus/', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, corpus), 'utf8');

/** Wrap match blocks in the usual v2 boilerplate. */
const v2 = (body: string) => `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${body}
  }
}`;

const block = (m: RuleModel, path: string) => {
  const b = m.matches.find((x) => x.documentPath === path);
  if (!b) throw new Error(`no block ${path} in ${m.matches.map((x) => x.documentPath).join(', ')}`);
  return b;
};

describe('match paths', () => {
  it('concatenates nested matches under the /databases/{database}/documents prefix', () => {
    const m = parseRules(read('parse/deep-nesting.rules'));
    expect(m.matches.map((b) => b.path)).toEqual([
      '/databases/{database}/documents',
      '/databases/{database}/documents/orgs/{orgId}',
      '/databases/{database}/documents/orgs/{orgId}/projects/{projectId}',
      '/databases/{database}/documents/orgs/{orgId}/projects/{projectId}/tasks/{taskId}',
      '/databases/{database}/documents/orgs/{orgId}/projects/{projectId}/tasks/{taskId}/comments/{commentId}',
      '/databases/{database}/documents/orgs/{orgId}/projects/{projectId}',
      '/databases/{database}/documents/public/{path=**}',
    ]);
    expect(block(m, 'orgs/{orgId}/projects/{projectId}/tasks/{taskId}').segments.slice(3)).toEqual([
      { kind: 'literal', value: 'orgs' },
      { kind: 'wildcard', name: 'orgId' },
      { kind: 'literal', value: 'projects' },
      { kind: 'wildcard', name: 'projectId' },
      { kind: 'literal', value: 'tasks' },
      { kind: 'wildcard', name: 'taskId' },
    ]);
    expect(block(m, 'public/{path=**}').segments.at(-1)).toEqual({ kind: 'recursive', name: 'path' });
    expect(m.warnings).toEqual([]);
  });

  it('accepts a literal (default) database and multi-segment match paths', () => {
    const m = parseRules(`rules_version = '2';
service cloud.firestore {
  match /databases/(default)/documents/a/{b}/c/{d} { allow read: if b == d; }
}`);
    expect(m.matches.map((b) => b.documentPath)).toEqual(['a/{b}/c/{d}']);
  });

  it('flags matches that are not under /databases/{database}/documents', () => {
    const m = parseRules(`rules_version = '2';
service cloud.firestore {
  match /users/{uid} { allow read; }
}`);
    expect(m.matches[0]!.documentPath).toBeNull();
    expect(m.warnings.map((w) => w.code)).toEqual(['outside-documents']);
    expect(matchDocument(m, 'users/u1')).toEqual([]);
  });

  it('binds wildcards when matching a concrete document', () => {
    const m = parseRules(read('parse/deep-nesting.rules'));
    const hits = matchDocument(m, 'orgs/o1/projects/p1/tasks/t1');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.bindings).toEqual({ database: '(default)', orgId: 'o1', projectId: 'p1', taskId: 't1' });
  });
});

describe('ops', () => {
  it('expands read and write', () => {
    const m = parseRules(v2(`match /a/{id} { allow read, write; allow update, delete: if false; }`));
    const [rw, ud] = block(m, 'a/{id}').allows;
    expect(rw!.declared).toEqual(['read', 'write']);
    expect(rw!.ops).toEqual(['get', 'list', 'create', 'update', 'delete']);
    expect(print(rw!.condition)).toBe('true');
    expect(ud!.ops).toEqual(['update', 'delete']);
  });

  it('rejects unknown operations with a location', () => {
    expect(() => parseRules(v2(`match /a/{id} { allow reed: if true; }`), 'x.rules')).toThrowError(
      /^x\.rules:4:23: unknown operation 'reed'/,
    );
  });
});

describe('OR semantics', () => {
  it('ORs several allow statements on one path', () => {
    const m = parseRules(v2(`match /a/{id} {
      allow get: if request.auth.uid == id;
      allow read: if resource.data.public == true;
      allow write: if false;
    }`));
    const b = block(m, 'a/{id}');
    expect(print(blockCondition(b, 'get'))).toBe('request.auth.uid == id || resource.data.public == true');
    expect(print(blockCondition(b, 'list'))).toBe('resource.data.public == true');
    expect(print(blockCondition(b, 'create'))).toBe('false');
  });

  it('ORs overlapping match blocks, binding each block’s own wildcard names', () => {
    const m = parseRules(v2(`
      match /users/{uid} { allow update: if request.auth.uid == uid; }
      match /users/{userId} { allow update: if request.auth.token.admin == true && userId != 'root'; }
      match /{document=**} { allow update: if request.auth.token.support == true; }
      match /posts/{id} { allow update: if true; }`));
    expect(print(effectiveCondition(m, 'update', 'users/u1'))).toBe(
      "request.auth.uid == 'u1' || request.auth.token.admin == true && 'u1' != 'root' || request.auth.token.support == true",
    );
    expect(print(effectiveCondition(m, 'delete', 'users/u1'))).toBe('false');
  });

  it('ORs the deep-nesting overlap', () => {
    const m = parseRules(read('parse/deep-nesting.rules'));
    expect(print(effectiveCondition(m, 'update', 'orgs/o1/projects/p1'))).toBe(
      "request.auth != null && request.resource.data.orgId == 'o1' || request.auth != null && request.auth.token.org_admin == 'o1'",
    );
  });
});

describe('rules_version and recursive wildcards', () => {
  const body = `match /cities/{city}/{rest=**} { allow read: if true; }`;
  const v1 = (declared: boolean) => `${declared ? "rules_version = '1';\n" : ''}service cloud.firestore {
  match /databases/{database}/documents { ${body} }
}`;

  it('v2: {x=**} matches zero or more segments', () => {
    const m = parseRules(v2(body));
    expect(m.version).toEqual({ declared: '2', effective: '2' });
    expect(matchDocument(m, 'cities/SF').map((h) => h.bindings.rest)).toEqual(['']);
    expect(matchDocument(m, 'cities/SF/landmarks/gg').map((h) => h.bindings.rest)).toEqual(['landmarks/gg']);
    expect(m.warnings).toEqual([]);
  });

  it('v1 declared: {x=**} needs at least one segment, and is flagged', () => {
    const m = parseRules(v1(true));
    expect(m.version).toEqual({ declared: '1', effective: '1' });
    expect(matchDocument(m, 'cities/SF')).toEqual([]);
    expect(matchDocument(m, 'cities/SF/landmarks/gg').map((h) => h.bindings.rest)).toEqual(['landmarks/gg']);
    expect(m.warnings.map((w) => w.code)).toEqual(['v1-recursive-wildcard']);
  });

  it('no rules_version: recorded as undeclared, v1 semantics applied, both flagged', () => {
    const m = parseRules(v1(false));
    expect(m.version).toEqual({ declared: null, effective: '1' });
    expect(matchDocument(m, 'cities/SF')).toEqual([]);
    expect(m.warnings.map((w) => w.code)).toEqual(['no-rules-version', 'v1-recursive-wildcard']);
  });

  it('rejects other versions', () => {
    expect(() => parseRules(`rules_version = '3'; service cloud.firestore { match /databases/{d}/documents { allow read; } }`)).toThrowError(/1:1: unsupported rules_version '3'/);
  });
});

describe('functions', () => {
  it('inlines functions calling functions, substituting parameters', () => {
    const m = parseRules(read('trap-01/head.rules'));
    const users = block(m, 'users/{uid}');
    expect(print(users.allows[1]!.condition)).toBe("isOwner(uid) && request.resource.data.role == 'member'");
    expect(print(users.allows[1]!.inlined)).toBe(
      "request.auth != null && request.auth.uid == uid && request.resource.data.role == 'member'",
    );
    expect(m.functions.map((f) => [f.name, f.params, f.scope])).toEqual([
      ['isSignedIn', [], '/databases/{database}/documents'],
      ['isOwner', ['uid'], '/databases/{database}/documents'],
    ]);
  });

  it('substitutes by position without capturing names, and applies let bindings in order', () => {
    const m = parseRules(v2(`
      function eq(y, x) { return y == x; }
      function check(x) { let a = x + 1; let b = a * 2; return eq(b, x); }
      match /n/{x} { allow read: if check(x) && check(3); }`));
    expect(print(block(m, 'n/{x}').allows[0]!.inlined)).toBe('(x + 1) * 2 == x && (3 + 1) * 2 == 3');
  });

  it('resolves free names in a body against the declaring block, not the caller', () => {
    const m = parseRules(v2(`
      match /a/{id} {
        function ownsA() { return request.auth.uid == id; }
        match /b/{bid} {
          function viaParam(id) { return ownsA() && id == 'x'; }
          allow read: if viaParam(bid);
        }
      }`));
    expect(print(block(m, 'a/{id}/b/{bid}').allows[0]!.inlined)).toBe("request.auth.uid == id && bid == 'x'");
  });

  it('sees functions from enclosing blocks and the top level, regardless of declaration order', () => {
    const m = parseRules(`rules_version = '2';
function top() { return true; }
service cloud.firestore {
  match /databases/{database}/documents {
    match /a/{id} {
      allow read: if later() && top();
      function later() { return id == 'x'; }
    }
  }
}`);
    expect(print(block(m, 'a/{id}').allows[0]!.inlined)).toBe("id == 'x' && true");
  });

  it("doesn't see functions from sibling blocks", () => {
    const m = parseRules(v2(`
      match /a/{id} { function onlyA() { return true; } allow read: if onlyA(); }
      match /b/{id} { allow read: if onlyA(); }`));
    expect(print(block(m, 'b/{id}').allows[0]!.inlined)).toBe('onlyA()');
    expect(m.warnings).toEqual([expect.objectContaining({ code: 'unknown-function', message: "Call to undeclared function 'onlyA'" })]);
  });

  it('leaves built-ins alone and inlines through get()/exists() arguments', () => {
    const m = parseRules(read('parse/lookups.rules'));
    expect(print(block(m, 'teams/{teamId}').allows[0]!.inlined)).toBe(
      "get(/databases/$(database)/documents/teams/$(teamId)/members/$(request.auth.uid)).data.role in ['viewer', 'editor', 'owner']",
    );
    expect(m.warnings).toEqual([]);
  });

  it('rejects recursion and wrong arity with the allow’s location', () => {
    expect(() => parseRules(v2(`
      function f(x) { return g(x); }
      function g(x) { return f(x); }
      match /a/{id} { allow read: if f(id); }`), 'r.rules')).toThrowError(/^r\.rules:7:23: recursive call: f -> g -> f$/);
    expect(() => parseRules(v2(`
      function f(x) { return x; }
      match /a/{id} { allow read: if f(id, 1); }`), 'r.rules')).toThrowError(/^r\.rules:6:23: f\(\) takes 1 argument\(s\), called with 2$/);
  });
});

describe('parse errors', () => {
  it('reports line:col and never returns a partial model', () => {
    const src = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read: if request.auth.uid == ;
    }
  }
}`;
    let err: unknown;
    let model: RuleModel | undefined;
    try {
      model = parseRules(src, 'broken.rules');
    } catch (e) {
      err = e;
    }
    expect(model).toBeUndefined();
    expect(err).toBeInstanceOf(RulesParseError);
    const e = err as RulesParseError;
    expect([e.file, e.line, e.column]).toEqual(['broken.rules', 5, 42]);
    expect(e.message).toMatch(/^broken\.rules:5:42: /);
  });

  it('reports a trailing slash in a match path', () => {
    expect(() => parseRules(v2(`match /a/ { allow read; }`), 't.rules')).toThrowError(/^t\.rules:4:9: Forward slash/);
  });

  it('reports an unterminated string', () => {
    expect(() => parseRules(v2(`match /a/{id} { allow read: if id == 'x; }`), 's.rules')).toThrowError(RulesParseError);
  });
});

describe('expressions', () => {
  it('builds trees with the grammar’s precedence', () => {
    const m = parseRules(v2(`match /a/{id} { allow read: if a || b && !c == d < e + f * -g; }`));
    expect(block(m, 'a/{id}').allows[0]!.condition).toEqual({
      kind: 'binary', op: '||',
      left: { kind: 'var', name: 'a' },
      right: {
        kind: 'binary', op: '&&',
        left: { kind: 'var', name: 'b' },
        right: {
          kind: 'binary', op: '==',
          left: { kind: 'unary', op: '!', operand: { kind: 'var', name: 'c' } },
          right: {
            kind: 'binary', op: '<',
            left: { kind: 'var', name: 'd' },
            right: {
              kind: 'binary', op: '+',
              left: { kind: 'var', name: 'e' },
              right: {
                kind: 'binary', op: '*',
                left: { kind: 'var', name: 'f' },
                right: { kind: 'unary', op: '-', operand: { kind: 'var', name: 'g' } },
              },
            },
          },
        },
      },
    });
  });

  it('parses literals, members, calls, paths, lists, maps, ranges, is, in, ternary', () => {
    const src = `x.y[0] == {'k': [1, 2.5, "s\\n", null, true]} && m[1:] is list && 'a' in z.keys() && math.abs(-1) == 1
      && (c ? get(/databases/$(database)/documents/u/$(request.auth.uid)).data.ok : false)`;
    const m = parseRules(v2(`match /a/{id} { allow read: if ${src}; }`));
    expect(print(block(m, 'a/{id}').allows[0]!.condition)).toBe(
      "x.y[0] == {'k': [1, 2.5, 's\\n', null, true]} && m[1:] is list && 'a' in z.keys() && math.abs(-1) == 1 && (c ? get(/databases/$(database)/documents/u/$(request.auth.uid)).data.ok : false)",
    );
  });

  it('prints every corpus condition back to text that parses to the same tree', () => {
    const files = ['trap-01/base.rules', 'trap-01/head.rules', ...readdirSync(new URL('parse/', corpus)).map((f) => `parse/${f}`)];
    for (const f of files) {
      const m = parseRules(read(f), f);
      for (const b of m.matches) {
        for (const a of b.allows) {
          for (const e of [a.condition, a.inlined]) {
            const again = parseRules(v2(`match /a/{id} { allow read: if ${print(e)}; }`)).matches[1]!.allows[0]!.condition;
            expect(again, `${f} ${b.path}`).toEqual(e);
          }
        }
      }
    }
  });
});

describe('fixtures', () => {
  it('parse the custom-claims fixture', () => {
    const m = parseRules(read('parse/claims.rules'));
    expect(print(block(m, 'articles/{articleId}').allows[1]!.inlined)).toBe(
      "request.auth.token.email_verified == true && request.auth.token.firebase.sign_in_provider != 'anonymous' && (request.auth.token.role == 'editor' || request.auth.token.role == 'writer')",
    );
    expect(m.warnings).toEqual([]);
  });
});
