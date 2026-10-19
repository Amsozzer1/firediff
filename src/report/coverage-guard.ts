import { stringify } from 'yaml';
import { branches, needsFor, type Sym } from '../generate/synth.js';
import { isAuthUid } from '../generate/extract.js';
import type { PathPart } from '../parse/index.js';
import type { PairResult } from '../run/pipeline.js';

export interface LowCoverage {
  reached: number;
  total: number;
  /** A firediff.yml starting point built from what the unreached rules check. */
  hint: { why: string; yaml: string } | null;
}

const UID = 'u_tester';

/** Warn when fewer than half of head's allow conditions were true for any request. */
export function lowCoverage(r: PairResult): LowCoverage | null {
  const c = r.coverage;
  if (!c || c.total === 0 || c.reached * 2 >= c.total) return null;
  return { reached: c.reached, total: c.total, hint: hint(r, c.unreachedLines) };
}

function hint(r: PairResult, lines: number[]): LowCoverage['hint'] {
  const claims: Record<string, unknown> = {};
  const docs = new Map<string, Record<string, unknown>>();
  const value = (s: Sym): unknown =>
    'lit' in s ? s.lit : 'uid' in s ? UID : 'listOf' in s ? [value(s.listOf)] : 'time' in s ? '<timestamp>' : `<${'wildcard' in s ? s.wildcard : s.field}>`;
  for (const block of r.head.matches) {
    const wildcards = new Set(block.segments.flatMap((s) => (s.kind === 'literal' ? [] : [s.name])));
    for (const allow of block.allows) {
      if (!lines.includes(allow.loc.line)) continue;
      const needs = branches(allow.inlined).map((b) => needsFor(b, wildcards)).find((n) => n && (n.token.size || n.lookups.length));
      if (!needs) continue;
      for (const [k, s] of needs.token) {
        let cur = claims;
        const keys = k.split('.');
        keys.forEach((key, i) => {
          if (i === keys.length - 1) cur[key] ??= value(s);
          else cur = (cur[key] ??= {}) as Record<string, unknown>;
        });
      }
      for (const l of needs.lookups) {
        const path = pathOf(l.parts, block.segments[1]?.kind === 'wildcard' ? block.segments[1].name : null);
        if (!path || !path.includes(UID)) continue;
        const data = docs.get(path) ?? {};
        for (const f of l.fields) {
          let cur = data;
          f.path.forEach((key, i) => {
            if (i === f.path.length - 1) cur[key] ??= value(f.value);
            else cur = (cur[key] ??= {}) as Record<string, unknown>;
          });
        }
        docs.set(path, data);
      }
    }
  }
  if (!Object.keys(claims).length && !docs.size) return null;
  const shown = lines.slice(0, 5).map((l) => `L${l}`).join(', ');
  const more = lines.length > 5 ? ` and ${lines.length - 5} more` : '';
  const config: Record<string, unknown> = {
    principals: [{ name: 'tester', uid: UID, ...(Object.keys(claims).length ? { claims } : {}) }],
    ...(docs.size ? { docs: [...docs].map(([path, data]) => ({ path, data })) } : {}),
  };
  return {
    why: `Rules at ${shown}${more} never allowed any request. A principal with what they check, in firediff.yml (fill in the <placeholders>):`,
    yaml: stringify(config).trimEnd(),
  };
}

function pathOf(parts: PathPart[], db: string | null): string | null {
  const segs: string[] = [];
  for (const p of parts) {
    if (p.kind === 'text') segs.push(p.value);
    else if (isAuthUid(p.expr)) segs.push(UID);
    else if (p.expr.kind === 'var' && p.expr.name === db) segs.push('(default)');
    else if (p.expr.kind === 'var') segs.push(`<${p.expr.name}>`);
    else return null;
  }
  return segs[0] === 'databases' && segs[2] === 'documents' ? segs.slice(3).join('/') : null;
}
