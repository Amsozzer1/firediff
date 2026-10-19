export type Op = 'get' | 'list' | 'create' | 'update' | 'delete';
export const OPS: readonly Op[] = ['get', 'list', 'create', 'update', 'delete'];

/** 1-based line and column. */
export interface Loc {
  line: number;
  column: number;
}

export type PathSegment =
  | { kind: 'literal'; value: string }
  /** {name} — exactly one segment */
  | { kind: 'wildcard'; name: string }
  /** {name=**} — see RuleModel.version for how many segments it matches */
  | { kind: 'recursive'; name: string };

export type PathPart = { kind: 'text'; value: string } | { kind: 'interp'; expr: Expr };

export type BinaryOp =
  | '||' | '&&'
  | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in'
  | '+' | '-' | '*' | '/' | '%';

export type Expr =
  | { kind: 'literal'; type: 'string' | 'int' | 'float' | 'bool' | 'null' | 'bytes'; value: string | number | boolean | null }
  | { kind: 'var'; name: string }
  | { kind: 'member'; object: Expr; property: string }
  | { kind: 'index'; object: Expr; index: Expr }
  | { kind: 'range'; object: Expr; start: Expr | null; end: Expr | null }
  /** Free function: get(), exists(), a user function before inlining, ... */
  | { kind: 'call'; callee: string; args: Expr[] }
  /** x.f(args) — includes namespaces like math.abs() */
  | { kind: 'method'; object: Expr; method: string; args: Expr[] }
  | { kind: 'unary'; op: '!' | '-'; operand: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'is'; operand: Expr; type: string }
  | { kind: 'ternary'; test: Expr; then: Expr; else: Expr }
  | { kind: 'list'; items: Expr[] }
  | { kind: 'map'; entries: Array<{ key: Expr; value: Expr }> }
  /** /databases/$(database)/documents/users/$(uid) */
  | { kind: 'path'; parts: PathPart[] };

export interface FunctionDecl {
  name: string;
  params: string[];
  lets: Array<{ name: string; value: Expr }>;
  returns: Expr;
  /** Full path of the match block it's declared in; '' for top level / service level. */
  scope: string;
  loc: Loc;
}

export interface Allow {
  /** As written: read, write, get, ... */
  declared: string[];
  /** Expanded: read → get+list, write → create+update+delete. */
  ops: Op[];
  /** As written; `allow read;` (no condition) is literal true. */
  condition: Expr;
  /** With every user function call replaced by its body. */
  inlined: Expr;
  loc: Loc;
  /** Where the condition expression starts (null for `allow read;`). Matches ruleCoverage positions. */
  conditionLoc: Loc | null;
}

export interface MatchBlock {
  /** Full path with nested matches concatenated, e.g. /databases/{database}/documents/users/{uid}. */
  path: string;
  segments: PathSegment[];
  /** Path below /databases/{x}/documents, e.g. users/{uid}; null if the block isn't under it. */
  documentPath: string | null;
  allows: Allow[];
  loc: Loc;
}

export interface Warning {
  code: 'no-rules-version' | 'v1-recursive-wildcard' | 'outside-documents' | 'other-service' | 'unknown-function';
  message: string;
  loc?: Loc;
}

export interface RuleModel {
  file: string;
  version: {
    /** What the file says; null when there's no rules_version statement. */
    declared: '1' | '2' | null;
    /** What Firestore applies: the declared version, or '1' when undeclared. */
    effective: '1' | '2';
  };
  service: string;
  functions: FunctionDecl[];
  matches: MatchBlock[];
  warnings: Warning[];
}

export class RulesParseError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    readonly column: number,
    readonly reason: string,
  ) {
    super(`${file}:${line}:${column}: ${reason}`);
    this.name = 'RulesParseError';
  }
}
