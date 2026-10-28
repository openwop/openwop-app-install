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
 *
 * Each case looks its variable up by name (round 1 graded the filtered COUNTS as
 * able to pass for the wrong variable). Over-HTTP twin for reqs 7/2/1:
 * `chain-deferred-expand-seam.test.ts` › "inline chain → variables[] carries
 * `format` iff minted"; this unit file is the only witness of reqs 6 and 8.
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
  // Each materialized variable is `<chain-slug>_<expansionId>_<param>`; the five
  // param names here share no suffix, so a suffix lookup names exactly one var.
  const varOf = (param: string) => {
    const hits = vars.filter((v) => v.name.endsWith(`_${param}`));
    expect(hits, param).toHaveLength(1);
    return hits[0]!;
  };

  it('req 7 — a string parameter’s `format` is copied verbatim onto the WorkflowVariable', () => {
    expect(vars).toHaveLength(5);
    expect(varOf('recipientEmail')).toMatchObject({ type: 'string', format: 'email' });
  });

  it('req 2 — an UNRECOGNISED `format` is still copied verbatim (never validated at mint)', () => {
    expect(varOf('weird')).toMatchObject({ type: 'string', format: 'not-a-real-format' });
  });

  it('req 1 — `format` on a NON-string parameter is NOT propagated', () => {
    const count = varOf('count');
    expect(count.type).toBe('number');
    expect(count).not.toHaveProperty('format');
  });

  it('req 6 — `format` composes with `sensitive` (both present, no interaction)', () => {
    expect(varOf('apiKey')).toMatchObject({ type: 'string', format: 'email', sensitive: true });
  });

  it('a string parameter with no declared `format` mints no `format`', () => {
    const plain = varOf('plain');
    expect(plain.type).toBe('string');
    expect(plain).not.toHaveProperty('format');
  });

  it('req 8 — `format` is NOT propagated into `configurableSchema` (the validation surface)', () => {
    // The whole schema, literally: bare names, `type` only, no `format` anywhere.
    expect(def.configurableSchema).toEqual({
      type: 'object',
      properties: {
        recipientEmail: { type: 'string' },
        weird: { type: 'string' },
        count: { type: 'number' },
        apiKey: { type: 'string' },
        plain: { type: 'string' },
      },
    });
  });
});
