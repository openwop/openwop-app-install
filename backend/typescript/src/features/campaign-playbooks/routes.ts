/**
 * Campaign playbooks routes — host extension under `/v1/host/openwop-app/campaign-playbooks/*`
 * (ADR 0959 P0). No RFC, nothing advertised.
 *
 * Authority (ADR 0959 matrix row 8), fail-closed, and the SAME checks campaign-ops uses
 * (imported, never copied):
 *  - authoring, publishing and installing: an AGENCY ADMIN (`host:members:manage` on the
 *    workspace root row exactly — campaign-ops `isAgencyAdmin`);
 *  - reading a client's installations: that client's `workspace:read` (campaign-ops
 *    `authorizeClient`); a client the caller cannot read, and an org that is not a client, are
 *    the same 404.
 * Both toggles are checked: `campaign-playbooks` here, `campaign-ops` inside its guards.
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled, tenantOf } from '../featureRoute.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { authorizeClient, isAgencyAdmin, CAMPAIGN_OPS_TOGGLE } from '../campaign-ops/routes.js';
import { getClient } from '../campaign-ops/clientService.js';
import { getDraft, listPlaybooks, listVersions, publishVersion, saveDraft } from './playbookStore.js';
import { getAgencyLayer, installationDrift, installPlaybook, listInstallations, listPlaybookInstallations, setAgencyLayer, setInstallationRing } from './installService.js';
import { applyContent } from './contentService.js';
import { getVersion } from './playbookStore.js';
import { getInstallation } from './installService.js';
import { advanceRollout, applyOpenRing, applyRolloutTarget, createRollout, getRollout, listRollouts, planRollout, rollbackRolloutTarget } from './rolloutService.js';

export const CAMPAIGN_PLAYBOOKS_TOGGLE = 'campaign-playbooks';
const LABEL = 'Campaign playbooks';
const BASE = '/host/openwop-app/campaign-playbooks';

async function requireAgencyAdmin(req: Request): Promise<{ tenantId: string; userId: string }> {
  await requireFeatureEnabled(req, CAMPAIGN_PLAYBOOKS_TOGGLE, LABEL);
  // `isAgencyAdmin` checks the role only, so the campaign-ops toggle is checked here
  // (`authorizeClient` checks it itself on the read route).
  await requireFeatureEnabled(req, CAMPAIGN_OPS_TOGGLE, 'Campaign operations');
  if (!(await isAgencyAdmin(req))) {
    throw new OpenwopError('forbidden_scope', 'Only an agency admin can author, publish or install playbooks.', 403, { requiredScope: 'host:members:manage' });
  }
  return { tenantId: tenantOf(req), userId: (await resolveCallerUser(req)).userId };
}

function param(req: Request, name: string): string {
  const v = req.params[name];
  return typeof v === 'string' ? v : '';
}

export function registerCampaignPlaybooksRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(`${BASE}/playbooks`, async (req, res, next) => {
    try {
      const { tenantId } = await requireAgencyAdmin(req);
      res.json({ playbooks: (await listPlaybooks(tenantId)).map(summary) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/playbooks/:playbookId/draft`, async (req, res, next) => {
    try {
      const { tenantId } = await requireAgencyAdmin(req);
      const draft = await getDraft(tenantId, param(req, 'playbookId'));
      if (!draft) throw new OpenwopError('not_found', 'Playbook draft not found.', 404, {});
      res.json({ draft });
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/playbooks/:playbookId/draft`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await requireAgencyAdmin(req);
      res.json({ draft: await saveDraft(tenantId, param(req, 'playbookId'), req.body, userId) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/playbooks/:playbookId/versions`, async (req, res, next) => {
    try {
      const { tenantId } = await requireAgencyAdmin(req);
      res.json({ versions: await listVersions(tenantId, param(req, 'playbookId')) });
    } catch (err) { next(err); }
  });

  // The installation matrix (matrix row 10): every client on this playbook, with drift.
  app.get(`${BASE}/playbooks/:playbookId/installations`, async (req, res, next) => {
    try {
      const { tenantId } = await requireAgencyAdmin(req);
      const rows = await listPlaybookInstallations(tenantId, param(req, 'playbookId'));
      res.json({ installations: await Promise.all(rows.map(async (r) => ({ ...r, drift: await installationDrift(r) }))) });
    } catch (err) { next(err); }
  });

  // D3 layer 1 — the agency's values for a playbook, applied to every client.
  app.get(`${BASE}/playbooks/:playbookId/agency-layer`, async (req, res, next) => {
    try {
      const { tenantId } = await requireAgencyAdmin(req);
      res.json({ agencyLayer: await getAgencyLayer(tenantId, param(req, 'playbookId')) });
    } catch (err) { next(err); }
  });

  app.put(`${BASE}/playbooks/:playbookId/agency-layer`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await requireAgencyAdmin(req);
      res.json({ agencyLayer: await setAgencyLayer(tenantId, param(req, 'playbookId'), req.body, userId) });
    } catch (err) { next(err); }
  });

  // D1 — publish freezes the draft. An existing version is a 409, never an overwrite.
  app.post(`${BASE}/playbooks/:playbookId/versions`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await requireAgencyAdmin(req);
      const version = typeof req.body?.version === 'string' ? req.body.version : '';
      res.status(201).json({ version: await publishVersion(tenantId, param(req, 'playbookId'), version, userId) });
    } catch (err) { next(err); }
  });

  // D6 — rollouts. The plan is pure; a rollout stores it and opens ONE review on the
  // shared approvals queue (decided at /approvals/:id/claim|reject); apply and rollback
  // are per client.
  const rolloutBody = (req: Request): { toVersion: string; orgIds: string[] } => {
    const b = (req.body ?? {}) as { toVersion?: unknown; orgIds?: unknown };
    if (typeof b.toVersion !== 'string' || !Array.isArray(b.orgIds) || !b.orgIds.every((x) => typeof x === 'string')) {
      throw new OpenwopError('validation_error', 'toVersion and orgIds are required.', 400, {});
    }
    return { toVersion: b.toVersion, orgIds: b.orgIds as string[] };
  };

  app.post(`${BASE}/playbooks/:playbookId/rollouts/plan`, async (req, res, next) => {
    try {
      const { tenantId } = await requireAgencyAdmin(req);
      const { toVersion, orgIds } = rolloutBody(req);
      const { plan, planHash } = await planRollout(tenantId, param(req, 'playbookId'), toVersion, orgIds);
      res.json({ plan, planHash });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/playbooks/:playbookId/rollouts`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await requireAgencyAdmin(req);
      const b = (req.body ?? {}) as { rings?: unknown; soakHours?: unknown };
      if (b.rings === true) {
        // D6.3 — ring mode: every installed client not held, canary → early → general.
        const toVersion = typeof (req.body as { toVersion?: unknown }).toVersion === 'string' ? (req.body as { toVersion: string }).toVersion : '';
        if (!toVersion) throw new OpenwopError('validation_error', 'toVersion is required.', 400, {});
        const soak = b.soakHours && typeof b.soakHours === 'object' ? b.soakHours as Record<string, number> : {};
        res.status(201).json(await createRollout(tenantId, param(req, 'playbookId'), toVersion, [], userId, { rings: true, soakHours: soak }));
        return;
      }
      const { toVersion, orgIds } = rolloutBody(req);
      res.status(201).json(await createRollout(tenantId, param(req, 'playbookId'), toVersion, orgIds, userId));
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/rollouts/:rolloutId/apply-ring`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await requireAgencyAdmin(req);
      res.json(await applyOpenRing(tenantId, param(req, 'rolloutId'), userId));
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/rollouts/:rolloutId/advance`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await requireAgencyAdmin(req);
      res.json({ rollout: await advanceRollout(deps.storage, tenantId, param(req, 'rolloutId'), userId) });
    } catch (err) { next(err); }
  });

  // D5 — (re)apply an installation's content: idempotent per slot, the retry for a failed item.
  app.post(`${BASE}/clients/:orgId/installs/:playbookId/content`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await requireAgencyAdmin(req);
      const install = await getInstallation(tenantId, param(req, 'orgId'), param(req, 'playbookId'));
      if (!install || install.status !== 'installed') throw new OpenwopError('not_found', 'Installation not found.', 404, {});
      const version = await getVersion(tenantId, install.playbookId, install.pinnedVersion);
      if (!version) throw new OpenwopError('not_found', 'Playbook version not found.', 404, {});
      res.json({ content: await applyContent(install, version, userId, { overwrite: (req.body as { overwrite?: unknown } | undefined)?.overwrite === true }) });
    } catch (err) { next(err); }
  });

  // D6.3/D6.6 — a client's ring (or `held`: skipped by every rollout).
  app.put(`${BASE}/clients/:orgId/installs/:playbookId/ring`, async (req, res, next) => {
    try {
      const { tenantId } = await requireAgencyAdmin(req);
      res.json({ installation: await setInstallationRing(tenantId, param(req, 'orgId'), param(req, 'playbookId'), (req.body as { ring?: unknown } | undefined)?.ring) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/playbooks/:playbookId/rollouts`, async (req, res, next) => {
    try {
      const { tenantId } = await requireAgencyAdmin(req);
      res.json({ rollouts: await listRollouts(tenantId, param(req, 'playbookId')) });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/rollouts/:rolloutId`, async (req, res, next) => {
    try {
      const { tenantId } = await requireAgencyAdmin(req);
      const rollout = await getRollout(tenantId, param(req, 'rolloutId'));
      if (!rollout) throw new OpenwopError('not_found', 'Rollout not found.', 404, {});
      res.json({ rollout });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/rollouts/:rolloutId/targets/:orgId/apply`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await requireAgencyAdmin(req);
      const body = (req.body ?? {}) as { clientLayer?: unknown; overwrite?: unknown };
      const out = await applyRolloutTarget({
        tenantId, rolloutId: param(req, 'rolloutId'), orgId: param(req, 'orgId'), by: userId,
        ...(body.clientLayer !== undefined ? { clientLayer: body.clientLayer } : {}),
        ...(body.overwrite === true ? { overwrite: true } : {}),
      });
      res.json(out);
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/rollouts/:rolloutId/targets/:orgId/rollback`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await requireAgencyAdmin(req);
      res.json({ installation: await rollbackRolloutTarget({ tenantId, rolloutId: param(req, 'rolloutId'), orgId: param(req, 'orgId'), by: userId }) });
    } catch (err) { next(err); }
  });

  // D4 — install one version for one client.
  app.post(`${BASE}/clients/:orgId/installs`, async (req, res, next) => {
    try {
      const { tenantId, userId } = await requireAgencyAdmin(req);
      const orgId = param(req, 'orgId');
      if (!(await getClient(tenantId, orgId))) throw new OpenwopError('not_found', 'Client not found.', 404, { orgId });
      const body = (req.body ?? {}) as { playbookId?: unknown; version?: unknown; clientLayer?: unknown };
      if (typeof body.playbookId !== 'string' || typeof body.version !== 'string') {
        throw new OpenwopError('validation_error', 'playbookId and version are required.', 400, {});
      }
      const installation = await installPlaybook({ tenantId, orgId, playbookId: body.playbookId, version: body.version, clientLayer: body.clientLayer, by: userId });
      res.status(201).json({ installation });
    } catch (err) { next(err); }
  });

  app.get(`${BASE}/clients/:orgId/installs`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, CAMPAIGN_PLAYBOOKS_TOGGLE, LABEL);
      const { tenantId, client } = await authorizeClient(req, 'workspace:read');
      // D3 — each with its drift: `edited` (changed in /builder) or `missing` (deleted/archived).
      const rows = await listInstallations(tenantId, client.orgId);
      res.json({ installations: await Promise.all(rows.map(async (r) => ({ ...r, drift: await installationDrift(r) }))) });
    } catch (err) { next(err); }
  });
}

function summary(v: { playbookId: string; version: string; title: string; contentHash: string; publishedAt: string; changelog: string }) {
  return { playbookId: v.playbookId, latestVersion: v.version, title: v.title, contentHash: v.contentHash, publishedAt: v.publishedAt, changelog: v.changelog };
}
