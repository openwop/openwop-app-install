/**
 * SAML ACS validator — RFC 0050 §A MUST list (ADR 0002, Phase 3).
 *
 * Proves the host's real validator (`host/auth/samlValidationService`) honors
 * the full §A list NON-VACUOUSLY — the justification for advertising
 * `openwop-auth-saml` in `capabilities.auth.profiles` (finding C1). It mints the
 * SAME 7 assertion variants the conformance synthetic IdP produces
 * (`createSyntheticSamlIdp`, ported here so the test is hermetic and matches the
 * exact signed canonical form), and asserts the host validator accepts `valid`
 * and rejects each of the 6 negatives — including the load-bearing
 * signature-wrapping (XSW) attack — for the right reason.
 */

import { describe, expect, it } from 'vitest';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { validateSamlAssertion } from '../src/host/auth/samlValidationService.js';

type Variant = 'valid' | 'alg-none' | 'bad-signature' | 'unsigned' | 'expired' | 'not-yet-valid' | 'signature-wrapping';

const SIG_RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SIG_NONE = 'http://www.w3.org/2000/09/xmldsig#none';

// --- Synthetic IdP (ported from conformance/src/lib/saml-idp.ts, by construction
// identical to what a host ACS is driven against over the live seam). ---
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const certificatePem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const digest = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64');
const sign = (s: string): string => createSign('RSA-SHA256').update(s, 'utf8').sign(privateKey, 'base64');

function canonical(id: string, subject: string, nb: string, noa: string): string {
  return (
    `<saml:Assertion ID="${id}" Version="2.0">` +
    `<saml:Conditions NotBefore="${nb}" NotOnOrAfter="${noa}"/>` +
    `<saml:Subject><saml:NameID>${subject}</saml:NameID></saml:Subject>` +
    `</saml:Assertion>`
  );
}

function envelope(p: { id: string; subject: string; nb: string; noa: string; alg: string; sig: string | null; refId: string }): string {
  const inner = canonical(p.id, p.subject, p.nb, p.noa);
  const sig =
    p.sig === null
      ? ''
      : `<ds:Signature><ds:SignedInfo><ds:SignatureMethod Algorithm="${p.alg}"/>` +
        `<ds:Reference URI="#${p.refId}"><ds:DigestValue>${digest(inner)}</ds:DigestValue></ds:Reference>` +
        `</ds:SignedInfo><ds:SignatureValue>${p.sig}</ds:SignatureValue></ds:Signature>`;
  return `<samlp:Response>${inner.replace('</saml:Assertion>', `${sig}</saml:Assertion>`)}</samlp:Response>`;
}

function mint(variant: Variant): string {
  const id = `a-${variant}`;
  const subject = 'user_42@example.com-opaque';
  const now = Date.now();
  const iso = (ms: number): string => new Date(ms).toISOString();
  const past = iso(now - 3_600_000);
  const future = iso(now + 3_600_000);
  switch (variant) {
    case 'valid':
      return envelope({ id, subject, nb: past, noa: future, alg: SIG_RSA_SHA256, sig: sign(canonical(id, subject, past, future)), refId: id });
    case 'unsigned':
      return envelope({ id, subject, nb: past, noa: future, alg: SIG_RSA_SHA256, sig: null, refId: id });
    case 'alg-none':
      return envelope({ id, subject, nb: past, noa: future, alg: SIG_NONE, sig: '', refId: id });
    case 'bad-signature':
      return envelope({ id, subject, nb: past, noa: future, alg: SIG_RSA_SHA256, sig: Buffer.from('forged').toString('base64'), refId: id });
    case 'expired': {
      const nb = iso(now - 7_200_000);
      return envelope({ id, subject, nb, noa: past, alg: SIG_RSA_SHA256, sig: sign(canonical(id, subject, nb, past)), refId: id });
    }
    case 'not-yet-valid': {
      const noa = iso(now + 7_200_000);
      return envelope({ id, subject, nb: future, noa, alg: SIG_RSA_SHA256, sig: sign(canonical(id, subject, future, noa)), refId: id });
    }
    case 'signature-wrapping': {
      // Valid signature over a benign assertion; an attacker-injected assertion
      // with a different Subject is the consumed (first) one — refId ≠ consumed.
      const benign = 'a-benign';
      const benignC = canonical(benign, subject, past, future);
      const injected = canonical(id, 'attacker@evil.example-opaque', past, future);
      const sig =
        `<ds:Signature><ds:SignedInfo><ds:SignatureMethod Algorithm="${SIG_RSA_SHA256}"/>` +
        `<ds:Reference URI="#${benign}"><ds:DigestValue>${digest(benignC)}</ds:DigestValue></ds:Reference>` +
        `</ds:SignedInfo><ds:SignatureValue>${sign(benignC)}</ds:SignatureValue></ds:Signature>`;
      return `<samlp:Response>${injected.replace('</saml:Assertion>', `${sig}</saml:Assertion>`)}${benignC}</samlp:Response>`;
    }
  }
}

describe('SAML ACS validator (RFC 0050 §A)', () => {
  it('ACCEPTS a valid signed, in-window, non-wrapped assertion → principal', () => {
    const r = validateSamlAssertion(mint('valid'), certificatePem);
    expect(r.valid, `expected valid; got reason=${r.reason}`).toBe(true);
    expect(r.principal?.principalId).toBe('saml:user_42@example.com-opaque');
    expect(r.principal?.groups).toEqual([]); // no group attributes in the synthetic assertion
  });

  const negatives: ReadonlyArray<[Exclude<Variant, 'valid'>, string]> = [
    ['alg-none', 'alg-none'],
    ['unsigned', 'unsigned'],
    ['bad-signature', 'bad-signature'],
    ['expired', 'expired'],
    ['not-yet-valid', 'not-yet-valid'],
    ['signature-wrapping', 'signature-wrapping'],
  ];

  for (const [variant, reason] of negatives) {
    it(`REJECTS the ${variant} assertion (reason=${reason})`, () => {
      const r = validateSamlAssertion(mint(variant), certificatePem);
      expect(r.valid, `${variant} MUST be rejected`).toBe(false);
      expect(r.reason).toBe(reason);
      expect(r.principal).toBeUndefined();
    });
  }

  it('rejects a valid assertion verified against the WRONG cert (bad-signature)', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const r = validateSamlAssertion(mint('valid'), other);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('bad-signature');
  });

  it('does NOT surface UNSIGNED injected group attributes (finding #1)', () => {
    // The signature only covers ID/Conditions/NameID, so an injected
    // <AttributeStatement> is unsigned — the validator MUST NOT surface it (else
    // signature-wrapping of groups → privilege escalation).
    const injected = mint('valid').replace(
      '</saml:Assertion>',
      '<saml:AttributeStatement><saml:Attribute Name="groups"><saml:AttributeValue>admin</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion>',
    );
    const r = validateSamlAssertion(injected, certificatePem);
    expect(r.valid).toBe(true); // signature still validates (attributes are outside signed scope)
    expect(r.principal?.groups).toEqual([]); // the forged 'admin' group is NOT surfaced
  });
});
