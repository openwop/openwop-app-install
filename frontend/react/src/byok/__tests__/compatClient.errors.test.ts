/**
 * ADR 0779 D7 (grade-ux H1) — the compat client's error carries the server
 * envelope, so the card shows the validation sentence ("baseUrl must be https …")
 * instead of classifying a 400 as "Something went wrong. Retry."
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCompatEndpoint } from '../lib/compatClient.js';
import { byokErrorMessage } from '../lib/byokWriteAccess.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('compat client errors', () => {
  it('a 400 reaches byokErrorMessage as the server sentence', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'validation_error', message: 'baseUrl must be https' }), { status: 400, headers: { 'content-type': 'application/json' } })));
    const err = await createCompatEndpoint({ orgId: 'o', label: 'x', baseUrl: 'http://x', capabilities: {} } as never).catch((e: unknown) => e);
    expect(byokErrorMessage((k: string) => k, err)).toBe('baseUrl must be https');
  });
});
