/**
 * ADR 0463 — the KickBot replan A2UI clarification leg.
 *
 * The `feature.kicktodo.nodes.replan-clarify` node sits BETWEEN the replan
 * composer and enrich (ADR 0459 flow). When the composer's plan-revision carries
 * an OPTIONAL `clarification` (ASK XOR ACT — an under-specified intent within the
 * ADR 0429 lanes, e.g. "move my rest day" with no day), the node raises a
 * `clarification` interrupt carrying an A2UI surface (RFC 0102 `ui.a2ui-surface`)
 * via `ctx.suspend` — the SAME interrupt→`a2uiInterruptCard` bridge the chat
 * renders — and folds the collected answer into the pending command's single
 * unfilled slot. With no clarification, or in a non-executor context with no
 * `ctx.suspend`, it passes the revision through UNCHANGED (bounded to one round).
 *
 * The node is unit-tested directly over the loaded pack (the kicktodo-0459-pack
 * pattern): a controllable `ctx.suspend` stands in for the executor's
 * `makeSuspendFn` (`executor/suspendSignal.ts`) — the first call suspends (throws,
 * as the SuspendSignal does), and the resume re-invocation returns the recorded
 * value inline.
 */

import { describe, expect, it } from 'vitest';

// Mirrors the host-pinned closed catalog (frontend `chat/a2ui/catalog.ts`
// SUPPORTED_COMPONENTS + A2UI_CATALOG_VERSION) — the renderer fail-closes on
// anything outside it, so a producer surface MUST stay within this set.
const CATALOG_VERSION = '0.9.1';
const CATALOG = new Set(['heading', 'text', 'field.text', 'field.date', 'field.select', 'field.checkbox', 'action.button']);

type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: { code: string } };
type Ctx = Record<string, unknown>;
const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;

async function replanClarify(): Promise<(ctx: Ctx) => Promise<NodeResult>> {
  const m = (await import(packUrl)) as { nodes: Record<string, (ctx: Ctx) => Promise<NodeResult>> };
  return m.nodes['feature.kicktodo.nodes.replan-clarify'];
}

/** Assert a suspend payload carries a closed-catalog-valid A2UI surface. */
function assertCatalogValid(payload: Record<string, unknown>): void {
  expect(payload.reason).toBe('clarification');
  expect(payload.resumeKey).toBe('replan-clarify');
  expect(payload.catalogVersion).toBe(CATALOG_VERSION);
  const surface = payload.surface as { title?: unknown; components?: unknown };
  expect(Array.isArray(surface.components)).toBe(true);
  for (const c of surface.components as Array<Record<string, unknown>>) {
    expect(CATALOG.has(String(c.component))).toBe(true);
    if (c.component === 'action.button') {
      // A surface action resolves to a host-allowlisted target only.
      expect((c.action as { target?: unknown }).target).toBe('resume');
    }
    if (c.component === 'field.select') {
      expect(Array.isArray(c.options)).toBe(true);
      expect((c.options as unknown[]).length).toBeGreaterThan(0);
    }
  }
}

describe('KickTodo replan-clarify A2UI clarification (ADR 0463)', () => {
  it('is registered in the pack', async () => {
    expect(typeof (await replanClarify())).toBe('function');
  });

  it('(a) a revision WITH a `select` clarification suspends with a catalog-valid surface; the resumed answer fills the pending command', async () => {
    const revision = {
      commands: [],
      rationale: 'I need to know which day is your rest day before I can move it.',
      clarification: {
        question: 'Which day is your rest day?',
        field: { id: 'daypart', type: 'select', label: 'Rest day', options: ['monday', 'wednesday', 'sunday'] },
        pendingCommand: { lane: 'schedule' },
      },
    };

    // First pass: the executor's SuspendSignal throw.
    let captured: Record<string, unknown> | undefined;
    const run = await replanClarify();
    await expect(
      run({
        inputs: { revision },
        suspend: async (payload: Record<string, unknown>) => {
          captured = payload;
          throw new Error('__suspended__');
        },
      }),
    ).rejects.toThrow('__suspended__');

    expect(captured).toBeDefined();
    expect(captured!.question).toBe('Which day is your rest day?');
    assertCatalogValid(captured!);

    const components = (captured!.surface as { components: Array<Record<string, unknown>> }).components;
    const text = components.find((c) => c.component === 'text');
    expect(text?.text).toBe('Which day is your rest day?');
    const selectField = components.find((c) => c.id === 'daypart');
    expect(selectField?.component).toBe('field.select');
    expect(selectField?.required).toBe(true);
    expect(selectField?.options).toEqual(['monday', 'wednesday', 'sunday']);
    expect(components.some((c) => c.component === 'action.button')).toBe(true);

    // Resume: ctx.suspend returns the recorded values inline; the slot is filled.
    const resumed = await run({
      inputs: { revision },
      suspend: async () => ({ daypart: 'wednesday' }),
    });
    expect(resumed.status).toBe('success');
    const result = resumed.outputs?.result as { commands: unknown[]; rationale: string };
    expect(result.commands).toEqual([{ lane: 'schedule', daypart: 'wednesday' }]);
    expect(result.rationale).toBe(revision.rationale);
  });

  it('(a2) a `date` clarification builds a field.date surface and folds the answer into the slot', async () => {
    const revision = {
      commands: [],
      rationale: 'Which date should the recovery land on?',
      clarification: {
        question: 'What date should we move it to?',
        field: { id: 'targetDate', type: 'date', label: 'New date' },
        pendingCommand: { lane: 'recovery' },
      },
    };
    let captured: Record<string, unknown> | undefined;
    const run = await replanClarify();
    await expect(
      run({
        inputs: { revision },
        suspend: async (payload: Record<string, unknown>) => {
          captured = payload;
          throw new Error('__suspended__');
        },
      }),
    ).rejects.toThrow('__suspended__');
    assertCatalogValid(captured!);
    const components = (captured!.surface as { components: Array<Record<string, unknown>> }).components;
    const dateField = components.find((c) => c.id === 'targetDate');
    expect(dateField?.component).toBe('field.date');
    expect(dateField?.options).toBeUndefined();

    const resumed = await run({ inputs: { revision }, suspend: async () => ({ targetDate: '2026-08-01' }) });
    const result = resumed.outputs?.result as { commands: unknown[] };
    expect(result.commands).toEqual([{ lane: 'recovery', targetDate: '2026-08-01' }]);
  });

  it('(b) a revision WITHOUT a clarification passes through UNCHANGED (no suspend)', async () => {
    const revision = { commands: [{ lane: 'recovery' }], rationale: 'Applying your recovery collapse.' };
    let suspendCalled = false;
    const run = await replanClarify();
    const out = await run({
      inputs: { revision },
      suspend: async () => {
        suspendCalled = true;
        return {};
      },
    });
    expect(suspendCalled).toBe(false);
    expect(out.status).toBe('success');
    expect(out.outputs?.result).toEqual(revision);
  });

  it('(c) a clarification WITHOUT ctx.suspend degrades to passthrough (non-executor context)', async () => {
    const revision = {
      commands: [],
      rationale: 'Need a day.',
      clarification: {
        question: 'Which day?',
        field: { id: 'daypart', type: 'select', label: 'Day', options: ['monday'] },
        pendingCommand: { lane: 'schedule' },
      },
    };
    const run = await replanClarify();
    const out = await run({ inputs: { revision } });
    expect(out.status).toBe('success');
    // No executor suspend ⇒ the revision (with its clarification) rides through unchanged.
    expect(out.outputs?.result).toEqual(revision);
  });

  it('a missing `revision` input is a typed validation failure', async () => {
    const run = await replanClarify();
    const out = await run({ inputs: {} });
    expect(out.status).toBe('failed');
    expect(out.error?.code).toBe('validation_error');
  });
});
