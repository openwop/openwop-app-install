/**
 * ADR 0051 §3/§5 — the assistant's `calendar.reschedule` A2UI clarification
 * (the fourth producer, sharing the `planClarification` dispatcher + the
 * `buildEventTimes` time builder with `calendar.invite`).
 *
 * The `feature.assistant.nodes.enqueue-action` node, for a `calendar.reschedule`
 * that names WHICH event (`payload.eventId`) but NOT a new time
 * (`payload.patch.start`), raises a `clarification` interrupt carrying a
 * date/slot/duration A2UI surface via `ctx.suspend` — the SAME bridge as the
 * other producers. The resumed time merges into `patch.start`/`patch.end` before
 * the single `enqueueActionWithApproval` enqueue. A missing `eventId` is NOT
 * clarified (the catalog has no event picker); an unusable resumed date fails
 * fast rather than enqueuing a no-op reschedule.
 *
 * Stub-ctx pattern (the assistant-loops convention): a real
 * `buildAssistantSurface` over the in-memory store + a controllable
 * `ctx.suspend` standing in for the executor's `makeSuspendFn`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { buildAssistantSurface } from '../src/features/assistant/surface.js';
import { __resetAssistantStore, listPendingActions } from '../src/features/assistant/assistantService.js';

const CATALOG_VERSION = '0.9.1';
const CATALOG = new Set(['heading', 'text', 'field.text', 'field.date', 'field.select', 'field.checkbox', 'action.button']);

describe('Assistant calendar.reschedule A2UI clarification (ADR 0051 §3/§5)', () => {
  let server: http.Server;
  let nodes: (typeof import('../../../packs/feature.assistant.nodes/index.mjs'))['nodes'];

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => {
      server = app.listen(0, res);
    });
    await __resetAssistantStore();
    nodes = (await import('../../../packs/feature.assistant.nodes/index.mjs')).nodes;
  });
  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  const enqueueAction = (ctx: unknown) => nodes['feature.assistant.nodes.enqueue-action'](ctx);
  const field = (r: { outputs?: Record<string, unknown> }, key: string): unknown => (r.outputs ?? {})[key];

  const assertCatalogValid = (payload: Record<string, unknown>): void => {
    expect(payload.catalogVersion).toBe(CATALOG_VERSION);
    const surface = payload.surface as { components?: unknown };
    expect(Array.isArray(surface.components)).toBe(true);
    for (const c of surface.components as Array<Record<string, unknown>>) {
      expect(CATALOG.has(String(c.component))).toBe(true);
      if (c.component === 'action.button') {
        expect((c.action as { target?: unknown }).target).toBe('resume');
      }
    }
  };

  it('a reschedule with a known event but no new time suspends with a date/slot surface', async () => {
    let captured: Record<string, unknown> | undefined;
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-resched' }) },
      inputs: { kind: 'calendar.reschedule', draft: 'Move the sync', payload: { eventId: 'evt123', patch: {} } },
      suspend: async (payload: Record<string, unknown>) => {
        captured = payload;
        throw new Error('__suspended__');
      },
    };
    await expect(enqueueAction(ctx)).rejects.toThrow('__suspended__');

    expect(captured!.reason).toBe('clarification');
    expect(captured!.resumeKey).toBe('calendar-reschedule-clarify');
    assertCatalogValid(captured!);
    const components = (captured!.surface as { components: Array<Record<string, unknown>> }).components;
    const ids = components.map((c) => c.id).filter((id): id is string => typeof id === 'string');
    expect(ids).toEqual(expect.arrayContaining(['date', 'time', 'durationMinutes']));
    // No event picker in the catalog — the surface never asks for an eventId.
    expect(ids).not.toContain('eventId');
  });

  it('resumed time merges into patch.start/end and preserves the eventId', async () => {
    const resume = { action: 'confirm', date: '2026-07-01', time: '14:00', durationMinutes: '60' };
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-resched2' }) },
      inputs: { kind: 'calendar.reschedule', draft: 'Move the sync', payload: { eventId: 'evt123', patch: { summary: 'Sync' } } },
      suspend: async () => resume,
    };
    const r = await enqueueAction(ctx);
    const pa = field(r, 'pendingAction') as {
      status: string;
      kind: string;
      payload: { eventId?: string; patch?: { start?: { dateTime?: string }; end?: { dateTime?: string }; summary?: string } };
    };
    expect(pa.status).toBe('pending');
    expect(pa.kind).toBe('calendar.reschedule');
    expect(pa.payload.eventId).toBe('evt123');
    expect(pa.payload.patch?.start).toEqual({ dateTime: '2026-07-01T14:00:00', timeZone: 'UTC' });
    expect(pa.payload.patch?.end).toEqual({ dateTime: '2026-07-01T15:00:00', timeZone: 'UTC' });
    // A pre-existing patch field survives the merge.
    expect(pa.payload.patch?.summary).toBe('Sync');
  });

  it('a missing eventId is NOT clarified (no event picker) — enqueues as-is', async () => {
    let suspendCalled = false;
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-resched3' }) },
      inputs: { kind: 'calendar.reschedule', draft: 'x', payload: { patch: {} } },
      suspend: async () => {
        suspendCalled = true;
        return {};
      },
    };
    const r = await enqueueAction(ctx);
    expect(suspendCalled).toBe(false);
    const pa = field(r, 'pendingAction') as { status: string };
    expect(pa.status).toBe('pending');
  });

  it('a reschedule that already names a new time does not clarify', async () => {
    let suspendCalled = false;
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-resched4' }) },
      inputs: {
        kind: 'calendar.reschedule',
        draft: 'x',
        payload: { eventId: 'evt9', patch: { start: { dateTime: '2026-07-02T10:00:00', timeZone: 'UTC' } } },
      },
      suspend: async () => {
        suspendCalled = true;
        return {};
      },
    };
    const r = await enqueueAction(ctx);
    expect(suspendCalled).toBe(false);
    const pa = field(r, 'pendingAction') as { payload: { patch?: { start?: { dateTime?: string } } } };
    expect(pa.payload.patch?.start?.dateTime).toBe('2026-07-02T10:00:00');
  });

  it('an unusable resumed date fails fast — no no-op reschedule is enqueued', async () => {
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-resched5' }) },
      inputs: { kind: 'calendar.reschedule', draft: 'x', payload: { eventId: 'evt5', patch: {} } },
      suspend: async () => ({ action: 'confirm', date: 'not-a-date', time: '14:00', durationMinutes: '60' }),
    };
    await expect(enqueueAction(ctx)).rejects.toThrow(/new time/);
    expect((await listPendingActions('t-resched5')).length).toBe(0);
  });
});
