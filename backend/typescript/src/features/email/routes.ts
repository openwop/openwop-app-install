/**
 * Email Marketing routes (host-extension, ADR 0019). Authed + org-scoped + RBAC —
 * NO public surface. Templates + campaigns CRUD; a send that resolves the audience
 * live from contactsService and consent-gates on `marketing`.
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { authorizeOrgScope, requireString, optionalString } from '../featureRoute.js';
import { CONTACT_STAGES, type ContactStage } from '../crm/contactsService.js';
import {
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate,
  listCampaigns, getCampaign, createCampaign, deleteCampaign, listSends, sendCampaign,
} from './emailService.js';

const FEATURE = { toggleId: 'email', label: 'Email Marketing' };
const ORG = '/v1/host/openwop-app/email/orgs/:orgId';
type Scope = 'workspace:read' | 'workspace:write';

export function registerEmailRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const authz = (req: Request, scope: Scope) => authorizeOrgScope(req, FEATURE, scope);

  // ── templates ──
  app.post(`${ORG}/templates`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const t = await createTemplate({ tenantId: user.tenantId, orgId, name: requireString(body.name, 'name'), subject: requireString(body.subject, 'subject'), body: requireString(body.body, 'body'), createdBy: user.userId });
      res.status(201).json(t);
    } catch (err) { next(err); }
  });
  app.get(`${ORG}/templates`, async (req, res, next) => {
    try { const { user, orgId } = await authz(req, 'workspace:read'); res.json({ templates: await listTemplates(user.tenantId, orgId) }); }
    catch (err) { next(err); }
  });
  app.patch(`${ORG}/templates/:templateId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: { name?: string; subject?: string; body?: string } = {};
      if (typeof body.name === 'string') patch.name = body.name;
      if (typeof body.subject === 'string') patch.subject = body.subject;
      if (typeof body.body === 'string') patch.body = body.body;
      const t = await updateTemplate(user.tenantId, orgId, req.params.templateId, patch);
      if (!t) throw new OpenwopError('not_found', 'Template not found.', 404, { templateId: req.params.templateId });
      res.json(t);
    } catch (err) { next(err); }
  });
  app.delete(`${ORG}/templates/:templateId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      if (!(await deleteTemplate(user.tenantId, orgId, req.params.templateId))) throw new OpenwopError('not_found', 'Template not found.', 404, { templateId: req.params.templateId });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ── campaigns ──
  app.post(`${ORG}/campaigns`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const templateId = requireString(body.templateId, 'templateId');
      if (!(await getTemplate(user.tenantId, orgId, templateId))) throw new OpenwopError('validation_error', 'Unknown templateId for this org.', 400, { templateId });
      const stage = optionalString(body.stage);
      if (stage && !CONTACT_STAGES.includes(stage as ContactStage)) throw new OpenwopError('validation_error', '`stage` is not a valid contact stage.', 400, { field: 'stage' });
      const c = await createCampaign({ tenantId: user.tenantId, orgId, templateId, ...(stage ? { stage: stage as ContactStage } : {}), createdBy: user.userId });
      res.status(201).json(c);
    } catch (err) { next(err); }
  });
  app.get(`${ORG}/campaigns`, async (req, res, next) => {
    try { const { user, orgId } = await authz(req, 'workspace:read'); res.json({ campaigns: await listCampaigns(user.tenantId, orgId) }); }
    catch (err) { next(err); }
  });
  app.delete(`${ORG}/campaigns/:campaignId`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      if (!(await deleteCampaign(user.tenantId, orgId, req.params.campaignId))) throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: req.params.campaignId });
      res.status(204).end();
    } catch (err) { next(err); }
  });
  app.post(`${ORG}/campaigns/:campaignId/send`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:write');
      const resend = (req.body ?? {} as Record<string, unknown>).resend === true;
      const c = await sendCampaign(user.tenantId, orgId, req.params.campaignId, { resend });
      if (!c) throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: req.params.campaignId });
      res.json(c);
    } catch (err) { next(err); }
  });
  app.get(`${ORG}/campaigns/:campaignId/sends`, async (req, res, next) => {
    try {
      const { user, orgId } = await authz(req, 'workspace:read');
      if (!(await getCampaign(user.tenantId, orgId, req.params.campaignId))) throw new OpenwopError('not_found', 'Campaign not found.', 404, { campaignId: req.params.campaignId });
      res.json({ sends: await listSends(user.tenantId, req.params.campaignId) });
    } catch (err) { next(err); }
  });
}
