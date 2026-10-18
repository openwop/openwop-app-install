/**
 * kicktodo-commerce (ADR 0420 P1) — the money ADAPTER.
 *
 * Composes the public contracts of Commerce (orders/products), kicktodo-core
 * (challenges/enroll guard), and — for tier gates later — Billing. It owns
 * exactly two projections and NO money truth:
 *
 *  - `ChallengeProductLink` — one Commerce product (a `digital` type in Wave 1
 *    per the ADR's H2 correction) sells one published challenge version.
 *  - `ChallengeEntitlement` — the per-buyer unlock, granted ONLY on the order
 *    row's CAS `pending→paid` (via the registered paid observer — never the
 *    checkout return) and revoked on full refund (future access only: the
 *    existing enrollment keeps converging; completed history is untouched).
 *
 * Idempotent + repairable everywhere: re-observing an order re-derives the
 *  same entitlements; `reprocessOrder` is the forward-repair entry.
 */

import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { getChallenge } from '../kicktodo-core/challengeService.js';
import { listTenantOrdersByStatus, getProductInTenant, type Order } from '../commerce/commerceService.js';
import { emitKicktodoLifecycle } from '../kicktodo-core/lifecycleEvents.js';

const log = createLogger('kicktodo.commerce');

export interface ChallengeProductLink {
  tenantId: string;
  productId: string;
  challengeId: string;
  challengeVersion: number;
  createdBy: string;
  createdAt: string;
}

export interface ChallengeEntitlement {
  tenantId: string;
  buyerSubject: string;
  challengeId: string;
  challengeVersion: number;
  orderId: string;
  /** ARCH-H1 — the pointed-at order's creation time. Without it "re-point to
   *  the NEWEST paying order" was unenforceable: the code re-pointed to
   *  whichever order was processed LAST, which under a reconciliation sweep is
   *  arbitrary. Optional for rows written before this field existed; absent is
   *  treated as oldest so a dated order always wins. */
  orderCreatedAt?: string;
  state: 'active' | 'revoked';
  grantedAt: string;
  revokedAt?: string;
  /** Grade-data KTCOM-D2 — set when a DSAR anonymized this row (its buyer key is
   *  then `erased:<hash>`). A paid order created at or before this instant belongs
   *  to the erased subject's history, so reconciliation must not re-grant it under
   *  the original subject. */
  erasedAt?: string;
}

/** Keyed by product — the paid-observer's lookup direction. */
const links = new DurableCollection<ChallengeProductLink>(
  'kicktodo-product-links',
  (l) => `${l.tenantId}::${l.productId}`,
);

/** Keyed by buyer+challenge — the enroll guard's point lookup.
 *
 *  ADR 0458 §2.5 — the collection name `kicktodo-entitlements` collides with the
 *  `host/entitlementSeam.ts` vocabulary (the runtime feature-entitlement grants). A
 *  rename to something like `kicktodo-challenge-access` was CONSIDERED and DECLINED:
 *  the namespace is a LIVE durable key (`hostext:kicktodo-entitlements:*` rows exist
 *  in every tenant that has sold a challenge), so a rename is a data migration with no
 *  behavioural payoff — the two "entitlement" concepts never share a store or a code
 *  path. The collision is a naming smell, not a correctness bug; kept as-is. */
const entitlements = new DurableCollection<ChallengeEntitlement>(
  'kicktodo-entitlements',
  (e) => `${e.tenantId}::${e.buyerSubject}::${e.challengeId}::v${e.challengeVersion}`,
);

const nowIso = (): string => new Date().toISOString();

export class LinkError extends Error {}

/** A link call refused because the product already sells a DIFFERENT challenge
 *  version and the caller did not ask to replace it (see {@link relinkConflict}). */
export class LinkConflictError extends LinkError {
  constructor(message: string, readonly existing: ChallengeProductLink) {
    super(message);
  }
}

/** Link a PUBLISHED challenge version to a Commerce product (publisher-gated
 *  at the route). One product ⇒ one challenge version.
 *
 *  A-18 (`/links` race) — the relink check and the write are ONE compare-and-swap.
 *  The route used to read the link, judge {@link relinkConflict}, then blind-`put`:
 *  two operators linking the same product to different versions both read "no
 *  link", both passed, and the later write silently replaced the earlier sale.
 *  Now the write only lands on the row the check judged; a lost swap re-reads and
 *  re-judges, so the loser gets the same 409 a sequential second call gets.
 *  `replace` defaults to true for in-process callers (seeding, tests), which have
 *  always overwritten; the route passes the operator's explicit choice. */
export async function linkChallengeProduct(
  tenantId: string,
  productId: string,
  challengeId: string,
  challengeVersion: number,
  createdBy: string,
  opts: { replace?: boolean } = { replace: true },
): Promise<ChallengeProductLink> {
  const challenge = await getChallenge(tenantId, challengeId, challengeVersion);
  if (!challenge) throw new LinkError('Challenge version not found.');
  if (challenge.status !== 'published') throw new LinkError('Only a PUBLISHED challenge version can be sold.');
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = (await links.get(`${tenantId}::${productId}`)) ?? null;
    const conflict = relinkConflict(existing, { challengeId, challengeVersion, replace: opts.replace === true });
    if (conflict) throw new LinkConflictError(conflict, existing!);
    const link: ChallengeProductLink = { tenantId, productId, challengeId, challengeVersion, createdBy, createdAt: nowIso() };
    if (await links.compareAndSwap(existing, link)) return link;
  }
  throw new LinkError('The product link kept changing; try again.');
}

export async function getLinkByProduct(tenantId: string, productId: string): Promise<ChallengeProductLink | null> {
  return (await links.get(`${tenantId}::${productId}`)) ?? null;
}

/** ADR 0420 (admin link surface) — why a link call must be REFUSED rather than silently
 *  overwrite: the product already sells a DIFFERENT challenge version and the caller
 *  did not say `replace`. Null ⇒ proceed (no link yet, the same version, or an explicit
 *  replace). Pure, so the rule is unit-testable without the HTTP harness. */
export function relinkConflict(
  existing: ChallengeProductLink | null,
  requested: { challengeId: string; challengeVersion: number; replace?: boolean },
): string | null {
  if (!existing || requested.replace === true) return null;
  if (existing.challengeId === requested.challengeId && existing.challengeVersion === requested.challengeVersion) return null;
  return `Product already sells ${existing.challengeId} v${existing.challengeVersion}; unlink it or pass replace: true.`;
}

/** ADR 0420 (admin link surface) — every product→challenge link in the tenant, the
 *  operator's view of what is for sale. A tenant prefix scan, like `isChallengePaid`. */
export async function listChallengeLinks(tenantId: string): Promise<ChallengeProductLink[]> {
  return (await links.listByPrefix(`${tenantId}::`)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** ADR 0420 (admin link surface) — stop selling: remove the product→challenge link.
 *  Entitlements already granted are untouched (a buyer keeps what they paid for);
 *  the enroll guard simply stops asking for payment on the next enrol. */
export async function unlinkChallengeProduct(tenantId: string, productId: string): Promise<boolean> {
  return await links.delete(`${tenantId}::${productId}`);
}

/** Whether ANY product sells this challenge version (⇒ enrollment is gated).
 *
 *  KTCOM-3 — "sells" means the linked product still EXISTS. A deleted product
 *  left its link behind, so this returned true (paywalled) while
 *  `productForChallenge` — which resolves the product — returned null: the Detail
 *  page had no price to show and the enroll guard still demanded a checkout that
 *  could not happen. The two now agree on one rule: a link whose product is gone
 *  sells nothing (an INACTIVE product still does — that is "temporarily
 *  unavailable", not "not for sale").
 *
 *  Deliberately NOT done by unlinking from commerce's `onProductDeleted` seam: the
 *  link is also the lookup for MONEY effects. An order created before the delete and
 *  paid after it (a slow Stripe webhook) still needs its entitlement grant, its author
 *  share accrual and the reconcile sweep's repair, and every one of those resolves
 *  `line.productId → link`. Deleting the link would silently drop all three. */
export async function isChallengePaid(tenantId: string, challengeId: string, challengeVersion: number): Promise<boolean> {
  const rows = await links.listByPrefix(`${tenantId}::`);
  for (const l of rows) {
    if (l.challengeId !== challengeId || l.challengeVersion !== challengeVersion) continue;
    if (await getProductInTenant(tenantId, l.productId)) return true;
  }
  return false;
}

/** ADR 0455 P1 — the price/CTA info the KickTodo Detail page needs to surface a
 *  paid challenge (which today dead-ends at the enroll wall). Reverse of
 *  `getLinkByProduct`: find the product(s) selling this version and return the
 *  buyable one — the LOWEST ACTIVE price when several tiers sell it (OQ2), else
 *  the lowest overall so the FE can show "temporarily unavailable". Null when no
 *  product links the version (a free challenge). Includes the product's `orgId`
 *  so the FE deep-links the org-scoped `/public-store/:orgId/checkout`. */
export interface ChallengePriceInfo {
  productId: string;
  orgId: string;
  price: number;
  currency: string;
  active: boolean;
}
export async function productForChallenge(tenantId: string, challengeId: string, challengeVersion: number): Promise<ChallengePriceInfo | null> {
  const rows = await links.listByPrefix(`${tenantId}::`);
  const linked = rows.filter((l) => l.challengeId === challengeId && l.challengeVersion === challengeVersion);
  const products = (await Promise.all(linked.map((l) => getProductInTenant(tenantId, l.productId))))
    .filter((p): p is NonNullable<typeof p> => p !== null);
  if (products.length === 0) return null;
  const active = products.filter((p) => p.active);
  const chosen = (active.length ? active : products).sort((a, b) => a.price - b.price)[0]!;
  return { productId: chosen.productId, orgId: chosen.orgId, price: chosen.price, currency: chosen.currency, active: chosen.active };
}

export async function getEntitlement(
  tenantId: string,
  buyerSubject: string,
  challengeId: string,
  challengeVersion: number,
): Promise<ChallengeEntitlement | null> {
  return (await entitlements.get(`${tenantId}::${buyerSubject}::${challengeId}::v${challengeVersion}`)) ?? null;
}

export async function listEntitlementsFor(tenantId: string, buyerSubject: string): Promise<ChallengeEntitlement[]> {
  const rows = await entitlements.listByPrefix(`${tenantId}::${buyerSubject}::`);
  return rows.sort((a, b) => a.grantedAt.localeCompare(b.grantedAt));
}

/** KTCOM-5 / KTM-2 — an entitlement write lost its compare-and-swap this many times
 *  in a row. Every loss means another writer changed the row in between, so this is
 *  sustained contention, not a stale read; the caller (an order observer, which
 *  commerce runs best-effort, or the reconcile sweep) retries the whole order. */
const ENTITLEMENT_CAS_ATTEMPTS = 8;

export class EntitlementConflictError extends Error {
  constructor(key: string) {
    super(`Entitlement ${key} kept changing under concurrent writers; retry.`);
  }
}

/** Derive + apply entitlement effects for one order (idempotent; the repair
 *  entry). `mode: 'grant'` on paid; `'revoke'` on full refund.
 *
 *  KTCOM-5 / KTM-2 — every write is a compare-and-swap against the row this call
 *  decided on, re-read and re-decided on a lost swap. It used to read, decide, then
 *  blind-`put`. Two paid orders for the same buyer and challenge (the paid observer
 *  racing the reconcile sweep, or two webhooks) could then both read "no row" or the
 *  same old row, and whichever wrote LAST won. If that was the OLDER order, the
 *  ARCH-H1 rule broke: a refund of the older order revoked access the newer one paid
 *  for. A refund racing a grant could likewise write `revoked` over the newer
 *  order's fresh grant. */
export async function reprocessOrder(order: Order, mode: 'grant' | 'revoke'): Promise<number> {
  if (mode === 'revoke') return await revokeOrderEntitlements(order);
  let affected = 0;
  for (const line of order.items ?? []) {
    const link = await getLinkByProduct(order.tenantId, line.productId);
    if (!link) continue;
    if (await grantLine(order, link)) {
      affected += 1;
      log.info('kicktodo_entitlement_granted', { orderId: order.orderId, challengeId: link.challengeId, buyer: order.createdBy });
      // ADR 0456 P2 — consent-gated purchased signal for CDP marketing. No-ops
      // unless the BUYER has a linked Contact (Gate 0) — so a `public:` guest
      // checkout emits nothing; best-effort + deduped once per (subject,order).
      await emitKicktodoLifecycle(order.tenantId, order.createdBy, 'purchased', { challengeId: link.challengeId, challengeVersion: link.challengeVersion });
    }
  }
  return affected;
}

/** One order line's grant decision, applied by CAS. True when this call changed the row. */
async function grantLine(order: Order, link: ChallengeProductLink): Promise<boolean> {
  const key = `${order.tenantId}::${order.createdBy}::${link.challengeId}::v${link.challengeVersion}`;
  for (let attempt = 0; attempt < ENTITLEMENT_CAS_ATTEMPTS; attempt++) {
    const existing = await entitlements.get(key);
    // Grade-data KTCOM-D2 — a DSAR moved this buyer's entitlement to an anonymized
    // key. `order.createdBy` still names the original subject (Commerce keeps the
    // order), so without this check the next reconcile sweep re-created the row
    // under the erased subject: the erasure was silently undone. Only orders the
    // erased history already covers are skipped; a NEWER purchase still grants.
    if (!existing && await coveredByErasure(order, link.challengeId, link.challengeVersion)) return false;
    // A-18 — an erasure has CLAIMED this row and is moving it to its anonymized key.
    // Re-pointing it now would be deleted with it; the erasure's tombstone covers
    // every order up to its `erasedAt`, exactly as for a finished erasure.
    if (existing?.erasedAt) return false;
    // Idempotent per order; a re-purchase RE-POINTS the entitlement to the
    // newest paying order so an older order's refund cannot claw back what
    // a newer order paid for.
    if (existing?.state === 'active' && existing.orderId === order.orderId) return false;
    // ARCH-H1 — only a STRICTLY NEWER order may take the pointer. The claim
    // above was previously unenforced, so a reconciliation sweep that
    // happened to process an older paid order last would re-point the
    // entitlement backwards; refunding that older order then revoked access
    // a newer order had paid for. It also meant the sweep never converged —
    // two paid orders flipped the pointer on every run, so
    // `entitlementsRepaired` could not reach zero.
    if (existing?.state === 'active' && (existing.orderCreatedAt ?? '') >= order.createdAt) return false;
    const next: ChallengeEntitlement = {
      tenantId: order.tenantId,
      buyerSubject: order.createdBy,
      challengeId: link.challengeId,
      challengeVersion: link.challengeVersion,
      orderId: order.orderId,
      orderCreatedAt: order.createdAt,
      state: 'active',
      grantedAt: existing?.grantedAt ?? nowIso(),
    };
    if (await entitlements.compareAndSwap(existing, next)) return true;
  }
  throw new EntitlementConflictError(key);
}

/** Grade-data KTCOM-D1 — revoke every entitlement THIS order granted, found by the
 *  `orderId` the entitlement records, never through the product's CURRENT link.
 *  The old revoke resolved `line.productId → link → challenge`, so a refund after
 *  the product was unlinked (`continue` on no link) or relinked with `replace`
 *  (a different challenge) never reached the entitlement the order had paid for,
 *  and the refunded buyer kept access permanently; reconcile used the same lookup
 *  and could not repair it. Matching on `orderId` alone also reaches an
 *  anonymized (DSAR) row, whose money-truth state must still follow its order.
 *  A later re-purchase re-pointed the row to a newer `orderId`, so an old refund
 *  still cannot claw it back.
 *
 *  KTCOM-5 — the listed row is only a candidate: the revoke re-reads it and swaps
 *  against that read, so a newer order's grant landing in between (which re-points
 *  `orderId`) makes this refund a no-op instead of being overwritten by it. */
async function revokeOrderEntitlements(order: Order): Promise<number> {
  let affected = 0;
  for (const candidate of await entitlements.listByPrefix(`${order.tenantId}::`)) {
    if (candidate.tenantId !== order.tenantId || candidate.orderId !== order.orderId || candidate.state === 'revoked') continue;
    const key = `${candidate.tenantId}::${candidate.buyerSubject}::${candidate.challengeId}::v${candidate.challengeVersion}`;
    let revoked: ChallengeEntitlement | null = null;
    for (let attempt = 0; attempt < ENTITLEMENT_CAS_ATTEMPTS && !revoked; attempt++) {
      const e = await entitlements.get(key);
      if (!e && !candidate.buyerSubject.startsWith('erased:')) {
        // A-18 — an erasure moved the row after this refund listed it. The refund
        // still belongs to the order, so it follows the row to its anonymized copy.
        if (await revokeAnonymizedCopy({ ...candidate, revokedAt: nowIso() })) affected += 1;
        break;
      }
      if (!e || e.orderId !== order.orderId || e.state === 'revoked') break; // re-pointed or revoked meanwhile
      const next: ChallengeEntitlement = { ...e, state: 'revoked', revokedAt: nowIso() };
      if (await entitlements.compareAndSwap(e, next)) revoked = next;
      else if (attempt === ENTITLEMENT_CAS_ATTEMPTS - 1) throw new EntitlementConflictError(key);
    }
    if (!revoked) continue;
    // A-18 — the row was claimed by an in-flight erasure, which may already have
    // copied it to the anonymized key and be about to delete this one. Apply the
    // refund to that copy too, so it survives whichever side finishes last.
    if (revoked.erasedAt && !revoked.buyerSubject.startsWith('erased:')) await revokeAnonymizedCopy(revoked);
    affected += 1;
    log.info('kicktodo_entitlement_revoked', { orderId: order.orderId, challengeId: revoked.challengeId, buyer: revoked.buyerSubject });
  }
  return affected;
}

/** Grade-data KTCOM-D2 — whether a DSAR already erased the entitlement this order
 *  would grant. The tombstone is the anonymized row `eraseSubjectEntitlements`
 *  wrote; an order created at or before its erasure is part of that history.
 *  Legacy tombstones (no `erasedAt`) fall back to their grant time. */
async function coveredByErasure(order: Order, challengeId: string, challengeVersion: number): Promise<boolean> {
  const anon = anonymizedSubject(order.tenantId, order.createdBy);
  const tomb = await entitlements.get(`${order.tenantId}::${anon}::${challengeId}::v${challengeVersion}`);
  if (!tomb) return false;
  return tomb.orderId === order.orderId || order.createdAt <= (tomb.erasedAt ?? tomb.grantedAt);
}

/** Creator revenue projection (ADR 0420 P3): the caller's OWN links with
 *  per-link entitlement counts. Money truth stays in Commerce — this counts
 *  ACCESS grants, the creator-facing signal that never exposes buyer PII
 *  (counts only, no buyer subjects). */
export async function revenueProjectionFor(tenantId: string, creatorSubject: string): Promise<Array<{
  productId: string;
  challengeId: string;
  challengeVersion: number;
  activeEntitlements: number;
  revokedEntitlements: number;
}>> {
  const myLinks = (await links.listByPrefix(`${tenantId}::`)).filter((l) => l.createdBy === creatorSubject);
  const allEnts = await entitlements.listByPrefix(`${tenantId}::`);
  return myLinks.map((l) => {
    const mine = allEnts.filter((e) => e.challengeId === l.challengeId && e.challengeVersion === l.challengeVersion);
    return {
      productId: l.productId,
      challengeId: l.challengeId,
      challengeVersion: l.challengeVersion,
      activeEntitlements: mine.filter((e) => e.state === 'active').length,
      revokedEntitlements: mine.filter((e) => e.state === 'revoked').length,
    };
  });
}

/**
 * KTFULL-B13 — the reconciliation caller `reprocessOrder` never had.
 *
 * Commerce invokes fulfilment observers best-effort: `notifyObservers` catches
 * and logs an adapter throw so the money truth never depends on fulfilment.
 * That is the right ordering, but it left NO path back — a paid order whose
 * observer failed once would lack its challenge entitlement permanently, and
 * the buyer would be told to "complete checkout" for something they had
 * already paid for.
 *
 * This sweeps every terminal-state order in the tenant and re-derives its
 * effects. `reprocessOrder` is idempotent and returns the number of rows it
 * actually changed, so a healthy tenant reconciles to zero repairs and the
 * count is a real signal rather than a restatement of the order volume.
 */
export async function reconcileEntitlements(tenantId: string): Promise<{
  ordersScanned: number;
  entitlementsRepaired: number;
}> {
  let ordersScanned = 0;
  let entitlementsRepaired = 0;
  const sweep = async (status: 'paid' | 'fulfilled' | 'refunded' | 'canceled', mode: 'grant' | 'revoke'): Promise<void> => {
    for (const order of await listTenantOrdersByStatus(tenantId, status)) {
      ordersScanned += 1;
      entitlementsRepaired += await reprocessOrder(order, mode);
    }
  };
  await sweep('paid', 'grant');
  await sweep('fulfilled', 'grant');
  await sweep('refunded', 'revoke');
  // ARCH-M7 — `canceled` has no registered observer at all, so an order that
  // reached `paid` (entitlement granted) and was later canceled kept its
  // entitlement forever with no path to notice. Revoking here is the only
  // repair; `refunding`/`partially_refunded` are correctly excluded because a
  // partial refund is not a full loss of access.
  await sweep('canceled', 'revoke');
  log.info('kicktodo_entitlements_reconciled', { tenantId, ordersScanned, entitlementsRepaired });
  return { ordersScanned, entitlementsRepaired };
}

/** The enroll-guard predicate (registered into kicktodo-core at boot):
 *  a challenge with a product link requires an ACTIVE entitlement; an
 *  unlinked challenge stays free. */
export async function enrollGuardVerdict(args: {
  tenantId: string;
  ownerSubject: string;
  challenge: { id: string; version: number };
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!(await isChallengePaid(args.tenantId, args.challenge.id, args.challenge.version))) return { ok: true };
  const ent = await getEntitlement(args.tenantId, args.ownerSubject, args.challenge.id, args.challenge.version);
  if (ent?.state === 'active') return { ok: true };
  return { ok: false, reason: 'This challenge requires a purchase. Complete checkout to enroll.' };
}

// ── ADR 0458 Phase 0 — compliance (subject erasure) ──
// A per-buyer entitlement is BILLING-RELEVANT evidence of a paid order (it carries
// `orderId` and is re-derivable from that order). Money-truth rows are never
// destroyed, so a DSAR ANONYMIZES the buyer key rather than deleting the row: the
// fact "an entitlement was granted for order X" survives while the person↔entitlement
// link is severed. The anonymized subject is a per-(tenant, subject) DETERMINISTIC
// token, so distinct erased buyers keep distinct keys (no collision / cross-contamination)
// and a re-run is idempotent (the original subject no longer matches).

/** The deterministic anonymized subject a DSAR rewrites a buyer key to. */
function anonymizedSubject(tenantId: string, subjectKey: string): string {
  return `erased:${createHash('sha256').update(`${tenantId}::${subjectKey}`).digest('hex').slice(0, 24)}`;
}

/** DSAR erasure (anonymize, not delete): rewrite every entitlement this tenant holds
 *  for the buyer under an anonymized key, preserving the money-truth fields (orderId,
 *  challenge, state, timestamps). Idempotent; fail-closed on a falsy tenant/subject.
 *  Returns the count anonymized.
 *
 *  A-18 (erasure race) — this used to copy each LISTED row and then delete the live
 *  one. A grant landing in between (a newer order re-pointing the row) was deleted
 *  with it and the tombstone kept the older order, and a row granted after the list
 *  was never erased at all. Now each row is first CLAIMED with a CAS that stamps
 *  `erasedAt` (grants back off a claimed row; a refund on it also reaches the
 *  copy), the copy is made from the claimed row and re-checked before the delete,
 *  and the tenant is re-listed until a pass finds nothing left. */
export async function eraseSubjectEntitlements(tenantId: string, subjectKey: string): Promise<number> {
  if (!tenantId || !subjectKey) return 0;
  const anon = anonymizedSubject(tenantId, subjectKey);
  let anonymized = 0;
  for (let pass = 0; pass < ENTITLEMENT_CAS_ATTEMPTS; pass++) {
    let found = 0;
    for (const listed of await entitlements.listByPrefix(`${tenantId}::`)) {
      if (listed.tenantId !== tenantId || listed.buyerSubject !== subjectKey) continue;
      found += 1;
      if (await eraseOne(`${tenantId}::${subjectKey}::${listed.challengeId}::v${listed.challengeVersion}`, anon)) anonymized += 1;
    }
    if (found === 0) return anonymized;
  }
  throw new EntitlementConflictError(`${tenantId}::${subjectKey}`);
}

/** Move one live entitlement to its anonymized key (see {@link eraseSubjectEntitlements}). */
async function eraseOne(key: string, anon: string): Promise<boolean> {
  for (let attempt = 0; attempt < ENTITLEMENT_CAS_ATTEMPTS; attempt++) {
    const live = await entitlements.get(key);
    if (!live) return false; // another erasure finished it
    const claimed: ChallengeEntitlement = live.erasedAt ? live : { ...live, erasedAt: nowIso() };
    if (claimed !== live && !(await entitlements.compareAndSwap(live, claimed))) continue;
    // Copy, then confirm nothing changed the claimed row (a refund may have) before
    // deleting it; a change is copied again.
    let current = claimed;
    for (let check = 0; check < ENTITLEMENT_CAS_ATTEMPTS; check++) {
      await entitlements.put({ ...current, buyerSubject: anon });
      const again = await entitlements.get(key);
      if (!again) return true;
      if (JSON.stringify(again) === JSON.stringify(current)) {
        await entitlements.delete(key);
        return true;
      }
      current = again;
    }
    throw new EntitlementConflictError(key);
  }
  throw new EntitlementConflictError(key);
}

/** A refund for a row an erasure claimed or already moved: apply it to the
 *  anonymized copy. True iff this call revoked the copy. */
async function revokeAnonymizedCopy(revoked: ChallengeEntitlement): Promise<boolean> {
  const key = `${revoked.tenantId}::${anonymizedSubject(revoked.tenantId, revoked.buyerSubject)}::${revoked.challengeId}::v${revoked.challengeVersion}`;
  for (let attempt = 0; attempt < ENTITLEMENT_CAS_ATTEMPTS; attempt++) {
    const copy = await entitlements.get(key);
    if (!copy || copy.orderId !== revoked.orderId || copy.state === 'revoked') return false;
    if (await entitlements.compareAndSwap(copy, { ...copy, state: 'revoked', revokedAt: revoked.revokedAt ?? nowIso() })) return true;
  }
  throw new EntitlementConflictError(key);
}
