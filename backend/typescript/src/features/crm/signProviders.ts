/**
 * Signature-provider seam (ADR 0402 §c / Phase 3 — DESIGN-ONLY).
 *
 * The shape a future external e-signature connector (DocuSign, an eIDAS
 * trust-service provider) slots into WITHOUT reshaping the P2 native entities.
 * v1 registers exactly ONE provider: `native` (our own click-to-sign, signing on
 * the operator's own /sign page). No external connector is built here.
 *
 * Deliberately NOT a strategy-pattern indirection over the working native flow
 * (premature abstraction from a single implementation). It is a SELECTION +
 * HONEST-GATING registry: `requestSignature` looks a provider up to validate it
 * and fail loudly for anything not actually implemented — the same "advertise
 * only what is honored" discipline as the wire-honesty rule. The native path
 * runs inline; an external provider's `initiate` hook is the deferred surface.
 *
 * The connector itself is a future RFC 0095 CONNECTION pack (host-ext, off-wire):
 * it registers here at boot, brokers its own credentials through the Connections
 * seam, drives signing off-domain, and calls back via a webhook route — all
 * deferred. Only `id`/`label`/`external` are fixed now; the `initiate` contract
 * is intentionally left for the connector to finalize so we do not guess the
 * external envelope shape wrong.
 *
 * @see docs/adr/0402-crm-booking-and-esign.md §b (Phase 3)
 */

import type { SignRequest } from './entities/signRequests.js';

export interface SignatureProvider {
  /** Stable id stamped on `SignRequest.provider` (`native` | `docusign` | …). */
  id: string;
  label: string;
  /**
   * false → signing happens on OUR public /sign page (native mints per-signer
   * capability tokens + emails them). true → signing happens OFF-domain (the
   * connector creates its envelope, redirects signers, and confirms via webhook).
   * Drives whether `requestSignature` runs the native token flow or hands off.
   */
  external: boolean;
  /**
   * DEFERRED (Phase 3 is design-only): an EXTERNAL provider's initiation hook —
   * create the provider's envelope from the request and return per-signer
   * redirect URLs + an opaque provider reference. The native provider omits it
   * (its token+email flow is the inline default). The exact shape is the
   * connector's to finalize; fixing it now would guess the external contract.
   */
  initiate?(req: SignRequest, ctx: { baseUrl: string }): Promise<{ signerUrls: Record<string, string>; providerRef?: string }>;
}

const providers = new Map<string, SignatureProvider>();

/** Register a signature provider (idempotent by id — re-registering replaces,
 *  the submission-sink boot-order contract). A future connection pack calls this
 *  at boot; nothing else imports the connector. */
export function registerSignatureProvider(provider: SignatureProvider): void {
  providers.set(provider.id, provider);
}

export function getSignatureProvider(id: string): SignatureProvider | undefined {
  return providers.get(id);
}

function registerNativeProvider(): void {
  registerSignatureProvider({ id: 'native', label: 'Native click-to-sign', external: false });
}

// v1 ships exactly one provider.
registerNativeProvider();
