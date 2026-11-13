/**
 * CC-BLD-1 — the Messaging kernel chain's `generate_kernel` node returns
 * `kernel`, `briefVersion` and `priorKernelAt`, and the chain's edges read them
 * by name. Its pack ships no output schema, so the catalog holds only the
 * fallback `out` port, and the canvas labelled every one of those edges
 * "Missing output: …" while Validate said the workflow was valid.
 *
 * A name is now flagged missing only when a declared schema lacks it. Red before
 * the fix: all three cases below projected `missing: true`.
 */
import { describe, it, expect } from 'vitest';
import { projectSourceOutput, virtualSourceOutputs } from '../schema/sourceOutput.js';
import { declaredOutputNames, portsFromSchema } from '../palette/catalogRegistry.js';

const named = (n: string) => ({ sourcePort: n, canonicalSourceOutput: n });

const OPEN = { names: [], closed: false } as const;

describe('CC-BLD-1 — named outputs on nodes that do not declare them', () => {
  it('a pack with no output schema: a named output is shown plainly, not as missing', () => {
    const outputs = portsFromSchema(undefined, 'out');
    expect(declaredOutputNames(undefined)).toEqual(OPEN);
    const p = projectSourceOutput(named('kernel'), outputs, 'en', declaredOutputNames(undefined));
    expect(p).toMatchObject({ missing: false, named: true, virtual: true, label: 'kernel (not declared by the node)' });
    expect(p.handleId).not.toContain('missing');
  });

  it('an optional output the schema declares is not missing (ports carry only required names)', () => {
    const schema = { type: 'object', properties: { kernel: { type: 'object' }, priorKernelAt: { type: 'string' } }, required: ['kernel'], additionalProperties: false };
    const outputs = portsFromSchema(schema, 'out');
    expect(outputs.map((o) => o.name)).toEqual(['kernel']);
    const declared = declaredOutputNames(schema);
    expect(declared).toEqual({ names: ['kernel', 'priorKernelAt'], closed: true });
    expect(projectSourceOutput(named('priorKernelAt'), outputs, 'en', declared)).toMatchObject({ missing: false, named: true, label: 'priorKernelAt' });
    expect(projectSourceOutput(named('kernel'), outputs, 'en', declared)).toMatchObject({ missing: false, virtual: false });
  });

  it('an open schema (extra properties allowed by default) does not rule a name out', () => {
    const schema = { type: 'object', properties: { kernel: { type: 'object' } }, required: ['kernel'] };
    expect(projectSourceOutput(named('briefVersion'), portsFromSchema(schema, 'out'), 'en', declaredOutputNames(schema)))
      .toMatchObject({ missing: false, named: true, label: 'briefVersion (not declared by the node)' });
  });

  it('a genuinely unknown output still flags, on a closed schema and on a curated entry', () => {
    const schema = { type: 'object', properties: { kernel: { type: 'object' } }, required: ['kernel'], additionalProperties: false };
    expect(projectSourceOutput(named('nope'), portsFromSchema(schema, 'out'), 'en', declaredOutputNames(schema)))
      .toMatchObject({ missing: true, named: false, label: 'Missing output: nope' });
    expect(projectSourceOutput(named('nope'), [{ name: 'text', type: 'string' }], 'en'))
      .toMatchObject({ missing: true });
  });

  it('the edge handle and the node’s virtual port agree, so the edge attaches', () => {
    const edges = [named('kernel'), named('briefVersion')];
    const ports = virtualSourceOutputs(edges, portsFromSchema(undefined, 'out'), 'en', OPEN);
    expect(ports.map((p) => p.handleId)).toEqual(edges.map((e) => projectSourceOutput(e, portsFromSchema(undefined, 'out'), undefined, OPEN).handleId));
    expect(ports.every((p) => !p.missing && p.named)).toBe(true);
  });

  it('a malformed schema (array properties) declares nothing and stays open', () => {
    expect(declaredOutputNames({ properties: ['a', 'b'] })).toEqual(OPEN);
  });
});
