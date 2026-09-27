/**
 * ADR 0743 — a signature that fails against a CACHED JWKS key gets ONE refetch,
 * bounded by a cooldown.
 *
 * MEASURED 2026-09-23: the conformance harness mints every synthetic issuer with
 * kid `openwop-conformance-key-0` and a fresh key, at the same URL. The verifier
 * cached the first scenario's key under that kid for the whole TTL, so the next
 * oidc scenario's VALID control token failed `invalid_signature` — the run-order
 * dependence behind three `v2-lane-exp-only-bound` reds that passed 4/4 in
 * isolation. A kid-miss refetch cannot see a re-used kid; only a signature failure
 * can. The cooldown is the other half: without it a forged signature would cost
 * an outbound JWKS fetch per request.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { OidcVerifier } from '../src/middleware/oidcVerifier.js';

const KID = 'reused-kid';
const AUD = 'urn:test:aud';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { jwk: { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }, privateKey };
}

let served = keypair();
let fetches = 0;
let server: http.Server;
let issuer: string;

function mint(privateKey: KeyObject): string {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }))}.${b64url(
    JSON.stringify({ iss: issuer, aud: AUD, sub: 'u1', iat: now, exp: now + 300 }),
  )}`;
  return `${input}.${b64url(createSign('sha256').update(input).sign(privateKey))}`;
}

beforeAll(async () => {
  const app = express();
  app.get('/.well-known/jwks.json', (_req, res) => {
    fetches += 1;
    res.json({ keys: [served.jwk] });
  });
  server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('OidcVerifier — re-used kid with a rotated key', () => {
  it('refetches once on a signature failure against a cached key, and accepts the new key', async () => {
    const v = new OidcVerifier({ issuer, audience: AUD });
    served = keypair();
    await expect(v.verify(mint(served.privateKey))).resolves.toMatchObject({ sub: 'u1' });
    expect(fetches).toBe(1);

    // Same kid, new key — exactly the harness's shape across two scenarios.
    served = keypair();
    await expect(v.verify(mint(served.privateKey))).resolves.toMatchObject({ sub: 'u1' });
    expect(fetches, 'exactly one extra fetch, driven by the signature failure').toBe(2);
  });

  it('a forged signature costs at most one refetch per cooldown, and is still refused', async () => {
    const v = new OidcVerifier({ issuer, audience: AUD });
    served = keypair();
    await v.verify(mint(served.privateKey));
    const base = fetches;

    const forger = keypair(); // a key the issuer never published under this kid
    await expect(v.verify(mint(forger.privateKey))).rejects.toMatchObject({ code: 'invalid_signature' });
    expect(fetches).toBe(base + 1);
    for (let i = 0; i < 5; i += 1) {
      await expect(v.verify(mint(forger.privateKey))).rejects.toMatchObject({ code: 'invalid_signature' });
    }
    expect(fetches, 'the cooldown holds: no further fetches').toBe(base + 1);
  });

  it('a signature failure on a key fetched by THIS call is not retried', async () => {
    const v = new OidcVerifier({ issuer, audience: AUD });
    served = keypair();
    const base = fetches;
    await expect(v.verify(mint(keypair().privateKey))).rejects.toMatchObject({ code: 'invalid_signature' });
    expect(fetches, 'the initial fetch only — a fresh key cannot be stale').toBe(base + 1);
  });
});
