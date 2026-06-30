/**
 * ADR 0051 §3/§5 — the assistant's `calendar.invite` A2UI clarification.
 *
 * The `feature.assistant.nodes.enqueue-action` node, for an INCOMPLETE
 * `calendar.invite` (missing title / start / attendees), raises a
 * `clarification` interrupt carrying an A2UI surface (RFC 0102
 * `ui.a2ui-surface`) via `ctx.suspend` — the SAME interrupt→`a2uiInterruptCard`
 * bridge the chat already renders (`chat/a2ui/interruptBridge.ts` + `MessageFeed`),
 * the same one `local.openwop-app.a2ui-clarify` uses. The resumed field values
 * merge into `payload.event` before the single enqueue path
 * (`enqueueActionWithApproval`) runs.
 *
 * Nodes run over a stub ctx (the csm-/assistant-loops pattern): a REAL
 * `buildAssistantSurface` over the in-memory store + a controllable `ctx.suspend`
 * standing in for the executor's `makeSuspendFn` (`executor/suspendSignal.ts`) —
 * the first call suspends (throws, as the SuspendSignal does), and the resume
 * re-invocation returns the recorded value inline.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { buildAssistantSurface } from '../src/features/assistant/surface.js';
import { __resetAssistantStore } from '../src/features/assistant/assistantService.js';

// Mirrors the host-pinned closed catalog (frontend `chat/a2ui/catalog.ts`
// SUPPORTED_COMPONENTS + A2UI_CATALOG_VERSION) — the renderer fail-closes on
// anything outside it, so a producer surface MUST stay within this set.
const CATALOG_VERSION = '0.9.1';
const CATALOG = new Set(['heading', 'text', 'field.text', 'field.date', 'field.select', 'field.checkbox', 'action.button']);

describe('Assistant calendar.invite A2UI clarification (ADR 0051 §3/§5)', () => {
  let server: http.Server;
  // Typed from the pack's ambient module declaration (test/feature-packs.d.ts) —
  // no `any`, no eslint-disable (mirrors the assistant-loops test pattern).
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

  // Resolved per-call (not hoisted) — `nodes` is populated in beforeAll.
  const enqueueAction = (ctx: unknown) => nodes['feature.assistant.nodes.enqueue-action'](ctx);
  const field = (r: { outputs?: Record<string, unknown> }, key: string): unknown => (r.outputs ?? {})[key];

  /** Assert a suspend payload carries a closed-catalog-valid A2UI surface. */
  const assertCatalogValid = (payload: Record<string, unknown>): void => {
    expect(payload.catalogVersion).toBe(CATALOG_VERSION);
    const surface = payload.surface as { title?: unknown; components?: unknown };
    expect(Array.isArray(surface.components)).toBe(true);
    for (const c of surface.components as Array<Record<string, unknown>>) {
      expect(CATALOG.has(String(c.component))).toBe(true);
      if (c.component === 'action.button') {
        // §A rule 4 — a surface action resolves to a host-allowlisted target only.
        expect((c.action as { target?: unknown }).target).toBe('resume');
      }
      if (c.component === 'field.select') {
        expect(Array.isArray(c.options)).toBe(true);
        expect((c.options as unknown[]).length).toBeGreaterThan(0);
      }
    }
  };

  it('an incomplete calendar.invite suspends with an A2UI surface for the missing fields', async () => {
    let captured: Record<string, unknown> | undefined;
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-cal' }) },
      inputs: { kind: 'calendar.invite', draft: 'Set up the kickoff', payload: { event: {} } },
      // Stand in for the executor's first-call SuspendSignal throw.
      suspend: async (payload: Record<string, unknown>) => {
        captured = payload;
        throw new Error('__suspended__');
      },
    };
    await expect(enqueueAction(ctx)).rejects.toThrow('__suspended__');

    expect(captured).toBeDefined();
    expect(captured!.reason).toBe('clarification');
    expect(captured!.resumeKey).toBe('calendar-invite-clarify');
    assertCatalogValid(captured!);

    const components = (captured!.surface as { components: Array<Record<string, unknown>> }).components;
    const ids = components.map((c) => c.id).filter((id): id is string => typeof id === 'string');
    // All three essentials were missing → the surface asks for each.
    expect(ids).toEqual(expect.arrayContaining(['summary', 'date', 'time', 'durationMinutes', 'attendees']));
    expect(components.some((c) => c.component === 'action.button')).toBe(true);
    // `time` is a constrained slot picker (no wire change — `field.select` is in
    // the day-1 catalog), not a free-text field, so the user can't mistype it.
    const time = components.find((c) => c.id === 'time');
    expect(time?.component).toBe('field.select');
    expect(Array.isArray(time?.options) && (time?.options as unknown[]).length).toBeGreaterThan(0);
  });

  it('asks for ONLY the missing field when the rest of the event is present', async () => {
    let captured: Record<string, unknown> | undefined;
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-cal-partial' }) },
      inputs: {
        kind: 'calendar.invite',
        draft: 'Kickoff',
        // Title + start present; only attendees missing.
        payload: { event: { summary: 'Kickoff', start: { dateTime: '2026-07-01T14:00:00' } } },
      },
      suspend: async (payload: Record<string, unknown>) => {
        captured = payload;
        throw new Error('__suspended__');
      },
    };
    await expect(enqueueAction(ctx)).rejects.toThrow('__suspended__');
    const components = (captured!.surface as { components: Array<Record<string, unknown>> }).components;
    const ids = components.map((c) => c.id).filter((id): id is string => typeof id === 'string');
    expect(ids).toContain('attendees');
    expect(ids).not.toContain('summary');
    expect(ids).not.toContain('date');
  });

  it('resumed values merge into payload.event and enqueue a complete invite', async () => {
    const resume = {
      action: 'confirm',
      summary: 'Kickoff with Acme',
      date: '2026-07-01',
      time: '14:00',
      durationMinutes: '60',
      attendees: 'sam@acme.com, lee@acme.com',
    };
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-cal2' }) },
      inputs: { kind: 'calendar.invite', draft: 'Set up the kickoff', payload: { event: {} } },
      // On resume, the executor re-invokes the node and ctx.suspend returns the
      // recorded resume value inline (suspendSignal.ts short-circuit).
      suspend: async () => resume,
    };
    const r = await enqueueAction(ctx);
    const pa = field(r, 'pendingAction') as { status: string; kind: string; payload: { event: Record<string, unknown> } };
    expect(pa.status).toBe('pending');
    expect(pa.kind).toBe('calendar.invite');

    const e = pa.payload.event as {
      summary?: string;
      start?: { dateTime?: string; timeZone?: string };
      end?: { dateTime?: string; timeZone?: string };
      attendees?: Array<{ email: string }>;
    };
    expect(e.summary).toBe('Kickoff with Acme');
    expect(e.start).toEqual({ dateTime: '2026-07-01T14:00:00', timeZone: 'UTC' });
    expect(e.end).toEqual({ dateTime: '2026-07-01T15:00:00', timeZone: 'UTC' }); // start + 60 min
    expect(e.attendees).toEqual([{ email: 'sam@acme.com' }, { email: 'lee@acme.com' }]);
  });

  it('an unparseable free-text time falls back to 09:00 (never a NaN dateTime)', async () => {
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-cal-badtime' }) },
      inputs: { kind: 'calendar.invite', draft: 'Kickoff', payload: { event: {} } },
      // `time` is a free-text field — "99:99" must not leak into the dateTime.
      suspend: async () => ({ action: 'confirm', summary: 'K', date: '2026-07-01', time: '99:99', durationMinutes: '30', attendees: 'a@b.com' }),
    };
    const r = await enqueueAction(ctx);
    const pa = field(r, 'pendingAction') as { payload: { event: { start?: { dateTime?: string }; end?: { dateTime?: string } } } };
    expect(pa.payload.event.start?.dateTime).toBe('2026-07-01T09:00:00');
    expect(pa.payload.event.end?.dateTime).toBe('2026-07-01T09:30:00');
    expect(JSON.stringify(pa.payload.event)).not.toContain('NaN');
  });

  it('an unparseable date drops the start entirely (no NaN-laced dateTime enqueued)', async () => {
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-cal-baddate' }) },
      inputs: { kind: 'calendar.invite', draft: 'Kickoff', payload: { event: {} } },
      suspend: async () => ({ action: 'confirm', summary: 'K', date: 'not-a-date', time: '14:00', durationMinutes: '60', attendees: 'a@b.com' }),
    };
    const r = await enqueueAction(ctx);
    const pa = field(r, 'pendingAction') as { payload: { event: Record<string, unknown> } };
    expect(pa.payload.event.start).toBeUndefined();
    expect(pa.payload.event.end).toBeUndefined();
    expect(JSON.stringify(pa.payload.event)).not.toContain('NaN');
    // The other clarified fields still merged.
    expect((pa.payload.event as { summary?: string }).summary).toBe('K');
  });

  it('a complete calendar.invite enqueues directly — no clarification raised', async () => {
    let suspendCalled = false;
    const completeEvent = {
      summary: 'Weekly sync',
      start: { dateTime: '2026-07-02T10:00:00' },
      end: { dateTime: '2026-07-02T10:30:00' },
      attendees: [{ email: 'a@b.com' }],
    };
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-cal3' }) },
      inputs: { kind: 'calendar.invite', draft: 'sync', payload: { event: completeEvent } },
      suspend: async () => {
        suspendCalled = true;
        return {};
      },
    };
    const r = await enqueueAction(ctx);
    expect(suspendCalled).toBe(false);
    const pa = field(r, 'pendingAction') as { payload: { event: { summary?: string } } };
    expect(pa.payload.event.summary).toBe('Weekly sync');
  });

  it('email.send is unaffected by the calendar clarification branch', async () => {
    let suspendCalled = false;
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-cal4' }) },
      inputs: { kind: 'email.send', draft: 'Hi', payload: { to: 'x@y.com' } },
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
});
