/**
 * Identity floor — deterministic session↔contact link (ADR 0226 / campaign gap
 * plan §5D D4). Analytics owns the session concept, so the link table lives
 * here: ONE row per (tenant, sessionKey) mapping an anonymous analytics session
 * to a CRM contact, written only by the two DETERMINISTIC writers —
 *
 *   - the public form submit (a visitor typed their details; source
 *     `'form-submit'`), consent-gated on `analytics` like the beacon, and
 *   - the email-click beacon hop (an opaque `owx` click token resolved back to
 *     its contact; source `'email-click'`).
 *
 * STRICT boundary (gap plan §6 — full CDP is a recorded NON-goal): no
 * probabilistic matching, no contact merge, no identity graph. Last-writer-wins
 * per session (a session is short-lived and single-visitor by construction; the
 * newest deterministic evidence is the best evidence — we deliberately do NOT
 * keep a history). Erasure: registered with the subject-erasure seam so a GDPR
 * data-subject delete removes link rows matching the subject by sessionKey AND
 * by contactId (either side may be the erased subject).
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser, registerSubjectKeyResolver } from '../../host/subjectErasure.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { cleanString } from '../../host/boundedStrings.js';

export type IdentityLinkSource = 'form-submit' | 'email-click';

export interface IdentityLink {
  /** `${tenantId}::${sessionKey}` — one link per session. */
  key: string;
  tenantId: string;
  sessionKey: string;
  contactId: string;
  source: IdentityLinkSource;
  at: string;
}

/** Same bound the analytics beacon applies to `sessionKey` (MAX_STR). */
const MAX_KEY = 1024;

const links = new DurableCollection<IdentityLink>('analytics:identity-link', (l) => l.key);

const keyOf = (tenantId: string, sessionKey: string): string => `${tenantId}::${sessionKey}`;

/** Upsert the session's link (last-writer-wins — see module header). Returns
 *  null (a no-op) on empty/oversized-to-empty inputs rather than throwing:
 *  both writers are best-effort side channels. */
export async function linkSession(
  tenantId: string, sessionKey: string, contactId: string, source: IdentityLinkSource,
): Promise<IdentityLink | null> {
  const s = cleanString(sessionKey, MAX_KEY);
  const c = cleanString(contactId, MAX_KEY);
  if (!tenantId || !s || !c) return null;
  const link: IdentityLink = { key: keyOf(tenantId, s), tenantId, sessionKey: s, contactId: c, source, at: new Date().toISOString() };
  invalidateLinksSnapshot();
  await links.put(link);
  return link;
}

/** Resolve a session to its linked contactId (null when unlinked). */
export async function contactForSession(tenantId: string, sessionKey: string): Promise<string | null> {
  const s = cleanString(sessionKey, MAX_KEY);
  if (!tenantId || !s) return null;
  const row = await links.get(keyOf(tenantId, s));
  return row && row.tenantId === tenantId ? row.contactId : null;
}

/** GDPR erasure: remove every link row for this tenant whose sessionKey OR
 *  contactId is the erased subject (the subject key may be either side —
 *  the beacon's anon session id or the CRM contactId). Returns count removed. */
export async function eraseSubjectLinks(tenantId: string, subjectKey: string): Promise<number> {
  invalidateLinksSnapshot();
  if (!tenantId || !subjectKey) return 0;
  const all = await links.listByPrefix(`${tenantId}::`);
  let removed = 0;
  for (const l of all) {
    if (l.tenantId !== tenantId) continue;
    if (l.sessionKey === subjectKey || l.contactId === subjectKey) {
      if (await links.delete(l.key)) removed += 1;
    }
  }
  return removed;
}

// Register with the subject-erasure seam (the analytics pattern) so Consent's
// data-subject delete cascades here. Module-load once per process.
// ANLWF-5 / ADR 0651 D5 — CORRECTED (grade-code 2026-09-10): this comment first
// claimed the eraser "was never pinned". FALSE — `host/subjectEraserManifest.ts`
// has listed `identityLinkEraser` since the consent batch (32319c52e), and the
// manifest pins by `fn.name`, which the `const` arrow already satisfied. The
// arrow→declaration change is cosmetic and kept only for readability; the real
// D5 change is the `declarePiiFields` below. The false claim is recorded rather
// than deleted because the ADR and the workflows assessment repeated it.
async function identityLinkEraser(tenantId: string, subjectKey: string): Promise<void> { await eraseSubjectLinks(tenantId, subjectKey); }
// ANLWF-6 / ADR 0651 D5 — a durable session↔contact mapping is the single most
// re-identifying artifact this feature produces; it read as plain `internal`.
// `maskGloballyByFieldName: false` for the same reason the analytics header gives
// for `sessionKey`: a global leaf-key mask on these names corrupts live log sites.
declarePiiFields('analytics.identity-link', ['sessionKey', 'contactId'], { maskGloballyByFieldName: false });
registerSubjectEraser(identityLinkEraser);

// ADR 0381 — the subject-key resolver: expand the erased subject to ALL of its linked
// identity keys BEFORE the erasure fan-out, so a delete keyed by a CDP sessionKey reaches
// the same person's contactId-keyed data (orders, etc.) and vice-versa. The graph is
// bipartite (session ↔ contact), so a 2-hop closure is COMPLETE:
//   {subject} ∪ contactForSession(subject) ∪ sessionsForContact(subject)
//            ∪ sessionsForContact(contactForSession(subject))
// Returns only authoritative, store-backed link keys (never a heuristic).
//
// NAMESPACE GUARD (grade-pass hardening): a `sessionKey` is CLIENT-supplied (analytics beacon
// / form-submit body), only length-capped — so a caller could plant a link whose sessionKey
// collides with the `crm:`-prefixed contactId namespace (e.g. `sessionKey = "crm:<victim>"`).
// Without this guard, `sessionsForContact` would then hand that value to the erasure fan-out
// as a subject key, letting an erasure of ONE subject reach a DIFFERENT subject's
// contact-keyed data (over-erasure). A real session key is never `crm:`-prefixed, so drop any
// session-hop result that looks like a contactId. (The `contactForSession` hop returns a
// system-resolved stored contactId, not raw client input, so it needs no such filter.)
//
// WF-ANL-8 — THE RESOLVER MUST NOT READ THE SNAPSHOT. `sessionsForContact`
// serves the lead-score read from a process-global 60s snapshot invalidated
// ONLY IN-PROCESS (`invalidateLinksSnapshot`). On a multi-instance fleet — the
// deployment this host actually ships to — instance B's `linkSession` write
// does not invalidate instance A's snapshot, so an erasure fielded by A can
// resolve a SHORT key closure and silently UNDER-ERASE: the person's
// contact-keyed data is never enumerated and therefore never deleted, while
// the fan-out still reports a clean erasure. A 60-second staleness window is a
// fine trade for a score; it is not one for a GDPR erasure. The resolver reads
// FRESH, tenant-scoped, every time.
const looksLikeContactId = (k: string): boolean => k.startsWith('crm:');
const identityLinkResolver = async (tenantId: string, subjectKey: string): Promise<readonly string[]> => {
  if (!tenantId || !subjectKey) return [];
  const keys = new Set<string>();
  const contact = await contactForSession(tenantId, subjectKey); // subject-as-session → its contact (a direct `get`, never cached)
  if (contact) keys.add(contact);
  for (const s of await sessionsForContact(tenantId, subjectKey, { fresh: true })) if (!looksLikeContactId(s)) keys.add(s); // subject-as-contact → its sessions
  if (contact) for (const s of await sessionsForContact(tenantId, contact, { fresh: true })) if (!looksLikeContactId(s)) keys.add(s); // sibling sessions
  keys.delete(subjectKey); // the caller already seeds the bare subjectKey
  return [...keys];
};
registerSubjectKeyResolver(identityLinkResolver);

/** Test-only: clear the link store. */
// GC-D3-1 (grade-code) — the links store has no tenant index (its key is
// `${tenantId}::${sessionKey}`), so the lead-score read amortizes the full
// scan through a short-TTL snapshot (the resolveCustomHost cache pattern):
// repeated score reads within the window share ONE scan. Writers invalidate.
let linksSnapshot: IdentityLink[] | null = null;
let linksSnapshotAt = 0;
const LINKS_SNAPSHOT_TTL_MS = 60_000;
function invalidateLinksSnapshot(): void { linksSnapshot = null; linksSnapshotAt = 0; }

/**
 * ADR 0297 D3 — every session linked to a contact (the lead-score read).
 *
 * `fresh: true` (WF-ANL-8) BYPASSES the snapshot and reads this tenant's slice
 * directly through the `${tenantId}::` key prefix — bounded, so it is not the
 * full scan the snapshot exists to amortize. Correctness callers (the ADR 0381
 * erasure resolver) MUST pass it: the snapshot is invalidated in-process only,
 * so a stale one on a multi-instance fleet returns a short key closure and the
 * erasure silently under-reaches.
 */
export async function sessionsForContact(
  tenantId: string,
  contactId: string,
  opts: { fresh?: boolean } = {},
): Promise<string[]> {
  const pick = (rows: readonly IdentityLink[]): string[] =>
    rows.filter((l) => l.tenantId === tenantId && l.contactId === contactId).map((l) => l.sessionKey);
  if (opts.fresh) return pick(await links.listByPrefix(`${tenantId}::`));
  const now = Date.now();
  if (!linksSnapshot || now - linksSnapshotAt > LINKS_SNAPSHOT_TTL_MS) {
    linksSnapshot = await links.list();
    linksSnapshotAt = now;
  }
  return pick(linksSnapshot);
}

export async function __resetIdentityLinks(): Promise<void> { await links.__clear(); invalidateLinksSnapshot(); }
