/**
 * ADR 0819 §5 — the toggle admin client turns the server's 409 into a typed
 * error carrying `reason`, which the panel keys its "re-read this toggle"
 * recovery on. The body shape is the canonical flat envelope the backend
 * sends (`{ error, message, details: { reason } }`), read through
 * `errorEnvelope.ts` rather than parsed by hand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveToggleConfig, deleteToggleConfig, ToggleAdminError } from '../featureTogglesClient.js';
import { config } from '../config.js';

afterEach(() => { vi.unstubAllGlobals(); });

const CONFLICT_MESSAGE = 'Feature toggle "forms" was changed by someone else.';
const conflict = (): Response => new Response(
  JSON.stringify({ error: 'conflict', message: CONFLICT_MESSAGE, details: { id: 'forms', reason: 'revision_conflict', revision: 'abc' } }),
  { status: 409, headers: { 'content-type': 'application/json' } },
);
const TOGGLE_URL = `${config.baseUrl}/host/openwop-app/feature-toggles/admin/configs/forms`;

function fetchStub() {
  const m = vi.fn(async (_url: string, _init?: RequestInit) => conflict());
  vi.stubGlobal('fetch', m);
  return m;
}

describe('toggle admin client errors', () => {
  it('a stale save sends its revision and rejects with reason revision_conflict and the server message', async () => {
    const m = fetchStub();
    const err = await saveToggleConfig('forms', { status: 'on', bucketUnit: 'user', salt: 'forms', revision: 'old' }).catch((e: unknown) => e);
    expect(m.mock.calls[0]![0]).toBe(TOGGLE_URL);
    expect(m.mock.calls[0]![1]!.method).toBe('PUT');
    expect((JSON.parse(String(m.mock.calls[0]![1]!.body)) as { revision?: unknown }).revision).toBe('old');
    expect(err).toBeInstanceOf(ToggleAdminError);
    expect((err as ToggleAdminError).reason).toBe('revision_conflict');
    expect((err as ToggleAdminError).status).toBe(409);
    expect((err as ToggleAdminError).message).toBe(CONFLICT_MESSAGE);
  });

  it('a revert sends the revision precondition and surfaces the server message', async () => {
    const m = fetchStub();
    const err = await deleteToggleConfig('forms', 'abc').catch((e: unknown) => e);
    expect(m.mock.calls[0]![0]).toBe(`${TOGGLE_URL}?revision=abc`);
    expect(m.mock.calls[0]![1]!.method).toBe('DELETE');
    expect(err).toBeInstanceOf(ToggleAdminError);
    expect((err as ToggleAdminError).reason).toBe('revision_conflict');
    expect((err as ToggleAdminError).status).toBe(409);
    expect((err as ToggleAdminError).message).toBe(CONFLICT_MESSAGE);
  });
});
