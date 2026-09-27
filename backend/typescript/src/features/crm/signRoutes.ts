/**
 * CRM e-signature routes (ADR 0402 §b) — host-extension surface.
 *   Authed (org-scoped, RBAC):  /v1/host/openwop-app/crm/orgs/:orgId/sign-requests[...]
 *   Public (unauthed):          /v1/host/openwop-app/public-sign/:token[...]
 *
 * The public prefix is on PUBLIC_PATH_PREFIXES. The signer authorizes by the
 * sharing `sign_request` capability TOKEN (possession = identity — the
 * commerce-quote public-accept precedent), NOT the sharing content toggle; the
 * routes gate on the owning `crm` toggle. Four public invariants: active-only,
 * tenant-from-resource, uniform 404, rate-limited.
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireString, optionalString, publicBaseUrl } from '../featureRoute.js';
import { checkEntitlement } from '../../host/entitlementSeam.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import {
  requestSignature, getSignatureStatus, listSignatureRequests, voidSignRequest,
  resolveSigner, signPublicView, signRequest, declineSign, esignEnabled,
} from './signService.js';
import { renderTarget } from './signTargets.js';

const FEATURE = { toggleId: 'crm', label: 'CRM' };
const ORG = '/v1/host/openwop-app/crm/orgs/:orgId';
const PUB = '/v1/host/openwop-app/public-sign';

type Scope = 'workspace:read' | 'workspace:write';

export function registerCrmSignRoutes(deps: RouteDeps): void {
  const { app } = deps;
  // ADR 0419 — authed management gates on toggle + org RBAC + plan/bundle entitlement
  // (CRM is sellable). PUBLIC signer routes (below, under PUB) never use `authz`, so a
  // public signer is never 403'd on the operator's plan (the ADR 0176 exemption).
  const authz = async (req: Request, scope: Scope) => {
    const ctx = await authorizeOrgScope(req, FEATURE, scope);
    await checkEntitlement(req, FEATURE.toggleId);
    return ctx;
  };

  // ───────────────────────── authed org-scoped management ─────────────────────
  app.get(`${ORG}/sign-requests`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      res.json({ signRequests: await listSignatureRequests(tenantId, orgId) });
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/sign-requests`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const target = (body.target ?? {}) as { kind?: unknown; id?: unknown };
      const signersIn = Array.isArray(body.signers) ? body.signers : [];
      const signers = signersIn.map((s) => {
        const o = (s ?? {}) as Record<string, unknown>;
        return {
          email: requireString(o.email, 'signers[].email'),
          ...(optionalString(o.name) ? { name: optionalString(o.name) } : {}),
          ...(typeof o.order === 'number' ? { order: o.order } : {}),
        };
      });
      const req0 = await requestSignature({
        tenantId,
        orgId,
        target: { kind: requireString(target.kind, 'target.kind'), id: requireString(target.id, 'target.id') },
        signers,
        createdBy: user.userId,
        ...(user.displayName || user.email ? { requestedBy: { ...(user.displayName ? { name: user.displayName } : {}), ...(user.email ? { email: user.email } : {}) } } : {}),
        baseUrl: publicBaseUrl(req),
        ...(optionalString(body.provider) ? { provider: optionalString(body.provider) } : {}),
      });
      const status = await getSignatureStatus(tenantId, orgId, req0.signRequestId);
      // Surface whether the signer invites were actually EMAILED. Without this
      // the field would stop at the service and the client would keep implying
      // delivery — the same "the host knew and didn't say" shape this fix exists
      // to remove. `false` means the request is live but the requester must
      // share the signing link themselves.
      res.status(201).json({ ...(status ?? {}), invitesEmailed: req0.invitesEmailed });
    } catch (err) { next(err); }
  });

  app.get(`${ORG}/sign-requests/:signRequestId`, async (req, res, next) => {
    try {
      const { orgId, tenantId } = await authz(req, 'workspace:read');
      const status = await getSignatureStatus(tenantId, orgId, req.params.signRequestId);
      if (!status) throw new OpenwopError('not_found', 'Sign request not found.', 404, {});
      res.json(status);
    } catch (err) { next(err); }
  });

  app.post(`${ORG}/sign-requests/:signRequestId/void`, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authz(req, 'workspace:write');
      const voided = await voidSignRequest(tenantId, orgId, req.params.signRequestId, user.userId);
      if (!voided) throw new OpenwopError('not_found', 'Sign request not found.', 404, {});
      res.json({ status: voided.status });
    } catch (err) { next(err); }
  });

  // ───────────────────────── public signer surface ────────────────────────────
  const resolveSignToken = async (token: string): Promise<{ resourceId: string; tenantId: string; orgId: string }> => {
    const notFound = (): never => { throw new OpenwopError('not_found', 'Sign request not found.', 404, {}); };
    if (!esignEnabled()) notFound();
    const { resolveActiveResource } = await import('../sharing/sharingService.js');
    const { tenantId, orgId, resourceId } = await resolveActiveResource(token, 'sign_request');
    const assignment = await resolveOne(FEATURE.toggleId, { tenantId });
    if (!assignment || !assignment.enabled) notFound();
    return { resourceId, tenantId, orgId };
  };

  app.get(`${PUB}/:token`, async (req, res, next) => {
    try {
      const { resourceId, tenantId, orgId } = await resolveSignToken(req.params.token);
      const resolved = await resolveSigner(resourceId);
      if (!resolved) throw new OpenwopError('not_found', 'Sign request not found.', 404, {});
      const rendered = await renderTarget(tenantId, orgId, resolved.req.target);
      res.json(signPublicView(resolved.req, resolved.signer, rendered));
    } catch (err) { next(err); }
  });

  app.post(`${PUB}/:token/sign`, async (req, res, next) => {
    try {
      const { resourceId } = await resolveSignToken(req.params.token);
      const body = (req.body ?? {}) as Record<string, unknown>;
      // R2 S-G2 — click-to-sign needs the signer's EXPLICIT acknowledgment; a
      // signature minted without it is not the consent record it claims to be.
      if (body.acknowledged !== true) {
        throw new OpenwopError('validation_error', 'The legal notice must be acknowledged to sign.', 400, { reason: 'acknowledgment_required' });
      }
      const out = await signRequest({
        resourceId,
        acknowledged: true,
        typedName: requireString(body.typedName, 'typedName'),
        ip: req.ip ?? '0.0.0.0',
        userAgent: req.header('user-agent') ?? '',
        nowMs: Date.now(),
        baseUrl: publicBaseUrl(req),
      });
      res.json(out);
    } catch (err) { next(err); }
  });

  app.post(`${PUB}/:token/decline`, async (req, res, next) => {
    try {
      const { resourceId } = await resolveSignToken(req.params.token);
      const out = await declineSign(resourceId, Date.now());
      res.json(out);
    } catch (err) { next(err); }
  });
}
