import { CharStream, CommonTokenStream } from 'antlr4';
import FirebaseRulesLexer from '../grammar/FirebaseRulesLexer.js';
import FirebaseRulesParser from '../grammar/FirebaseRulesParser.js';
import { inline, type Scope } from './inline.js';
import {
  RulesParseError,
  type Allow,
  type BinaryOp,
  type Expr,
  type FunctionDecl,
  type Loc,
  type MatchBlock,
  type Op,
  type PathPart,
  type PathSegment,
  type RuleModel,
  type Warning,
} from './model.js';

// The vendored parser is untyped (@ts-nocheck); contexts are attached as statics on the class.
const P: any = FirebaseRulesParser;

interface Node {
  symbol?: { type: number; text: string; line: number; column: number };
  start: { line: number; column: number };
  getChildCount(): number;
  getChild(i: number): Node;
  getText(): string;
}

const OP_EXPANSION: Record<string, Op[]> = {
  read: ['get', 'list'],
  write: ['create', 'update', 'delete'],
  get: ['get'],
  list: ['list'],
  create: ['create'],
  update: ['update'],
  delete: ['delete'],
};

const DOCUMENTS_PREFIX = 3; // /databases/{database}/documents

/**
 * Parse a Firestore rules file into a rule model. Throws RulesParseError (with line:col) on any
 * syntax or structural error; never returns a partial model.
 */
export function parseRules(source: string, file = '<rules>'): RuleModel {
  return new Walker(file).ruleset(syntaxTree(stripBom(source), file));
}

/** Editors on Windows save a UTF-8 byte-order mark; Firebase accepts it, so do we. */
export const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

function syntaxTree(source: string, file: string): Node {
  const errors: RulesParseError[] = [];
  const listener = {
    syntaxError(_r: unknown, _sym: unknown, line: number, column: number, msg: string) {
      errors.push(new RulesParseError(file, line, column + 1, msg));
    },
    reportAmbiguity() {},
    reportAttemptingFullContext() {},
    reportContextSensitivity() {},
  };
  const lexer: any = new FirebaseRulesLexer(new CharStream(source));
  lexer.removeErrorListeners();
  lexer.addErrorListener(listener);
  const parser: any = new FirebaseRulesParser(new CommonTokenStream(lexer));
  parser.removeErrorListeners();
  parser.addErrorListener(listener);
  const tree: Node = parser.ruleset();
  if (errors.length) throw errors[0];
  return tree;
}

function children(n: Node): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < n.getChildCount(); i++) out.push(n.getChild(i));
  return out;
}

const rules = (n: Node) => children(n).filter((c) => !c.symbol);
const is = (n: Node, ctx: string) => n instanceof P[ctx];
const loc = (n: Node): Loc => (n.symbol ? { line: n.symbol.line, column: n.symbol.column + 1 } : { line: n.start.line, column: n.start.column + 1 });

class Walker {
  private warnings: Warning[] = [];
  private functions: FunctionDecl[] = [];
  private matches: MatchBlock[] = [];
  private declared: '1' | '2' | null = null;
  private service = '';

  constructor(private readonly file: string) {}

  private fail(n: Node, reason: string): never {
    const l = loc(n);
    throw new RulesParseError(this.file, l.line, l.column, reason);
  }

  ruleset(tree: Node): RuleModel {
    const top: Scope = { path: '', functions: new Map(), parent: null };
    const pending: Array<() => void> = [];

    for (const c of rules(tree)) {
      if (is(c, 'VersionStatementContext')) {
        const v = unquote(c.getChild(2).getText());
        if (v !== '1' && v !== '2') this.fail(c, `unsupported rules_version '${v}'`);
        this.declared = v;
      } else if (is(c, 'ImportStatementContext')) {
        this.fail(c, 'import statements are not supported');
      } else if (is(c, 'RulesetStatementContext')) {
        const s = rules(c)[0]!;
        if (is(s, 'FunctionDeclarationContext')) this.declareFunction(s, top);
        else pending.push(() => this.serviceDecl(s, top));
      }
    }
    // Top-level functions are visible in every service, wherever they appear in the file.
    for (const p of pending) p();

    const effective = this.declared ?? '1';
    if (this.declared === null) {
      this.warnings.unshift({
        code: 'no-rules-version',
        message: "No rules_version statement; Firestore applies version 1 semantics. Add rules_version = '2'; if that's not what you meant.",
      });
    }
    if (effective === '1') {
      for (const m of this.matches) {
        if (m.segments.some((s) => s.kind === 'recursive')) {
          this.warnings.push({
            code: 'v1-recursive-wildcard',
            message: `${m.path}: under rules_version 1, {x=**} matches one or more segments (not zero), binds a string, and doesn't apply to collection-group queries.`,
            loc: m.loc,
          });
        }
      }
    }

    return {
      file: this.file,
      version: { declared: this.declared, effective },
      service: this.service,
      functions: this.functions,
      matches: this.matches,
      warnings: this.warnings,
    };
  }

  private serviceDecl(n: Node, parent: Scope): void {
    const name = rules(n).find((c) => is(c, 'ServiceIdContext'))!.getText();
    if (name !== 'cloud.firestore') {
      this.warnings.push({ code: 'other-service', message: `Skipped service ${name}`, loc: loc(n) });
      return;
    }
    this.service = name;
    const scope: Scope = { path: '', functions: new Map(), parent };
    const stmts = rules(n).filter((c) => is(c, 'ServiceStatementContext')).map((c) => rules(c)[0]!);
    for (const s of stmts) if (is(s, 'FunctionDeclarationContext')) this.declareFunction(s, scope);
    for (const s of stmts) if (is(s, 'MatchRuleDeclarationContext')) this.matchDecl(s, [], scope);
  }

  private declareFunction(n: Node, scope: Scope): void {
    const [idCtx, sigCtx, bodyCtx] = rules(n);
    const name = idCtx!.getText();
    if (scope.functions.has(name)) this.fail(n, `function ${name} is already declared in this scope`);
    const paramList = rules(sigCtx!).find((c) => is(c, 'ParamListContext'));
    const params = paramList ? rules(paramList).map((p) => p.getText()) : [];
    const lets: FunctionDecl['lets'] = [];
    let returns: Expr | undefined;
    for (const s of rules(bodyCtx!)) {
      if (is(s, 'BindingDeclarationContext')) {
        const [v, e] = rules(s);
        lets.push({ name: v!.getText(), value: this.expr(e!) });
      } else if (is(s, 'ReturnStatementContext')) {
        returns = this.expr(rules(s)[0]!);
      }
    }
    if (!returns) this.fail(n, `function ${name} has no return statement`);
    const decl: FunctionDecl = { name, params, lets, returns, scope: scope.path, loc: loc(n) };
    scope.functions.set(name, decl);
    this.functions.push(decl);
  }

  private matchDecl(n: Node, outer: PathSegment[], parent: Scope): void {
    const pathCtx = rules(n).find((c) => is(c, 'PathDeclContext'))!;
    const segments = [...outer, ...this.pathDecl(pathCtx)];
    const path = formatPath(segments);
    const scope: Scope = { path, functions: new Map(), parent };
    const stmts = rules(n).filter((c) => is(c, 'MatchStatementContext')).map((c) => rules(c)[0]!);

    // Functions first: they're visible to every allow in the block regardless of order.
    for (const s of stmts) if (is(s, 'FunctionDeclarationContext')) this.declareFunction(s, scope);

    const block: MatchBlock = { path, segments, documentPath: documentPath(segments), allows: [], loc: loc(n) };
    if (block.documentPath === null) {
      this.warnings.push({
        code: 'outside-documents',
        message: `${path} is not under /databases/{database}/documents, so it never matches a document`,
        loc: block.loc,
      });
    }
    this.matches.push(block);
    for (const s of stmts) {
      if (is(s, 'PermissionDeclarationContext')) block.allows.push(this.allow(s, scope));
      else if (is(s, 'MatchRuleDeclarationContext')) this.matchDecl(s, segments, scope);
    }
  }

  private pathDecl(n: Node): PathSegment[] {
    return rules(n).map((seg): PathSegment => {
      if (is(seg, 'SimpleSegmemntContext')) return { kind: 'literal', value: seg.getText().replace(/^\//, '') };
      if (is(seg, 'CaptureSegmentContext')) {
        const cap = rules(seg)[0]!;
        return { kind: 'wildcard', name: rules(cap)[0]!.getText() };
      }
      if (is(seg, 'GlobSegmentContext')) {
        const glob = rules(seg)[0]!;
        return { kind: 'recursive', name: rules(glob)[0]!.getText() };
      }
      return this.fail(seg, 'empty path segment');
    });
  }

  private allow(n: Node, scope: Scope): Allow {
    const [opsCtx, bodyCtx] = rules(n);
    const declared = rules(opsCtx!).map((c) => c.getText());
    const ops = new Set<Op>();
    for (const d of declared) {
      const expanded = OP_EXPANSION[d];
      if (!expanded) this.fail(opsCtx!, `unknown operation '${d}' (expected read, write, get, list, create, update, delete)`);
      for (const op of expanded) ops.add(op);
    }
    const condCtx = bodyCtx ? rules(bodyCtx)[0]! : null;
    const condition: Expr = condCtx ? this.expr(condCtx) : { kind: 'literal', type: 'bool', value: true };
    const where = loc(n);
    const inlined = inline(condition, scope, {
      error: (reason) => {
        throw new RulesParseError(this.file, where.line, where.column, reason);
      },
      unknownFunction: (name) => {
        if (!this.warnings.some((w) => w.code === 'unknown-function' && w.message.includes(`'${name}'`))) {
          this.warnings.push({ code: 'unknown-function', message: `Call to undeclared function '${name}'`, loc: where });
        }
      },
    });
    return { declared, ops: [...ops], condition, inlined, loc: where, conditionLoc: condCtx ? loc(condCtx) : null };
  }

  private expr(n: Node): Expr {
    if (is(n, 'PrimaryExpressionContext')) return this.simple(rules(n)[0]!);
    if (is(n, 'UnaryAdditiveExpressionContext')) {
      if (n.getChild(0).getText() !== '-') this.fail(n, 'increment/decrement operators are not supported');
      return { kind: 'unary', op: '-', operand: this.simple(rules(n)[0]!) };
    }
    if (is(n, 'UnsupportedAdditivePrefixContext') || is(n, 'UnsupportedAdditivePostfixContext')) {
      this.fail(n, 'increment/decrement operators are not supported');
    }
    if (is(n, 'NotExpressionContext')) return { kind: 'unary', op: '!', operand: this.expr(rules(n)[0]!) };
    if (is(n, 'ExprIsTypeIdExpressionContext')) {
      const [e, t] = rules(n);
      return { kind: 'is', operand: this.expr(e!), type: t!.getText() };
    }
    if (is(n, 'TernaryExpressionContext')) {
      const [test, a, b] = rules(n);
      return { kind: 'ternary', test: this.expr(test!), then: this.expr(a!), else: this.expr(b!) };
    }
    const kids = children(n);
    if (kids.length === 3 && !kids[0]!.symbol && kids[1]!.symbol && !kids[2]!.symbol) {
      return { kind: 'binary', op: kids[1]!.getText() as BinaryOp, left: this.expr(kids[0]!), right: this.expr(kids[2]!) };
    }
    return this.fail(n, `unsupported expression '${n.getText()}'`);
  }

  private simple(n: Node): Expr {
    if (is(n, 'LiteralExpressionContext')) return this.literal(rules(n)[0]!);
    if (is(n, 'VariableSimpleExpressionContext')) return { kind: 'var', name: n.getText() };
    if (is(n, 'ParenSimpleExpressionContext')) return this.expr(rules(n)[0]!);
    if (is(n, 'MemberLookupSimpleExpressionContext')) {
      const [obj, key] = rules(n);
      return { kind: 'member', object: this.simple(obj!), property: key!.getText() };
    }
    if (is(n, 'MemberFunctionCallSimpleExpressionContext')) {
      const [obj, member, args] = rules(n);
      return { kind: 'method', object: this.simple(obj!), method: member!.getText(), args: this.exprList(args) };
    }
    if (is(n, 'IdMemberFunctionCallSimpleExpressionContext')) {
      const [id, member, args] = rules(n);
      return { kind: 'method', object: { kind: 'var', name: id!.getText() }, method: member!.getText(), args: this.exprList(args) };
    }
    if (is(n, 'FunctionCallSimpleExpressionContext')) {
      const [id, args] = rules(n);
      return { kind: 'call', callee: id!.getText(), args: this.exprList(args) };
    }
    if (is(n, 'ListLookupSimpleExpressionContext')) {
      const [obj, idx] = rules(n);
      const object = this.simple(obj!);
      if (is(idx!, 'IndexLookupContext')) return { kind: 'index', object, index: this.expr(rules(idx!)[0]!) };
      // Range: [a:b], [a:], [:b]
      let start: Expr | null = null;
      let end: Expr | null = null;
      let seenColon = false;
      for (const c of children(idx!)) {
        if (c.symbol) seenColon = true;
        else if (seenColon) end = this.expr(c);
        else start = this.expr(c);
      }
      return { kind: 'range', object, start, end };
    }
    if (is(n, 'ListSimpleExpressionContext')) return { kind: 'list', items: this.exprList(rules(n)[0]) };
    if (is(n, 'MapSimpleExpressionContext')) {
      const entriesCtx = rules(rules(n)[0]!)[0];
      const entries = entriesCtx
        ? rules(entriesCtx).map((e) => {
            const [k, v] = rules(e);
            return { key: this.expr(k!), value: this.expr(v!) };
          })
        : [];
      return { kind: 'map', entries };
    }
    if (is(n, 'PathSimpleExpressionContext')) return this.pathExpr(rules(n)[0]!);
    return this.fail(n, `unsupported expression '${n.getText()}'`);
  }

  private exprList(n: Node | undefined): Expr[] {
    return n ? rules(n).map((e) => this.expr(e)) : [];
  }

  private pathExpr(n: Node): Expr {
    const parts: PathPart[] = [];
    for (const seg of rules(n)) {
      const inner = rules(seg)[0]!;
      if (is(inner, 'SimpleSegmemntContext')) parts.push({ kind: 'text', value: inner.getText().replace(/^\//, '') });
      else if (is(inner, 'ExpressionContext')) parts.push({ kind: 'interp', expr: this.expr(inner) });
      else this.fail(inner, `unsupported path segment '${inner.getText()}'`);
    }
    return { kind: 'path', parts };
  }

  private literal(n: Node): Expr {
    const tok = n.getChild(0).symbol!;
    const text = tok.text;
    switch (tok.type) {
      case P.NUM_INT:
        return { kind: 'literal', type: 'int', value: Number(text) };
      case P.NUM_FLOAT:
        return { kind: 'literal', type: 'float', value: Number(text) };
      case P.STRING:
        return { kind: 'literal', type: 'string', value: unquote(text) };
      case P.BYTES:
        return { kind: 'literal', type: 'bytes', value: text };
      case P.TRUE:
        return { kind: 'literal', type: 'bool', value: true };
      case P.FALSE:
        return { kind: 'literal', type: 'bool', value: false };
      case P.NULL:
        return { kind: 'literal', type: 'null', value: null };
      default:
        return this.fail(n, `unterminated string ${text}`);
    }
  }
}

function unquote(s: string): string {
  const body = s.slice(1, -1);
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, e: string) => {
    if (e[0] === 'u' || e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '0': '\0' } as Record<string, string>)[e] ?? e;
  });
}

export function formatPath(segments: PathSegment[]): string {
  return segments
    .map((s) => (s.kind === 'literal' ? `/${s.value}` : s.kind === 'wildcard' ? `/{${s.name}}` : `/{${s.name}=**}`))
    .join('');
}

function documentPath(segments: PathSegment[]): string | null {
  const [db, name, docs] = segments;
  const isPrefix =
    db?.kind === 'literal' && db.value === 'databases' &&
    (name?.kind === 'wildcard' || (name?.kind === 'literal' && name.value === '(default)')) &&
    docs?.kind === 'literal' && docs.value === 'documents';
  return isPrefix ? formatPath(segments.slice(DOCUMENTS_PREFIX)).replace(/^\//, '') : null;
}
