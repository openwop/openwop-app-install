/**
 * ADR 0738 (reusable WorkItems) — the core `core.openwop.kanban-work-items`
 * materializer forwards a producer's proposal to the tenant-scoped
 * `ctx.kanban.materializeWorkItems` boundary with a DETERMINISTIC delivery key
 * (per run/node/board/source), and never a tenantId (the host fills tenant from
 * the run scope). Red if the key gains entropy or the command carries a tenant
 * (probes w37g1-pack-key-deterministic, w37g1-pack-no-tenant), or stops varying
 * with the run or the source revision (wave 120). ADR 1137 D3/P3: `refresh` is
 * forwarded only when configured, and an item's assignee and labels pass
 * through; red if either is dropped or `refresh` is sent unconditionally.
 * ADR 1155 P2b (pack 1.3.0): an item's `facets` pass through, the input schema
 * admits them within the host's own limits (8 keys, lower-case key pattern, 1–64
 * characters, no control characters) and refuses anything past them; red if the
 * schema drops `facets` (it is `additionalProperties: false`) or drifts from
 * `kanbanService`'s FACETS_MAX / FACET_KEY_RE / FACET_VALUE_MAX.
 *
 * The review-policy gate (`requireApproval`) is owned by
 * `adr0835-approvals-and-repo.test.ts` (S6: approve/accept pass; reject, missing
 * and override refuse) — not duplicated here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { FACETS_MAX, FACET_KEY_RE, FACET_VALUE_MAX } from '../src/host/kanbanService.js';

type CorePack = typeof import('../../../packs/core.openwop.kanban-work-items/index.mjs');

const proposal = {
  scope: { kind: 'canvas.example', externalRef: 'canvas-1' },
  source: { kind: 'example.plan', id: 'plan-1', revision: '2' },
  items: [{ key: 'first', title: 'First work item', columnId: 'todo' }],
};

describe('core.openwop.kanban-work-items', () => {
  const pack = (): Promise<CorePack> => import('../../../packs/core.openwop.kanban-work-items/index.mjs');

  it('binds a generic producer proposal to the tenant-scoped host command with a deterministic run delivery key', async () => {
    const { materializeWorkItems } = await pack();
    const received: Array<Record<string, unknown>> = [];
    const ctx = {
      runId: 'run-1',
      nodeId: 'node-1',
      inputs: { boardId: 'board-1', proposal },
      config: {},
      kanban: {
        materializeWorkItems: async (command: Record<string, unknown>) => {
          received.push(command);
          return { dryRun: false, workItems: [{ workItemId: 'work-1' }], cards: [{ id: 'card-1' }] };
        },
      },
    };
    const first = await materializeWorkItems(ctx);
    await materializeWorkItems(ctx);
    expect(first).toMatchObject({ status: 'success', outputs: { dryRun: false, workItems: [{ workItemId: 'work-1' }] } });
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ boardId: 'board-1', ...proposal });
    expect(received[0]?.idempotencyKey).toMatch(/^kanban-work-[0-9a-f]{32}$/);
    expect(received[0]?.idempotencyKey).toEqual(received[1]?.idempotencyKey);
    expect(received[0]).not.toHaveProperty('tenantId');
    // …and the key is PER run/node/board/source: change any one and it changes
    // (a constant key would fold distinct deliveries into one).
    const variants = [
      { ...ctx, runId: 'run-2' },
      { ...ctx, nodeId: 'node-2' },
      { ...ctx, inputs: { boardId: 'board-2', proposal } },
      { ...ctx, inputs: { boardId: 'board-1', proposal: { ...proposal, source: { ...proposal.source, revision: '3' } } } },
    ];
    for (const v of variants) await materializeWorkItems(v);
    const keys = received.map((c) => c.idempotencyKey);
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(5); // the two identical deliveries share one key; each variant has its own
  });
  it('ADR 1137: forwards refresh only when configured, and passes a proposal item\'s assignee through untouched', async () => {
    const { materializeWorkItems } = await pack();
    const received: Array<Record<string, unknown>> = [];
    const kanban = {
      materializeWorkItems: async (command: Record<string, unknown>) => {
        received.push(command);
        return { dryRun: false, workItems: [], cards: [], refreshedCardIds: [] };
      },
    };
    const assigned = { ...proposal, items: [{ ...proposal.items[0], assigneeId: 'user:alice', labels: ['waiting-on'] }] };
    await materializeWorkItems({ runId: 'run-1', nodeId: 'n', inputs: { boardId: 'b', proposal: assigned }, config: { refresh: true }, kanban });
    await materializeWorkItems({ runId: 'run-1', nodeId: 'n', inputs: { boardId: 'b', proposal }, config: {}, kanban });
    expect(received[0]).toMatchObject({ refresh: true, items: [{ assigneeId: 'user:alice', labels: ['waiting-on'] }] });
    expect(received[1]).not.toHaveProperty('refresh');
  });

  it('ADR 1155 P2b: passes an item\'s facets through, and the input schema holds the host\'s facet limits', async () => {
    const { materializeWorkItems } = await pack();
    const received: Array<Record<string, unknown>> = [];
    const kanban = {
      materializeWorkItems: async (command: Record<string, unknown>) => {
        received.push(command);
        return { dryRun: false, workItems: [], cards: [], refreshedCardIds: [] };
      },
    };
    const facets = { stage: 'rough-in', room: 'r-12', system: 'hvac' };
    const faceted = { ...proposal, items: [{ ...proposal.items[0], facets }] };
    await materializeWorkItems({ runId: 'run-1', nodeId: 'n', inputs: { boardId: 'b', proposal: faceted }, config: { refresh: true }, kanban });
    expect(received[0]).toMatchObject({ refresh: true, items: [{ key: 'first', facets }] });

    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packs', 'core.openwop.kanban-work-items');
    const manifest = JSON.parse(readFileSync(join(root, 'pack.json'), 'utf8')) as { version: string; nodes: Array<{ version: string }> };
    expect(manifest.version).toBe('1.3.0');
    expect(manifest.nodes[0]?.version).toBe('1.3.0');
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(join(root, 'schemas', 'materialize.input.json'), 'utf8')) as object);
    const withFacets = (f: unknown) => ({ boardId: 'b', proposal: { ...proposal, items: [{ ...proposal.items[0], facets: f }] } });
    expect(validate(withFacets(facets)), JSON.stringify(validate.errors)).toBe(true);
    const full = Object.fromEntries(Array.from({ length: FACETS_MAX }, (_, i) => [`k${i}`, 'v']));
    expect(validate(withFacets(full)), 'exactly the host maximum').toBe(true);
    expect(validate(withFacets({ ...full, extra: 'v' })), 'one past the host maximum').toBe(false);
    expect(validate(withFacets({ stage: 'x'.repeat(FACET_VALUE_MAX) }))).toBe(true);
    expect(validate(withFacets({ stage: 'x'.repeat(FACET_VALUE_MAX + 1) }))).toBe(false);
    expect(validate(withFacets({ stage: '' }))).toBe(false);
    expect(validate(withFacets({ stage: 'rough\nin' })), 'a control character').toBe(false);
    expect(validate(withFacets({ stage: 7 }))).toBe(false);
    for (const key of ['Stage', '9room', 'a'.repeat(33), 'has space']) {
      expect(FACET_KEY_RE.test(key), key).toBe(false);
      expect(validate(withFacets({ [key]: 'v' })), key).toBe(false);
    }
    expect(validate(withFacets({ ['a'.repeat(32)]: 'v' }))).toBe(true);
  });
});
