/**
 * RFC 0136 step 4 (reference-host witness) — deferred-mode chain-parameter
 * `format` propagation. A host advertising
 * `capabilities.workflowChainPacks.deferredParameters.supported: true` MUST copy a
 * STRING parameter's JSON-Schema `format` verbatim onto the `WorkflowVariable` it
 * materializes (requirement 7), string-typed only (req 1), unvalidated so an
 * unknown value is still copied (req 2), composing with `sensitive` (req 6) — and
 * MUST NOT carry it into `configurableSchema` (req 8), the run-options validation
 * surface where a format-asserting validator would turn an advisory hint into a
 * run-rejection path (violating the absolute requirement 3).
 */
import { describe, it, expect } from 'vitest';
import { expandChain, type WorkflowChain } from '../src/host/workflowChainPackLoader.js';

function chainWithParams(props: Record<string, unknown>): WorkflowChain {
  return {
    chainId: 'c.fmt',
    version: '1.0.0',
    label: 'Format fixture',
    description: 'RFC 0136 format-propagation fixture',
    parameters: { type: 'object', properties: props },
    dag: { nodes: [{ id: 'n1', typeId: 'core.identity', config: {} }], edges: [] },
  };
}

describe('RFC 0136 — deferred-mode chain-param `format` propagation (step 4)', () => {
  const def = expandChain(
    chainWithParams({
      recipientEmail: { type: 'string', format: 'email' }, // req 7 — copied verbatim
      weird: { type: 'string', format: 'not-a-real-format' }, // req 2 — unknown, still copied
      count: { type: 'number', format: 'email' }, // req 1 — non-string, format ignored
      apiKey: { type: 'string', format: 'email', 'x-openwop-sensitive': true }, // req 6 — composes with sensitive
      plain: { type: 'string' }, // no format declared → none minted
    }),
    { deferred: true },
  );
  const vars = def.variables ?? [];

  it('req 7 — a string parameter’s `format` is copied verbatim onto the WorkflowVariable', () => {
    // recipientEmail + apiKey both declare format:"email"
    const emailVars = vars.filter((v) => v.format === 'email');
    expect(emailVars.length).toBe(2);
    for (const v of emailVars) expect(v.type).toBe('string');
  });

  it('req 2 — an UNRECOGNISED `format` is still copied verbatim (never validated at mint)', () => {
    expect(vars.some((v) => v.format === 'not-a-real-format')).toBe(true);
  });

  it('req 1 — `format` on a NON-string parameter is NOT propagated', () => {
    const numberVars = vars.filter((v) => v.type === 'number');
    expect(numberVars.length).toBe(1); // `count`
    expect(numberVars.every((v) => !('format' in v))).toBe(true);
  });

  it('req 6 — `format` composes with `sensitive` (both present, no interaction)', () => {
    const both = vars.filter((v) => v.sensitive === true && v.format === 'email');
    expect(both.length).toBe(1); // apiKey
  });

  it('a string parameter with no declared `format` mints no `format`', () => {
    // `plain` is the only string var without format; every var either has a
    // format we declared or is `plain`.
    const noFormat = vars.filter((v) => v.type === 'string' && !('format' in v));
    expect(noFormat.length).toBe(1);
  });

  it('req 8 — `format` is NOT propagated into `configurableSchema` (the validation surface)', () => {
    const cs = (def as { configurableSchema?: { properties?: Record<string, Record<string, unknown>> } })
      .configurableSchema;
    expect(cs?.properties).toBeTruthy();
    for (const prop of Object.values(cs!.properties!)) {
      expect(prop).not.toHaveProperty('format');
    }
  });
});
