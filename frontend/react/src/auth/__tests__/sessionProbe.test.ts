/**
 * Issue 5991 — the session probe reads "not signed in" from a 204, so a public page
 * logs no failed request. An older host that still answers 401 throws as before, and
 * the session store already settles that to "no user".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMeIfSignedIn, UsersApiError } from '../../features/users/usersClient.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('issue 5991 — getMeIfSignedIn', () => {
  it('asks the probe form and reads a 204 as nobody signed in', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await getMeIfSignedIn()).toBeNull();
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(/\/users\/me\?optional=1$/);
  });

  it('returns the record for a signed-in caller', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ userId: 'u1' }), { status: 200, headers: { 'content-type': 'application/json' } })));
    expect(await getMeIfSignedIn()).toMatchObject({ userId: 'u1' });
  });

  it('an older host\'s 401 still throws a typed error the store treats as definitive', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'sign_in_required' }), { status: 401, headers: { 'content-type': 'application/json' } })));
    await expect(getMeIfSignedIn()).rejects.toBeInstanceOf(UsersApiError);
  });
});
