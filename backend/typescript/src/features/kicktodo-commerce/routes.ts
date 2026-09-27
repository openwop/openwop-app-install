/**
 * kicktodo-commerce REST (ADR 0420 P1) — under the ONE KickTodo prefix;
 * joins the collision-test union. Toggle-gated (linking/read surfaces only —
 * money effects ride the unconditional observers in feature.ts).
 */

import type { Request, Response, NextFunction, Express } from 'express';
import { OpenwopError } from '../../types.js';
import { linkCohortProduct, reserveSeat, seatAvailability, SeatLinkError } from './seatService.js';
import { CohortFullForHoldError } from '../kicktodo-accountability/cohortService.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
import { requireKicktodoManage, requireFeatureEnabled } from '../featureRoute.js';
import {
  linkChallengeProduct,
  getLinkByProduct,
  productForChallenge,
  listEntitlementsFor,
  reconcileEntitlements,
  revenueProjectionFor,
  LinkError,
  listChallengeLinks,
  unlinkChallengeProduct,
  relinkConflict,
} from './entitlementService.js';
import { ensureAffiliateForSubject, referralEarningsForSubject } from './subjectAffiliateBridge.js';
import { requestSellerOnboarding, sellerRequestStatus, SellerRequestError } from './sellerRequestService.js';
import {
  getSharePolicy,
  setSharePolicy,
  listSharesForAuthor,
  listSharesForTenant,
  reconcileShares,
  summarizeShares,
  createPayoutRun,
  confirmPayoutRun,
  cancelPayoutRun,
  listPayoutRuns,
  PayoutRunError,
  SharePolicyError,
  type ShareLedgerRow,
} from './shareLedgerService.js';

/** ADR 0445 P3 — payout-run gate: manage authority AND the commerce-connect
 *  feature live (the matrix rule: payout ACTIONS are additionally gated on the
 *  Connect lane being on; ledger/policy reads are not). */
async function payoutGate(req: Request): Promise<void> {
  await requireKicktodoManage(req, 'kicktodo-commerce', 'KickTodo Commerce');
  await requireFeatureEnabled(req, 'commerce-connect', 'Commerce Connect');
}

/** ADR 0445 P4 — the statement serializer (ADR 0297 D2 CSV idiom). Amounts
 *  stay in MINOR units (a statement is an audit artifact, not a display). */
export function sharesCsv(rows: ShareLedgerRow[], withAuthor: boolean): string {
  // Quote-escape + neutralize spreadsheet formula prefixes (=+-@) on STRING
  // fields (grade-code #7); numeric columns stay raw (a leading '-' there is a
  // legitimate negative amount, not a formula).
  const esc = (v: string): string => `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
  const header = [...(withAuthor ? ['author'] : []), 'created_at', 'order_id', 'challenge_id', 'kind', 'currency', 'share_minor', 'share_bps', 'policy_version', 'state', 'payout_run'];
  const lines = rows.map((r) => [
    ...(withAuthor ? [esc(r.authorSubject)] : []),
    esc(r.createdAt), esc(r.orderId), esc(r.challengeId), r.kind, esc(r.currency),
    String(r.shareMinor), String(r.shareBps), String(r.policyVersion), r.state, esc(r.payoutId ?? ''),
  ].join(','));
  return [header.join(','), ...lines].join('\n');
}

function mapPayoutError(err: unknown): never {
  if (err instanceof PayoutRunError) {
    if (err.code === 'not-found') throw new OpenwopError('not_found', 'Not found.', 404);
    throw new OpenwopError(err.code === 'bad-state' ? 'conflict' : 'validation_error', err.message, err.code === 'bad-state' ? 409 : 400);
  }
  throw err;
}

// NOT `/kicktodo/commerce` — the reserved-namespace guard (PRD §9.4) rightly
// reads that as a second commerce owner. This surface is entitlement/link
// management; the name says so.
export const KICKTODO_COMMERCE_PREFIX = '/v1/host/openwop-app/kicktodo/entitlements';

type Handler = (req: Request, res: Response) => Promise<void>;

function subjectOf(req: Request): string {
  const s = callerSubject(req);
  if (!s) throw new OpenwopError('unauthenticated', 'An identified caller is required.', 401);
  return s;
}

async function gate(req: Request): Promise<void> {
  await requireFeatureEnabled(req, 'kicktodo-commerce', 'KickTodo Commerce');
}

export const KICKTODO_COMMERCE_ROUTES: ReadonlyArray<{ method: 'get' | 'post' | 'delete'; path: string; handler: Handler }> = [
  {
    // ADR 0431 — RESERVE a seat before checkout. A held seat is an occupied
    // seat, so two buyers can never both see the last one.
    method: 'post',
    path: `${KICKTODO_COMMERCE_PREFIX}/cohort-seats/hold`,
    handler: async (req, res) => {
      await gate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.productId !== 'string' || !b.productId) {
        throw new OpenwopError('validation_error', 'Field `productId` is required.', 400);
      }
      try {
        res.json(await reserveSeat(tenantOf(req), subjectOf(req), b.productId));
      } catch (err) {
        if (err instanceof CohortFullForHoldError) throw new OpenwopError('conflict', err.message, 409);
        if (err instanceof SeatLinkError) throw new OpenwopError('not_found', 'Not found.', 404);
        throw err;
      }
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_COMMERCE_PREFIX}/cohort-seats/:productId`,
    handler: async (req, res) => {
      await gate(req);
      const availability = await seatAvailability(tenantOf(req), subjectOf(req), req.params.productId);
      if (!availability) throw new OpenwopError('not_found', 'Not found.', 404);
      res.json(availability);
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_COMMERCE_PREFIX}/cohort-seats/link`,
    handler: async (req, res) => {
      // ADR 0434 (KTFULL-B14) — linking a PRODUCT to a cohort/challenge decides
      // what is sold and to whom; publisher authority, not any co-tenant.
      // Buyer actions (availability, hold) deliberately stay on the open gate.
      await requireKicktodoManage(req, 'kicktodo-commerce', 'KickTodo Commerce');
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.productId !== 'string' || typeof b.circleId !== 'string') {
        throw new OpenwopError('validation_error', 'Fields `productId` and `circleId` are required.', 400);
      }
      try {
        res.json(await linkCohortProduct(tenantOf(req), subjectOf(req), { productId: b.productId, circleId: b.circleId }));
      } catch (err) {
        if (err instanceof SeatLinkError) throw new OpenwopError('not_found', 'Not found.', 404);
        throw err;
      }
    },
  },
  {
    // Publisher-gated linking: one Commerce product sells one PUBLISHED version.
    // ADR 0434 (KTFULL-B14) — the comment claimed "publisher-gated" while the
    // code gated on toggle + identity. Now it actually is.
    method: 'post',
    path: `${KICKTODO_COMMERCE_PREFIX}/links`,
    handler: async (req, res) => {
      await requireKicktodoManage(req, 'kicktodo-commerce', 'KickTodo Commerce');
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.productId !== 'string' || typeof b.challengeId !== 'string' || typeof b.challengeVersion !== 'number') {
        throw new OpenwopError('validation_error', 'Fields `productId`, `challengeId`, `challengeVersion` are required.', 400);
      }
      // Refuse a SILENT relink: a product already selling a DIFFERENT challenge version
      // is a decision the operator must make explicitly (`replace: true`), not a side
      // effect of a second link call. Re-linking the same version is idempotent.
      const existing = await getLinkByProduct(tenantOf(req), b.productId);
      const conflict = relinkConflict(existing, { challengeId: b.challengeId, challengeVersion: b.challengeVersion, replace: b.replace === true });
      if (conflict) throw new OpenwopError('conflict', conflict, 409, { existing });
      try {
        res.json(await linkChallengeProduct(tenantOf(req), b.productId, b.challengeId, b.challengeVersion, subjectOf(req)));
      } catch (err) {
        if (err instanceof LinkError) throw new OpenwopError('conflict', err.message, 409);
        throw err;
      }
    },
  },
  {
    // ADR 0420 (admin link surface) — what is for sale in this tenant. Manage-gated:
    // the operator's catalog view, not a shopper's (the shopper reads price per
    // challenge below).
    method: 'get',
    path: `${KICKTODO_COMMERCE_PREFIX}/links`,
    handler: async (req, res) => {
      await requireKicktodoManage(req, 'kicktodo-commerce', 'KickTodo Commerce');
      res.json({ links: await listChallengeLinks(tenantOf(req)) });
    },
  },
  {
    // ADR 0420 (admin link surface) — stop selling a challenge through a product.
    // Granted entitlements survive (a buyer keeps what they paid for).
    method: 'delete',
    path: `${KICKTODO_COMMERCE_PREFIX}/links/:productId`,
    handler: async (req, res) => {
      await requireKicktodoManage(req, 'kicktodo-commerce', 'KickTodo Commerce');
      const removed = await unlinkChallengeProduct(tenantOf(req), req.params.productId);
      if (!removed) throw new OpenwopError('not_found', 'No challenge link for this product.', 404);
      res.status(204).end();
    },
  },
  {
    method: 'get',
    path: `${KICKTODO_COMMERCE_PREFIX}/links/:productId`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      const link = await getLinkByProduct(tenantOf(req), req.params.productId);
      if (!link) throw new OpenwopError('not_found', 'No challenge link for this product.', 404);
      res.json(link);
    },
  },
  {
    // ADR 0455 P2 — the price a paid challenge sells for, so the Detail page can
    // surface it + a Buy CTA instead of dead-ending at the enroll wall. `null`
    // (200) for a free challenge — an absent price is not an error.
    method: 'get',
    path: `${KICKTODO_COMMERCE_PREFIX}/challenges/:challengeId/:version/price`,
    handler: async (req, res) => {
      await gate(req);
      subjectOf(req);
      const version = Number(req.params.version);
      if (!Number.isInteger(version) || version < 1) throw new OpenwopError('validation_error', 'Invalid version.', 400);
      res.json({ price: await productForChallenge(tenantOf(req), req.params.challengeId, version) });
    },
  },
  {
    // ADR 0451 P2b — the CALLER's referral code for a paid challenge, so their
    // invite link can carry `?ref=<code>` and a referred purchase accrues them
    // commission through the existing checkout→Order.affiliateCode path. Null
    // for a free challenge (nothing to refer). Lazily mints the affiliate in the
    // challenge's product org so `affiliateCodeExists(tenant, org, code)` resolves.
    method: 'get',
    path: `${KICKTODO_COMMERCE_PREFIX}/challenges/:challengeId/:version/referral-code`,
    handler: async (req, res) => {
      await gate(req);
      const subject = subjectOf(req);
      const version = Number(req.params.version);
      if (!Number.isInteger(version) || version < 1) throw new OpenwopError('validation_error', 'Invalid version.', 400);
      const priceInfo = await productForChallenge(tenantOf(req), req.params.challengeId, version);
      if (!priceInfo) { res.json({ code: null }); return; }
      const link = await ensureAffiliateForSubject(tenantOf(req), priceInfo.orgId, subject);
      res.json({ code: link.code });
    },
  },
  {
    // ADR 0451 P3 — the CALLER's OWN referral earnings (accrued commission owed).
    // Read-only; zero + null code when they've never referred. Advisory.
    method: 'get',
    path: `${KICKTODO_COMMERCE_PREFIX}/referral-earnings`,
    handler: async (req, res) => {
      await gate(req);
      res.json(await referralEarningsForSubject(tenantOf(req), subjectOf(req)));
    },
  },
  {
    // ADR 0420 P3 — the creator's OWN revenue projection (counts only; buyer
    // subjects never leave the service; money truth stays in Commerce).
    method: 'get',
    path: `${KICKTODO_COMMERCE_PREFIX}/revenue`,
    handler: async (req, res) => {
      await gate(req);
      res.json({ revenue: await revenueProjectionFor(tenantOf(req), subjectOf(req)) });
    },
  },
  {
    // KTFULL-B13 — the operator reconciliation entry. Fulfilment observers are
    // best-effort by design, so this is how a stranded paid order gets its
    // entitlement back. Idempotent: a healthy tenant repairs zero rows.
    method: 'post',
    path: `${KICKTODO_COMMERCE_PREFIX}/reconcile`,
    handler: async (req, res) => {
      await requireKicktodoManage(req, 'kicktodo-commerce', 'KickTodo Commerce');
      const entitlementRepair = await reconcileEntitlements(tenantOf(req));
      // ADR 0445 P1 — shares ride the same best-effort observers, so the same
      // operator entry repairs a stranded share row.
      const shareRepair = await reconcileShares(tenantOf(req));
      res.json({ ...entitlementRepair, ...shareRepair });
    },
  },
  {
    // ADR 0445 P1 — the tenant share policy (operator read; the setter below
    // decides how authors are paid, so both sit on manage authority).
    method: 'get',
    path: `${KICKTODO_COMMERCE_PREFIX}/share-policy`,
    handler: async (req, res) => {
      await requireKicktodoManage(req, 'kicktodo-commerce', 'KickTodo Commerce');
      res.json({ policy: await getSharePolicy(tenantOf(req)) });
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_COMMERCE_PREFIX}/share-policy`,
    handler: async (req, res) => {
      await requireKicktodoManage(req, 'kicktodo-commerce', 'KickTodo Commerce');
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.shareBps !== 'number') {
        throw new OpenwopError('validation_error', 'Field `shareBps` (integer basis points 0..10000) is required.', 400);
      }
      try {
        res.json({ policy: await setSharePolicy(tenantOf(req), b.shareBps, subjectOf(req)) });
      } catch (err) {
        if (err instanceof SharePolicyError) throw new OpenwopError('validation_error', err.message, 400);
        throw err;
      }
    },
  },
  {
    // ADR 0445 P1 — the tenant ledger (operator/reconciliation view).
    method: 'get',
    path: `${KICKTODO_COMMERCE_PREFIX}/share-ledger`,
    handler: async (req, res) => {
      await requireKicktodoManage(req, 'kicktodo-commerce', 'KickTodo Commerce');
      res.json({ rows: await listSharesForTenant(tenantOf(req)) });
    },
  },
  {
    // ADR 0445 P1 — the author's OWN earnings: their ledger rows + per-currency
    // accrued/paid totals. Honest: accrued means UNPAID until a P3 payout run.
    method: 'get',
    path: `${KICKTODO_COMMERCE_PREFIX}/my-earnings`,
    handler: async (req, res) => {
      await gate(req);
      const rows = await listSharesForAuthor(tenantOf(req), subjectOf(req));
      res.json({ rows, totals: summarizeShares(rows) });
    },
  },
  {
    // ADR 0445 P3 — payout runs (operator records over the ledger; the host
    // NEVER moves money — see shareLedgerService's correction note).
    method: 'get',
    path: `${KICKTODO_COMMERCE_PREFIX}/payout-runs`,
    handler: async (req, res) => {
      await requireKicktodoManage(req, 'kicktodo-commerce', 'KickTodo Commerce');
      res.json({ runs: await listPayoutRuns(tenantOf(req)) });
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_COMMERCE_PREFIX}/payout-runs`,
    handler: async (req, res) => {
      await payoutGate(req);
      try {
        res.json({ run: await createPayoutRun(tenantOf(req), subjectOf(req)) });
      } catch (err) { mapPayoutError(err); }
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_COMMERCE_PREFIX}/payout-runs/confirm`,
    handler: async (req, res) => {
      await payoutGate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.runId !== 'string' || typeof b.reference !== 'string' || !b.reference.trim()) {
        throw new OpenwopError('validation_error', 'Fields `runId` and a non-empty `reference` (the external payment evidence) are required.', 400);
      }
      try {
        res.json({ run: await confirmPayoutRun(tenantOf(req), b.runId, subjectOf(req), b.reference.trim()) });
      } catch (err) { mapPayoutError(err); }
    },
  },
  {
    method: 'post',
    path: `${KICKTODO_COMMERCE_PREFIX}/payout-runs/cancel`,
    handler: async (req, res) => {
      await payoutGate(req);
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (typeof b.runId !== 'string') throw new OpenwopError('validation_error', 'Field `runId` is required.', 400);
      try {
        res.json({ run: await cancelPayoutRun(tenantOf(req), b.runId) });
      } catch (err) { mapPayoutError(err); }
    },
  },
  {
    // ADR 0445 P2 — request payout onboarding: ONE `connect-seller` approval on
    // the shared queue (seller lanes are approval-gated). Idempotent per author.
    method: 'post',
    path: `${KICKTODO_COMMERCE_PREFIX}/seller-onboarding/request`,
    handler: async (req, res) => {
      await gate(req);
      try {
        const row = await requestSellerOnboarding(tenantOf(req), subjectOf(req));
        res.json({ approvalId: row.approvalId });
      } catch (err) {
        if (err instanceof SellerRequestError) {
          throw new OpenwopError(err.code === 'forbidden' ? 'forbidden_scope' : 'validation_error', err.message, err.code === 'forbidden' ? 403 : 400);
        }
        throw err;
      }
    },
  },
  {
    // ADR 0445 P2 — the author's own request state + the tenant seller state.
    method: 'get',
    path: `${KICKTODO_COMMERCE_PREFIX}/seller-onboarding/status`,
    handler: async (req, res) => {
      await gate(req);
      res.json(await sellerRequestStatus(tenantOf(req), subjectOf(req)));
    },
  },
  {
    // ADR 0445 P4 — the author's OWN statement (CSV): the ADR 0297 D2
    // audit-export pattern — the ledger as a file, no money movement. Self-
    // scoped; no buyer PII (order ids + amounts only).
    method: 'get',
    path: `${KICKTODO_COMMERCE_PREFIX}/my-earnings.csv`,
    handler: async (req, res) => {
      await gate(req);
      const rows = await listSharesForAuthor(tenantOf(req), subjectOf(req));
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', 'attachment; filename="kicktodo-earnings.csv"');
      res.send(sharesCsv(rows, false));
    },
  },
  {
    // ADR 0445 P4 — the operator statement (manage-gated; includes the author
    // column the self-scoped export omits).
    method: 'get',
    path: `${KICKTODO_COMMERCE_PREFIX}/share-ledger.csv`,
    handler: async (req, res) => {
      await requireKicktodoManage(req, 'kicktodo-commerce', 'KickTodo Commerce');
      const rows = await listSharesForTenant(tenantOf(req));
      res.setHeader('content-type', 'text/csv; charset=utf-8');
      res.setHeader('content-disposition', 'attachment; filename="kicktodo-share-ledger.csv"');
      res.send(sharesCsv(rows, true));
    },
  },
  {
    // "My purchases" — the caller's own entitlements only (uniform scope).
    method: 'get',
    path: `${KICKTODO_COMMERCE_PREFIX}/mine`,
    handler: async (req, res) => {
      await gate(req);
      res.json({ entitlements: await listEntitlementsFor(tenantOf(req), subjectOf(req)) });
    },
  },
];

export function registerKicktodoCommerceRoutes(deps: RouteDeps): void {
  const app: Express = deps.app;
  const wrap = (h: Handler) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await h(req, res);
    } catch (err) {
      next(err);
    }
  };
  for (const r of KICKTODO_COMMERCE_ROUTES) {
    app[r.method](r.path, wrap(r.handler));
  }
}
