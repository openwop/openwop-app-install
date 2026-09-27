/**
 * Typed AP2 mandate chain (ADR 0188 Phase 2) — the buyer-authored half of the
 * Agent Payments Protocol: Intent ("what the human authorized") → Cart ("what
 * the merchant resolved it to") → Payment ("the approved money movement").
 * Authored HERE (the server's `ap2.ts` intake is untyped by design — these types
 * are shared so intake can adopt them without a fork). DEMO-MODE posture: the
 * mandates are structurally complete but NOT VC-signed — every payment carries
 * an explicit warning until an operator wires live AP2 signing (the ADR's
 * deferred last-mile).
 */

import { signEddsaJcs2022, verifyEddsaJcs2022, type EddsaJcsProof } from './dataIntegrity.js';

export interface Ap2IntentMandate {
  kind: 'ap2.intent';
  /** The human-readable authorization ("buy 2 bags of coffee under $50"). */
  intent: string;
  /** Ceiling the human authorized, in MINOR units — the cart must not exceed it. */
  maxAmountMinor: number;
  currency: string;
  createdAt: string;
}

export interface Ap2CartLine { externalProductId: string; name: string; quantity: number; unitPriceMinor: number }

export interface Ap2CartMandate {
  kind: 'ap2.cart';
  merchantUrl: string;
  lines: Ap2CartLine[];
  totalMinor: number;
  currency: string;
  /** The intent this cart resolves — integrity: total ≤ intent.maxAmountMinor. */
  intentRef: Ap2IntentMandate;
  createdAt: string;
}

/** ADR 0254 — a CONFORMANT W3C Data-Integrity `eddsa-jcs-2022` proof (VC-DI-EDDSA). Present
 *  ONLY when an operator configured an AP2 signing key. Supersedes the ADR 0240
 *  `OpenwopAp2Ed25519Json` proof (raw EdDSA over JSON.stringify): this uses JCS
 *  canonicalization (RFC 8785) and a `did:key` verificationMethod, so a standards-conformant
 *  relying party can verify the signature.
 *  TRUST MODEL (honest): `verifyPaymentMandate` proves INTEGRITY (the mandate wasn't altered
 *  after signing) + SELF-CONSISTENCY (the embedded did:key signed it) — NOT authenticity. An
 *  attacker can sign a forged mandate with their OWN key and embed their OWN did:key, and it
 *  will verify. AUTHENTICITY still requires the relying party to pin/authorize the
 *  `verificationMethod` (did:key) against an expected/authorized issuer out-of-band. */
export type Ap2Proof = EddsaJcsProof;

export interface Ap2PaymentMandate {
  kind: 'ap2.payment';
  cartRef: Ap2CartMandate;
  totalMinor: number;
  currency: string;
  /** The host approval that authorized this spend (the ONE queue). */
  approvalId: string;
  /** Honesty: empty once signed; carries an explicit unsigned/failed warning otherwise. */
  warnings: string[];
  /** DEF-2 — present when AP2 signing is configured (a verifiable credential proof). */
  proof?: Ap2Proof;
  createdAt: string;
}

/** Build an intent → cart pair, enforcing amount/currency integrity. */
export function buildCartMandate(input: {
  intent: string;
  maxAmountMinor: number;
  merchantUrl: string;
  lines: Ap2CartLine[];
  currency: string;
  now?: string;
}): { intent: Ap2IntentMandate; cart: Ap2CartMandate } {
  const at = input.now ?? new Date().toISOString();
  const totalMinor = input.lines.reduce((s, l) => s + l.unitPriceMinor * l.quantity, 0);
  if (totalMinor > input.maxAmountMinor) {
    throw Object.assign(new Error(`Cart total ${totalMinor} exceeds the authorized ceiling ${input.maxAmountMinor}.`), { code: 'intent_ceiling_exceeded' });
  }
  const intent: Ap2IntentMandate = { kind: 'ap2.intent', intent: input.intent, maxAmountMinor: input.maxAmountMinor, currency: input.currency, createdAt: at };
  const cart: Ap2CartMandate = { kind: 'ap2.cart', merchantUrl: input.merchantUrl, lines: input.lines, totalMinor, currency: input.currency, intentRef: intent, createdAt: at };
  return { intent, cart };
}

export function buildPaymentMandate(cart: Ap2CartMandate, approvalId: string, now?: string): Ap2PaymentMandate {
  return {
    kind: 'ap2.payment',
    cartRef: cart,
    totalMinor: cart.totalMinor,
    currency: cart.currency,
    approvalId,
    warnings: ['ap2_vc_signing_not_configured: demo-mode mandate — not a verifiable credential'],
    createdAt: now ?? new Date().toISOString(),
  };
}

/** The SECURED document a proof signs: the mandate WITHOUT its own `warnings`/`proof`
 *  (host annotations, not part of the authorization being attested). Returned as an object
 *  for JCS canonicalization at sign/verify time. */
export function mandateDocument(m: Ap2PaymentMandate): Record<string, unknown> {
  const { warnings: _w, proof: _p, ...rest } = m;
  void _w; void _p;
  return rest as Record<string, unknown>;
}

/** Sign a payment mandate as a verifiable credential when an Ed25519 AP2 signing key is
 *  configured (`OPENWOP_AP2_SIGNING_KEY`, a PKCS8 PEM). Configured ⇒ attach a conformant
 *  eddsa-jcs-2022 proof and clear the unsigned warning; unconfigured ⇒ return the mandate
 *  untouched (the honest unsigned warning stays); a bad key ⇒ keep it unsigned WITH a
 *  failure warning (NEVER throws — signing must not break a placement). Pass `privateKeyPem`
 *  to override the env key in a test. */
export function signPaymentMandate(mandate: Ap2PaymentMandate, opts: { privateKeyPem?: string } = {}): Ap2PaymentMandate {
  const pem = opts.privateKeyPem ?? process.env.OPENWOP_AP2_SIGNING_KEY;
  if (!pem) return mandate; // unsigned — the demo-mode warning stands
  try {
    const proof = signEddsaJcs2022(mandateDocument(mandate), pem, mandate.createdAt);
    return { ...mandate, warnings: [], proof };
  } catch (err) {
    return { ...mandate, warnings: [...mandate.warnings, `ap2_vc_signing_failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

/** Verify a signed mandate's proof. Returns true when the signature is INTEGRITY-valid for
 *  the embedded `verificationMethod` — this does NOT establish authenticity (see the trust
 *  model on `Ap2Proof`). A caller that GATES A DECISION on the result MUST also compare
 *  `mandate.proof.verificationMethod` against an expected/authorized did:key (pass one via
 *  `expectedDidKey`); the app itself never gates on this (the spend cap + approval run
 *  before signing). */
export function verifyPaymentMandate(mandate: Ap2PaymentMandate, opts: { expectedDidKey?: string } = {}): boolean {
  if (!mandate.proof) return false;
  if (opts.expectedDidKey) {
    const vm = mandate.proof.verificationMethod.split('#')[0];
    if (vm !== opts.expectedDidKey.split('#')[0]) return false; // wrong issuer — reject
  }
  return verifyEddsaJcs2022(mandateDocument(mandate), mandate.proof);
}
