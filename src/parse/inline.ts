import type { Expr, FunctionDecl } from './model.js';

/** Functions visible from a match block: its own, then each enclosing block's, then top level. */
export interface Scope {
  path: string;
  functions: Map<string, FunctionDecl>;
  parent: Scope | null;
}

/** Built-in free functions; calls to these are left as-is. */
export const BUILTIN_FUNCTIONS = new Set(['get', 'exists', 'getAfter', 'existsAfter', 'debug', 'int', 'float', 'string', 'path', 'bool', 'bytes']);

// Firestore rejects call chains deeper than 20.
const MAX_DEPTH = 20;

export interface InlineHooks {
  error(reason: string): never;
  unknownFunction(name: string): void;
}

function lookup(scope: Scope | null, name: string): { fn: FunctionDecl; scope: Scope } | undefined {
  for (let s = scope; s; s = s.parent) {
    const fn = s.functions.get(name);
    if (fn) return { fn, scope: s };
  }
  return undefined;
}

/**
 * Replace every user function call with the function's body, parameters and let bindings
 * substituted by the (already inlined) caller-side expressions. Function bodies resolve
 * other functions from the scope they were declared in, not the caller's.
 */
export function inline(expr: Expr, scope: Scope, hooks: InlineHooks): Expr {
  return walk(expr, scope, new Map(), [], hooks);
}

function walk(e: Expr, scope: Scope, env: Map<string, Expr>, stack: string[], hooks: InlineHooks): Expr {
  const w = (x: Expr) => walk(x, scope, env, stack, hooks);
  switch (e.kind) {
    case 'literal':
      return e;
    case 'var':
      return env.get(e.name) ?? e;
    case 'member':
      return { ...e, object: w(e.object) };
    case 'index':
      return { ...e, object: w(e.object), index: w(e.index) };
    case 'range':
      return { ...e, object: w(e.object), start: e.start && w(e.start), end: e.end && w(e.end) };
    case 'method':
      return { ...e, object: w(e.object), args: e.args.map(w) };
    case 'unary':
      return { ...e, operand: w(e.operand) };
    case 'binary':
      return { ...e, left: w(e.left), right: w(e.right) };
    case 'is':
      return { ...e, operand: w(e.operand) };
    case 'ternary':
      return { ...e, test: w(e.test), then: w(e.then), else: w(e.else) };
    case 'list':
      return { ...e, items: e.items.map(w) };
    case 'map':
      return { ...e, entries: e.entries.map((x) => ({ key: w(x.key), value: w(x.value) })) };
    case 'path':
      return { ...e, parts: e.parts.map((p) => (p.kind === 'interp' ? { ...p, expr: w(p.expr) } : p)) };
    case 'call': {
      const args = e.args.map(w);
      // A parameter or let can't hold a function, so only declared functions are inlined.
      const found = lookup(scope, e.callee);
      if (!found) {
        if (!BUILTIN_FUNCTIONS.has(e.callee)) hooks.unknownFunction(e.callee);
        return { ...e, args };
      }
      const { fn, scope: fnScope } = found;
      if (stack.includes(fn.name)) hooks.error(`recursive call: ${[...stack, fn.name].join(' -> ')}`);
      if (stack.length >= MAX_DEPTH) hooks.error(`function calls nested deeper than ${MAX_DEPTH}: ${stack.join(' -> ')}`);
      if (args.length !== fn.params.length) {
        hooks.error(`${fn.name}() takes ${fn.params.length} argument(s), called with ${args.length}`);
      }
      // The body sees only its own params and lets; free names refer to the declaring block's wildcards.
      const inner = new Map<string, Expr>(fn.params.map((p, i) => [p, args[i]!]));
      const innerStack = [...stack, fn.name];
      for (const b of fn.lets) inner.set(b.name, walk(b.value, fnScope, inner, innerStack, hooks));
      return walk(fn.returns, fnScope, inner, innerStack, hooks);
    }
  }
}
