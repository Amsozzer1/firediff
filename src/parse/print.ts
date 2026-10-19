import type { Expr } from './model.js';

const PRECEDENCE: Record<string, number> = {
  '||': 2,
  '&&': 3,
  '==': 4, '!=': 4,
  '<': 5, '<=': 5, '>': 5, '>=': 5, in: 5, is: 5,
  '+': 6, '-': 6,
  '*': 7, '/': 7, '%': 7,
};
const TERNARY = 1;
const UNARY = 8;
const ATOM = 9;

function prec(e: Expr): number {
  if (e.kind === 'ternary') return TERNARY;
  if (e.kind === 'binary') return PRECEDENCE[e.op]!;
  if (e.kind === 'is') return PRECEDENCE.is!;
  if (e.kind === 'unary') return UNARY;
  return ATOM;
}

function wrap(e: Expr, min: number): string {
  const s = print(e);
  return prec(e) < min ? `(${s})` : s;
}

/** Render an expression back to rules syntax (parenthesized only where needed). */
export function print(e: Expr): string {
  switch (e.kind) {
    case 'literal':
      if (e.type === 'string') return `'${String(e.value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
      if (e.type === 'null') return 'null';
      return String(e.value);
    case 'var':
      return e.name;
    case 'member':
      return `${wrap(e.object, ATOM)}.${e.property}`;
    case 'index':
      return `${wrap(e.object, ATOM)}[${print(e.index)}]`;
    case 'range':
      return `${wrap(e.object, ATOM)}[${e.start ? print(e.start) : ''}:${e.end ? print(e.end) : ''}]`;
    case 'call':
      return `${e.callee}(${e.args.map(print).join(', ')})`;
    case 'method':
      return `${wrap(e.object, ATOM)}.${e.method}(${e.args.map(print).join(', ')})`;
    case 'unary':
      return `${e.op}${wrap(e.operand, UNARY)}`;
    case 'binary': {
      const p = PRECEDENCE[e.op]!;
      // Left-associative: the right operand needs parens at equal precedence.
      return `${wrap(e.left, p)} ${e.op} ${wrap(e.right, p + 1)}`;
    }
    case 'is':
      return `${wrap(e.operand, PRECEDENCE.is! + 1)} is ${e.type}`;
    case 'ternary':
      return `${wrap(e.test, TERNARY + 1)} ? ${print(e.then)} : ${print(e.else)}`;
    case 'list':
      return `[${e.items.map(print).join(', ')}]`;
    case 'map':
      return `{${e.entries.map((x) => `${print(x.key)}: ${print(x.value)}`).join(', ')}}`;
    case 'path':
      return e.parts.map((p) => (p.kind === 'text' ? `/${p.value}` : `/$(${print(p.expr)})`)).join('');
  }
}
