/**
 * ADR 0081 Phase 2 — BigQuery service-account-JWT mint.
 *
 * Verifies the RS256 JWT assembly (verifiable with the SA key's public half), the token
 * exchange (mock fetch — no live Google), the in-process cache (expiry refresh), the
 * single-flight coalescing, and fail-closed on a bad key / non-OK token endpoint.
 * No live GCP credentials needed — a test keypair stands in for the SA private key.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { assembleServiceAccountJwt, mintServiceAccountToken, __resetSaJwtCache } from '../src/features/connections/serviceAccountJwt.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SA = { client_email: 'svc@proj.iam.gserviceaccount.com', private_key: privatePem, token_uri: 'https://oauth2.googleapis.com/token' };
const NOW = 1_900_000_000_000;

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
}

afterEach(() => __resetSaJwtCache());

describe('ADR 0081 §2 — assembleServiceAccountJwt', () => {
  it('produces an RS256 JWT with correct claims, verifiable by the public key', () => {
    const jws = assembleServiceAccountJwt(SA, { scope: 'https://www.googleapis.com/auth/bigquery.readonly', aud: SA.token_uri, now: NOW });
    const [h, c, sig] = jws.split('.');
    expect(decode(h!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decode(c!);
    expect(claims.iss).toBe(SA.client_email);
    expect(claims.scope).toBe('https://www.googleapis.com/auth/bigquery.readonly');
    expect(claims.aud).toBe(SA.token_uri);
    expect(claims.exp as number).toBe((claims.iat as number) + 3600);
    // Signature verifies against the SA public key; a tampered payload does not.
    const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    expect(ok).toBe(true);
    const bad = createVerify('RSA-SHA256').update(`${h}.${c}x`).verify(publicKey, Buffer.from(sig!.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    expect(bad).toBe(false);
  });

  it('throws sa_jwt_bad_key when client_email/private_key are missing', () => {
    expect(() => assembleServiceAccountJwt({ private_key: privatePem }, { scope: 's', aud: 'a', now: NOW })).toThrow(/sa_jwt_bad_key/);
  });
});

describe('ADR 0081 §2 — mintServiceAccountToken', () => {
  const okFetch = (calls: { n: number }): typeof fetch => (async (_url, init) => {
    calls.n += 1;
    const body = String((init as RequestInit).body);
    expect(body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    expect(body).toContain('assertion=');
    return { ok: true, status: 200, json: async () => ({ access_token: 'ya29.test', expires_in: 3600 }) } as Response;
  }) as typeof fetch;

  it('exchanges the JWT for an access token (mock endpoint)', async () => {
    const calls = { n: 0 };
    const tok = await mintServiceAccountToken('conn-1', JSON.stringify(SA), { now: NOW, fetchImpl: okFetch(calls) });
    expect(tok).toBe('ya29.test');
    expect(calls.n).toBe(1);
  });

  it('caches the token within TTL (no second exchange), refreshes after expiry', async () => {
    const calls = { n: 0 };
    const f = okFetch(calls);
    await mintServiceAccountToken('conn-2', JSON.stringify(SA), { now: NOW, fetchImpl: f });
    await mintServiceAccountToken('conn-2', JSON.stringify(SA), { now: NOW + 60_000, fetchImpl: f }); // within TTL
    expect(calls.n).toBe(1);
    await mintServiceAccountToken('conn-2', JSON.stringify(SA), { now: NOW + 3_700_000, fetchImpl: f }); // past expiry
    expect(calls.n).toBe(2);
  });

  it('single-flight: concurrent resolves coalesce onto one exchange', async () => {
    const calls = { n: 0 };
    const slowFetch = (async () => { calls.n += 1; await new Promise((r) => setTimeout(r, 10)); return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) } as Response; }) as typeof fetch;
    const [a, b] = await Promise.all([
      mintServiceAccountToken('conn-3', JSON.stringify(SA), { now: NOW, fetchImpl: slowFetch }),
      mintServiceAccountToken('conn-3', JSON.stringify(SA), { now: NOW, fetchImpl: slowFetch }),
    ]);
    expect(a).toBe('t'); expect(b).toBe('t');
    expect(calls.n).toBe(1);
  });

  it('fails closed (null) on a malformed key and on a non-OK token endpoint', async () => {
    expect(await mintServiceAccountToken('conn-4', 'not json', { now: NOW })).toBeNull();
    const errFetch = (async () => ({ ok: false, status: 401, json: async () => ({}) } as Response)) as typeof fetch;
    expect(await mintServiceAccountToken('conn-5', JSON.stringify(SA), { now: NOW, fetchImpl: errFetch })).toBeNull();
  });
});
