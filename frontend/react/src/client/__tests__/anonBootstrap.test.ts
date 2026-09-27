/**
 * ADR 0750 — the SPA recovers from the major-2 no-credential 401 by establishing
 * a session and retrying ONCE; it never papers over a refused credential.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const refreshBackendSession = vi.fn(async () => {});
vi.mock('../../auth/backendSession.js', () => ({ refreshBackendSession: () => refreshBackendSession() }));

const { isNoCredentialChallenge, withSessionBootstrap } = await import('../anonBootstrap.js');

const res = (status: number, challenge?: string): Response =>
  new Response('{}', { status, headers: challenge ? { 'WWW-Authenticate': challenge } : {} });

const NO_CRED = 'Bearer resource_metadata="https://h/.well-known/oauth-protected-resource"';
const REFUSED = 'Bearer error="invalid_token", resource_metadata="https://h/.well-known/oauth-protected-resource"';

beforeEach(() => refreshBackendSession.mockClear());

describe('isNoCredentialChallenge', () => {
  it('is true only for a 401 Bearer challenge WITHOUT an error parameter', () => {
    expect(isNoCredentialChallenge(res(401, NO_CRED))).toBe(true);
    expect(isNoCredentialChallenge(res(401, REFUSED))).toBe(false);
    expect(isNoCredentialChallenge(res(401))).toBe(false);
    expect(isNoCredentialChallenge(res(403, NO_CRED))).toBe(false);
    expect(isNoCredentialChallenge(res(401, 'Basic realm="x"'))).toBe(false);
  });
});

describe('withSessionBootstrap', () => {
  it('bootstraps a session and retries exactly once on the no-credential 401', async () => {
    const doFetch = vi.fn().mockResolvedValueOnce(res(401, NO_CRED)).mockResolvedValueOnce(res(200));
    const out = await withSessionBootstrap(doFetch);
    expect(out.status).toBe(200);
    expect(refreshBackendSession).toHaveBeenCalledTimes(1);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it('never retries twice — a second no-credential 401 is returned as-is', async () => {
    const doFetch = vi.fn().mockResolvedValue(res(401, NO_CRED));
    const out = await withSessionBootstrap(doFetch);
    expect(out.status).toBe(401);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it('does NOT bootstrap over a refused credential (invalid_token) — ADR 0434, no silent identity switch', async () => {
    const doFetch = vi.fn().mockResolvedValue(res(401, REFUSED));
    const out = await withSessionBootstrap(doFetch);
    expect(out.status).toBe(401);
    expect(refreshBackendSession).not.toHaveBeenCalled();
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it('passes every other response straight through', async () => {
    const doFetch = vi.fn().mockResolvedValue(res(404));
    expect((await withSessionBootstrap(doFetch)).status).toBe(404);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(refreshBackendSession).not.toHaveBeenCalled();
  });
});
