/**
 * ADR 0547 D2/P3 — an uncompilable `inputSchema` fails CLOSED.
 *
 * Before this, `compileToolValidator` caught the compile error and returned
 * `() => ({ ok: true })`: the tool stayed offered to the model and accepted ANY
 * arguments for the life of the process. Two callers of one schema class
 * therefore disagreed — MCP rejected the same tool outright.
 *
 * The tool is now dropped from the offered surface, which is the rule
 * `resolveAgentTools` already applies to a tool it cannot resolve ("a host that
 * can't describe a tool does not offer it"), extended to the case that escaped it.
 */
import { describe, expect, it } from 'vitest';
import { compileAgentTools } from '../src/host/agentDispatch.js';
import { toolSchemaCompiles, validateToolInput } from '../src/host/toolSchemaValidation.js';
import type { AgentToolDef } from '../src/host/agentDispatch.js';
import type { ResolvedAgentManifest } from '../src/executor/agentRegistry.js';

const GOOD: Record<string, unknown> = {
  type: 'object',
  properties: { orgId: { type: 'string' } },
  required: ['orgId'],
  additionalProperties: false,
};
/** Ajv2020 throws on this even with `strict:false` — see the P4 ratchet header. */
const BROKEN: Record<string, unknown> = {
  type: 'object',
  properties: { a: { $ref: '#/definitions/does-not-exist' } },
};

const defs: Record<string, AgentToolDef> = {
  good: { name: 'good', description: 'ok', inputSchema: GOOD },
  broken: { name: 'broken', description: 'bad schema', inputSchema: BROKEN },
};

// A REAL manifest, not a cast. `as never`/`as unknown as` would silently keep
// compiling if `compileAgentTools` grew a dependency on another field.
const agent: ResolvedAgentManifest = {
  agentId: 'agent-under-test',
  packName: 'test.pack',
  packVersion: '0.0.1',
  persona: 'test',
  modelClass: 'test',
  systemPrompt: '',
  toolAllowlist: ['good', 'broken'],
};
const compile = () => compileAgentTools(agent, ['good', 'broken'], (n) => defs[n]);

describe('ADR 0547 — uncompilable tool schemas fail closed', () => {
  it('the BROKEN fixture really is uncompilable — else every test here is vacuous', () => {
    expect(toolSchemaCompiles(GOOD)).toBe(true);
    expect(toolSchemaCompiles(BROKEN)).toBe(false);
  });

  it('drops the tool from the offered surface, keeping the sound one', () => {
    const names = compile().map((c) => c.def.name);
    expect(names).toContain('good');
    expect(names, 'a tool with no validatable schema must not be offered to the model').not.toContain('broken');
  });

  it('the model is never offered a tool it could call unchecked', () => {
    // The precise regression: pre-fix this returned BOTH tools, and `broken`
    // accepted anything. Pinning the count catches a re-introduction that a
    // `.not.toContain` alone would miss if the drop moved elsewhere.
    expect(compile()).toHaveLength(1);
  });

  it('still ENFORCES arguments for the sound tool — the drop is not a blanket bypass', () => {
    const good = compile().find((c) => c.def.name === 'good')!;
    expect(good.validate({ orgId: 'org-1' }).ok).toBe(true);
    const missing = good.validate({});
    expect(missing.ok, 'a required property is still required').toBe(false);
    expect(missing.errors, 'the model needs the Ajv path to self-correct').toMatch(/orgId/);
  });

  it('reports a broken schema as its own outcome, never as "valid"', () => {
    // The inversion that mattered: "cannot check" must not resolve to "checked, fine".
    const r = validateToolInput(BROKEN, { literally: 'anything' });
    expect(r.ok).toBe(false);
    expect(r.schemaBroken).toBe(true);
  });

  it('$id is stripped, so two tools may share one — both callers, one instance', () => {
    // ADR 0547 D4. With one shared Ajv, an unstripped duplicate `$id` would throw
    // on the second compile and take out an unrelated tool.
    const a = { $id: 'https://example.test/dup', type: 'object', properties: { x: { type: 'string' } } };
    const b = { $id: 'https://example.test/dup', type: 'object', properties: { y: { type: 'number' } } };
    expect(toolSchemaCompiles(a)).toBe(true);
    expect(toolSchemaCompiles(b)).toBe(true);
    expect(validateToolInput(b, { y: 1 }).ok).toBe(true);
    expect(validateToolInput(b, { y: 'no' }).ok, 'b must validate as ITSELF, not as a cached a').toBe(false);
  });
});
