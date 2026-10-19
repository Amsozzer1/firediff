import { describe, expect, it } from 'vitest';
import { sampleFor } from '../src/generate/regex.js';
import { branches, needsFor } from '../src/generate/synth.js';
import { parseRules, print, type Expr } from '../src/parse/index.js';

const cond = (c: string, body = `match /posts/{postId} { allow update: if ${c}; }`): Expr =>
  parseRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    ${body}
  }
}`).matches[1]!.allows[0]!.inlined;

const W = new Set(['postId', 'database']);

describe('branches', () => {
  it('splits ORs into branches of ANDed atoms, pushing negation through', () => {
    const b = branches(cond('a && (b || c) && !(d || e)'));
    expect(b.map((br) => br.map((x) => `${x.neg ? '!' : ''}${print(x.e)}`).join(' & '))).toEqual(['a & b & !d & !e', 'a & c & !d & !e']);
  });
  it('caps the number of branches', () => {
    expect(branches(cond('(a || b) && (c || d) && (e || f) && (g || h)')).length).toBe(8);
  });
});

describe('needsFor', () => {
  it('collects claims, ownership and lookup docs needed together', () => {
    const [b] = branches(cond(`request.auth.token.email_verified == true
      && request.auth.token.email.matches('.*@ubc[.]ca')
      && resource.data.author == request.auth.uid
      && get(/databases/$(database)/documents/userProperties/$(request.auth.uid)).data.enabled == true
      && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.readOnly.writeRate <= 1`));
    const n = needsFor(b!, W)!;
    expect(n.ownsTarget).toBe(true);
    expect(Object.fromEntries(n.token)).toEqual({ email_verified: { lit: true }, email: { lit: 'a@ubc.ca' } });
    expect(n.lookups.map((l) => [print({ kind: 'path', parts: l.parts }), l.fields])).toEqual([
      ['/databases/$(database)/documents/userProperties/$(request.auth.uid)', [{ path: ['enabled'], value: { lit: true } }]],
      ['/databases/$(database)/documents/users/$(request.auth.uid)', [{ path: ['readOnly', 'writeRate'], value: { lit: 1 } }]],
    ]);
  });

  it('handles map indexes, bare boolean lookups, membership, numeric bounds and request.time', () => {
    const [b] = branches(cond(`get(/databases/$(database)/documents/users/$(request.auth.uid)).data.roles['editor'] == true
      && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.admin
      && request.auth.uid in get(/databases/$(database)/documents/teams/$(postId)).data.members
      && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.credits > 0
      && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.lastWrite < request.time`));
    const n = needsFor(b!, W)!;
    const fields = Object.fromEntries(n.lookups.map((l) => [print({ kind: 'path', parts: l.parts }).split('/').at(-2), l.fields.map((f) => [f.path.join('.'), f.value])]));
    expect(fields).toEqual({
      users: [['roles.editor', { lit: true }], ['admin', { lit: true }], ['credits', { lit: 1 }], ['lastWrite', { time: 'past' }]],
      teams: [['members', { listOf: { uid: true } }]],
    });
  });

  it('returns null for branches that need a signed-out caller, and ignores negated atoms', () => {
    expect(needsFor(branches(cond('request.auth == null'))[0]!, W)).toBeNull();
    const n = needsFor(branches(cond('request.auth != null && !request.auth.token.banned && request.auth.token.tier in ["gold", "silver"]'))[0]!, W)!;
    expect(Object.fromEntries(n.token)).toEqual({ tier: { lit: 'gold' } });
  });

  it('records a uid literal and lookups keyed on document data', () => {
    const n = needsFor(branches(cond(`request.auth.uid == 'abc123' || get(/databases/$(database)/documents/orgs/$(resource.data.org)/members/$(request.auth.uid)).data.role == 'admin'`))[1]!, W)!;
    expect(n.lookups[0]!.parts.some((p) => p.kind === 'interp' && print(p.expr) === 'resource.data.org')).toBe(true);
    expect(needsFor(branches(cond(`request.auth.uid == 'abc123'`))[0]!, W)!.uidLiteral).toBe('abc123');
  });
});

describe('sampleFor', () => {
  it('builds a string that fully matches the pattern', () => {
    for (const p of ['.*@ubc[.]ca$', '.*@(student\\.)?ubc\\.ca', '^[a-z0-9._%+-]+@example\\.com$', '[A-Za-z]{3,16}', '^(admin|editor)$', '[^@]+@[^@]+']) {
      const s = sampleFor(p);
      expect(s, p).not.toBeNull();
      expect(new RegExp(`^(?:${p.replace(/^\^/, '').replace(/\$$/, '')})$`).test(s!), p).toBe(true);
    }
  });
  it('returns null for unsupported syntax', () => expect(sampleFor('x(?=y)')).toBeNull());
});
