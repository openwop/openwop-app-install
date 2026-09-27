/**
 * Dealer Network — REST routes (ADR 0281 Phase 1: dealer + outlet CRUD).
 *
 * Host-extension surface under `/v1/host/openwop-app/dealers/orgs/:orgId/*`
 * (non-normative — no OpenWOP RFC). Gated by the shared `authorizeOrgScope`
 * (toggle `dealers` ON + the caller's scope in the PATH org, IDOR-guarded,
 * fail-closed). Reads need `workspace:read`; dealer/outlet admin `workspace:write`.
 * (Deal-registration approval — `host:dealers:manage` — lands in P2.)
 *
 * @see docs/adr/0281-dealer-network-prm.md
 */

import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import type { Scope } from '../../host/accessControlService.js';
import { authorizeOrgScope, publicBaseUrl } from '../featureRoute.js';
import { createDealer, listDealers, getDealer, updateDealer, deleteDealer, createOutlet, listOutlets, getOutlet, updateOutlet, deleteOutlet } from './entities/dealer.js';
import { mintPartnerToken, resolvePartnerToken, createRegistration, listRegistrations, repairUnqueuedRegistrations, deleteDealerPrmData } from './entities/registration.js';
import { dealerMutated } from './emit.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { OpenwopError } from '../../types.js';

const TOGGLE_ID = 'dealers';
const LABEL = 'Dealers';
const authorize = (req: Request, scope: Scope) => authorizeOrgScope(req, { toggleId: TOGGLE_ID, label: LABEL }, scope);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export function registerDealerRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/dealers/orgs/:orgId';

  // ── Dealers ──
  app.get(`${BASE}/dealers`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      res.json({ dealers: await listDealers(tenantId, orgId, { territoryId: optStr(req.query.territoryId), status: optStr(req.query.status) }) });
    } catch (err) { next(err); }
  });
  app.get(`${BASE}/dealers/:dealerId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      res.json(await getDealer(tenantId, orgId, req.params.dealerId));
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/dealers`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      const dealer = await createDealer(tenantId, orgId, (req.body ?? {}) as Record<string, unknown>, user.userId);
      dealerMutated({ entity: 'dealer', verb: 'created', tenantId, orgId, actor: user.userId, entityId: dealer.dealerId });
      res.status(201).json(dealer);
    } catch (err) { next(err); }
  });
  app.patch(`${BASE}/dealers/:dealerId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      const dealer = await updateDealer(tenantId, orgId, req.params.dealerId, (req.body ?? {}) as Record<string, unknown>, user.userId);
      dealerMutated({ entity: 'dealer', verb: 'updated', tenantId, orgId, actor: user.userId, entityId: dealer.dealerId });
      res.json(dealer);
    } catch (err) { next(err); }
  });
  app.delete(`${BASE}/dealers/:dealerId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      // Children-first cascade (DEAL-DATA-1): purge the dealer's PRM data
      // (registrations + partner tokens) BEFORE the dealer+outlets, so a
      // mid-cascade failure leaves the dealer re-deletable, never orphan tokens
      // that could keep minting registrations.
      const prmRows = await deleteDealerPrmData(tenantId, orgId, req.params.dealerId);
      const removed = await deleteDealer(tenantId, orgId, req.params.dealerId);
      dealerMutated({ entity: 'dealer', verb: 'deleted', tenantId, orgId, actor: user.userId, entityId: req.params.dealerId });
      res.json({ success: true, removed: removed + prmRows });
    } catch (err) { next(err); }
  });

  // ── Outlets (owned by a dealer) ──
  app.get(`${BASE}/dealers/:dealerId/outlets`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      await getDealer(tenantId, orgId, req.params.dealerId); // 404 before listing children
      res.json({ outlets: await listOutlets(tenantId, orgId, { dealerId: req.params.dealerId }) });
    } catch (err) { next(err); }
  });
  app.get(`${BASE}/outlets`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      res.json({ outlets: await listOutlets(tenantId, orgId, { dealerId: optStr(req.query.dealerId) }) });
    } catch (err) { next(err); }
  });
  app.get(`${BASE}/outlets/:outletId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      res.json(await getOutlet(tenantId, orgId, req.params.outletId));
    } catch (err) { next(err); }
  });
  app.post(`${BASE}/dealers/:dealerId/outlets`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      const outlet = await createOutlet(tenantId, orgId, req.params.dealerId, (req.body ?? {}) as Record<string, unknown>, user.userId);
      dealerMutated({ entity: 'outlet', verb: 'created', tenantId, orgId, actor: user.userId, entityId: outlet.outletId });
      res.status(201).json(outlet);
    } catch (err) { next(err); }
  });
  app.patch(`${BASE}/outlets/:outletId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      const outlet = await updateOutlet(tenantId, orgId, req.params.outletId, (req.body ?? {}) as Record<string, unknown>, user.userId);
      dealerMutated({ entity: 'outlet', verb: 'updated', tenantId, orgId, actor: user.userId, entityId: outlet.outletId });
      res.json(outlet);
    } catch (err) { next(err); }
  });
  app.delete(`${BASE}/outlets/:outletId`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      await deleteOutlet(tenantId, orgId, req.params.outletId);
      dealerMutated({ entity: 'outlet', verb: 'deleted', tenantId, orgId, actor: user.userId, entityId: req.params.outletId });
      res.json({ success: true });
    } catch (err) { next(err); }
  });

  // ── PRM: partner-portal token (P2) ──
  // Mint/rotate a dealer's partner-portal capability token (internal admin).
  app.post(`${BASE}/dealers/:dealerId/portal-token`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorize(req, 'workspace:write');
      const t = await mintPartnerToken(tenantId, orgId, req.params.dealerId);
      dealerMutated({ entity: 'dealer', verb: 'portal-issued', tenantId, orgId, actor: user.userId, entityId: req.params.dealerId });
      res.status(201).json({ token: t.token, url: `${publicBaseUrl(req)}/v1/host/openwop-app/partner/${t.token}` });
    } catch (err) { next(err); }
  });

  // ── Deal registrations (internal review) ──
  app.get(`${BASE}/registrations`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authorize(req, 'workspace:read');
      // R2 DLR2-B2 — repair on the ADMIN read: a registration whose review card never
      // landed is re-queued here, so opening the console is what heals it. The public
      // partner read deliberately does NOT do this (it must stay side-effect-free).
      const rows = await listRegistrations(tenantId, orgId, { dealerId: optStr(req.query.dealerId), status: optStr(req.query.status) });
      // R3 (the R2 deferral) — the repair is a WRITE (re-queues approvals), and
      // this GET admits workspace:read. A viewer must never trigger writes, and
      // their GET must stay idempotent — so the self-heal runs only for callers
      // who could have queued the approval in the first place. Viewers get the
      // same rows, un-repaired (a manager's next visit heals them).
      let canRepair = false;
      try { await authorize(req, 'workspace:write'); canRepair = true; } catch { /* viewer — read-only */ }
      res.json({ registrations: canRepair ? await repairUnqueuedRegistrations(rows) : rows });
    } catch (err) { next(err); }
  });
  // CFP-1 (D9) — the bespoke `POST /registrations/:regId/{approve,reject}` decision
  // routes are DEMOLISHED. A pending registration auto-queues a `dealer-registration`
  // approval (see `createRegistration`); the manager decides it through the SHARED
  // reviews inbox (`/v1/host/openwop-app/reviews/:reviewId/actions/{approve,reject}`),
  // whose decision core dispatches to this feature's registered gate handler
  // (`registrationApproval.ts`). No path writes the registration state without the
  // gate. A resurrected decision route fails `dealers.test.ts`.

  // ── PUBLIC partner portal (NO auth — the token IS the credential; uniform 404) ──
  // Tenant/org/dealer are resolved FROM the token, never the request (CTI-1). Rides
  // PUBLIC_PATH_PREFIXES + the global per-IP rate limit; payloads are bounded.
  //
  // R2 DLR2-B1 — these two were the ONLY routes in the feature that never consulted
  // the toggle. Every org route runs `authorize()` → `requireFeatureEnabled`, so an
  // operator switching `dealers` off reasonably believes the surface is gone: the nav
  // hides and all 13 org routes 404. Meanwhile every issued partner link kept serving
  // the dealer's outlet names and STREET ADDRESSES, and kept ACCEPTING new deal
  // registrations — durable rows, approvals queued, into a console that no longer
  // exists. The toggle is the operator's kill-switch; a public route is exactly where
  // it has to hold, because that is the one an outsider can still reach.
  //
  // The tenant comes from the TOKEN (never the request — CTI-1), and the 404 is the
  // same uniform shape an unknown token gets, so toggle state is not an oracle.
  const requirePartnerFeatureEnabled = async (tenantId: string): Promise<void> => {
    // Review I7 — the org routes resolve with `toggleSubjectOf(req)` = {tenantId, userId},
    // and `resolveConfig`'s closed-beta branch matches the cohort against EITHER. A tenant
    // put into a beta by USER id would have a working console and dead partner links —
    // a silent divergence. There is no request user here (that is the point of a public
    // route), so the tenant is all there is; the divergence is named rather than hidden.
    const assignment = await resolveOne(TOGGLE_ID, { tenantId });
    // REVIEW B2 — the FIRST version threw `'Not found.'` while a bad token throws
    // `'Invalid partner link.'`, and the error envelope emits `message` verbatim. So the
    // two 404s were distinguishable: with the feature off, an outsider probing links got
    // one string for a guess and another for a REAL token — a token-validity oracle,
    // handed out in exactly the state the operator believes the surface is gone. The
    // shapes must be identical, not merely both 404.
    if (!assignment?.enabled) throw new OpenwopError('not_found', 'Invalid partner link.', 404, {});
  };
  app.get('/v1/host/openwop-app/partner/:token', async (req, res, next) => {
    try {
      const t = await resolvePartnerToken(req.params.token);
      await requirePartnerFeatureEnabled(t.tenantId);
      const dealer = await getDealer(t.tenantId, t.orgId, t.dealerId);
      const [outlets, registrations] = await Promise.all([
        listOutlets(t.tenantId, t.orgId, { dealerId: t.dealerId }),
        listRegistrations(t.tenantId, t.orgId, { dealerId: t.dealerId }),
      ]);
      // Partner-safe projection only — never leak internal ids/tenant.
      res.json({
        dealer: { name: dealer.name, tier: dealer.tier, status: dealer.status },
        outlets: outlets.map((o) => ({ name: o.name, address: o.address, status: o.status })),
        registrations: registrations.map((r) => ({ dealTitle: r.dealTitle, companyName: r.companyName, status: r.status, at: r.at })),
      });
    } catch (err) { next(err); }
  });
  app.post('/v1/host/openwop-app/partner/:token/register', async (req, res, next) => {
    try {
      const t = await resolvePartnerToken(req.params.token);
      await requirePartnerFeatureEnabled(t.tenantId);
      const body = (req.body ?? {}) as { dealTitle?: unknown; companyName?: unknown };
      const reg = await createRegistration(t.tenantId, t.orgId, t.dealerId, body);
      dealerMutated({ entity: 'registration', verb: 'created', tenantId: t.tenantId, orgId: t.orgId, actor: `partner:${t.dealerId}`, entityId: reg.regId });
      res.status(201).json({ dealTitle: reg.dealTitle, companyName: reg.companyName, status: reg.status, at: reg.at });
    } catch (err) { next(err); }
  });
}
