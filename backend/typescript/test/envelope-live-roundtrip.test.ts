/**
 * XCH-ENV-5 / XCH-INFRA-1 (LLM-EXCHANGE-AUDIT Wave 5): `openwop:schema.lookup`
 * serves all three schema families (node types, canvas component catalogs,
 * artifact types), and schema-read tool outputs are never compacted.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('openwop:schema.lookup serves all three families (XCH-ENV-5 / XCH-ENV-3)', () => {
  const run = (input: Record<string, unknown>) =>
    createAgentToolProvider({ tenantId: 'default' }).executeTool({ name: 'openwop:schema.lookup', input });
  const parse = (r: { content: string }) => JSON.parse(r.content) as Record<string, unknown>;

  it('node typeIds resolve from the live registry', async () => {
    const out = parse(await run({ kind: 'node', names: ['core.noop'] }));
    expect(JSON.stringify(out)).toContain('core.noop');
  });
  it('canvas component catalogs resolve (canvas.slides)', async () => {
    const out = parse(await run({ kind: 'canvas-component', canvasTypeId: 'canvas.slides' }));
    expect(Array.isArray(out.components)).toBe(true);
    expect((out.components as unknown[]).length).toBeGreaterThan(5);
    expect(String(out.promptSchema)).toContain('- heading');
  });
  it('artifact types list + fetch by id', async () => {
    const list = parse(await run({ kind: 'artifact-type' }));
    expect(Array.isArray(list.artifactTypes)).toBe(true);
    expect((list.artifactTypes as unknown[]).length).toBeGreaterThan(0);
    const first = (list.artifactTypes as Array<{ artifactTypeId: string }>)[0]!;
    const byId = parse(await run({ kind: 'artifact-type', names: [first.artifactTypeId] }));
    const found = (byId.artifactTypes as Array<{ artifactTypeId: string; schema?: unknown }>)[0]!;
    expect(found.artifactTypeId).toBe(first.artifactTypeId);
    expect(found.schema).toBeTruthy();
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
    const { applyToolResultTransform, SCHEMA_READ_EXEMPT_TOOLS } = await import('../src/host/toolResultTransform.js');
    expect(SCHEMA_READ_EXEMPT_TOOLS.length).toBeGreaterThanOrEqual(18); // the loop below is vacuous without this
    for (const toolName of SCHEMA_READ_EXEMPT_TOOLS) {
      expect(applyToolResultTransform(schemaish, { decision: LOSSY, toolName }), `${toolName} must stay byte-exact`).toBe(schemaish);
      expect(applyToolResultTransform(elidable, { decision: LOSSY, toolName }), `${toolName} must stay byte-exact`).toBe(elidable);
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
