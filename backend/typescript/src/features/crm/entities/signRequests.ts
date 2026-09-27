/**
 * CRM e-signature entities (ADR 0402 §b) — a SignRequest (the multi-party
 * request) and append-only SignatureRecord audit rows. KV-blob
 * DurableCollections over host_ext_kv (ADR 0383 family — NO SQL migration).
 *
 * @see docs/adr/0402-crm-booking-and-esign.md §b
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';
import { MAX, MAX_PER_ORG_ENTITIES, assertUnderCap, nowIso } from './shared.js';
import type { SignTargetKind } from '../signTargets.js';

export type SignerStatus = 'pending' | 'signed' | 'declined';
export type SignRequestStatus = 'draft' | 'sent' | 'partially_signed' | 'completed' | 'declined' | 'voided';
export const SIGN_REQUEST_STATUSES: SignRequestStatus[] = ['draft', 'sent', 'partially_signed', 'completed', 'declined', 'voided'];

export interface Signer {
  signerId: string;
  email: string;
  name?: string;
  /** Sequential-signing order (lower signs first); absent ⇒ any order. */
  order?: number;
  status: SignerStatus;
  signedAt?: string;
  /** The minted sharing `sign_request` capability token for this signer — the
   *  credential in the emailed link. DEPRECATED (ADR 0448 grade fix #2): never
   *  written since 2026-07-20 — the raw is emailed and dropped; `putSignRequest`
   *  strips it defensively, so pre-fix rows shed theirs on next write. */
  token?: string;
}

export interface SignRequest {
  signRequestId: string;
  tenantId: string;
  orgId: string;
  title: string;
  target: { kind: SignTargetKind; id: string };
  /** SHA-256 of the target's canonical serialization AT REQUEST TIME. */
  contentHash: string;
  signers: Signer[];
  status: SignRequestStatus;
  /** Which signature provider handled this request (ADR 0402 §c / P3 seam).
   *  v1 registers only `native`; an external connector (DocuSign/eIDAS) is a
   *  deferred RFC 0095 connection pack. Stamped now so a future external request
   *  is distinguishable with NO entity reshape. */
  provider: string;
  createdBy: string;
  /** R2 S1R2-5 — the human-facing requester identity, captured at creation
   *  (display name/email of the acting user). Optional: pre-R2 rows lack it. */
  requestedBy?: { name?: string; email?: string };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** The generated PDF certificate's media serve token (ADR 0402 §b). */
  certificateArtifactId?: string;
}

export interface SignatureRecord {
  /** `${signRequestId}:${signerId}` — one signature event per signer. */
  recordId: string;
  /** The owning tenant — the tenant-teardown reclaim key (ADR 0284). Signature
   *  records hold signer PII (typed name), so they MUST be purgeable on erasure. */
  tenantId: string;
  signRequestId: string;
  signerId: string;
  signedAt: string;
  /** Hashed IP + UA — the raw values are PII we do not retain. */
  ipHash: string;
  userAgentHash: string;
  /** MUST equal SignRequest.contentHash — a mismatch voids the sign. */
  contentHashAtSign: string;
  method: 'click-to-sign';
  /** R2 S-G2 — the signer's explicit legal-notice acknowledgment, recorded
   *  server-side with the signature (optional: pre-R2 records lack it). */
  acknowledgedLegalNotice?: boolean;
  typedName?: string;
}

const MAX_SIGNERS = 20;

function isSignRequest(v: unknown): SignRequest | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.signRequestId !== 'string' || typeof r.tenantId !== 'string' || !Array.isArray(r.signers)) return null;
  return v as SignRequest;
}

function isSignatureRecord(v: unknown): SignatureRecord | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.recordId !== 'string' || typeof r.tenantId !== 'string' || typeof r.signRequestId !== 'string' || typeof r.signerId !== 'string' || typeof r.contentHashAtSign !== 'string') return null;
  return v as SignatureRecord;
}

const requests = new DurableCollection<SignRequest>('crm:sign-request', (r) => r.signRequestId, isSignRequest, (r) => r.tenantId);
// tenantOf MUST be the real tenant (not signRequestId) so tenant teardown reclaims
// these PII-bearing audit rows — the P0 orphan grade-data flagged.
const records = new DurableCollection<SignatureRecord>('crm:signature-record', (r) => r.recordId, isSignatureRecord, (r) => r.tenantId);

export function signatureRecordId(signRequestId: string, signerId: string): string {
  return `${signRequestId}:${signerId}`;
}

export async function listSignRequests(tenantId: string, orgId: string): Promise<SignRequest[]> {
  return (await requests.listForTenantIndexed(tenantId))
    .filter((r) => r.orgId === orgId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSignRequest(tenantId: string, orgId: string, signRequestId: string): Promise<SignRequest | null> {
  const r = await requests.get(signRequestId);
  return r && r.tenantId === tenantId && r.orgId === orgId ? r : null;
}

/** By id WITHOUT the org guard — for the public signing path, where the
 *  capability token is the authority (still tenant/org re-checked by the caller). */
export async function getSignRequestById(signRequestId: string): Promise<SignRequest | null> {
  return requests.get(signRequestId);
}

export async function createSignRequest(input: {
  tenantId: string;
  orgId: string;
  title: string;
  target: { kind: SignTargetKind; id: string };
  contentHash: string;
  signers: Signer[];
  createdBy: string;
  requestedBy?: { name?: string; email?: string };
  status?: SignRequestStatus;
  /** The handling provider (P3 seam); defaults to `native`. */
  provider?: string;
  /** Deterministic id (ADR 0162). MUST be `sign-request:`-prefixed. */
  signRequestId?: string;
}): Promise<SignRequest> {
  if (input.signRequestId !== undefined) {
    if (!input.signRequestId.startsWith('sign-request:')) {
      throw new OpenwopError('validation_error', 'signRequestId must be `sign-request:`-prefixed.', 400, { signRequestId: input.signRequestId });
    }
    const existing = await requests.get(input.signRequestId);
    if (existing) {
      if (existing.tenantId === input.tenantId && existing.orgId === input.orgId) return existing;
      throw new OpenwopError('not_found', 'Sign request not found.', 404, { signRequestId: input.signRequestId });
    }
  }
  if (input.signers.length === 0 || input.signers.length > MAX_SIGNERS) {
    throw new OpenwopError('validation_error', `A sign request needs 1–${MAX_SIGNERS} signers.`, 400, { field: 'signers' });
  }
  assertUnderCap((await listSignRequests(input.tenantId, input.orgId)).length, MAX_PER_ORG_ENTITIES, 'sign requests');
  const ts = nowIso();
  const req: SignRequest = {
    signRequestId: input.signRequestId ?? `sign-request:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    title: input.title.slice(0, MAX.name),
    target: input.target,
    contentHash: input.contentHash,
    signers: input.signers,
    status: input.status ?? 'sent',
    provider: input.provider ?? 'native',
    createdBy: input.createdBy,
    ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
    createdAt: ts,
    updatedAt: ts,
  };
  await requests.put(req);
  return req;
}

export async function putSignRequest(next: SignRequest): Promise<void> {
  // ADR 0448 grade fix #2 — raw signer tokens are never at rest: strip on
  // every persist (pre-fix rows shed theirs on their next write).
  const signers = next.signers.map((s) => { const { token: _raw, ...rest } = s; return rest; });
  await requests.put({ ...next, signers, updatedAt: nowIso() });
}

/** Atomic compare-and-swap on a sign request (the concurrency gate for
 *  multi-signer status transitions — a blind put loses updates when two signers
 *  respond at once). `expected` MUST be the exact object last read. */
export async function casSignRequest(expected: SignRequest, next: SignRequest): Promise<boolean> {
  return requests.compareAndSwap(expected, { ...next, updatedAt: nowIso() });
}

/** Append (idempotent by `${signRequestId}:${signerId}`) a signature audit row. */
export async function appendSignatureRecord(rec: Omit<SignatureRecord, 'recordId'>): Promise<SignatureRecord> {
  const recordId = signatureRecordId(rec.signRequestId, rec.signerId);
  const existing = await records.get(recordId);
  if (existing) return existing; // one signature event per signer — never overwrite
  const full: SignatureRecord = { ...rec, recordId };
  await records.put(full);
  return full;
}

export async function listSignatureRecords(signRequestId: string): Promise<SignatureRecord[]> {
  return (await records.listByPrefix(`${signRequestId}:`)).sort((a, b) => a.signedAt.localeCompare(b.signedAt));
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __clearSignRequests(): Promise<void> {
  await requests.__clear();
  await records.__clear();
}
