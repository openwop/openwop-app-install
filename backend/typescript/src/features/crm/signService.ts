/**
 * CRM e-signature orchestration (ADR 0402 §b) — native click-to-sign.
 *
 * Signer identity = possession of an emailed capability token (the commerce-quote
 * public-accept precedent). A signature binds to a CONTENT HASH of the target's
 * canonical serialization taken at request time; at sign time the target is
 * re-serialized and re-hashed, and a mismatch FAILS LOUDLY (never a silent sign
 * of stale content). On completion a PDF certificate is generated and stored.
 *
 * This is a LIGHTWEIGHT electronic-signature record (ESIGN/UETA tier), NOT a
 * qualified/eIDAS signature — see SIGN_LEGAL_NOTICE, non-negotiable copy that
 * ships on the signing page AND in the certificate.
 *
 * @see docs/adr/0402-crm-booking-and-esign.md §b
 */

import { createHmac } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { activeProvider, emailTransportConfigured } from '../email/emailService.js';
import { crmMutated, type CrmEmitOptions } from './emit.js';
import { renderTarget, hashCanonical, SIGN_TARGET_KINDS, type SignTarget } from './signTargets.js';
import { getSignatureProvider } from './signProviders.js';
import {
  type SignRequest, type Signer, type SignatureRecord,
  createSignRequest, getSignRequest, getSignRequestById, putSignRequest, casSignRequest,
  listSignRequests, appendSignatureRecord, listSignatureRecords,
} from './entities/signRequests.js';

const log = createLogger('crm.sign');

/** The non-negotiable legal-scope statement (ADR 0402 §b). Ships verbatim on the
 *  signing page and in the certificate — an honest capability claim. */
const SIGN_LEGAL_NOTICE =
  'This is a lightweight electronic-signature record (signer intent plus a cryptographic hash binding the signature to the exact signed content, with an audit trail). It is suitable for internal approvals and general business agreements under e-signature statutes that recognize electronic records (e.g. US ESIGN / UETA). It is NOT a qualified or advanced electronic signature under eIDAS, does not use a trust-service-provider certificate, and does not perform government-ID identity verification.';

/** Whether the e-sign surface is exposed (default on when crm is on). */
export function esignEnabled(): boolean {
  return process.env.OPENWOP_CRM_ESIGN_ENABLED !== 'false';
}

/** Keyed (HMAC) hash of PII (IP / UA) for the audit record. A plain SHA-256 of a
 *  low-entropy IPv4 is brute-forceable in seconds — reversible, so not actually
 *  anonymizing. Key it with a per-host secret so the stored digest cannot be
 *  reversed to the raw value. Falls back to the session secret (always set in a
 *  real deployment) so the audit stays one-way even without a dedicated key. */
function hashPii(value: string): string {
  const key = process.env.OPENWOP_PII_HASH_KEY || process.env.OPENWOP_SESSION_SECRET || 'openwop-sign-pii';
  return createHmac('sha256', key).update(value, 'utf8').digest('hex').slice(0, 32);
}

// ── projections ──────────────────────────────────────────────────────────────

function signStatusView(req: SignRequest, records: SignatureRecord[], certUrl?: string): Record<string, unknown> {
  const recBySigner = new Map(records.map((r) => [r.signerId, r]));
  return {
    signRequestId: req.signRequestId,
    title: req.title,
    status: req.status,
    target: req.target,
    createdAt: req.createdAt,
    ...(req.completedAt ? { completedAt: req.completedAt } : {}),
    ...(certUrl ? { certificateUrl: certUrl } : {}),
    signers: req.signers.map((s) => ({
      signerId: s.signerId,
      email: s.email,
      ...(s.name ? { name: s.name } : {}),
      ...(s.order !== undefined ? { order: s.order } : {}),
      status: s.status,
      ...(s.signedAt ? { signedAt: s.signedAt } : {}),
      ...(recBySigner.get(s.signerId) ? { audit: { ipHash: recBySigner.get(s.signerId)!.ipHash, userAgentHash: recBySigner.get(s.signerId)!.userAgentHash } } : {}),
    })),
  };
}

/** The public signing-page projection behind a signer token. */
export function signPublicView(req: SignRequest, signer: Signer, rendered: { markdown: string; title: string }): Record<string, unknown> {
  return {
    signRequestId: req.signRequestId,
    title: req.title,
    status: req.status,
    signerId: signer.signerId,
    signerEmail: signer.email,
    signerStatus: signer.status,
    yourTurn: isSignersTurn(req, signer),
    // R2 S1R2-5 — the signer sees WHO is asking and WHEN, and (returning after
    // signing) when they themselves signed. Review F1: this projection is the
    // wire — capture-at-create alone left the frontend rendering a field that
    // never arrived.
    requestedAt: req.createdAt,
    ...(req.requestedBy ? { requestedBy: req.requestedBy } : {}),
    ...(signer.signedAt ? { signedAt: signer.signedAt } : {}),
    contentMarkdown: rendered.markdown,
    legalNotice: SIGN_LEGAL_NOTICE,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function isSignersTurn(req: SignRequest, signer: Signer): boolean {
  if (signer.order === undefined) return true;
  return req.signers.every((s) => s.order === undefined || s.order >= signer.order! || s.status === 'signed');
}

function certUrlFor(req: SignRequest): string | undefined {
  return req.certificateArtifactId ? `/v1/host/openwop-app/assets/${req.certificateArtifactId}` : undefined;
}

const MANAGE_TOKEN_ACTOR = 'system:crm-sign';

async function mintSignerToken(tenantId: string, orgId: string, signRequestId: string, signerId: string): Promise<string | null> {
  try {
    const { createLink } = await import('../sharing/sharingService.js');
    const link = await createLink(tenantId, orgId, MANAGE_TOKEN_ACTOR, { resourceType: 'sign_request', resourceId: `${signRequestId}:${signerId}`, expiresInDays: 90 });
    return link.token;
  } catch (err) {
    log.warn('signer token mint failed', { signRequestId, signerId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function revokeAllSignerTokens(tenantId: string, req: SignRequest): Promise<void> {
  try {
    const { purgeLinksForResource } = await import('../sharing/sharingService.js');
    for (const s of req.signers) await purgeLinksForResource(tenantId, 'sign_request', `${req.signRequestId}:${s.signerId}`);
  } catch (err) {
    log.warn('signer token revoke failed', { signRequestId: req.signRequestId, error: err instanceof Error ? err.message : String(err) });
  }
}

// ── requestSignature (authed / node-driven) ──────────────────────────────────

export interface RequestSignatureInput {
  tenantId: string;
  orgId: string;
  target: { kind: string; id: string };
  signers: { email: string; name?: string; order?: number }[];
  createdBy: string;
  /** R2 S1R2-5 — human-facing requester identity shown to signers. */
  requestedBy?: { name?: string; email?: string };
  baseUrl: string;
  /** Signature provider (P3 seam) — defaults to `native`. An external provider
   *  is honestly refused until its connector is built. */
  provider?: string;
  /** Deterministic id (ADR 0162) for replay/fork safety. */
  signRequestId?: string;
  /** ADR 0617 D1a — stamped by the workflow surface only (review S3): a chain
   *  bound to `host.crm.sign-request.created` whose run requests a signature
   *  must not re-trigger itself through its own `created`. */
  origin?: CrmEmitOptions['origin'];
}

/**
 * Create a signature request and email each signer their link.
 *
 * Returns `invitesEmailed` — TRANSIENT (never persisted), and load-bearing.
 * Invites are best-effort by design, but the caller previously had NO way to
 * learn they were not sent: the console stub's `send()` is a no-op, `emailSigner`
 * swallows into a `log.warn`, and the call is dispatched with `void`. So a
 * signature request reported success with no email in existence, and the only
 * trace was a server log the requester never sees. The API can now say
 * "created — share the link yourself" instead of implying delivery.
 */
export async function requestSignature(input: RequestSignatureInput): Promise<SignRequest & { invitesEmailed: boolean }> {
  if (!SIGN_TARGET_KINDS.includes(input.target.kind as SignTarget['kind'])) {
    throw new OpenwopError('validation_error', `target.kind must be one of: ${SIGN_TARGET_KINDS.join(', ')}.`, 400, { field: 'target.kind' });
  }
  // P3 seam: select + honestly gate the provider. v1 registers only `native`;
  // an external connector isn't built, so requesting one fails loudly (never a
  // dishonest "signed" via a provider that can't actually collect signatures).
  const providerId = input.provider ?? 'native';
  const provider = getSignatureProvider(providerId);
  if (!provider) {
    throw new OpenwopError('host_capability_missing', `Signature provider '${providerId}' is not configured on this host.`, 501, { provider: providerId });
  }
  if (provider.external) {
    throw new OpenwopError('host_capability_missing', `Signature provider '${providerId}' (external signing) is not yet implemented — use the native provider.`, 501, { provider: providerId });
  }
  const target: SignTarget = { kind: input.target.kind as SignTarget['kind'], id: input.target.id };

  // Idempotent by deterministic id — a fork/re-run returns the existing request
  // WITHOUT re-minting tokens or re-emailing signers.
  if (input.signRequestId) {
    const existing = await getSignRequest(input.tenantId, input.orgId, input.signRequestId);
    // The idempotent replay re-emails nobody, so it must not claim it did.
    if (existing) return { ...existing, invitesEmailed: false };
  }

  const rendered = await renderTarget(input.tenantId, input.orgId, target);
  const contentHash = hashCanonical(rendered.canonical);

  const signers: Signer[] = input.signers.map((s, i) => ({
    signerId: `signer-${i}`,
    email: s.email,
    ...(s.name ? { name: s.name } : {}),
    ...(typeof s.order === 'number' ? { order: s.order } : {}),
    status: 'pending' as const,
  }));

  // Persist first (so the sharing resolver's mint-time validate finds the request),
  // then mint per-signer tokens, then re-persist with the tokens.
  const req = await createSignRequest({
    tenantId: input.tenantId,
    orgId: input.orgId,
    title: rendered.title,
    target,
    contentHash,
    signers,
    provider: providerId,
    createdBy: input.createdBy,
    ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
    ...(input.signRequestId ? { signRequestId: input.signRequestId } : {}),
  });

  // ADR 0448 grade fix (#2): the raw signer token is NEVER persisted — it
  // lives in this map only long enough to be emailed (the booking-lane
  // posture). The public /sign/:token page resolves via sharing's hashed
  // store; nothing ever needs to read the raw back.
  const signerTokens = new Map<string, string>();
  for (const signer of req.signers) {
    const token = await mintSignerToken(req.tenantId, req.orgId, req.signRequestId, signer.signerId);
    if (token) {
      signerTokens.set(signer.signerId, token);
      rememberMintedTokenForTest(`${req.signRequestId}:${signer.signerId}`, token);
    }
  }
  await putSignRequest(req);

  crmMutated({ entity: 'sign-request', verb: 'created', tenantId: req.tenantId, orgId: req.orgId, actor: input.createdBy, entityId: req.signRequestId, ...(input.origin ? { origin: input.origin } : {}) });

  // Email each signer their signing link (best-effort; console stub no-ops). Skip
  // when no public origin is configured — a brokered provider would otherwise send
  // a schemeless `/sign/<token>` link the signer cannot open (the operator sets
  // OPENWOP_PUBLIC_BASE_URL, or the HTTP route derives it from the request).
  const origin = input.baseUrl.trim();
  // Honest up front: no public origin OR no real transport ⇒ nothing was emailed.
  const invitesEmailed = Boolean(origin) && emailTransportConfigured();
  if (!invitesEmailed && origin) {
    log.warn('sign invite emails not delivered — no email transport configured', { signRequestId: req.signRequestId });
  }
  if (origin) {
    for (const signer of req.signers) {
      const token = signerTokens.get(signer.signerId);
      if (!token) continue;
      void emailSigner(signer.email, req.title, `${origin}/sign/${token}`);
    }
  } else {
    log.warn('sign invite emails skipped — no public base URL configured', { signRequestId: req.signRequestId });
  }
  return { ...req, invitesEmailed };
}

/** Test affordance (the `_frameViewCountForToken` convention): raw signer
 *  tokens are no longer at rest, so tests capture them from this BOUNDED
 *  in-process map instead of the store. Never routed; FIFO-capped so a long-
 *  lived process holds only the most recent mints (they exist transiently in
 *  process memory during the email loop regardless). */
const mintedTokensForTest = new Map<string, string>();
function rememberMintedTokenForTest(key: string, token: string): void {
  mintedTokensForTest.set(key, token);
  if (mintedTokensForTest.size > 200) {
    const oldest = mintedTokensForTest.keys().next().value;
    if (oldest !== undefined) mintedTokensForTest.delete(oldest);
  }
}
export function __signerTokenForTest(signRequestId: string, signerId: string): string | undefined {
  return mintedTokensForTest.get(`${signRequestId}:${signerId}`);
}

function publicOriginFromEnv(): string {
  return process.env.OPENWOP_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') ?? '';
}

/** R2 S1R2-2 — the COMPLETION email is not an invite: everyone has signed, and
 *  the link is the signed certificate, not a request to act. */
async function emailSignerCompletion(to: string, title: string, certUrl: string): Promise<void> {
  try {
    await activeProvider().send({
      to,
      subject: `Signed: ${title}`,
      body: [`Everyone has signed "${title}".`, '', `Download the signed certificate: ${certUrl}`, '', SIGN_LEGAL_NOTICE].join('\n'),
    });
  } catch (err) {
    log.warn('sign completion email failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

async function emailSigner(to: string, title: string, url: string): Promise<void> {
  try {
    await activeProvider().send({
      to,
      subject: `Signature requested: ${title}`,
      body: [`You have been asked to review and sign "${title}".`, '', `Open to sign: ${url}`, '', SIGN_LEGAL_NOTICE].join('\n'),
    });
  } catch (err) {
    log.warn('signer invite email failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── status (authed) ──────────────────────────────────────────────────────────

export async function getSignatureStatus(tenantId: string, orgId: string, signRequestId: string): Promise<Record<string, unknown> | null> {
  const req = await getSignRequest(tenantId, orgId, signRequestId);
  if (!req) return null;
  const records = await listSignatureRecords(signRequestId);
  return signStatusView(req, records, certUrlFor(req));
}

export async function listSignatureRequests(tenantId: string, orgId: string): Promise<Record<string, unknown>[]> {
  const reqs = await listSignRequests(tenantId, orgId);
  return Promise.all(reqs.map(async (r) => signStatusView(r, await listSignatureRecords(r.signRequestId), certUrlFor(r))));
}

// ── public: resolve a signer token → the request + signer ─────────────────────

function parseSignerResource(resourceId: string): { signRequestId: string; signerId: string } | null {
  // resourceId = `${signRequestId}:${signerId}`; signRequestId itself is
  // `sign-request:<uuid>` (contains one colon), so split off the LAST segment.
  const idx = resourceId.lastIndexOf(':');
  if (idx <= 0) return null;
  return { signRequestId: resourceId.slice(0, idx), signerId: resourceId.slice(idx + 1) };
}

export async function resolveSigner(resourceId: string): Promise<{ req: SignRequest; signer: Signer } | null> {
  const parsed = parseSignerResource(resourceId);
  if (!parsed) return null;
  const req = await getSignRequestById(parsed.signRequestId);
  if (!req) return null;
  const signer = req.signers.find((s) => s.signerId === parsed.signerId);
  if (!signer) return null;
  return { req, signer };
}

/** Sharing resolver hooks (sign_request capability token). */
export async function signShareValidate(tenantId: string, orgId: string, resourceId: string): Promise<void> {
  const resolved = await resolveSigner(resourceId);
  if (!resolved || resolved.req.tenantId !== tenantId || resolved.req.orgId !== orgId) {
    throw new OpenwopError('not_found', 'Sign request not found.', 404, { resourceId });
  }
}
export async function signShareLoad(tenantId: string, orgId: string, resourceId: string): Promise<Record<string, unknown> | null> {
  if (!esignEnabled()) return null;
  const resolved = await resolveSigner(resourceId);
  if (!resolved || resolved.req.tenantId !== tenantId || resolved.req.orgId !== orgId) return null;
  const rendered = await renderTarget(tenantId, orgId, resolved.req.target);
  return { kind: 'sign_request', ...signPublicView(resolved.req, resolved.signer, rendered) };
}

// ── public: sign / decline ─────────────────────────────────────────────────

export interface SignInput { resourceId: string; typedName: string; ip: string; userAgent: string; nowMs: number;
  /** R2 S-G2 — the signer's explicit legal-notice acknowledgment (recorded on
   *  the SignatureRecord; the public route requires it). */
  acknowledged?: boolean;
  /** R2 S1R2-2 — the public origin (route-derived or OPENWOP_PUBLIC_BASE_URL): the
   *  completion email must carry an ABSOLUTE certificate URL a mail client links. */
  baseUrl?: string }

export async function signRequest(input: SignInput): Promise<{ status: SignRequest['status']; signedAt: string; certificateEmailPlanned: boolean }> {
  const resolved = await resolveSigner(input.resourceId);
  if (!resolved) throw new OpenwopError('not_found', 'Sign request not found.', 404, {});
  const { req, signer } = resolved;

  if (req.status === 'voided' || req.status === 'declined' || req.status === 'completed') {
    throw new OpenwopError('conflict', 'This request can no longer be signed.', 409, { reason: 'terminal', status: req.status });
  }
  if (signer.status !== 'pending') {
    throw new OpenwopError('conflict', 'You have already responded to this request.', 409, { reason: signer.status });
  }
  if (!isSignersTurn(req, signer)) {
    throw new OpenwopError('conflict', 'It is not your turn to sign yet.', 409, { reason: 'out_of_order' });
  }
  const typedName = input.typedName.trim().slice(0, 160);
  if (!typedName) throw new OpenwopError('validation_error', 'A typed name is required to sign.', 400, { field: 'typedName' });

  // Re-hash the target NOW — a change since the request voids the sign, loudly.
  const rendered = await renderTarget(req.tenantId, req.orgId, req.target);
  const currentHash = hashCanonical(rendered.canonical);
  if (currentHash !== req.contentHash) {
    throw new OpenwopError('conflict', 'The document changed after this request was created and can no longer be signed.', 409, { reason: 'content_changed' });
  }

  const signedAt = new Date(input.nowMs).toISOString();
  // Durable proof first (idempotent by (request, signer)); the request's
  // signer-status is derived from it.
  await appendSignatureRecord({
    tenantId: req.tenantId,
    signRequestId: req.signRequestId,
    signerId: signer.signerId,
    signedAt,
    ipHash: hashPii(input.ip),
    userAgentHash: hashPii(input.userAgent),
    contentHashAtSign: currentHash,
    method: 'click-to-sign',
    typedName,
    ...(input.acknowledged !== undefined ? { acknowledgedLegalNotice: input.acknowledged } : {}),
  });

  // Apply the signer's transition under CAS so two signers responding at once
  // never lose an update (a blind put would revert the other's signed status and
  // leave the request stuck partially_signed → certificate never fires).
  const { req: after, changed } = await transitionSignRequest(req.signRequestId, (cur) => {
    if (cur.status === 'voided' || cur.status === 'declined') {
      throw new OpenwopError('conflict', 'This request can no longer be signed.', 409, { reason: 'terminal', status: cur.status });
    }
    const s = cur.signers.find((x) => x.signerId === signer.signerId);
    if (!s) throw new OpenwopError('not_found', 'Sign request not found.', 404, {});
    if (s.status === 'signed') return null; // a concurrent winner already applied it
    if (s.status === 'declined') throw new OpenwopError('conflict', 'You have already responded to this request.', 409, { reason: 'declined' });
    if (!isSignersTurn(cur, s)) throw new OpenwopError('conflict', 'It is not your turn to sign yet.', 409, { reason: 'out_of_order' });
    const nextSigners = cur.signers.map((x) => (x.signerId === s.signerId ? { ...x, status: 'signed' as const, signedAt } : x));
    const allSigned = nextSigners.every((x) => x.status === 'signed');
    return { ...cur, signers: nextSigners, status: allSigned ? 'completed' : 'partially_signed', ...(allSigned ? { completedAt: signedAt } : {}) };
  });
  if (!after) throw new OpenwopError('not_found', 'Sign request not found.', 404, {});

  if (changed) {
    crmMutated({ entity: 'sign-request', verb: after.status === 'completed' ? 'completed' : 'signed', tenantId: after.tenantId, orgId: after.orgId, actor: `signer:${signer.signerId}`, entityId: after.signRequestId });
  }
  // Finalize exactly once — only the CAS write that flipped the request to
  // completed runs it (a concurrent loser sees `changed=false` or a non-completed
  // return and does nothing).
  if (changed && after.status === 'completed') {
    await revokeAllSignerTokens(after.tenantId, after);
    await finalizeCertificate(after, rendered.markdown, input.baseUrl);
  }
  // UX_UPGRADE-crm-public S-G1 — return the SERVER's signature instant so the
  // signer's downloadable copy carries the same timestamp as the durable
  // record. The client must never stamp this itself: a copy of an agreement
  // dated by the signer's own clock is not a record of anything.
  // R2 S1R2-3 — the done screen must not promise an email that cannot be
  // delivered: no transport or no public origin ⇒ no certificate email, ever.
  const certificateEmailPlanned = emailTransportConfigured() && Boolean((input.baseUrl ?? '').trim() || publicOriginFromEnv());
  return { status: after.status, signedAt, certificateEmailPlanned };
}

/**
 * Read-modify-CAS-retry a sign request's state. `mutate` returns the next request,
 * or null when no change is needed (a concurrent winner already applied it — the
 * idempotent no-op). `mutate` MAY throw a typed error to reject the transition.
 * Returns the resulting request + whether THIS call wrote it (so completion side
 * effects fire exactly once).
 */
async function transitionSignRequest(
  signRequestId: string,
  mutate: (cur: SignRequest) => SignRequest | null,
): Promise<{ req: SignRequest | null; changed: boolean }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await getSignRequestById(signRequestId);
    if (!cur) return { req: null, changed: false };
    const next = mutate(cur);
    if (next === null) return { req: cur, changed: false };
    if (await casSignRequest(cur, next)) return { req: next, changed: true };
    // CAS lost a race — re-read and retry.
  }
  throw new OpenwopError('conflict', 'Could not apply the change due to concurrent updates. Please retry.', 409, { reason: 'cas_exhausted' });
}

export async function declineSign(resourceId: string, nowMs: number): Promise<{ status: SignRequest['status'] }> {
  const resolved = await resolveSigner(resourceId);
  if (!resolved) throw new OpenwopError('not_found', 'Sign request not found.', 404, {});
  const { req, signer } = resolved;
  const { req: after, changed } = await transitionSignRequest(req.signRequestId, (cur) => {
    if (cur.status === 'voided' || cur.status === 'declined' || cur.status === 'completed') return null; // terminal — idempotent
    const nextSigners = cur.signers.map((s) => (s.signerId === signer.signerId ? { ...s, status: 'declined' as const, signedAt: new Date(nowMs).toISOString() } : s));
    return { ...cur, signers: nextSigners, status: 'declined' };
  });
  if (!after) throw new OpenwopError('not_found', 'Sign request not found.', 404, {});
  if (changed) {
    await revokeAllSignerTokens(after.tenantId, after);
    crmMutated({ entity: 'sign-request', verb: 'declined', tenantId: after.tenantId, orgId: after.orgId, actor: `signer:${signer.signerId}`, entityId: after.signRequestId });
  }
  return { status: after.status };
}

// ── void (authed requester) ────────────────────────────────────────────────

export async function voidSignRequest(tenantId: string, orgId: string, signRequestId: string, actor: string): Promise<SignRequest | null> {
  // Org-guard the initial read (IDOR); then transition under CAS so a void racing
  // a completing sign resolves deterministically (the CAS loser re-reads).
  const guard = await getSignRequest(tenantId, orgId, signRequestId);
  if (!guard) return null;
  const { req: after, changed } = await transitionSignRequest(signRequestId, (cur) => {
    if (cur.status === 'completed') throw new OpenwopError('conflict', 'A completed request cannot be voided.', 409, { reason: 'completed' });
    if (cur.status === 'voided') return null; // idempotent
    return { ...cur, status: 'voided' };
  });
  if (!after) return null;
  if (changed) {
    await revokeAllSignerTokens(tenantId, after);
    crmMutated({ entity: 'sign-request', verb: 'voided', tenantId, orgId, actor, entityId: signRequestId });
  }
  return after;
}

// ── certificate ───────────────────────────────────────────────────────────

async function finalizeCertificate(req: SignRequest, targetMarkdown: string, baseUrl?: string): Promise<void> {
  try {
    const records = await listSignatureRecords(req.signRequestId);
    const recBySigner = new Map(records.map((r) => [r.signerId, r]));
    const signerRows = req.signers.map((s) => {
      const rec = recBySigner.get(s.signerId);
      return `| ${rec?.typedName ?? s.name ?? '—'} | ${s.email} | ${s.signedAt ?? '—'} | ${rec?.ipHash ?? '—'} | ${rec?.userAgentHash ?? '—'} |`;
    }).join('\n');
    const md = [
      `# Certificate of Completion`,
      '',
      `**Document:** ${req.title}`,
      `**Request ID:** ${req.signRequestId}`,
      `**Completed:** ${req.completedAt ?? ''}`,
      `**Content hash (SHA-256):** \`${req.contentHash}\``,
      '',
      '## Signers',
      '',
      '| Name | Email | Signed at (UTC) | IP hash | UA hash |',
      '| --- | --- | --- | --- | --- |',
      signerRows,
      '',
      '## Signed content',
      '',
      targetMarkdown,
      '',
      '---',
      '',
      `_${SIGN_LEGAL_NOTICE}_`,
    ].join('\n');

    const { renderMarkdownToPdf } = await import('../documents/render.js');
    const bytes = await renderMarkdownToPdf(md, { title: `Certificate — ${req.title}` });
    const { put: mediaPut } = await import('../media/mediaStorage.js');
    const { createAsset } = await import('../media/mediaService.js');
    const stored = await mediaPut(req.tenantId, { contentBase64: bytes.toString('base64'), contentType: 'application/pdf' });
    await createAsset({
      tenantId: req.tenantId, orgId: req.orgId, name: `certificate-${req.signRequestId}.pdf`,
      contentType: 'application/pdf', sizeBytes: stored.sizeBytes, storageRef: stored.storageRef, serveToken: stored.serveToken,
      uploadedBy: MANAGE_TOKEN_ACTOR,
    });
    // Re-read (a concurrent write is unlikely on a completed request) and stamp.
    const fresh = await getSignRequestById(req.signRequestId);
    if (fresh && !fresh.certificateArtifactId) await putSignRequest({ ...fresh, certificateArtifactId: stored.serveToken });

    // Notify the requester + email signers the completed certificate URL.
    const certUrl = `/v1/host/openwop-app/assets/${stored.serveToken}`;
    // R2 S1R2-2 — mail clients don't link a schemeless path; absolute or nothing.
    const origin = (baseUrl ?? '').trim().replace(/\/+$/, '') || publicOriginFromEnv();
    try {
      await getNotificationEmitter().emit({
        tenantId: req.tenantId, type: 'workflow.completed', priority: 'normal',
        title: 'Signature completed', message: `All signers have signed "${req.title}".`,
        actionUrl: `/crm?tab=esign&org=${encodeURIComponent(req.orgId)}`,
        metadata: { signRequestId: req.signRequestId },
      });
    } catch (err) { log.warn('sign-complete notification failed', { signRequestId: req.signRequestId, error: err instanceof Error ? err.message : String(err) }); }
    if (origin) {
      for (const s of req.signers) void emailSignerCompletion(s.email, req.title, `${origin}${certUrl}`);
    } else {
      log.warn('sign completion emails skipped — no public base URL configured', { signRequestId: req.signRequestId });
    }
  } catch (err) {
    log.warn('certificate generation failed', { signRequestId: req.signRequestId, error: err instanceof Error ? err.message : String(err) });
  }
}
