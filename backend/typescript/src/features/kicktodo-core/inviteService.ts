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
import { registerKvAgeOut } from '../../host/kvAgeOut.js';
import { registerTenantIndexAdoption } from '../../host/tenantIndexAdoption.js';
import { hasPublishedVersion, listPublished } from './challengeService.js';
import { KICKTODO_REVOKED_ROW_RETENTION_DAYS } from './types.js';

export interface InviteRow {
  tokenHash: string;
  tenantId: string;
  challengeId: string;
  inviterSubject: string;
  createdAt: string;
  revokedAt?: string;
}

/** Hash-keyed token rows (the lookup lane). KTX-D1 / KTC-8 (KickTodo wave 4C) —
 *  the primary key stays the hash (the public resolve has no tenant, and existing
 *  production rows are never re-keyed); the 4th arg adds a TENANT SECONDARY INDEX
 *  written on every put/CAS/delete, so a per-tenant read is a bounded slice. */
const invites = new DurableCollection<InviteRow>('kicktodo-invites', (r) => r.tokenHash, undefined, (r) => r.tenantId);
// ADR 0866 — rows written before the index have no marker. The hourly reconcile
// (retention tick) is the idempotent backfill: it writes a marker for every
// unmarked row, changes nothing on a second pass, and VERIFIES the index only
// after a full adoption window. Until then `tenantInvites` keeps the full scan.
registerTenantIndexAdoption('kicktodo-invites', invites);
// KTCORE-4 — revoked invites were never purged (one per re-mint, unbounded). A
// revoked token already resolves exactly like an unknown one (`resolveInvite` →
// null), so past the window it is reclaimed. Keyed on `revokedAt`: a live token
// has none and is never touched. `acceptIndexed`: the sweep deletes through the
// collection, so the tenant-index marker goes with the row.
registerKvAgeOut({
  id: 'kicktodo-invites:revoked',
  prefix: 'hostext:kicktodo-invites:',
  ttlDays: KICKTODO_REVOKED_ROW_RETENTION_DAYS,
  timestampField: 'revokedAt',
  acceptIndexed: true,
});

/** KTC-8 — one tenant's invite rows: the verified tenant index, else (until the
 *  backfill has run and been verified) the legacy full scan + tenant filter. */
async function tenantInvites(tenantId: string): Promise<InviteRow[]> {
  if (await invites.tenantIndexVerified()) return invites.listForTenantIndexed(tenantId);
  return (await invites.list()).filter((r) => r.tenantId === tenantId);
}

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

  // KTCORE-3 — the index row is the ONE-live-token claim, so it is taken by CAS.
  // The old read-then-put let two concurrent mints both read the same prior,
  // both write their own token row, and both put the index (last write wins):
  // the loser's token stayed LIVE with nothing pointing at it, so no re-mint or
  // revoke could ever reach it. Order is deliberate: claim the index FIRST,
  // write the token row only after winning. A crash between the two leaves the
  // index naming a row that does not exist (resolves to "no attribution", and
  // the next mint replaces it) — never a live token the index does not track.
  const idxKey = `${tenantId}::${challengeId}::${inviterSubject}`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const prior = await inviteIndex.get(idxKey);
    // ADR 0448 P1 — the host mint (hash computed once; raw returned exactly once).
    const { raw, hash } = mintToken('ktinv');
    const claimed = await inviteIndex.compareAndSwap(prior, { tenantId, challengeId, inviterSubject, tokenHash: hash });
    if (!claimed) continue; // a concurrent mint/erase moved the index — re-read and retry
    await invites.put({ tokenHash: hash, tenantId, challengeId, inviterSubject, createdAt: nowIso() });
    if (prior) await revokeTokenRow(prior.tokenHash);
    // A later mint may have superseded our index claim BEFORE our row existed,
    // so its revoke of our hash found nothing. Re-check after writing: if the
    // index no longer names us, our row is untracked — revoke it ourselves.
    // (The caller's link then reads as revoked: the concurrent later mint by
    // the same inviter is the one live link, which is the one-live rule.)
    if ((await inviteIndex.get(idxKey))?.tokenHash !== hash) await revokeTokenRow(hash);
    return raw;
  }
  throw new InviteConflictError();
}

/** KTCORE-3 — the index kept moving under four consecutive mints. */
export class InviteConflictError extends Error {
  constructor() { super('Concurrent invite updates — retry.'); }
}

async function revokeTokenRow(tokenHash: string): Promise<void> {
  const row = await invites.get(tokenHash);
  if (row && !row.revokedAt) await invites.put({ ...row, revokedAt: nowIso() });
}

/** KTCORE-2 — revoke EVERY live invite for a challenge (all inviters). Called by
 *  `retireOne` once no version of the challenge is published. Bounded by the
 *  tenant+challenge prefix of the one-live index. Returns the count revoked. */
export async function revokeInvitesForChallenge(tenantId: string, challengeId: string): Promise<number> {
  let revoked = 0;
  for (const idx of await inviteIndex.listByPrefix(`${tenantId}::${challengeId}::`)) {
    if (idx.tenantId !== tenantId || idx.challengeId !== challengeId) continue;
    const row = await invites.get(idx.tokenHash);
    if (row && !row.revokedAt) {
      await invites.put({ ...row, revokedAt: nowIso() });
      revoked += 1;
    }
  }
  return revoked;
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
  // KTCORE-2 — the link shares a CHALLENGE, so it is only live while that
  // challenge is: a token minted before a retire (or whose retire-time revoke
  // was missed) must not keep stamping attribution onto a dead challenge.
  if (!(await hasPublishedVersion(tenantId, row.challengeId))) return null;
  return row;
}

// ── ADR 0458 Phase 0 — compliance (subject erasure) ──
/** DSAR erasure: delete every invite (and its one-live index row) MINTED BY the
 *  subject in this tenant. The token store is hash-keyed (no tenant prefix), so
 *  the invite read goes through the tenant index (KTC-8 — it scanned every
 *  tenant before); the one-live index is tenant-prefixed. Idempotent;
 *  fail-closed on a falsy tenant/subject. Returns the count of invites removed. */
export async function eraseSubjectInvites(tenantId: string, subjectKey: string): Promise<number> {
  if (!tenantId || !subjectKey) return 0;
  let removed = 0;
  for (const r of await tenantInvites(tenantId)) {
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

/** Test seam. */
export const __test = { invites, inviteIndex };
