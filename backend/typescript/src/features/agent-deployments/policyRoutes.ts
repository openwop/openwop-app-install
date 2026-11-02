/**
 * ADR 1005 D12 — the operator promotion policy, non-normative host routes.
 *
 *   GET    /host/openwop-app/agent-deployments/:agentId/policy   `packs:publish`
 *   PUT    /host/openwop-app/agent-deployments/:agentId/policy   `host:org:manage`
 *   DELETE /host/openwop-app/agent-deployments/:agentId/policy   `host:org:manage`
 *
 * Reading needs the transition's membership scope. Writing needs the stricter
 * org scope: a caller who can deploy must not be able to remove the gate on
 * their own promotion. All three answer 404 while the facet is unadvertised.
 * `If-Match: "<revision>"` makes a write conditional (ETag is the revision).
 */
import type { Request, Response, NextFunction } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
import { callerHoldsTenantScope } from '../featureRoute.js';
import { gate, holdsMemberScope, MEMBER_SCOPE } from './v2Routes.js';
import { audit, isReservedAgent } from './service.js';
import { deletePolicy, effectivePolicy, getStoredPolicy, isFixedPolicy, parsePolicy, putPolicy } from './policy.js';
import { resolveAgentForTenant } from '../../host/agentVisibility.js';

const BASE = '/host/openwop-app/agent-deployments/:agentId/policy';
const ORG_SCOPE = 'host:org:manage' as const;

function ifMatch(req: Request): number | undefined {
  const h = req.get('if-match');
  if (h === undefined) return undefined;
  const m = /^"?(\d{1,12})"?$/.exec(h.trim());
  if (!m) throw new OpenwopError('validation_error', '`If-Match` must be a policy revision.', 400, { field: 'If-Match' });
  return Number(m[1]);
}

/** 404 for an agent this tenant cannot see (the same for "absent" and "not yours"). */
async function requireVisibleAgent(req: Request, agentId: string): Promise<void> {
  if (isReservedAgent(agentId)) return;
  if (!(await resolveAgentForTenant(agentId, tenantOf(req)))) {
    throw new OpenwopError('not_found', `agent '${agentId}' is not installed on this host`, 404);
  }
}

async function requireOrgScope(req: Request): Promise<void> {
  if (!(await callerHoldsTenantScope(req, tenantOf(req), ORG_SCOPE))) {
    throw new OpenwopError('forbidden', `Changing a promotion policy needs the \`${ORG_SCOPE}\` scope in this workspace.`, 403, { requiredScope: ORG_SCOPE });
  }
}

export function registerAgentDeploymentPolicyRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const wrap = (h: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try { await h(req, res); } catch (err) { next(err); }
    };

  app.get(BASE, wrap(async (req, res) => {
    const agentId = gate(req);
    if (!(await holdsMemberScope(req))) {
      throw new OpenwopError('forbidden', `This needs the \`${MEMBER_SCOPE}\` scope in this workspace.`, 403, { requiredScope: MEMBER_SCOPE });
    }
    await requireVisibleAgent(req, agentId);
    const tenant = tenantOf(req);
    const stored = await getStoredPolicy(tenant, agentId);
    if (stored) res.set('ETag', `"${stored.revision}"`);
    res.json({ agentId, fixed: isFixedPolicy(agentId), revision: stored?.revision ?? 0, policy: await effectivePolicy(tenant, agentId) });
  }));

  app.put(BASE, wrap(async (req, res) => {
    const agentId = gate(req);
    await requireOrgScope(req);
    await requireVisibleAgent(req, agentId);
    const policy = parsePolicy(req.body);
    const tenant = tenantOf(req);
    const by = callerSubject(req) ?? 'anonymous';
    const stored = await putPolicy(tenant, agentId, policy, by, ifMatch(req));
    await audit(tenant, 'agent-deployment.policy.changed', { agentId, revision: stored.revision, requiredEval: policy.requiredEval !== undefined, approval: policy.approval !== undefined });
    res.set('ETag', `"${stored.revision}"`);
    res.json({ agentId, fixed: false, revision: stored.revision, policy });
  }));

  app.delete(BASE, wrap(async (req, res) => {
    const agentId = gate(req);
    await requireOrgScope(req);
    await requireVisibleAgent(req, agentId);
    const tenant = tenantOf(req);
    const gone = await deletePolicy(tenant, agentId, callerSubject(req) ?? 'anonymous', ifMatch(req));
    if (gone) await audit(tenant, 'agent-deployment.policy.changed', { agentId, revision: gone.revision, requiredEval: false, approval: false });
    res.status(204).end();
  }));
}
