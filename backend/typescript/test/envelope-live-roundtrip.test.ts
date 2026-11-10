/**
 * XCH-ENV-5 / XCH-INFRA-1 (LLM-EXCHANGE-AUDIT Wave 5; ADR 0604 TOCC-2):
 * `openwop:schema.lookup` serves all three schema families (node types, canvas
 * component catalogs, artifact types), and schema-read tool outputs are never
 * compacted.
 *
 * THE FILENAME IS HISTORICAL. This file once also tested the RFC 0021 AI Envelope
 * `schema.request` round trip; ADR 1007 deleted the envelope from the host
 * (a99ecc8e1) and that half with it. The name is kept because ADRs 0604, 0999 and
 * 1001 cite it.
 *
 * Sabotage-witnessed (wave 82): a node lookup that resolves nothing (the name
 * lands in `notFound`) reds the node case; an empty component list reds the
 * canvas case; a by-id fetch without `schema` reds the artifact case; dropping the
 * exempt short-circuit in `applyToolResultTransform` reds the byte-exact case;
 * breaking BOTH exemption lanes of `isSchemaReadExempt` (the literal array and the
 * tool's `schemaCarrying` declaration — a double guard, so one lane alone stays
 * green) reds the byte-exact and predicate cases; removing an ADR 0604 id from
 * the array reds the exempt-set case.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';

// Boot populates the node, canvas and artifact registries the lookup reads.
// No HTTP is used, so no server is started.
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
}, 120_000);

function field(value: unknown, ...path: Array<string | number>): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = Reflect.get(cur, key);
  }
  return cur;
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

describe('openwop:schema.lookup serves all three families (XCH-ENV-5 / XCH-ENV-3)', () => {
  const run = (input: Record<string, unknown>) =>
    createAgentToolProvider({ tenantId: 'default' }).executeTool({ name: 'openwop:schema.lookup', input });
  const parse = (r: { content: string }): unknown => JSON.parse(r.content);

  it('node typeIds resolve from the live registry', async () => {
    const out = parse(await run({ kind: 'node', names: ['core.noop'] }));
    // A miss echoes the name into `notFound`, so asserting the name appears
    // anywhere could not fail (wave 82 probe): assert it RESOLVED.
    expect(list(field(out, 'schemas')).map((s) => field(s, 'typeId'))).toEqual(['core.noop']);
    expect(field(out, 'notFound')).toEqual([]);
  });
  it('canvas component catalogs resolve (canvas.slides)', async () => {
    const out = parse(await run({ kind: 'canvas-component', canvasTypeId: 'canvas.slides' }));
    expect(Array.isArray(field(out, 'components'))).toBe(true);
    expect(list(field(out, 'components')).length).toBeGreaterThan(5);
    expect(String(field(out, 'promptSchema'))).toContain('- heading');
  });
  it('artifact types list + fetch by id', async () => {
    const all = parse(await run({ kind: 'artifact-type' }));
    expect(list(field(all, 'artifactTypes')).length).toBeGreaterThan(0);
    const firstId = field(all, 'artifactTypes', 0, 'artifactTypeId');
    expect(typeof firstId).toBe('string');
    const byId = parse(await run({ kind: 'artifact-type', names: [String(firstId)] }));
    expect(field(byId, 'artifactTypes', 0, 'artifactTypeId')).toBe(firstId);
    expect(field(byId, 'artifactTypes', 0, 'schema')).toBeTruthy();
  });
});

describe('schema-read tool outputs are never compacted (XCH-INFRA-1)', () => {
  /**
   * TOCC-2 / TOCC-2a (ADR 0604) — THIS GATE COULD NOT FAIL.
   *
   * It used to be a bare `for (const toolName of SCHEMA_READ_EXEMPT_TOOLS)`
   * loop: it iterated its own allowlist and checked each member. With no
   * `expect.assertions`, no length floor and no negative control, **emptying the
   * array was GREEN**, and so was deleting 4 of its 9 entries. A gate whose
   * population IS the thing under test is vacuous by construction for
   * completeness — it can only ever confirm that what is listed is listed.
   *
   * Three things fixed, each of which the sabotage below actually kills:
   *   1. a named floor, so an emptied or shortened array reddens;
   *   2. explicit per-id assertions for the ids this feature's assessment
   *      proved were MISSING, so a silent revert of the additions reddens;
   *   3. a NEGATIVE CONTROL — a tool that is NOT exempt must actually be
   *      compacted — because a transform that has quietly become identity would
   *      otherwise make every "stays byte-exact" assertion pass for free. That
   *      is the failure mode the original loop shared with a stable mock: it
   *      measured a condition the code no longer had.
   */
  const LOSSY = { mode: 'lossy' as const, head: 1, tail: 1 };
  const schemaish = JSON.stringify({ type: 'object', required: [], properties: { a: { enum: ['x', 'y', 'z'] } } });
  // Long enough that elision genuinely shrinks it — the first draft used ten
  // short rows and the never-regress guard returned the ORIGINAL, which the
  // negative control below correctly reported as "not compacted". A negative
  // control that cannot distinguish "exempt" from "not worth compacting" would
  // have been the same vacuity in a new costume.
  // ADR 0999 D5.2 — rows are OBJECTS: `lossy` no longer elides an array of
  // scalars (an enum or id list gained an object element), so a string row list
  // would make the negative control below report "not compacted" for the wrong
  // reason.
  const elidable = JSON.stringify({ rows: Array.from({ length: 60 }, (_, i) => ({ id: `row-value-${i}` })), note: '', extra: [] });

  it('the exempt set is non-empty and still contains every id it was proved to need', async () => {
    const { SCHEMA_READ_EXEMPT_TOOLS } = await import('../src/host/toolResultTransform.js');
    // Floor: the count at the time of writing. Shrinking it must be a deliberate act.
    expect(SCHEMA_READ_EXEMPT_TOOLS.length).toBeGreaterThanOrEqual(18);
    for (const id of [
      'openwop:schema.lookup',
      'openwop:app-builder.catalog',
      'openwop:app-builder.get-design',
      'openwop:slides.catalog',
      'openwop:documents.list-templates',
      'openwop:entities.describe-type',
      'openwop:priority-matrix.list-lists',
      'openwop:priority-matrix.list-ranked-ideas',
      'openwop:feature.workflow-author.nodes.draft',
      // ADR 0604 — each of these was MISSING and is individually named here so a
      // revert cannot pass by leaving the array merely non-empty.
      'openwop:feature.agent-author.nodes.get',
      'openwop:feature.workflow-author.nodes.get',
      'openwop:documents.get-template',
      'openwop:slides.get-design',
      'openwop:feature.crm.nodes.segment-vocabulary',
      'openwop:feature.crm.nodes.validate-segment',
      'openwop:cad.get-design',
      'openwop:drawings.get-design',
      'openwop:campaign-studio.get-design',
    ]) {
      expect(SCHEMA_READ_EXEMPT_TOOLS, `${id} must be exempt`).toContain(id);
    }
  });

  it('every exempt id passes through byte-exact under the most aggressive decision', async () => {
    const { applyToolResultTransform, registerToolResultTransform, __resetToolResultTransform, SCHEMA_READ_EXEMPT_TOOLS } =
      await import('../src/host/toolResultTransform.js');
    const { compactToolOutput } = await import('../src/features/tool-output-compaction/compact.js');
    // Its OWN live transform: the boot-registered one is reset by the negative
    // control's `finally`, so under shuffle this loop could run against identity
    // and never fail.
    registerToolResultTransform((content, ctx) => (ctx.decision ? compactToolOutput(content, ctx.decision) : content));
    try {
      expect(SCHEMA_READ_EXEMPT_TOOLS.length).toBeGreaterThanOrEqual(18); // the loop below is vacuous without this
      // Positive control: the same transform DOES compact a non-exempt tool.
      expect(applyToolResultTransform(elidable, { decision: LOSSY, toolName: 'openwop:crm.definitely-not-a-schema-tool' })).not.toBe(elidable);
      for (const toolName of SCHEMA_READ_EXEMPT_TOOLS) {
        expect(applyToolResultTransform(schemaish, { decision: LOSSY, toolName }), `${toolName} must stay byte-exact`).toBe(schemaish);
        expect(applyToolResultTransform(elidable, { decision: LOSSY, toolName }), `${toolName} must stay byte-exact`).toBe(elidable);
      }
    } finally {
      __resetToolResultTransform();
    }
  });

  it('NEGATIVE CONTROL — a non-exempt tool IS compacted (proves the loop above measures something)', async () => {
    const { applyToolResultTransform, registerToolResultTransform, __resetToolResultTransform, SCHEMA_READ_EXEMPT_TOOLS } =
      await import('../src/host/toolResultTransform.js');
    const { compactToolOutput } = await import('../src/features/tool-output-compaction/compact.js');
    registerToolResultTransform((content, ctx) => (ctx.decision ? compactToolOutput(content, ctx.decision) : content));
    try {
      const notExempt = 'openwop:crm.definitely-not-a-schema-tool';
      expect(SCHEMA_READ_EXEMPT_TOOLS).not.toContain(notExempt);
      const out = applyToolResultTransform(elidable, { decision: LOSSY, toolName: notExempt });
      expect(out).not.toBe(elidable);
      expect(out).toContain('_elided');
    } finally {
      __resetToolResultTransform();
    }
  });

  it('the predicate, not just the array, is what the transform consults', async () => {
    const { isSchemaReadExempt } = await import('../src/host/toolResultTransform.js');
    expect(isSchemaReadExempt('openwop:schema.lookup')).toBe(true);
    expect(isSchemaReadExempt('openwop:crm.definitely-not-a-schema-tool')).toBe(false);
    expect(isSchemaReadExempt(undefined)).toBe(false);
  });
});
