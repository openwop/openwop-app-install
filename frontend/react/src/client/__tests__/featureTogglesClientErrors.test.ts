/**
 * ADR 0819 §5 — the toggle admin client turns the server's 409 into a typed
 * error carrying `reason`, which the panel keys its "re-read this toggle"
 * recovery on. The body shape is the canonical flat envelope the backend
 * sends (`{ error, message, details: { reason } }`), read through
 * `errorEnvelope.ts` rather than parsed by hand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveToggleConfig, deleteToggleConfig, ToggleAdminError } from '../featureTogglesClient.js';

afterEach(() => { vi.unstubAllGlobals(); });

const conflict = (): Response => ({
  ok: false,
  status: 409,
  json: async () => ({ error: 'conflict', message: 'Feature toggle "forms" was changed by someone else.', details: { id: 'forms', reason: 'revision_conflict', revision: 'abc' } }),
}) as unknown as Response;

describe('toggle admin client errors', () => {
  it('a stale save rejects with reason revision_conflict and the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => conflict()));
    const err = await saveToggleConfig('forms', { status: 'on', bucketUnit: 'user', salt: 'forms', revision: 'old' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToggleAdminError);
    expect((err as ToggleAdminError).reason).toBe('revision_conflict');
    expect((err as ToggleAdminError).status).toBe(409);
    expect((err as Error).message).toContain('changed by someone else');
  });

  it('a revert sends the revision precondition and surfaces the server message', async () => {
    const m = vi.fn(async (_url: string, _init?: RequestInit) => conflict());
    vi.stubGlobal('fetch', m);
    const err = await deleteToggleConfig('forms', 'abc').catch((e: unknown) => e);
    expect(String(m.mock.calls[0]![0])).toContain('?revision=abc');
    expect((err as ToggleAdminError).reason).toBe('revision_conflict');
  });
});
