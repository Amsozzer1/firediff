import { print, type Allow, type Expr, type MatchBlock, type RuleModel } from '../parse/index.js';

export interface AllowRef {
  block: MatchBlock;
  allow: Allow;
}

function calls(e: Expr, out: Set<string>): void {
  if (e.kind === 'call') out.add(e.callee);
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
  for (const k of kids) calls(k, out);
}

/**
 * Line ranges per allow: its own statement lines plus every function it calls (transitively).
 * A statement runs from its first line to the line before the next match/allow/function.
 */
export function allowRanges(model: RuleModel): Array<{ ref: AllowRef; ranges: Array<[number, number]> }> {
  const starts = [
    ...model.matches.map((m) => m.loc.line),
    ...model.matches.flatMap((m) => m.allows.map((a) => a.loc.line)),
    ...model.functions.map((f) => f.loc.line),
  ].sort((a, b) => a - b);
  const span = (s: number): [number, number] => [s, (starts.find((x) => x > s) ?? Infinity) - 1];
  return model.matches.flatMap((block) =>
    block.allows.map((allow) => {
      const ranges: Array<[number, number]> = [span(allow.loc.line)];
      const seen = new Set<string>();
      const todo = new Set<string>();
      calls(allow.condition, todo);
      while (todo.size) {
        const name = todo.values().next().value!;
        todo.delete(name);
        if (seen.has(name)) continue;
        seen.add(name);
        for (const f of model.functions.filter((x) => x.name === name)) {
          ranges.push(span(f.loc.line));
          const more = new Set<string>();
          calls(f.returns, more);
          for (const l of f.lets) calls(l.value, more);
          for (const m of more) if (!seen.has(m)) todo.add(m);
        }
      }
      return { ref: { block, allow }, ranges };
    }),
  );
}

/** Allows whose own statement or called functions cover `line`, own-statement matches first. */
export function allowsAt(ranges: ReturnType<typeof allowRanges>, line: number): AllowRef[] {
  const own = ranges.filter((r) => line >= r.ranges[0]![0] && line <= r.ranges[0]![1]).map((r) => r.ref);
  if (own.length) return own;
  return ranges.filter((r) => r.ranges.slice(1).some(([a, b]) => line >= a && line <= b)).map((r) => r.ref);
}

/** Identity of an allow across versions: its document path, ops and inlined condition. */
export const allowKey = (block: MatchBlock, allow: Allow) => `${block.documentPath ?? block.path} ${allow.ops.join(',')}: ${print(allow.inlined)}`;

/** Head allows whose text (after inlining) has no identical counterpart in base. */
export function changedAllows(base: RuleModel, head: RuleModel): Set<Allow> {
  const baseKeys = new Set(base.matches.flatMap((b) => b.allows.map((a) => allowKey(b, a))));
  return new Set(head.matches.flatMap((b) => b.allows.filter((a) => !baseKeys.has(allowKey(b, a)))));
}
