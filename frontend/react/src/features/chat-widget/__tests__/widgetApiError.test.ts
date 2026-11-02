/**
 * ADR 1018 D8 — the client carries the server's `details.code`, so the console can map
 * `widget_byok_required` to translated copy instead of splicing the server's English.
 * Breaks if the code is dropped on the way from the envelope to `WidgetApiError`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WidgetApiError, isWidgetByokRequired, provisionWidget } from '../../../client/chatWidgetClient.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('chatWidgetClient error envelope (ADR 1018 D8)', () => {
  it('a 400 carrying details.code widget_byok_required is recognised', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'validation_error', message: 'needs key', details: { field: 'credential', code: 'widget_byok_required' } }), { status: 400 })));
    const err = await provisionWidget('o1', { agentId: 'a', allowedDomains: ['acme.com'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WidgetApiError);
    expect(err).toMatchObject({ field: 'credential', code: 'widget_byok_required' });
    expect(isWidgetByokRequired(err)).toBe(true);
  });

  it('any other refusal is not', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'validation_error', message: 'bad agent', details: { field: 'agentId' } }), { status: 400 })));
    const err = await provisionWidget('o1', { agentId: 'a', allowedDomains: ['acme.com'] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ field: 'agentId' });
    expect(isWidgetByokRequired(err)).toBe(false);
  });
});
