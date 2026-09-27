/**
 * "Challenge a friend" invite links (ADR 0444 I1) — the consent-clean remnant of
 * the original viral loop: an invite shares a CHALLENGE, never the inviter's
 * activity, and grants NOTHING but attribution (no scopes, no circle membership
 * — a circle invite stays the explicit ADR 0419 consent flow).
 *
 * Token posture mirrors the ADR 0421 feed token: the store is HASH-keyed
 * (sha256; a leaked DB row can't be replayed as a link) with tenant IN CONTENT
 * (purge-safe — the KTD-1 content-scan finding). ONE live token per
 * (inviter, challenge): re-mint revokes the old and mints fresh.
 */

import { hashToken, mintToken } from '../../host/capabilityToken.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { listPublished } from './challengeService.js';

export interface InviteRow {
  tokenHash: string;
  tenantId: string;
  challengeId: string;
  inviterSubject: string;
  createdAt: string;
  revokedAt?: string;
}

/** Hash-keyed token rows (the lookup lane). */
const invites = new DurableCollection<InviteRow>('kicktodo-invites', (r) => r.tokenHash);

/** One-live-per-(inviter, challenge) index → the current tokenHash. */
const inviteIndex = new DurableCollection<{ tenantId: string; challengeId: string; inviterSubject: string; tokenHash: string }>(
  'kicktodo-invite-index',
  (r) => `${r.tenantId}::${r.challengeId}::${r.inviterSubject}`,
);

const nowIso = (): string => new Date().toISOString();

export class InviteDeniedError extends Error {
  constructor() { super('Not found.'); } // uniform — no existence leak
}

/** Mint (or re-mint) the inviter's link token for a PUBLISHED challenge.
 *  Re-minting revokes the prior token (one live link per inviter+challenge —
 *  an inherent mint cap) and returns a fresh raw token. */
export async function mintInvite(tenantId: string, challengeId: string, inviterSubject: string): Promise<string> {
  // Published-only: an invite never points at a draft/retired-only lineage
  // (the catalog owner's published projection is the single truth of that).
  const anyPublished = (await listPublished(tenantId)).some((c) => c.id === challengeId);
  if (!anyPublished) throw new InviteDeniedError();

  const idxKey = `${tenantId}::${challengeId}::${inviterSubject}`;
  const prior = await inviteIndex.get(idxKey);
  if (prior) {
    const priorRow = await invites.get(prior.tokenHash);
    if (priorRow && !priorRow.revokedAt) await invites.put({ ...priorRow, revokedAt: nowIso() });
  }
  // ADR 0448 P1 — the host mint (hash computed once; raw returned exactly once).
  const { raw, hash } = mintToken('ktinv');
  await invites.put({ tokenHash: hash, tenantId, challengeId, inviterSubject, createdAt: nowIso() });
  await inviteIndex.put({ tenantId, challengeId, inviterSubject, tokenHash: hash });
  return raw;
}

/** Revoke the inviter's live token (uniform no-op when none). */
export async function revokeInvite(tenantId: string, challengeId: string, inviterSubject: string): Promise<void> {
  const idx = await inviteIndex.get(`${tenantId}::${challengeId}::${inviterSubject}`);
  if (!idx) return;
  const row = await invites.get(idx.tokenHash);
  if (row && !row.revokedAt) await invites.put({ ...row, revokedAt: nowIso() });
}

/** Resolve a raw token → its live row, TENANT-CHECKED (an invite never crosses
 *  tenants). Null on unknown/revoked/foreign — callers treat null as "no
 *  attribution", never an error (an invalid token must not break enrolling). */
export async function resolveInvite(tenantId: string, rawToken: string): Promise<InviteRow | null> {
  const row = await invites.get(hashToken(rawToken));
  if (!row || row.revokedAt || row.tenantId !== tenantId) return null;
  return row;
}

// ── ADR 0458 Phase 0 — compliance (subject erasure) ──
/** DSAR erasure: delete every invite (and its one-live index row) MINTED BY the
 *  subject in this tenant. The token store is hash-keyed (no tenant prefix), so
 *  the invite scan is a `list()`; the index is tenant-prefixed. Idempotent;
 *  fail-closed on a falsy tenant/subject. Returns the count of invites removed. */
export async function eraseSubjectInvites(tenantId: string, subjectKey: string): Promise<number> {
  if (!tenantId || !subjectKey) return 0;
  let removed = 0;
  for (const r of await invites.list()) {
    if (r.tenantId === tenantId && r.inviterSubject === subjectKey) {
      if (await invites.delete(r.tokenHash)) removed += 1;
    }
  }
  for (const idx of await inviteIndex.listByPrefix(`${tenantId}::`)) {
    if (idx.tenantId === tenantId && idx.inviterSubject === subjectKey) {
      await inviteIndex.delete(`${idx.tenantId}::${idx.challengeId}::${idx.inviterSubject}`);
    }
  }
  return removed;
}
