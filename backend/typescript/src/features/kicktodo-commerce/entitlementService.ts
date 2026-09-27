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

/** Link a PUBLISHED challenge version to a Commerce product (publisher-gated
 *  at the route). One product ⇒ one challenge version; relinking overwrites. */
export async function linkChallengeProduct(
  tenantId: string,
  productId: string,
  challengeId: string,
  challengeVersion: number,
  createdBy: string,
): Promise<ChallengeProductLink> {
  const challenge = await getChallenge(tenantId, challengeId, challengeVersion);
  if (!challenge) throw new LinkError('Challenge version not found.');
  if (challenge.status !== 'published') throw new LinkError('Only a PUBLISHED challenge version can be sold.');
  const link: ChallengeProductLink = { tenantId, productId, challengeId, challengeVersion, createdBy, createdAt: nowIso() };
  await links.put(link);
  return link;
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

/** Whether ANY product sells this challenge version (⇒ enrollment is gated). */
export async function isChallengePaid(tenantId: string, challengeId: string, challengeVersion: number): Promise<boolean> {
  const rows = await links.listByPrefix(`${tenantId}::`);
  return rows.some((l) => l.challengeId === challengeId && l.challengeVersion === challengeVersion);
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

/** Derive + apply entitlement effects for one order (idempotent; the repair
 *  entry). `mode: 'grant'` on paid; `'revoke'` on full refund. */
export async function reprocessOrder(order: Order, mode: 'grant' | 'revoke'): Promise<number> {
  let affected = 0;
  for (const line of order.items ?? []) {
    const link = await getLinkByProduct(order.tenantId, line.productId);
    if (!link) continue;
    const key = `${order.tenantId}::${order.createdBy}::${link.challengeId}::v${link.challengeVersion}`;
    const existing = await entitlements.get(key);
    if (mode === 'grant') {
      // Idempotent per order; a re-purchase RE-POINTS the entitlement to the
      // newest paying order so an older order's refund cannot claw back what
      // a newer order paid for.
      if (existing?.state === 'active' && existing.orderId === order.orderId) continue;
      // ARCH-H1 — only a STRICTLY NEWER order may take the pointer. The claim
      // above was previously unenforced, so a reconciliation sweep that
      // happened to process an older paid order last would re-point the
      // entitlement backwards; refunding that older order then revoked access
      // a newer order had paid for. It also meant the sweep never converged —
      // two paid orders flipped the pointer on every run, so
      // `entitlementsRepaired` could not reach zero.
      if (existing?.state === 'active' && (existing.orderCreatedAt ?? '') >= order.createdAt) continue;
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
      await entitlements.put(next);
      affected += 1;
      log.info('kicktodo_entitlement_granted', { orderId: order.orderId, challengeId: link.challengeId, buyer: order.createdBy });
      // ADR 0456 P2 — consent-gated purchased signal for CDP marketing. No-ops
      // unless the BUYER has a linked Contact (Gate 0) — so a `public:` guest
      // checkout emits nothing; best-effort + deduped once per (subject,order).
      await emitKicktodoLifecycle(order.tenantId, order.createdBy, 'purchased', { challengeId: link.challengeId, challengeVersion: link.challengeVersion });
    } else {
      // Revoke ONLY the entitlement this order granted (a later re-purchase
      // through a different order must not be clawed back by an old refund).
      if (!existing || existing.state === 'revoked' || existing.orderId !== order.orderId) continue;
      await entitlements.put({ ...existing, state: 'revoked', revokedAt: nowIso() });
      affected += 1;
      log.info('kicktodo_entitlement_revoked', { orderId: order.orderId, challengeId: link.challengeId, buyer: order.createdBy });
    }
  }
  return affected;
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
 *  Returns the count anonymized. */
export async function eraseSubjectEntitlements(tenantId: string, subjectKey: string): Promise<number> {
  if (!tenantId || !subjectKey) return 0;
  const anon = anonymizedSubject(tenantId, subjectKey);
  let anonymized = 0;
  for (const e of await entitlements.listByPrefix(`${tenantId}::`)) {
    if (e.tenantId !== tenantId || e.buyerSubject !== subjectKey) continue;
    await entitlements.put({ ...e, buyerSubject: anon });
    await entitlements.delete(`${tenantId}::${subjectKey}::${e.challengeId}::v${e.challengeVersion}`);
    anonymized += 1;
  }
  return anonymized;
}
