import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { parse as parseYaml } from 'yaml';
import type { DocData } from '../run/types.js';

/** firediff.yml: extra inputs for the generator. */
export interface Config {
  /** Extra seed docs (merged over generated ones at the same path). */
  docs?: Array<{ path: string; data: DocData }>;
  /** Extra claim values; each becomes a principal, like claims found in the rules. */
  claims?: Record<string, Array<string | number | boolean>>;
  /** Extra principals. Omit uid for a signed-out principal. */
  principals?: Array<{ name: string; label?: string; uid?: string; claims?: Record<string, unknown> }>;
  /** Extra write payloads, sent by every principal. */
  payloads?: Array<{ op: 'create' | 'update'; path: string; data: DocData }>;
}

const docPath = { type: 'string', pattern: '^[^/]+(/[^/]+)*$' };

export const CONFIG_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'firediff.yml',
  type: 'object',
  additionalProperties: false,
  properties: {
    docs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'data'],
        properties: { path: docPath, data: { type: 'object' } },
      },
    },
    claims: {
      type: 'object',
      additionalProperties: { type: 'array', minItems: 1, items: { type: ['string', 'number', 'boolean'] } },
    },
    principals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1 },
          label: { type: 'string' },
          uid: { type: 'string', minLength: 1 },
          claims: { type: 'object' },
        },
      },
    },
    payloads: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'path', 'data'],
        properties: { op: { enum: ['create', 'update'] }, path: docPath, data: { type: 'object' } },
      },
    },
  },
} as const;

export class ConfigError extends Error {
  constructor(file: string, problems: string[]) {
    super(`${file}: invalid config\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const validate = new Ajv({ allErrors: true, allowUnionTypes: true }).compile<Config>(CONFIG_SCHEMA);

export function parseConfig(text: string, file = 'firediff.yml'): Config {
  let raw: unknown;
  try {
    raw = parseYaml(text) ?? {};
  } catch (e) {
    throw new ConfigError(file, [(e as Error).message]);
  }
  if (!validate(raw)) {
    throw new ConfigError(
      file,
      (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message}${e.params && 'additionalProperty' in e.params ? `: ${e.params.additionalProperty}` : ''}`),
    );
  }
  return raw;
}

export function loadConfig(file: string): Config {
  return parseConfig(readFileSync(file, 'utf8'), file);
}
