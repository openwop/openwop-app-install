import { describe, it, expect } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildV2Advertisement, v2A2aRecord, v2McpRecord } from '../src/routes/discovery.js';
import { _setV2ProjectA2aForTest } from '../src/host/a2aProfile.js';
import { MAX_SUB_CHAIN_DEPTH } from '../src/host/workflowChainPackLoader.js';
import type { AppConfig } from '../src/index.js';

/**
 * ADR 0670 — the v2 advertisement is validated against the v2 schema.
 *
 * Nothing did this before. `schemas/v2/capabilities.schema.json` was vendored,
 * the drift guard kept it current, and the document this host actually
 * publishes was never checked against it — so the ONLY thing standing between
 * an invalid advertisement and production was whoever last edited
 * `buildV2Advertisement` reading the schema carefully.
 *
 * That is not hypothetical. Declaring five families for ADR 0670, I wrote
 * `deferredParameters: { supported: true }` — copied from the v1 record, and
 * matching what the v2 schema's own DESCRIPTION still says ("When
 * `supported: true`…"). The property list says otherwise: that sub-object
 * declares no `supported` property and sets `additionalProperties: false`, so
 * the record was schema-INVALID. The description is stale corpus prose; the
 * properties are the contract. A human reading caught it once. This catches it
 * every time.
 *
 * Tracker TST-BGF-6. Red when: a family record carries an undeclared facet (the
 * schema validation); `stripSupported` leaves a `supported` seat; a declared family
 * goes missing; `workflowChainPacks.subChains` drops `maxDepth`; or the mcp record
 * advertises a relative `serverUrls` entry.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const V2 = join(ROOT, 'schemas', 'v2');

function validator() {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  // Register every sibling so `$ref`s between them resolve. The schemas
  // reference each other by bare filename.
  for (const f of readdirSync(V2)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(readFileSync(join(V2, f), 'utf8')) as Record<string, unknown>;
      ajv.addSchema(s, f);
    } catch { /* a malformed sibling is that sibling's test's problem */ }
  }
  // Fetch by `$id` rather than compiling again: the file is already registered
  // by the loop above, and `compile()` would re-add it and throw
  // "schema with key or id … already exists".
  const root = JSON.parse(readFileSync(join(V2, 'capabilities.schema.json'), 'utf8')) as { $id?: string };
  const byId = root.$id ? ajv.getSchema(root.$id) : undefined;
  const fn = byId ?? ajv.getSchema('capabilities.schema.json');
  if (!fn) throw new Error('capabilities.schema.json did not register — the validator would be vacuous');
  return fn;
}

const CONFIG: AppConfig = { port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false };

describe('ADR 0670 — the published v2 advertisement satisfies the v2 schema', () => {
  it('the vendored v2 schema tree is present — an absent tree must fail, not skip', () => {
    // Without this, a checkout missing `schemas/v2/` would make the validation
    // below vacuously green: no schema, no errors, no signal. Empty-and-passing
    // is the failure mode this repo keeps finding in its own gates.
    expect(existsSync(join(V2, 'capabilities.schema.json'))).toBe(true);
    expect(readdirSync(V2).filter((f) => f.endsWith('.json')).length).toBeGreaterThan(10);
  });

  it('validates, and reports every violation rather than the first', () => {
    const doc = buildV2Advertisement(CONFIG);
    const validate = validator();
    const ok = validate(doc);
    const errors = (validate.errors ?? []).map(
      (e) => `${e.instancePath || '(root)'} ${e.message} ${JSON.stringify(e.params)}`,
    );
    expect(errors, errors.join('\n')).toEqual([]);
    expect(ok).toBe(true);
  });

  it('the two ADR 0670 families are in the document, with the three later ones; `sandbox` stays an honest opt-out', () => {
    // Non-vacuity for the assertion above: an advertisement that declared
    // NOTHING would also validate. This pins what the validation is validating.
    //
    // It was five until the major-2 ratchet ran. Declaring a family un-skips
    // the scenarios gated on it, and `compensation`, `forms` and `connections`
    // then executed for the first time and failed their v2 MUSTs. The negative
    // half below is the load-bearing one: re-adding any of the three would
    // restore a FALSE wire claim, and this is what notices.
    //
    // CORRECTED 2026-10-03 (ADR 0807/0808/0809): `compensation`, `forms` and `connections` moved to the positive half
    // in the same commit that made `GET /runs/{runId}/compensation` real. This
    // guard is what made that move deliberate rather than incidental.
    const doc = buildV2Advertisement(CONFIG) as Record<string, unknown>;
    for (const f of ['feedback', 'workflowChainPacks', 'compensation', 'forms', 'connections']) {
      expect(doc[f], `${f} must be declared at major 2`).toBeTruthy();
    }
    // All three that failed in 2026-09 now pass their scenarios and are
    // declared (ADR 0807/0808/0809); `sandbox` is the one honest opt-out left,
    // and it is pinned here so its return is a deliberate act too.
    for (const f of ['sandbox']) {
      expect(doc[f], `${f} is an honest opt-out — no isolation model to declare`).toBeUndefined();
    }
  });

  it('carries no `supported` seat at ANY depth', () => {
    // `capabilities.md` line 39 — presence of the record IS the claim. The v1
    // document carries 168 of these; the v2 document must carry none, and the
    // sub-objects are where it is easy to leave one behind.
    const doc = buildV2Advertisement(CONFIG);
    const found: string[] = [];
    (function walk(o: unknown, path: string): void {
      if (o === null || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (k === 'supported') found.push(`${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
    })(doc, '');
    expect(found, `unexpected \`supported\` seats: ${found.join(', ')}`).toEqual([]);
  });

  it('workflowChainPacks carries only facets declared by the v2 schema', () => {
    const doc = buildV2Advertisement(CONFIG) as Record<string, unknown>;
    const family = doc['workflowChainPacks'] as Record<string, unknown>;
    // WHD-7 — this pinned the literal `{}`, which pinned the DEFECT: the facet
    // was unconditional and had dropped `maxDepth`, a property the v2
    // sub-object declares. It is now the v1 owner's record minus `supported`
    // (`test/whd7-v2-projection-parity.test.ts` holds the derivation); this
    // leg keeps only what it was always for — the closed record's key set.
    expect(family['subChains']).toEqual({ maxDepth: MAX_SUB_CHAIN_DEPTH });
    expect(family['deferredParameters'], 'removed from the v2 schema by RFC 0192').toBeUndefined();
  });

  it('ADR 0858 P4 — the built a2a (major-2-only host) and mcp records validate', () => {
    // Both records are built but withheld (`V2_PROJECT_A2A` / `V2_PROJECT_MCP`,
    // behaviour gaps), so they are spliced in here: projecting one later must not
    // be the first time anything validated it.
    const saved = { a: process.env.OPENWOP_A2A_SERVER_ENABLED };
    process.env.OPENWOP_A2A_SERVER_ENABLED = 'true';
    _setV2ProjectA2aForTest(true);
    try {
      const a2a = v2A2aRecord('2.0', '2.1');
      expect(a2a, 'the a2a record is built on a major-2-only host with the A2A server on').toBeTruthy();
      const doc = { ...(buildV2Advertisement(CONFIG) as Record<string, unknown>), a2a: a2a! };
      const withMcp = { ...doc, mcp: v2McpRecord('2.0', '2.1') };
      const validate = validator();
      const ok = validate(withMcp);
      const errors = (validate.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message} ${JSON.stringify(e.params)}`);
      expect(errors, errors.join('\n')).toEqual([]);
      expect(ok).toBe(true);
      // `interop.md` §"Legacy profiles are absent".
      expect(JSON.stringify([(doc['a2a'] as Record<string, unknown>)['profiles'], withMcp.mcp['profiles']])).not.toContain('-legacy');
    } finally {
      _setV2ProjectA2aForTest(undefined);
      if (saved.a === undefined) delete process.env.OPENWOP_A2A_SERVER_ENABLED; else process.env.OPENWOP_A2A_SERVER_ENABLED = saved.a;
    }
  });
});
