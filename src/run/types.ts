export type DocData = Record<string, unknown>;

export interface Principal {
  /** Stable id, used as the "who" in results. */
  name: string;
  /** Plain-English description for reports. */
  label?: string;
  /** null = signed out */
  auth: { uid: string; token?: Record<string, unknown> } | null;
  /** Only sent shared requests on these targets (doc paths / collections); unset = every target. */
  scope?: string[];
  /** Acts on docs it owns (its own copies), so wording says "their own doc". */
  ownsTarget?: boolean;
  /**
   * What this principal needs to have: 'claim:admin=true', 'own', 'doc:users/{uid}',
   * 'doc:users/{uid}#role=admin'. A principal whose requirements include another flipped
   * principal's is narrower, so reports don't list it next to the broader one.
   */
  requires?: string[];
}

/** Placeholder values the harness turns into Firestore types before writing. */
export const SERVER_TIME = { __firediff: 'serverTimestamp' } as const;
export const timestampAt = (iso: string) => ({ __firediff: 'timestamp', iso }) as const;

export type Request = (
  | { op: 'get' | 'delete'; path: string }
  | { op: 'list'; collection: string; where?: Array<[field: string, op: '==', value: unknown]> }
  /**
   * `fields`: for update, the fields being changed; for create, the fields overridden from the
   * allowed payload (absent = the allowed payload itself).
   */
  | { op: 'create' | 'update'; path: string; data: DocData; fields?: string[] }
) & {
  /** For requests on a synthesized principal's own copy: the target it stands in for (used for grouping). */
  canonical?: string;
  /** A probe on a doc that doesn't exist: reported on its own, below every other row. */
  probe?: 'missing';
};

export interface Case {
  principal: Principal;
  request: Request;
}

export type Outcome =
  | { result: 'allow' }
  /** `reason`: the emulator's message, e.g. "false for 'get' @ L13". */
  | { result: 'deny'; reason?: string }
  | { result: 'error'; message: string };

export interface Seed {
  path: string;
  data: DocData;
}

export interface Row {
  case: Case;
  base: Outcome;
  head: Outcome;
}

export function requestTarget(r: Request): string {
  return r.op === 'list' ? r.collection : r.path;
}

/** The target used for grouping and wording: the canonical path for copies, else the real one. */
export function groupTarget(r: Request): string {
  return r.canonical ?? requestTarget(r);
}

export function isWrite(r: Request): boolean {
  return r.op === 'create' || r.op === 'update' || r.op === 'delete';
}

/** Fields that identify a request variant: changed/overridden fields, or list filter fields. */
export function requestFields(r: Request): string[] | undefined {
  if (r.op === 'update') return r.fields ?? Object.keys(r.data);
  if (r.op === 'create') return r.fields;
  return undefined;
}

/** The comparable shape stored in corpus expected.json files. */
export interface ExpectedRow {
  who: string;
  op: Request['op'];
  fields?: string[];
  where?: string[];
  path: string;
  base: Outcome['result'];
  head: Outcome['result'];
}

export function toExpectedRow(r: Row): ExpectedRow {
  const req = r.case.request;
  const fields = requestFields(req);
  const where = req.op === 'list' && req.where?.length ? req.where.map(([f]) => f) : undefined;
  return {
    who: r.case.principal.name,
    op: req.op,
    ...(fields ? { fields } : {}),
    ...(where ? { where } : {}),
    path: requestTarget(req),
    base: r.base.result,
    head: r.head.result,
  };
}

export const expectedKey = (e: ExpectedRow) => JSON.stringify([e.path, e.op, e.fields ?? [], e.where ?? [], e.who, e.base, e.head]);
