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

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The closed catalog is READ FROM ITS SSoT — the renderer's own
// `frontend/react/src/chat/a2ui/catalog.ts` (`A2UI_CATALOG_VERSION` +
// `SUPPORTED_COMPONENTS`), which fail-closes on anything outside it. A hand-copied
// list here could drift from what the chat actually renders (CLAUDE.md § AI
// exchange: schema text is generated from or test-pinned to its SSoT). The backend
// cannot import the SPA module (i18n/React deps), so the source is parsed.
const CATALOG_SRC = readFileSync(new URL('../../../frontend/react/src/chat/a2ui/catalog.ts', import.meta.url), 'utf8');
const CATALOG_VERSION = /export const A2UI_CATALOG_VERSION = '([^']+)';/.exec(CATALOG_SRC)?.[1] ?? '';
const CATALOG = new Set(
  [...(/export const SUPPORTED_COMPONENTS = \[([\s\S]*?)\] as const;/.exec(CATALOG_SRC)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? ''),
);

type NodeResult = { status: string; outputs?: Record<string, unknown>; error?: { code: string } };
/** One A2UI component as the node emits it (the fields these cases read). */
interface SurfaceComponent { component: string; id?: string; text?: string; label?: string; required?: boolean; options?: unknown[]; action?: { target?: unknown } }
/** The `ctx.suspend` payload the node raises. */
interface SuspendPayload { reason?: string; resumeKey?: string; question?: string; catalogVersion?: string; surface?: { title?: string; components?: SurfaceComponent[] } }
interface Ctx { inputs: Record<string, unknown>; suspend?: (payload: SuspendPayload) => Promise<unknown> }
const packUrl = new URL('../../../packs/feature.kicktodo.nodes/index.mjs', import.meta.url).href;

async function replanClarify(): Promise<(ctx: Ctx) => Promise<NodeResult>> {
  // The pack is untyped `.mjs`: this one boundary cast is the honest ceiling.
  const m = (await import(packUrl)) as { nodes: Record<string, (ctx: Ctx) => Promise<NodeResult>> };
  return m.nodes['feature.kicktodo.nodes.replan-clarify'];
}

/** Assert a suspend payload carries a closed-catalog-valid A2UI surface; returns its components. */
function assertCatalogValid(payload: SuspendPayload | undefined): SurfaceComponent[] {
  if (!payload) throw new Error('the node must suspend with a payload');
  expect(payload.reason).toBe('clarification');
  expect(payload.resumeKey).toBe('replan-clarify');
  expect(payload.catalogVersion).toBe(CATALOG_VERSION);
  const components = payload.surface?.components ?? [];
  expect(components.length).toBeGreaterThan(0);
  for (const c of components) {
    expect(CATALOG.has(c.component)).toBe(true);
    if (c.component === 'action.button') {
      // A surface action resolves to a host-allowlisted target only.
      expect(c.action?.target).toBe('resume');
    }
    if (c.component === 'field.select') {
      expect(c.options?.length ?? 0).toBeGreaterThan(0);
    }
  }
  return components;
}

describe('KickTodo replan-clarify A2UI clarification (ADR 0463)', () => {
  it('reads the closed catalog from its SSoT (never an empty / unparsed list)', () => {
    // If the parse ever silently found nothing, assertCatalogValid would be checking
    // against an empty set and every surface case below would go red for the wrong
    // reason — or, worse, a version of '' would match nothing meaningful.
    expect(CATALOG_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CATALOG.size).toBeGreaterThanOrEqual(7);
    for (const c of ['text', 'field.select', 'field.date', 'action.button']) expect(CATALOG.has(c)).toBe(true);
  });

  // Twin: every case below calls the node. Kept, and strengthened to the pack's
  // MANIFEST — the export alone does not make a typeId resolvable by the loader.
  it('is registered in the pack', async () => {
    expect(typeof (await replanClarify())).toBe('function');
    const manifest: { nodes?: Array<{ typeId?: string }> } = JSON.parse(
      readFileSync(new URL('../../../packs/feature.kicktodo.nodes/pack.json', import.meta.url), 'utf8'),
    );
    expect((manifest.nodes ?? []).map((n) => n.typeId)).toContain('feature.kicktodo.nodes.replan-clarify');
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
    let captured: SuspendPayload | undefined;
    const run = await replanClarify();
    await expect(
      run({
        inputs: { revision },
        suspend: async (payload) => {
          captured = payload;
          throw new Error('__suspended__');
        },
      }),
    ).rejects.toThrow('__suspended__');

    expect(captured?.question).toBe('Which day is your rest day?');
    const components = assertCatalogValid(captured);
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
    expect(resumed.outputs?.result).toEqual({ commands: [{ lane: 'schedule', daypart: 'wednesday' }], rationale: revision.rationale });
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
    let captured: SuspendPayload | undefined;
    const run = await replanClarify();
    await expect(
      run({
        inputs: { revision },
        suspend: async (payload) => {
          captured = payload;
          throw new Error('__suspended__');
        },
      }),
    ).rejects.toThrow('__suspended__');
    const components = assertCatalogValid(captured);
    const dateField = components.find((c) => c.id === 'targetDate');
    expect(dateField?.component).toBe('field.date');
    expect(dateField?.options).toBeUndefined();

    const resumed = await run({ inputs: { revision }, suspend: async () => ({ targetDate: '2026-08-01' }) });
    expect(resumed.outputs?.result).toEqual({ commands: [{ lane: 'recovery', targetDate: '2026-08-01' }], rationale: revision.rationale });
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

  // XCH-RC-3 — the answer must be one the form offered, and a revision may ask
  // OR act, never both. Sabotage: removing clarificationAnswerDefect fills the
  // command with 'friday'; removing the ambiguity check drops the commands and
  // asks anyway.
  describe('ASK XOR ACT and offered answers only (XCH-RC-3)', () => {
    const select = {
      commands: [],
      rationale: 'Which rest day?',
      clarification: {
        question: 'Which day is your rest day?',
        field: { id: 'daypart', type: 'select', label: 'Rest day', options: ['monday', { value: 'sunday', label: 'Sunday' }] },
        pendingCommand: { lane: 'schedule' },
      },
    };

    it('an answer outside field.options is a typed failure, never a filled command', async () => {
      const run = await replanClarify();
      const out = await run({ inputs: { revision: select }, suspend: async () => ({ daypart: 'friday' }) });
      expect(out.status).toBe('failed');
      expect(out.error?.code).toBe('clarification_answer_invalid');
    });

    it('an offered answer (string or {value} option) fills the command', async () => {
      const run = await replanClarify();
      for (const daypart of ['monday', 'sunday']) {
        const out = await run({ inputs: { revision: select }, suspend: async () => ({ daypart }) });
        expect(out.status).toBe('success');
        expect(out.outputs?.result).toEqual({ commands: [{ lane: 'schedule', daypart }], rationale: 'Which rest day?' });
      }
    });

    it('a missing answer or a malformed date is a typed failure', async () => {
      const run = await replanClarify();
      expect((await run({ inputs: { revision: select }, suspend: async () => ({}) })).error?.code).toBe('clarification_answer_invalid');
      const date = { ...select, clarification: { ...select.clarification, field: { id: 'restDate', type: 'date', label: 'Date' } } };
      expect((await run({ inputs: { revision: date }, suspend: async () => ({ restDate: 'next tuesday' }) })).error?.code).toBe('clarification_answer_invalid');
      expect((await run({ inputs: { revision: date }, suspend: async () => ({ restDate: '2026-10-20' }) })).status).toBe('success');
    });

    it('a revision with BOTH commands and a clarification is revision_ambiguous, and nothing is asked', async () => {
      const run = await replanClarify();
      let asked = false;
      const out = await run({
        inputs: { revision: { ...select, commands: [{ lane: 'recovery' }] } },
        suspend: async () => { asked = true; return { daypart: 'monday' }; },
      });
      expect(out.status).toBe('failed');
      expect(out.error?.code).toBe('revision_ambiguous');
      expect(asked).toBe(false);
    });
  });
});
