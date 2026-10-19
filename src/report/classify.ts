import type { Group } from '../diff/group.js';
import { dataField, isAuthUid, LOOKUP_FNS } from '../generate/extract.js';
import { matchDocument, type Expr, type RuleModel } from '../parse/index.js';
import { groupTarget, requestTarget, type Row, type Seed } from '../run/types.js';

const ENTRY = /([^,]*?) for '(\w+)' @ L(\d+)/g;

function* walk(e: Expr): Generator<Expr> {
  yield e;
  const kids: Expr[] =
    e.kind === 'member' ? [e.object] :
    e.kind === 'index' ? [e.object, e.index] :
    e.kind === 'range' ? [e.object, ...(e.start ? [e.start] : []), ...(e.end ? [e.end] : [])] :
    e.kind === 'call' ? e.args :
    e.kind === 'method' ? [e.object, ...e.args] :
    e.kind === 'unary' || e.kind === 'is' ? [e.operand] :
    e.kind === 'binary' ? [e.left, e.right] :
    e.kind === 'ternary' ? [e.test, e.then, e.else] :
    e.kind === 'list' ? e.items :
    e.kind === 'map' ? e.entries.flatMap((x) => [x.key, x.value]) :
    e.kind === 'path' ? e.parts.flatMap((p) => (p.kind === 'interp' ? [p.expr] : [])) : [];
  for (const k of kids) yield* walk(k);
}

const isAppCheck = (e: Expr) =>
  e.kind === 'member' && (e.property === 'app' || e.property === 'appcheck') && e.object.kind === 'var' && e.object.name === 'request';

/**
 * For a lost row: does the head rule that denied it need something firediff can't provide for this
 * caller? An App Check token, or a lookup doc (get/exists) that was never seeded for them. Returns a
 * plain description of the missing piece, or null when the loss looks real.
 */
export function missingPiece(row: Row, head: RuleModel, seeds: Seed[]): string | null {
  if (row.head.result !== 'deny') return null;
  const req = row.case.request;
  const target = requestTarget(req);
  const lines = new Set([...(row.head.reason ?? '').matchAll(ENTRY)].filter((m) => m[2] === req.op).map((m) => Number(m[3])));
  if (!lines.size) return null;
  const seeded = new Set(seeds.map((s) => s.path));
  const seedOf = (p: string) => seeds.find((s) => s.path === p)?.data ?? {};
  const uid = row.case.principal.auth?.uid;
  const docPath = req.op === 'list' ? `${target}/__firediff_doc__` : groupTarget(req);

  for (const { block, bindings } of matchDocument(head, docPath)) {
    const db = block.segments[1]?.kind === 'wildcard' ? block.segments[1].name : null;
    for (const allow of block.allows) {
      if (!lines.has(allow.loc.line) || !allow.ops.includes(req.op)) continue;
      for (const e of walk(allow.inlined)) {
        if (isAppCheck(e)) return 'an App Check token (firediff requests never carry one)';
        if (e.kind !== 'call' || !LOOKUP_FNS.has(e.callee) || e.callee.endsWith('After') || e.args[0]?.kind !== 'path') continue;
        const segs: string[] = [];
        const shown: string[] = [];
        let ok = true;
        for (const p of e.args[0].parts) {
          if (p.kind === 'text') {
            segs.push(p.value);
            shown.push(p.value);
          } else if (isAuthUid(p.expr)) {
            if (!uid) ok = false;
            segs.push(uid ?? '');
            shown.push('{uid}');
          } else if (p.expr.kind === 'var' && p.expr.name === db) {
            segs.push('(default)');
            shown.push('(default)');
          } else if (p.expr.kind === 'var' && bindings[p.expr.name] !== undefined) {
            segs.push(bindings[p.expr.name]!);
            shown.push(`{${p.expr.name}}`);
          } else {
            const f = dataField(p.expr);
            const v = f !== null ? seedOf(target)[f] : undefined;
            if (typeof v !== 'string') ok = false;
            segs.push(String(v));
            shown.push(`$(${f ?? '…'})`);
          }
        }
        if (!ok || segs[0] !== 'databases' || segs[2] !== 'documents') continue;
        const path = segs.slice(3).join('/');
        if (path !== target && !seeded.has(path)) return `a doc at ${shown.slice(3).join('/')} for this user (firediff didn't seed one)`;
      }
    }
  }
  return null;
}

/**
 * A create/update group where every flip is only about the payload: the same caller already had
 * (or still has) that op on that doc with another payload firediff sent, and none of the flipped
 * payloads touch a field the rules guard. Access didn't change; the data the rules accept did.
 * (An owner who can now change their own `role` is an access change and stays in gained.)
 */
export function isDataShapeOnly(g: Group, rows: Row[], guarded: (path: string) => Set<string>): boolean {
  if (!g.ops.every((o) => o === 'create' || o === 'update')) return false;
  return g.rows.every((flip) => {
    const { principal, request } = flip.case;
    const fields = request.op === 'create' || request.op === 'update' ? request.fields ?? [] : [];
    const protectedHere = guarded(groupTarget(request));
    if (fields.some((f) => protectedHere.has(f))) return false;
    return rows.some((other) => {
      if (other === flip || other.case.principal.name !== principal.name || other.case.request.op !== request.op) return false;
      if (groupTarget(other.case.request) !== groupTarget(request)) return false;
      return g.direction === 'gained' ? other.base.result === 'allow' : other.head.result === 'allow';
    });
  });
}
