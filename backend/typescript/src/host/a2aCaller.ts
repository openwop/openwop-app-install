/**
 * ADR 1045 D1 (CHAN-P6-1) — WHO is calling the A2A server, resolved ONCE per
 * HTTP request, before any body is dispatched.
 *
 * Before this, the A2A route read `req.tenantId ?? 'default'` and
 * `req.principal?.principalId ?? 'anon'`. In the cookie posture the auth
 * middleware MINTS an `anon:<sid>` principal for a credential-less caller
 * (ADR 0015), so an unauthenticated POST reached the server: the defect RFC 0153
 * §E found on the MCP mount on 2026-08-17 (H43). This resolver is the A2A twin of
 * that fix, and of `mcpCallerFor`'s tenant rule:
 *
 *  - no principal → 401;
 *  - an anonymous principal → 401, unless the host ADVERTISES `anonymousActor`
 *    (RFC 0132): the advert and the behaviour must agree;
 *  - the tenant is `req.tenantId`, which the auth middleware sets for every
 *    scoped lane. A wildcard operator key leaves it unset by design and acts in
 *    `default` (the `tenantOf` operator posture `POST /workflows` and the MCP
 *    mount already use). Any other principal with no tenant is refused 403.
 *    There is no `'default'` fallback for a scoped caller and no `'anon'` id.
 *
 * It also owns the per-method authorization (ADR 1045 D6): each A2A method takes
 * the protocol scope its HTTP sibling route takes, through the SAME
 * `requireProtocolScopeIn` call, so A2A cannot become a way around a refusal the
 * `/runs` routes would make.
 */
import type { Request } from 'express';
import { OpenwopError } from '../types.js';
import { anonymousActorAdvertised } from './anonymousActor.js';
import { requireProtocolScopeIn, type EnforcedProtocolScope } from './protocolAuthorization.js';
import { A2A_10_METHODS } from './a2aCodec10.js';

export interface A2aCaller {
  /** The ONE tenant every A2A decision on this request is made in. */
  tenantId: string;
  /** The authenticated principal id. Never a placeholder. */
  principalId: string;
}

/** The operator tenant a wildcard key acts in (`host/requestSubject.ts` `tenantOf`). */
const WILDCARD_OPERATOR_TENANT = 'default';

/** Resolve the caller, or throw a 401/403 `OpenwopError`. */
export function resolveA2aCaller(req: Request): A2aCaller {
  const principal = req.principal;
  if (!principal) {
    throw new OpenwopError('unauthenticated', 'The A2A server requires an authenticated principal.', 401, {});
  }
  if (req.anonymousPrincipal === true && !anonymousActorAdvertised()) {
    throw new OpenwopError(
      'unauthenticated',
      'The A2A server requires an authenticated, non-anonymous principal; this host does not advertise anonymousActor.',
      401,
      { reason: 'anonymous_principal_refused' },
    );
  }
  const bound = (req as { tenantId?: string }).tenantId;
  if (typeof bound === 'string' && bound !== '') {
    return { tenantId: bound, principalId: principal.principalId };
  }
  if ((principal.tenants ?? []).includes('*')) {
    return { tenantId: WILDCARD_OPERATOR_TENANT, principalId: principal.principalId };
  }
  throw new OpenwopError('forbidden', 'The A2A server could not bind a tenant for this principal.', 403, { reason: 'no_tenant_binding' });
}

/**
 * ADR 1045 D6 — the protocol scope each A2A method takes: the scope of the HTTP
 * route that does the same thing. `null` = no tenant data and no effect
 * (card reads; the public GET serves the same card).
 */
const SCOPE_BY_METHOD: Readonly<Record<string, EnforcedProtocolScope | null>> = {
  // 0.3 codec
  'agent/getCard': null,
  'message/send': 'runs:create',
  'tasks/get': 'runs:read',
  'tasks/resubscribe': 'runs:read',
  'tasks/pushNotificationConfig/set': 'webhooks:manage',
  // 1.0 codec
  [A2A_10_METHODS.sendMessage]: 'runs:create',
  [A2A_10_METHODS.sendStreamingMessage]: 'runs:create',
  [A2A_10_METHODS.getTask]: 'runs:read',
  [A2A_10_METHODS.listTasks]: 'runs:read',
  [A2A_10_METHODS.subscribeToTask]: 'runs:read',
  [A2A_10_METHODS.cancelTask]: 'runs:cancel',
  [A2A_10_METHODS.createPushConfig]: 'webhooks:manage',
  [A2A_10_METHODS.deletePushConfig]: 'webhooks:manage',
  [A2A_10_METHODS.getPushConfig]: 'runs:read',
  [A2A_10_METHODS.listPushConfigs]: 'runs:read',
  [A2A_10_METHODS.getExtendedCard]: null,
};

/** The scope `method` requires, or `null` when it requires none / is unknown
 *  (an unknown method is answered `-32601` by the codec and touches nothing). */
export function a2aScopeFor(method: unknown): EnforcedProtocolScope | null {
  if (typeof method !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(SCOPE_BY_METHOD, method) ? SCOPE_BY_METHOD[method] ?? null : null;
}

/** ADR 1045 D2 — the methods that start work, and so take the per-principal budget. */
export const A2A_RUN_STARTING_METHODS: ReadonlySet<string> = new Set([
  'message/send',
  A2A_10_METHODS.sendMessage,
  A2A_10_METHODS.sendStreamingMessage,
]);

/** Enforce `method`'s scope for `caller` (throws the shared 403 `OpenwopError`). */
export async function authorizeA2aMethod(req: Request, caller: A2aCaller, method: unknown): Promise<void> {
  const scope = a2aScopeFor(method);
  if (scope) await requireProtocolScopeIn(req, caller.tenantId, scope);
}
