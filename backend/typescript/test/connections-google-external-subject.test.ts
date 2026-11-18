/**
 * #5983 — a Google connection records which Google account it is.
 *
 * `shapeTokenMaterial` set `externalSubject` only from Slack's `authed_user.id`, so
 * every Google connection had none, and nothing could tell two Google accounts apart
 * (re-connect-as-another-account, twin retirement, account continuity). Google now
 * gets `openid` on every authorize request, and the `sub` of the id_token that comes
 * back on the token response is the externalSubject, once its issuer, audience and
 * expiry check out.
 *
 * Red when: the Google manifest drops `identityScopes`, or `shapeTokenMaterial`
 * stops reading the id_token, or any of the three claim checks is removed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as undici from 'undici';

vi.mock('undici', async (orig) => {
  const actual = await orig<typeof import('undici')>();
  return { ...actual, fetch: vi.fn(actual.fetch) };
});
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { beginAuthorization, exchangeCodeForTokens, idTokenSubject } from '../src/features/connections/oauthFlow.js';

const CLIENT = 'gcid.apps.googleusercontent.com';
const ISS = 'https://accounts.google.com';

const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = (claims: Record<string, unknown>): string => `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`;
const future = (): number => Math.floor(Date.now() / 1000) + 3600;

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_ID = CLIENT;
  process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_SECRET = 'gcsecret';
});
afterAll(() => {
  delete process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_ID;
  delete process.env.OPENWOP_OAUTH_GOOGLE_CLIENT_SECRET;
});
afterEach(() => { vi.mocked(undici.fetch).mockReset(); });

function tokenResponse(body: Record<string, unknown>): void {
  vi.mocked(undici.fetch).mockResolvedValue(
    new undici.Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
}
const exchange = () => exchangeCodeForTokens({ provider: 'google', code: 'c', codeVerifier: 'v', scopes: ['openid'], reqOrigin: 'https://host.example' });

describe('#5983 — a Google connection carries its account id', () => {
  it('asks Google for `openid` on every authorize request, reads and write alike', async () => {
    for (const includeWrite of [false, true]) {
      const { authorizeUrl } = await beginAuthorization({ provider: 'google', tenantId: 't', userId: 'u', reqOrigin: 'https://host.example', includeWrite });
      expect(new URL(authorizeUrl).searchParams.get('scope')!.split(' ')).toContain('openid');
    }
  });

  it('stores the id_token `sub`, and two Google accounts are told apart', async () => {
    tokenResponse({ access_token: 'AT-a', token_type: 'Bearer', expires_in: 3600, id_token: idToken({ iss: ISS, aud: CLIENT, exp: future(), sub: '1001' }) });
    const a = await exchange();
    tokenResponse({ access_token: 'AT-b', token_type: 'Bearer', expires_in: 3600, id_token: idToken({ iss: 'accounts.google.com', aud: CLIENT, exp: future(), sub: '2002' }) });
    const b = await exchange();
    expect(a.externalSubject).toBe('1001');
    expect(b.externalSubject, 'Google also sends iss without the scheme').toBe('2002');
  });

  it('a token response with no id_token still connects, with no subject (an older grant)', async () => {
    tokenResponse({ access_token: 'AT', token_type: 'Bearer', expires_in: 3600 });
    expect((await exchange()).externalSubject).toBeUndefined();
  });

  it('ignores an id_token for another client, another issuer, or one that expired', () => {
    const ok = { iss: ISS, aud: CLIENT, exp: future(), sub: '1001' };
    const want = { issuer: ISS, clientId: CLIENT };
    expect(idTokenSubject(idToken(ok), want)).toBe('1001');
    expect(idTokenSubject(idToken({ ...ok, aud: 'someone-else' }), want)).toBeUndefined();
    expect(idTokenSubject(idToken({ ...ok, aud: [CLIENT, 'x'] }), want)).toBe('1001');
    expect(idTokenSubject(idToken({ ...ok, iss: 'https://evil.example' }), want)).toBeUndefined();
    expect(idTokenSubject(idToken({ ...ok, exp: Math.floor(Date.now() / 1000) - 10 }), want)).toBeUndefined();
    expect(idTokenSubject(idToken({ ...ok, sub: '' }), want)).toBeUndefined();
    expect(idTokenSubject('not-a-jwt', want)).toBeUndefined();
    expect(idTokenSubject(idToken(ok), { issuer: undefined, clientId: CLIENT })).toBeUndefined();
  });
});
