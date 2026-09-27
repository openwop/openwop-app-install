/**
 * ADR 0525 — `buildChainPackManifest` is the sole writer of a file the product's
 * own banner invites the user to PR to a PUBLIC registry (`PublishHelpBanner`),
 * and it had no test at all.
 *
 * BE HONEST ABOUT WHAT THIS IS: a ratchet over already-correct behaviour, not a
 * bug-find. A grade pass verified by hand that the emitted manifest validates
 * against `schemas/workflow-chain-pack-manifest.schema.json` and round-trips
 * through `expandChain` — but a review artifact is not a test, and this module
 * changed more than any other in ADR 0523.
 *
 * The schema-validation and expansion halves live in a BACKEND test
 * (`backend/typescript/test/chain-pack-export-loads.test.ts`): ajv is not a
 * frontend dependency and the loader is backend-only, so re-implementing either
 * here would be the second copy the architecture contract forbids. This half
 * covers the derivation logic, one assertion per property.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const stubEntry = (typeId: string) => ({
  kind: typeId, typeId, label: typeId, description: '', category: 'action',
  badge: 'X', accent: '', inputs: [], outputs: [],
});
vi.mock('../../palette/catalogRegistry.js', () => ({
  catalogEntryByTypeId: (t: string) => stubEntry(t),
  catalogEntry: (k: string) => stubEntry(k),
  defaultConfigFor: () => ({}),
  mergedCatalog: () => [],
  resolvableTypeIds: () => [],
}));

import { buildChainPackManifest } from '../chainPackManifest.js';
import type { SavedWorkflow, BuilderNode } from '../workflow.js';

const REPO = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');

const node = (id: string, over: Partial<BuilderNode> = {}): BuilderNode => ({
  id, kind: 'core.noop', name: id, position: { x: 0, y: 0 }, config: {}, ...over,
});

const wf = (nodes: BuilderNode[], name = 'My Export'): SavedWorkflow => ({
  id: 'wf.export', name, version: '1.0.0', nodes,
  edges: nodes.length > 1
    ? [{ id: 'e1', source: nodes[0]!.id, sourcePort: 'out', target: nodes[1]!.id, targetPort: 'in' }]
    : [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('parameters are DERIVED from the tokens actually present', () => {
  it('FIXTURE GUARD: a real shipped chain authors tokens in `inputs`', () => {
    // Synthetic-only fixtures are what let ADR 0523's strip look like a perfect
    // fixed point — they only ever carried fields the builder already modelled.
    // This pins that the real corpus still has the shape the assertions assume.
    const pack = JSON.parse(
      readFileSync(join(REPO, 'examples/workflow-chain-packs/commerce/pack.json'), 'utf8'),
    ) as { chains: { chainId: string; dag: { nodes: { inputs?: Record<string, unknown> }[] } }[] };
    const chain = pack.chains.find((c) => c.chainId === 'commerce.post-purchase-thankyou')!;
    const tokened = chain.dag.nodes.filter((n) =>
      JSON.stringify(n.inputs ?? {}).includes('{{params.'));
    expect(tokened.length, 'the reference chain no longer authors {{params.*}} in inputs').toBeGreaterThan(0);
  });

  it('finds a token authored in `inputs` — not just `config`', () => {
    // The ADR 0523 regression, one surface along: exporting `inputs` widened the
    // fabrication exposure from `config` to `inputs.to` (an email recipient).
    const m = buildChainPackManifest(wf([node('a', { inputs: { to: '{{params.recipientEmail}}' } })]));
    expect(m.chains[0]!.parameters).toMatchObject({ required: ['recipientEmail'] });
  });

  it('finds a token NESTED inside an object or array', () => {
    const m = buildChainPackManifest(wf([
      node('a', { config: { headers: [{ value: '{{params.apiKey}}' }] } }),
    ]));
    expect((m.chains[0]!.parameters as { required?: string[] }).required).toEqual(['apiKey']);
  });

  it('finds the whitespace form `{{ params.x }}`', () => {
    const m = buildChainPackManifest(wf([node('a', { config: { q: '{{ params.spaced }}' } })]));
    expect((m.chains[0]!.parameters as { required?: string[] }).required).toEqual(['spaced']);
  });

  it('emits `parameters: {}` and plain-language copy when there are NO tokens', () => {
    const m = buildChainPackManifest(wf([node('a', { config: { q: 'literal' } })]));
    expect(m.chains[0]!.parameters).toEqual({});
    // Both description branches land on the gallery card and the preflight
    // modal, so both address whoever is CHOOSING the template. The old
    // zero-param string ("Builder export of X. Fully bound (no {{params.*}}) —
    // parameterize as needed.") was aimed at whoever wrote the exporter.
    expect(m.chains[0]!.description).toContain('Needs no values from you');
    expect(m.chains[0]!.description, 'raw template syntax leaked into user-facing copy').not.toContain('{{params');
    expect(m.chains[0]!.description).not.toContain('Builder export');
    // The gallery card renders `label` as the heading directly above this, so
    // repeating it here is the restate-the-label defect (and could restate 400
    // characters).
    expect(m.chains[0]!.description.startsWith(m.chains[0]!.label)).toBe(false);
  });

  it('THE ANTI-FABRICATION INVARIANT: ≥1 token ⟹ `required` is non-empty', () => {
    // An UNDECLARED `{{params.x}}` freezes to '' and the node SUCCEEDS (ADR
    // 0507). So a manifest that carries a token while declaring no parameter is
    // a fabrication the user never sees. This is the property the whole
    // derivation exists for.
    const m = buildChainPackManifest(wf([node('a', { inputs: { to: '{{params.who}}' } })]));
    const params = m.chains[0]!.parameters as { required?: string[]; properties?: Record<string, unknown> };
    expect(params.required?.length ?? 0).toBeGreaterThan(0);
    expect(Object.keys(params.properties ?? {})).toEqual(params.required);
  });

  it('deduplicates and sorts a token used twice', () => {
    const m = buildChainPackManifest(wf([
      node('a', { config: { x: '{{params.z}}' }, inputs: { y: '{{params.a}}' } }),
      node('b', { config: { x: '{{params.z}}' } }),
    ]));
    expect((m.chains[0]!.parameters as { required?: string[] }).required).toEqual(['a', 'z']);
  });
});

describe('the node fragment carries what the executor needs', () => {
  it('emits BOTH config and inputs for a node authoring both', () => {
    // The ADR 0523 defect: `inputs` was dropped everywhere, including here, so
    // an exported pack lost every recipient and headline.
    const m = buildChainPackManifest(wf([
      node('a', { config: { from: 'me@example.com' }, inputs: { to: 'you@example.com' } }),
    ]));
    const n = m.chains[0]!.dag.nodes[0]!;
    expect(n.config).toEqual({ from: 'me@example.com' });
    expect(n.inputs).toEqual({ to: 'you@example.com' });
  });

  it('omits empty config/inputs rather than emitting `{}`', () => {
    const n = buildChainPackManifest(wf([node('a')])).chains[0]!.dag.nodes[0]!;
    expect(n).not.toHaveProperty('config');
    expect(n).not.toHaveProperty('inputs');
  });
});

describe('every length-constrained field stays inside the schema', () => {
  // Capping the SLUG bounded `name`/`chainId` and left `description` unbounded,
  // where the full label is embedded twice — the same defect one field along.
  // Nothing caps a workflow title in the builder, so this is reachable.
  it('bounds `description` for an absurdly long workflow title', () => {
    // ONLY the two constraints the schema actually declares: top-level `name`
    // 256 and top-level `description` 1024. The chain's `label`/`description`
    // carry no maxLength — asserting one here would be the third invented
    // constraint in this file, and an invented constraint yields an invented
    // finding. Read the SSoT, not the intuition.
    const m = buildChainPackManifest(wf([node('a')], 'T'.repeat(2000)));
    expect(m.name.length, 'pack name exceeds maxLength 256').toBeLessThanOrEqual(256);
    expect(m.description.length, 'pack description exceeds maxLength 1024').toBeLessThanOrEqual(1024);
  });
});

describe('the pack name survives hostile workflow names', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'whitespace'],
    ['🎉🎉', 'emoji-only'],
    ['123 starts with a digit', 'leading digit'],
    ['...', 'dots only'],
    ['Café Über', 'accented'],
    ['x'.repeat(300), 'very long'],
  ])('produces a schema-legal name for %s (%s)', (name) => {
    const m = buildChainPackManifest(wf([node('a')], name));
    // The REAL constraints, read from `schemas/workflow-chain-pack-manifest.schema.json`
    // rather than assumed: a reverse-DNS pattern and maxLength 256. (My first
    // draft asserted npm's 214 and a looser pattern — an invented constraint
    // produces an invented finding, so the assertion has to come from the SSoT.)
    expect(m.name, `slug escaped the manifest name pattern: ${m.name}`)
      .toMatch(/^(core|vendor|community|private)\.[a-z][a-z0-9_-]*(\.[a-z][a-zA-Z0-9_-]*)+$/);
    expect(m.name.length, `slug exceeds maxLength 256: ${m.name.length}`).toBeLessThanOrEqual(256);
  });
});
