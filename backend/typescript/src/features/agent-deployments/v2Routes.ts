/**
 * RFC 0082 — `listAgentDeployments` / `transitionAgentDeployment`
 * (`GET` / `POST /agents/{agentId}/deployments`), ADR 1005 D3/D6.
 *
 * Gate order on a transition (ADR 1005 D3; each refusal writes nothing):
 *   1. advertised, else 404 (also the reserved `roster` / `org-chart` ids);
 *   2. key-lane scope: a key that declares scopes needs the literal `deploy:*`;
 *   3. membership authority (`packs:publish`), BEFORE anything is loaded, so a
 *      caller without it learns nothing about which versions exist;
 *   4. the body against `agent-deployment-transition.schema.json`;
 *   5. the agent and version exist for this tenant (404, the same for "absent"
 *      and "not yours");
 *   6.–8. advertised states, legality, the eval gate (`service.ts`).
 * A refusal is audited as `authorization.decided` on the tenant log; an applied
 * transition records it on its deployment-management run (RFC 0254 §D).
 */

import type { Request, Response, NextFunction } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
import { resolveSubjectScopesUnion } from '../../host/accessControlService.js';
import { credentialScopesIn, requireDeployKeyScope, requireProtocolScope } from '../../host/protocolAuthorization.js';
import { resolveAgentForTenant } from '../../host/agentVisibility.js';
import { fromWireRunId } from '../../host/v2Ids.js';
import { canonicalDecider } from '../../host/delegatedSubject.js';
import { canonicalReviewerUserId } from '../../host/approverResolution.js';
import { agentDeploymentFacet } from './capability.js';
import { applyTransition, audit, isReservedAgent, listDeployments } from './service.js';
import { DEPLOYMENT_STATES, DEPLOYMENT_TRANSITIONS, wireView, type DeploymentTransition, type TransitionRequest } from './types.js';

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,255}$/;
const RESERVED_SEGMENTS = new Set(['roster', 'org-chart']);
export const MEMBER_SCOPE = 'packs:publish';

function notFound(message: string): OpenwopError {
  return new OpenwopError('not_found', message, 404);
}

export function gate(req: Request): string {
  if (!agentDeploymentFacet()) {
    throw new OpenwopError('not_found', 'capabilities.agents.deployment is not advertised', 404, { family: 'agents', facet: 'deployment' });
  }
  const agentId = req.params.agentId;
  if (typeof agentId !== 'string' || RESERVED_SEGMENTS.has(agentId) || !AGENT_ID.test(agentId)) throw notFound('No such agent.');
  return agentId;
}

/** The installed version of a visible agent; reserved conformance agents need none. 404 otherwise. */
async function baselineOf(req: Request, agentId: string): Promise<string | undefined> {
  if (isReservedAgent(agentId)) return undefined;
  const a = await resolveAgentForTenant(agentId, tenantOf(req));
  if (!a) throw notFound(`agent '${agentId}' is not installed on this host`);
  // An agent's version on this host is its pack's (RFC 0070 packs version agents).
  return a.packVersion || undefined;
}

export async function holdsMemberScope(req: Request): Promise<boolean> {
  const kind = req.principal?.auth?.kind;
  if (kind === 'env-key' || kind === 'api-key') {
    return (await credentialScopesIn(req.principal!, tenantOf(req), callerSubject(req))).includes(MEMBER_SCOPE);
  }
  if (req.principal?.tenants?.includes('*')) return true;
  const subject = callerSubject(req);
  return subject ? (await resolveSubjectScopesUnion(tenantOf(req), subject)).scopes.includes(MEMBER_SCOPE) : false;
}

/**
 * ADR 1005 D13 — every spelling of whoever asked: the session user, the
 * principal, and a key's issuer, each with its canonical decider and user. The
 * approval compares the decider the same way, so one person keyed two ways is
 * still one person. A spelling that cannot be resolved fails closed.
 */
async function requesterIdentities(req: Request, tenant: string): Promise<{ ids: string[]; unresolved: boolean }> {
  const raw = [
    (req as { userId?: string }).userId,
    req.principal?.principalId,
    req.principal?.auth?.kind === 'api-key' ? req.principal.auth.issuer : undefined,
  ].filter((x): x is string => typeof x === 'string' && x.length > 0);
  const ids = new Set<string>();
  let unresolved = false;
  for (const r of raw) {
    ids.add(r);
    const decider = await canonicalDecider(tenant, r);
    if (decider === null) { unresolved = true; continue; }
    ids.add(decider);
    ids.add(await canonicalReviewerUserId(tenant, decider));
  }
  return { ids: [...ids], unresolved: unresolved || ids.size === 0 };
}

function field(message: string, name: string): OpenwopError {
  return new OpenwopError('validation_error', message, 400, { field: name });
}

const ALLOWED = new Set(['version', 'transition', 'toState', 'channel', 'canaryPercent', 'evalRunId', 'reason']);

/** `agent-deployment-transition.schema.json` (closed), by hand. */
export function parseTransition(raw: unknown): TransitionRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw field('The request body must be a JSON object.', 'body');
  const b = raw as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!ALLOWED.has(k)) throw field(`Unknown field \`${k}\`.`, k);
  const str = (k: string, max: number): string | undefined => {
    const v = b[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length < 1 || v.length > max) throw field(`\`${k}\` must be a string of 1–${max} characters.`, k);
    return v;
  };
  const version = str('version', 64);
  if (version === undefined) throw field('`version` is required.', 'version');
  const transition = b.transition;
  if (typeof transition !== 'string' || !(DEPLOYMENT_TRANSITIONS as readonly string[]).includes(transition)) {
    throw field(`\`transition\` must be one of: ${DEPLOYMENT_TRANSITIONS.join(', ')}.`, 'transition');
  }
  const toState = b.toState;
  if (toState !== undefined && (typeof toState !== 'string' || !(DEPLOYMENT_STATES as readonly string[]).includes(toState))) {
    throw field(`\`toState\` must be one of: ${DEPLOYMENT_STATES.join(', ')}.`, 'toState');
  }
  const canary = b.canaryPercent;
  if (canary !== undefined && (typeof canary !== 'number' || !Number.isInteger(canary) || canary < 0 || canary > 100)) {
    throw field('`canaryPercent` must be an integer from 0 to 100.', 'canaryPercent');
  }
  const channel = str('channel', 64);
  const evalRunId = str('evalRunId', 512);
  const reason = str('reason', 512);
  return {
    version,
    transition: transition as DeploymentTransition,
    ...(toState !== undefined ? { toState: toState as TransitionRequest['toState'] & string } : {}),
    ...(channel !== undefined ? { channel } : {}),
    ...(canary !== undefined ? { canaryPercent: canary as number } : {}),
    ...(evalRunId !== undefined ? { evalRunId } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

export function registerAgentDeploymentV2Routes(deps: RouteDeps): void {
  const { app, storage } = deps;
  const wrap = (h: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try { await h(req, res); } catch (err) { next(err); }
    };

  // listAgentDeployments
  app.get('/agents/:agentId/deployments', wrap(async (req, res) => {
    const agentId = gate(req);
    await requireProtocolScope(req, 'runs:read');
    const baseline = await baselineOf(req, agentId);
    res.json((await listDeployments(tenantOf(req), agentId, baseline)).map(wireView));
  }));

  // transitionAgentDeployment
  app.post('/agents/:agentId/deployments', wrap(async (req, res) => {
    const agentId = gate(req);
    const tenant = tenantOf(req);
    const principal = req.principal?.principalId ?? callerSubject(req) ?? 'anonymous';
    // A refusal creates no management run (RFC 0254 §D), so it is audited on the
    // tenant log; an applied transition records its decision on its own run.
    const refused = (reason: string): Promise<void> =>
      audit(tenant, 'authorization.decided', { principal, action: 'deploy:*', resource: `agent:${agentId}`, allowed: false, reason });
    try {
      requireDeployKeyScope(req);
    } catch (err) {
      await refused('key-scopes');
      throw err;
    }
    if (!(await holdsMemberScope(req))) {
      await refused('membership');
      throw new OpenwopError('forbidden', `This needs the \`${MEMBER_SCOPE}\` scope in this workspace.`, 403, { requiredScope: MEMBER_SCOPE });
    }
    const body = parseTransition(req.body);
    const baseline = await baselineOf(req, agentId);
    let storedEvalRunId: string | undefined;
    if (body.evalRunId !== undefined) {
      const decoded = fromWireRunId(body.evalRunId, tenant);
      // A run id bound to another tenant names no run this caller can cite: the
      // empty id reads as `eval_run_not_found`.
      storedEvalRunId = decoded.ok ? decoded.runId : '';
    }
    const requester = await requesterIdentities(req, tenant);
    const outcome = await applyTransition(tenant, agentId, body, {
      storage,
      principal,
      requesterIds: requester.ids,
      ...(requester.unresolved ? { requesterUnresolved: true } : {}),
      ...(baseline !== undefined ? { baselineVersion: baseline } : {}),
      ...(storedEvalRunId !== undefined ? { storedEvalRunId } : {}),
    });
    // RFC 0254 §D — `202` when ADR 1005 D13 gates it: the record unchanged except `transitionRunId`.
    res.status(outcome.status).json(wireView(outcome.record));
  }));
}
