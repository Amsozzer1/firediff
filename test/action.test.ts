import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// GitHub only loads action.yml when a workflow uses the Action, so a YAML mistake (like an unquoted
// colon in the description) would otherwise ship unnoticed and break every `uses: …@v0.1`.
describe('action.yml', () => {
  const action = parse(readFileSync('action.yml', 'utf8'));

  it('parses, with the fields the Marketplace needs', () => {
    expect(action.name).toBe('firediff');
    expect(typeof action.description).toBe('string');
    expect(action.description.length).toBeLessThanOrEqual(125);
    expect(action.branding).toEqual({ icon: expect.any(String), color: expect.any(String) });
  });

  it('runs the bundled Action entry point', () => {
    expect(action.runs.using).toBe('composite');
    expect(JSON.stringify(action.runs.steps)).toContain('dist/action/index.js');
  });
});
