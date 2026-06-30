/**
 * ADR 0051 §3/§5 — the assistant's `email.send` A2UI clarification (the third
 * producer, sharing the per-kind `planClarification` dispatcher with
 * `calendar.invite`).
 *
 * The `feature.assistant.nodes.enqueue-action` node, for an `email.send` the
 * assistant drafted WITHOUT a recipient, raises a `clarification` interrupt
 * carrying a missing-fields A2UI surface (RFC 0102 `ui.a2ui-surface`, day-1
 * catalog 0.9.1) via `ctx.suspend` — the SAME interrupt→`a2uiInterruptCard`
 * bridge as the calendar producer. The resumed recipient/subject merge into the
 * payload before the single `enqueueActionWithApproval` enqueue. A missing
 * SUBJECT alone is not blocking (it has a default), so it does not interrupt.
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

// Mirrors the host-pinned closed catalog (frontend `chat/a2ui/catalog.ts`).
const CATALOG_VERSION = '0.9.1';
const CATALOG = new Set(['heading', 'text', 'field.text', 'field.date', 'field.select', 'field.checkbox', 'action.button']);

describe('Assistant email.send A2UI clarification (ADR 0051 §3/§5)', () => {
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

  it('an email.send with no recipient suspends with an A2UI surface asking for it', async () => {
    let captured: Record<string, unknown> | undefined;
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-mail' }) },
      inputs: { kind: 'email.send', draft: 'Thanks for the chat — following up.', payload: {} },
      suspend: async (payload: Record<string, unknown>) => {
        captured = payload;
        throw new Error('__suspended__');
      },
    };
    await expect(enqueueAction(ctx)).rejects.toThrow('__suspended__');

    expect(captured!.reason).toBe('clarification');
    expect(captured!.resumeKey).toBe('email-send-clarify');
    assertCatalogValid(captured!);
    const components = (captured!.surface as { components: Array<Record<string, unknown>> }).components;
    const ids = components.map((c) => c.id).filter((id): id is string => typeof id === 'string');
    // No recipient and no subject → asks for both.
    expect(ids).toEqual(expect.arrayContaining(['to', 'subject']));
    expect(components.some((c) => c.component === 'action.button')).toBe(true);
  });

  it('resumed recipient + subject merge into the payload and enqueue', async () => {
    const resume = { action: 'confirm', to: 'sam@acme.com, lee@acme.com', subject: 'Following up' };
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-mail2' }) },
      inputs: { kind: 'email.send', draft: 'Following up on our chat.', payload: {} },
      suspend: async () => resume,
    };
    const r = await enqueueAction(ctx);
    const pa = field(r, 'pendingAction') as { status: string; kind: string; payload: { to?: unknown; subject?: unknown } };
    expect(pa.status).toBe('pending');
    expect(pa.kind).toBe('email.send');
    expect(pa.payload.to).toEqual(['sam@acme.com', 'lee@acme.com']);
    expect(pa.payload.subject).toBe('Following up');
  });

  it('a recipient already present → no clarification (subject-only gap is not blocking)', async () => {
    let suspendCalled = false;
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-mail3' }) },
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

  it('a fully-specified email.send enqueues directly — no clarification', async () => {
    let suspendCalled = false;
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-mail4' }) },
      inputs: { kind: 'email.send', draft: 'Hi', payload: { to: ['a@b.com'], subject: 'Re: sync' } },
      suspend: async () => {
        suspendCalled = true;
        return {};
      },
    };
    const r = await enqueueAction(ctx);
    expect(suspendCalled).toBe(false);
    const pa = field(r, 'pendingAction') as { payload: { subject?: string } };
    expect(pa.payload.subject).toBe('Re: sync');
  });

  it('the recipient field re-validates the resumed value (drops non-emails)', async () => {
    const resume = { action: 'confirm', to: 'not-an-email, real@acme.com, also bad' };
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-mail5' }) },
      inputs: { kind: 'email.send', draft: 'Hi', payload: {} },
      suspend: async () => resume,
    };
    const r = await enqueueAction(ctx);
    const pa = field(r, 'pendingAction') as { payload: { to?: unknown } };
    expect(pa.payload.to).toEqual(['real@acme.com']);
  });

  it('an all-invalid recipient on resume fails fast — no doomed email is enqueued', async () => {
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-mail6' }) },
      inputs: { kind: 'email.send', draft: 'Hi', payload: {} },
      // Only invalid addresses → after re-validation the recipient is still missing.
      suspend: async () => ({ action: 'confirm', to: 'nope, also-bad' }),
    };
    await expect(enqueueAction(ctx)).rejects.toThrow(/recipient/);
    // The node failed BEFORE the enqueue — the store has no pending action.
    expect((await listPendingActions('t-mail6')).length).toBe(0);
  });

  it('a CR/LF-bearing recipient is rejected (header-injection defense)', async () => {
    const ctx = {
      features: { assistant: buildAssistantSurface({ tenantId: 't-mail7' }) },
      inputs: { kind: 'email.send', draft: 'Hi', payload: {} },
      // The newline makes the whole token fail the email regex → dropped → still missing → fail fast.
      suspend: async () => ({ action: 'confirm', to: 'a@b.com\nBcc: evil@x.com' }),
    };
    await expect(enqueueAction(ctx)).rejects.toThrow(/recipient/);
  });
});
