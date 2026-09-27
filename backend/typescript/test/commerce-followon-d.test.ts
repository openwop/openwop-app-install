/**
 * Ecommerce follow-on Group D (ADR 0254) — UCP buyer depth:
 *  - conformant W3C Data-Integrity `eddsa-jcs-2022` AP2 proof (JCS canonicalization +
 *    did:key), replacing the raw-EdDSA-over-JSON.stringify proof.
 *  (MCP transport is deferred — see ADR 0254: the outbound mcpClient is run-coupled but
 *   the buyer is runless; that seam + the money-path change is a separate phase.)
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { jcsCanonicalize, base58btcEncode, base58btcDecode, ed25519DidKey, publicKeyFromDidKey, signEddsaJcs2022, verifyEddsaJcs2022 } from '../src/features/commerce/ucpBuyer/dataIntegrity.js';
import { buildCartMandate, buildPaymentMandate, signPaymentMandate, verifyPaymentMandate } from '../src/features/commerce/ucpBuyer/ap2Mandates.js';
import { createPublicKey, createPrivateKey } from 'node:crypto';

const pem = (): string => generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

describe('JCS canonicalization (RFC 8785, mandate value space)', () => {
  it('sorts object keys lexicographically and is stable regardless of input order', () => {
    expect(jcsCanonicalize({ b: 1, a: 2, c: { z: 1, y: 2 } })).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}');
    expect(jcsCanonicalize({ a: 2, b: 1 })).toBe(jcsCanonicalize({ b: 1, a: 2 }));
  });
  it('escapes control characters and serializes arrays/booleans/integers', () => {
    expect(jcsCanonicalize({ s: 'a\nb"c', arr: [1, true, 'x'] })).toBe('{"arr":[1,true,"x"],"s":"a\\nb\\"c"}');
  });
  it('rejects a non-integer number (out of the supported value space)', () => {
    expect(() => jcsCanonicalize({ n: 1.5 })).toThrow();
  });
});

describe('base58-btc + did:key round-trips', () => {
  it('base58 round-trips arbitrary bytes incl. leading zeros', () => {
    const b = Uint8Array.from([0, 0, 1, 2, 3, 255, 128]);
    expect(Array.from(base58btcDecode(base58btcEncode(b)))).toEqual(Array.from(b));
  });
  it('an Ed25519 did:key resolves back to the same public key', () => {
    const priv = createPrivateKey(pem());
    const pub = createPublicKey(priv);
    const did = ed25519DidKey(pub);
    expect(did.startsWith('did:key:z')).toBe(true);
    const back = publicKeyFromDidKey(did);
    expect(back.export({ format: 'jwk' })).toEqual(pub.export({ format: 'jwk' }));
  });
});

describe('eddsa-jcs-2022 proof', () => {
  it('signs and verifies a document', () => {
    const key = pem();
    const doc = { kind: 'ap2.payment', totalMinor: 1200, currency: 'USD', createdAt: '2026-01-01T00:00:00.000Z' };
    const proof = signEddsaJcs2022(doc, key, '2026-01-01T00:00:00.000Z');
    expect(proof.type).toBe('DataIntegrityProof');
    expect(proof.cryptosuite).toBe('eddsa-jcs-2022');
    expect(proof.verificationMethod.startsWith('did:key:z')).toBe(true);
    expect(proof.proofValue.startsWith('z')).toBe(true);
    expect(verifyEddsaJcs2022(doc, proof)).toBe(true);
  });
  it('fails verification when the document is tampered', () => {
    const key = pem();
    const doc = { totalMinor: 1200, currency: 'USD' };
    const proof = signEddsaJcs2022(doc, key, '2026-01-01T00:00:00.000Z');
    expect(verifyEddsaJcs2022({ ...doc, totalMinor: 1201 }, proof)).toBe(false);
  });
  it('fails verification when the proofValue is tampered', () => {
    const key = pem();
    const doc = { totalMinor: 1200 };
    const proof = signEddsaJcs2022(doc, key, '2026-01-01T00:00:00.000Z');
    expect(verifyEddsaJcs2022(doc, { ...proof, proofValue: `z${'1'.repeat(80)}` })).toBe(false);
  });
});

describe('eddsa-jcs-2022 known-answer (locks the algorithm — JCS order, concat order, encoding)', () => {
  // A FIXED Ed25519 seed (0x01 × 32) ⇒ a frozen did:key + proofValue. Any change to the JCS
  // canonicalization, the SHA-256(proofConfig)‖SHA-256(document) order, or the base58/did:key
  // encoding will change these and fail here — catching silent algorithm drift the
  // homegrown sign↔verify round-trip cannot.
  const fixedPem = (): string => {
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from('01'.repeat(32), 'hex')]);
    return `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----\n`;
  };
  it('produces the frozen did:key + proofValue for a fixed key + doc + created', () => {
    const proof = signEddsaJcs2022({ amount: 1200, currency: 'USD' }, fixedPem(), '2026-01-01T00:00:00.000Z');
    expect(proof.verificationMethod).toBe('did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX#z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX');
    expect(proof.proofValue).toBe('z2vY7s8cjpRfmcg7A91WpZFF2KwtVpVi4GatGPxcchkwc6N6UWR6WXvyHAi2uRfRFGU7mrbiHqLNWcLMoAHLkN9Q');
    expect(verifyEddsaJcs2022({ amount: 1200, currency: 'USD' }, proof)).toBe(true);
  });
});

describe('AP2 payment mandate signing (via eddsa-jcs-2022)', () => {
  const mandate = () => {
    const { cart } = buildCartMandate({ intent: 'buy coffee', maxAmountMinor: 5000, merchantUrl: 'https://m.test', currency: 'USD', lines: [{ externalProductId: 'x', name: 'Coffee', quantity: 1, unitPriceMinor: 1200 }], now: '2026-01-01T00:00:00.000Z' });
    return buildPaymentMandate(cart, 'appr:1', '2026-01-01T00:00:00.000Z');
  };
  it('a configured key yields a conformant proof that verifies', () => {
    const signed = signPaymentMandate(mandate(), { privateKeyPem: pem() });
    expect(signed.proof?.cryptosuite).toBe('eddsa-jcs-2022');
    expect(signed.warnings).toHaveLength(0);
    expect(verifyPaymentMandate(signed)).toBe(true);
  });
  it('tampering the signed mandate breaks verification', () => {
    const signed = signPaymentMandate(mandate(), { privateKeyPem: pem() });
    expect(verifyPaymentMandate({ ...signed, totalMinor: signed.totalMinor + 1 })).toBe(false);
  });
  it('no key ⇒ the honest unsigned warning; a bad key ⇒ a failure warning (never throws)', () => {
    expect(signPaymentMandate(mandate(), {}).warnings[0]).toMatch(/not_configured/);
    expect(signPaymentMandate(mandate(), { privateKeyPem: 'nope' }).warnings.some((w) => /vc_signing_failed/.test(w))).toBe(true);
  });
  it('a proof signed by a DIFFERENT key is rejected when an expected did:key is pinned (authenticity)', () => {
    // Integrity-valid but from the wrong issuer — verify() alone returns true (self-consistent),
    // but pinning `expectedDidKey` to a different issuer rejects it (the honest trust model).
    const forged = signPaymentMandate(mandate(), { privateKeyPem: pem() });
    expect(verifyPaymentMandate(forged)).toBe(true); // integrity + self-consistency
    const someoneElse = signPaymentMandate(mandate(), { privateKeyPem: pem() });
    expect(verifyPaymentMandate(forged, { expectedDidKey: someoneElse.proof!.verificationMethod })).toBe(false);
  });
});
