/**
 * Dealer Network — deal registration + the capability-token partner portal
 * (ADR 0281 Phase 2).
 *
 * Reuses the SHARING PATTERN (ADR 0013), not its code: the sharing service's
 * resolver is bound to CMS content types, so — rather than fork it to know about
 * dealers — we mint a dealers-owned opaque capability token bound to one dealer,
 * and resolve tenant+org+dealer FROM the token (never the request). A partner
 * (dealer) uses the token to view their status/outlets and register deals; an
 * internal manager approves/rejects. Uniform 404 on a bad/absent token (no
 * existence leak); the public prefix rides `PUBLIC_PATH_PREFIXES` + the global
 * per-IP rate limit + bounded payloads.
 *
 * @see docs/adr/0281-dealer-network-prm.md §3/§7
 */

import { randomUUID, createHash } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { OpenwopError } from '../../../types.js';
import { cleanString } from '../../../host/boundedStrings.js';
import { createDealerRegistrationApproval, findPendingDealerRegistrationApproval, closePendingDealerRegistrationApprovals, reopenApproval } from '../../../host/approvalService.js';
import { subjectKeyForms, ERASED } from '../../../host/subjectErasureRedaction.js';
import { getDealer } from './dealer.js';
import { validateRegistration, validatePartnerToken } from './rowGuards.js';
import { createLogger } from '../../../observability/logger.js';

export type RegistrationStatus = 'pending' | 'approved' | 'rejected';

export interface DealRegistration {
  regId: string;
  tenantId: string;
  orgId: string;
  dealerId: string;
  dealTitle: string;
  companyName: string;
  status: RegistrationStatus;
  at: string;
  decidedBy?: string;
  decidedAt?: string;
  /**
   * R2 DLR2-B2 — the approval row is the ONLY decision path (the bespoke
   * approve/reject routes were demolished in CFP-1), and its write is best-effort:
   * one hiccup and the partner gets a 201, the console shows "Awaiting review", and
   * no card ever reaches Reviews. Nothing could tell the two states apart, because
   * the chip was derived from `status` — which is `pending` either way.
   * Set when the queue write did not land. It is a fact about the ROW, so it can be
   * shown, and it is what the admin list retries on.
   */
  queueFailed?: boolean;
}

/** The partner-portal capability token — bound to ONE dealer. `token` is the id
 *  so resolve is an O(1) point lookup. */
export interface PartnerToken {
  /** ADR 1034 D9 — `ptokh:<sha256hex(raw)>`. The raw token is returned once at mint and
   *  never stored, so a database or backup read yields no working link. A legacy row
   *  (`ptoken:<uuid>`, plaintext) is re-keyed by the `rekey-partner-tokens-hashed` app
   *  migration. */
  token: string;
  tenantId: string;
  orgId: string;
  dealerId: string;
  createdAt: string;
  /** ADR 1034 D9 — the link stops working after this instant (uniform 404). */
  expiresAt?: string;
}

/** ADR 1034 D9 — a link is valid for 180 days from mint. */
export const PARTNER_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const LEGACY_TOKEN_PREFIX = 'ptoken:';
const HASHED_TOKEN_PREFIX = 'ptokh:';

/** The at-rest form of a raw partner token. */
export function hashPartnerToken(raw: string): string {
  return `${HASHED_TOKEN_PREFIX}${createHash('sha256').update(raw).digest('hex')}`;
}

/** When a row expires: its own `expiresAt`, else `createdAt + TTL` (a legacy row), else
 *  `fallbackFrom + TTL` (a legacy row with no parseable `createdAt`). */
function expiryOf(t: PartnerToken, fallbackFrom: number): string {
  if (t.expiresAt !== undefined) return t.expiresAt;
  const created = Date.parse(t.createdAt);
  return new Date((Number.isFinite(created) ? created : fallbackFrom) + PARTNER_TOKEN_TTL_MS).toISOString();
}

const MAX = { title: 200, company: 200, perDealerRegistrations: 2000 } as const;

const log = createLogger('dealers.registration');
const registrations = new DurableCollection<DealRegistration>('dealers:registration', (r) => r.regId, validateRegistration, (r) => r.tenantId);
const tokens = new DurableCollection<PartnerToken>('dealers:partner-token', (t) => t.token, validatePartnerToken, (t) => t.tenantId);

const nowIso = (): string => new Date().toISOString();
const scoped = <T extends { tenantId: string; orgId: string }>(rows: T[], tenantId: string, orgId: string): T[] =>
  rows.filter((r) => r.tenantId === tenantId && r.orgId === orgId);

// ── Partner token (mint / rotate / resolve) ──────────────────────────────────
/** Mint (rotating any existing) the dealer's partner-portal token. Returns the RAW token
 *  once, for the link; only its hash is stored (ADR 1034 D9). */
export async function mintPartnerToken(tenantId: string, orgId: string, dealerId: string): Promise<{ raw: string; row: PartnerToken }> {
  await getDealer(tenantId, orgId, dealerId); // dealer must exist + be visible
  await revokePartnerTokens(tenantId, orgId, dealerId); // one active token per dealer — rotate replaces
  const raw = `${LEGACY_TOKEN_PREFIX}${randomUUID()}`; // the link keeps its familiar shape
  const now = Date.now();
  const row: PartnerToken = { token: hashPartnerToken(raw), tenantId, orgId, dealerId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PARTNER_TOKEN_TTL_MS).toISOString() };
  await tokens.put(row);
  return { raw, row };
}

/** ADR 1034 D9 — revoke the dealer's partner link(s). Returns how many were removed. */
export async function revokePartnerTokens(tenantId: string, orgId: string, dealerId: string): Promise<number> {
  let removed = 0;
  for (const old of scoped(await tokens.listForTenantIndexed(tenantId), tenantId, orgId).filter((t) => t.dealerId === dealerId)) {
    if (await tokens.delete(old.token)) removed += 1;
  }
  return removed;
}

/** Resolve a RAW partner token → its binding. Throws the uniform 404 on a bad, absent or
 *  expired token. */
export async function resolvePartnerToken(raw: string): Promise<PartnerToken> {
  const invalid = (): OpenwopError => new OpenwopError('not_found', 'Invalid partner link.', 404, {});
  if (!raw) throw invalid();
  // The hashed row first. A legacy plaintext row answers only until the boot migration
  // re-keys it (the migration runs before this host serves; the fallback covers a row
  // written by an older instance during a rolling deploy).
  const t = (await tokens.get(hashPartnerToken(raw))) ?? (raw.startsWith(LEGACY_TOKEN_PREFIX) ? await tokens.get(raw) : null);
  if (!t) throw invalid();
  if (Date.now() >= Date.parse(expiryOf(t, Date.now()))) {
    await tokens.compareAndDelete(t); // an expired link is dead weight at rest; clear it
    throw invalid();
  }
  return t;
}

/**
 * ADR 1034 D9 — the `rekey-partner-tokens-hashed` app migration. Every legacy plaintext row
 * becomes its hashed twin with an expiry; idempotent and safe to run on two instances at
 * once: the loser's `putIfAbsent` returns false, and its `compareAndDelete` of the exact
 * legacy row finds it already gone. Returns how many rows this run re-keyed.
 */
export async function rekeyLegacyPartnerTokens(now: number = Date.now()): Promise<number> {
  let rekeyed = 0;
  for (const legacy of await tokens.list()) {
    if (!legacy.token.startsWith(LEGACY_TOKEN_PREFIX)) continue;
    const hashed: PartnerToken = { ...legacy, token: hashPartnerToken(legacy.token), expiresAt: expiryOf(legacy, now) };
    if (await tokens.putIfAbsent(hashed)) rekeyed += 1;
    await tokens.compareAndDelete(legacy);
  }
  return rekeyed;
}

// ── Deal registrations ───────────────────────────────────────────────────────
export async function createRegistration(tenantId: string, orgId: string, dealerId: string, input: { dealTitle?: unknown; companyName?: unknown }): Promise<DealRegistration> {
  // Fail-closed like the read portal (DEAL-DATA-1): a partner token that outlived
  // its dealer must NOT keep minting orphan registrations — the dealer must exist.
  await getDealer(tenantId, orgId, dealerId);
  const dealTitle = cleanString(input.dealTitle, MAX.title, '');
  const companyName = cleanString(input.companyName, MAX.company, '');
  if (!dealTitle) throw new OpenwopError('validation_error', '`dealTitle` is required.', 400, { field: 'dealTitle' });
  if (!companyName) throw new OpenwopError('validation_error', '`companyName` is required.', 400, { field: 'companyName' });
  if (scoped(await registrations.listForTenantIndexed(tenantId), tenantId, orgId).filter((r) => r.dealerId === dealerId).length >= MAX.perDealerRegistrations) {
    throw new OpenwopError('validation_error', 'This dealer has too many registrations.', 409, { max: MAX.perDealerRegistrations });
  }
  const reg: DealRegistration = { regId: `dealreg:${randomUUID()}`, tenantId, orgId, dealerId, dealTitle, companyName, status: 'pending', at: nowIso() };
  await registrations.put(reg);
  // CFP-1 (D9) — the partner PROPOSES; a manager DISPOSES in the shared reviews
  // inbox. Queue a `dealer-registration` approval so the decision rides the shared
  // HITL machinery (visible only to host:dealers:manage), not a bespoke page
  // button. Dedup per-registration; best-effort so a public partner submit never
  // 500s if the queue write hiccups (the reg row is already durable, and the
  // manager can still see it in the pending list).
  // R2 DLR2-B2 — still best-effort (a public partner submit must not 500 when the
  // reg row is already durable), but no longer SILENT: a failure is recorded on the
  // row so the console can say "not queued" instead of "awaiting review", and the
  // admin list can retry it.
  if (!(await queueRegistrationApproval(reg))) {
    reg.queueFailed = true;
    await registrations.put(reg);
  }
  return reg;
}

/** The review card's proposal text — one spelling for every lane that mints the card. */
export function registrationProposalText(reg: Pick<DealRegistration, 'dealTitle' | 'companyName'>): string {
  return `Approve deal registration “${reg.dealTitle}” from ${reg.companyName}`;
}

/** One registration, tenant + org scoped (uniform 404 across tenants/orgs). */
export async function getRegistration(tenantId: string, orgId: string, regId: string): Promise<DealRegistration> {
  const r = await registrations.get(regId);
  if (!r || r.tenantId !== tenantId || r.orgId !== orgId) throw new OpenwopError('not_found', 'Registration not found.', 404, { regId });
  return r;
}

/** Queue the review card, deduped. Returns false when the queue write did not land. */
async function queueRegistrationApproval(reg: DealRegistration): Promise<boolean> {
  try {
    if (await findPendingDealerRegistrationApproval(reg.tenantId, reg.regId)) return true;
    const created = await createDealerRegistrationApproval({
      tenantId: reg.tenantId, orgId: reg.orgId, regId: reg.regId, dealerId: reg.dealerId,
      proposal: registrationProposalText(reg),
    });
    // REVIEW B5+I2, the seam between the two fixes. The approval id is deterministic in
    // `regId` (so a race cannot mint a second card), which means a RESOLVED card occupies
    // the id and `createDealerRegistrationApproval` returns it untouched — correct, since
    // a decided deal must never be silently resurrected. But a card can also be closed
    // while its registration stays `pending`: the delete cascade closes one per row, and
    // if that loop then throws, the survivors have a closed card and an undecided deal.
    // THAT is the state the repair exists for, and it is distinguishable — the row's own
    // status is the discriminator, and this function is only ever called for a pending
    // row. So: reopen, rather than leave a decision nobody made standing.
    if (created.status !== 'pending') await reopenApproval(created.approvalId);
    return true;
  } catch {
    return false;
  }
}

/**
 * R2 DLR2-B2 — repair the rows whose review card never landed. Called from the ADMIN
 * list route only (never the public partner read, which must stay side-effect-free),
 * so an operator opening the console is what heals the queue. Returns the rows with
 * `queueFailed` cleared for any that succeeded — a repaired row must not keep
 * advertising a failure it no longer has.
 */
export async function repairUnqueuedRegistrations(rows: DealRegistration[]): Promise<DealRegistration[]> {
  const out: DealRegistration[] = [];
  for (const r of rows) {
    // REVIEW I2 — the predicate was `queueFailed`, which only heals rows this build
    // flagged. It misses BOTH the rows whose queue write failed before this shipped and
    // the ones whose card was closed by a delete cascade that then threw part-way: those
    // are `pending` with no card and no flag, so the console says "awaiting review" for a
    // deal nobody was asked to decide — the exact lie B2 exists to close, in the one form
    // its own repair could not reach. `queueRegistrationApproval` is dedup-safe, so
    // asking it about every pending row is correct and cheap enough (a point lookup
    // first); the flag is now only a hint for the UI, never the repair's gate.
    if (r.status !== 'pending') { out.push(r); continue; }
    if (!(await queueRegistrationApproval(r))) {
      out.push(r.queueFailed ? r : { ...r, queueFailed: true });
      if (!r.queueFailed) await registrations.put({ ...r, queueFailed: true });
      continue;
    }
    if (!r.queueFailed) { out.push(r); continue; }
    const fixed = { ...r };
    delete fixed.queueFailed;
    await registrations.put(fixed);
    out.push(fixed);
  }
  return out;
}

export async function listRegistrations(tenantId: string, orgId: string, filter: { dealerId?: string; status?: string } = {}): Promise<DealRegistration[]> {
  let rows = scoped(await registrations.listForTenantIndexed(tenantId), tenantId, orgId);
  if (filter.dealerId) rows = rows.filter((r) => r.dealerId === filter.dealerId);
  if (filter.status) rows = rows.filter((r) => r.status === filter.status);
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

/** Approve or reject a PENDING registration (host:dealers:manage). Idempotent on a
 *  terminal state only if the decision matches; a conflicting re-decision is 409. */
/**
 * R2 DLR2-B4 — `via` exists because THREE lanes decide a registration and only one of
 * them owns the review card. The workflow surface and the demo seeder called this
 * directly and left the auto-queued approval `pending`, so the inbox showed cards for
 * already-decided registrations — and whether one could ever be cleared depended on
 * which way it had been decided: re-approving an approved row is idempotent and
 * clears, but approving a REJECTED row 409s, the handler re-opens the approval, and
 * the card is wedged forever. The demo tenant seeds one of each.
 *
 * `'approval'` means the card itself is the caller (it resolves its own row via CAS
 * before applying, so touching it here would fight that). Every other lane defaults
 * to closing it — the safe direction for a caller that has not thought about it.
 */
export async function decideRegistration(
  tenantId: string, orgId: string, regId: string, decision: 'approved' | 'rejected', actor: string,
  via: 'approval' | 'direct' = 'direct',
): Promise<DealRegistration> {
  const r = await registrations.get(regId);
  if (!r || r.tenantId !== tenantId || r.orgId !== orgId) throw new OpenwopError('not_found', 'Registration not found.', 404, { regId });
  if (r.status === decision) return r; // idempotent
  if (r.status !== 'pending') throw new OpenwopError('conflict', `This registration is already ${r.status}.`, 409, { regId, status: r.status });
  const next: DealRegistration = { ...r, status: decision, decidedBy: actor, decidedAt: nowIso() };
  // ADR 1034 — a CAS, not a plain `put`: the card lane and a direct lane (the seeder)
  // could otherwise both read `pending` and the later write would silently win with the
  // opposite decision.
  if (!(await registrations.compareAndSwap(r, next))) {
    throw new OpenwopError('conflict', 'This registration changed while it was being decided. Reload and try again.', 409, { regId });
  }
  if (via === 'direct') {
    // REVIEW I3 — best-effort, like the queue write one function up: the ROW is the
    // truth and the card is recoverable, so a failing close must not make a decision
    // that already landed report as a failure (and then leave the card pending, which
    // is the B4 wedge). The registration is flipped above; this is bookkeeping.
    await closePendingDealerRegistrationApprovals(tenantId, [regId], `Decided outside the review inbox (${decision}).`, decision, actor)
      .catch((err) => { log.warn('could not close the review card for a directly-decided registration', { tenantId, orgId, regId, decision, error: err instanceof Error ? err.message : String(err) }); });
  }
  return next;
}

/**
 * R2 DLR2-M3 — GDPR subject erasure. `DealRegistration.decidedBy` is a userId under a
 * field name NEITHER erasure ratchet can see (the host gate scans `src/host`; the
 * feature gate binds on a `userId: string` declaration), and no dealers collection
 * registered anything, so a manager who decided forty registrations kept their id on
 * all forty — readable through `listRegistrations` and the dealers agent tool.
 * The decision itself is business truth, so the row survives and only the person-link
 * is severed: the same "anonymize in place" outcome ADR 0464 prescribes for a
 * structurally-needed row.
 */
export async function eraseSubjectDealers(tenantId: string, subjectKey: string): Promise<void> {
  const forms = subjectKeyForms(subjectKey).forms;
  for (const r of await registrations.listForTenantIndexed(tenantId)) {
    if (r.tenantId !== tenantId || r.decidedBy === undefined || !forms.has(r.decidedBy)) continue;
    await registrations.put({ ...r, decidedBy: ERASED });
  }
}

/** Cascade a dealer's PRM data — registrations + partner tokens (DEAL-DATA-1).
 *  Lives here (not `deleteDealer`) because `dealer.ts` can't import this module
 *  without a cycle; the routes DELETE handler orchestrates children-first. Returns
 *  the row count removed. */
export async function deleteDealerPrmData(tenantId: string, orgId: string, dealerId: string): Promise<number> {
  let removed = 0;
  const doomed = scoped(await registrations.listForTenantIndexed(tenantId), tenantId, orgId).filter((r) => r.dealerId === dealerId);
  // R2 DLR2-B3 — close the review cards BEFORE deleting the rows they point at.
  // Afterwards is too late: the handler resolves the registration by id, so a card
  // whose row is gone 404s on approve AND on reject, and the compensating
  // `reopenApproval` puts it straight back — an inbox item no action can dismiss.
  // REVIEW I1 — per row, immediately before ITS delete. Closing all of them up front
  // opens a window: if the delete loop throws part-way (the reason this route documents
  // itself children-first and retryable), the survivors are `pending` with no card at
  // all — invisible to a repair keyed on a flag they never got.
  for (const r of doomed) {
    await closePendingDealerRegistrationApprovals(tenantId, [r.regId], 'The dealer and its deal registrations were deleted.');
    await registrations.delete(r.regId);
    removed += 1;
  }
  for (const t of scoped(await tokens.listForTenantIndexed(tenantId), tenantId, orgId).filter((t) => t.dealerId === dealerId)) {
    await tokens.delete(t.token);
    removed += 1;
  }
  return removed;
}

