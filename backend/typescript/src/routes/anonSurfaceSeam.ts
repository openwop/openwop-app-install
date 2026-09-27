/**
 * RFC 0132 (Draft) — the anonymous-actor conformance WITNESS seam.
 *
 * `@openwop/openwop-conformance`'s anonymous-actor scenarios probe these
 * host-extension sample endpoints (NOT the production widget path) to witness that
 * a live host honors the §A opaque principal + §C two tiers + §D audit + the §F
 * MUST-NOTs NON-VACUOUSLY:
 *
 *   GET  /v1/host/sample/anon-surface/tools?surface=<id>
 *        → { tools: [{ name }] }   (the RFC 0078 catalog scoped to the anon session:
 *          the EXPLICIT grant only; fails EMPTY — never the ADR 0315 baseline)
 *   POST /v1/host/sample/anon-surface/dispatch  { surface, tool, args?, destination? }
 *        → { authorizationDecided:{ payload:{ principal, action, resource, allowed, reason } },
 *            owner:{ tenant, principal, principalKind:"anonymous" },
 *            egressDecided?:{ decision, reason, credentialAttached },
 *            interrupt?:{ kind }, result? }
 *
 * This surface is a SECOND CONSUMER of the ONE authorization owner
 * (`host/anonymousActor.ts`): it mints the opaque principal, creates the durable
 * anon-owned run + RFC 0049 `authorization.decided` audit, and delegates EVERY
 * authorize/egress/dispatch decision to `decideAnonToolCall`. It owns NO
 * authorization logic of its own — only the synthetic surface fixtures.
 *
 * HONEST-OFF: every route 404s unless `OPENWOP_ANON_ACTOR_ENABLED` (checked per
 * request, mirroring the discovery advert). The anon surface is unauthenticated by
 * construction (`PUBLIC_PATH_PREFIXES` in middleware/auth.ts), the RFC's whole point.
 *
 * @see RFCS/0132-anonymous-actor-authorization.md (§A/§C/§D) · docs/adr (host record)
 */

import { randomUUID } from 'node:crypto';
import { anonOwnerStamp } from '../host/runOwner.js';
import type { Express, Request, Response, NextFunction } from 'express';
import type { Storage } from '../storage/storage.js';
import {
  anonymousActorEnabled,
  mintAnonPrincipal,
  anonRunOwner,
  decideAnonToolCall,
  emitAnonAuthorizationDecided,
  buildRunRecord,
  ANON_SURFACE_WORKFLOW_ID,
  type AnonSeamGrant,
  type AnonRunEmit,
} from '../host/anonymousActor.js';
import { setSecret } from '../byok/secretResolver.js';
import { createLogger } from '../observability/logger.js';
import { sendError } from '../middleware/errorEnvelope.js';

const log = createLogger('routes.anonSurfaceSeam');

/** The sample tenant the two witness surfaces are scoped to. */
const SAMPLE_TENANT = 'sample-anon-tenant';

/** The planted BYOK canary in the sample tenant. An anon dispatch MUST NEVER
 *  surface this value — the read tool projects only the tenant-scoped catalog and
 *  has NO path to secrets (`actingUserId` undefined by construction). The
 *  belt-and-suspenders assert below re-verifies it never appears in a response. */
const CANARY = 'sk-openwop-anon-canary-DO-NOT-LEAK';

/**
 * The two configured witness surfaces (a deterministic, self-contained test seam):
 *   - `sample-public-widget`: a read grant (`catalog.read`) + a HITL-controlled
 *     bounded-write (`lead.capture`) + an audience-bound egress (`http.fetch` may
 *     reach only `api.sample-widget.example` — `attacker.example` is NOT in it).
 *   - `sample-uncontrolled-surface`: an UNCONTROLLED write (`lead.capture`,
 *     `control:'none'`) ⇒ every write dispatch MUST deny `anon-write-ungated`.
 */
const SURFACES: Record<string, { tenantId: string; grant: AnonSeamGrant }> = {
  'sample-public-widget': {
    tenantId: SAMPLE_TENANT,
    grant: {
      read: ['catalog.read'],
      write: [{ tool: 'lead.capture', control: 'hitl' }],
      egress: [{ tool: 'http.fetch', audience: ['api.sample-widget.example'] }],
    },
  },
  'sample-uncontrolled-surface': {
    tenantId: SAMPLE_TENANT,
    grant: {
      read: [],
      write: [{ tool: 'lead.capture', control: 'none' }],
      egress: [],
    },
  },
};

/** Plant the canary once (best-effort — a missing store must never 500 the seam;
 *  the no-secret-reach witness holds regardless, since no code path reaches it). */
let canaryPlanted = false;
async function ensureCanary(): Promise<void> {
  if (canaryPlanted) return;
  canaryPlanted = true;
  try {
    await setSecret('anon-canary', CANARY, { tenantId: SAMPLE_TENANT });
  } catch (err) {
    log.warn('anon_canary_plant_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

export function registerAnonSurfaceSeamRoutes(app: Express, deps: { storage: Storage }): void {
  const { storage } = deps;

  // GET the RFC 0078 catalog scoped to the anon session — the EXPLICIT grant only,
  // fails EMPTY on an unknown surface (never the ADR 0315 baseline). Flag off ⇒ 404.
  app.get('/v1/host/sample/anon-surface/tools', (req: Request, res: Response) => {
    if (!anonymousActorEnabled()) {
      sendError(res, 404, 'not_found', 'The anonymous-actor surface is not enabled on this host.');
      return;
    }
    const surfaceId = typeof req.query.surface === 'string' ? req.query.surface : '';
    const surface = SURFACES[surfaceId];
    if (!surface) {
      res.json({ tools: [] });
      return;
    }
    const names = [
      ...surface.grant.read,
      ...surface.grant.write.map((w) => w.tool),
      ...surface.grant.egress.map((e) => e.tool),
    ];
    res.json({ tools: names.map((name) => ({ name })) });
  });

  // POST a single anon tool dispatch — the deterministic witness of §C/§D. Creates a
  // durable anon-owned run, records the `authorization.decided` audit, and returns
  // the decision (+ result only for a granted read tool). Flag off OR unknown surface
  // ⇒ a UNIFORM 404 (the ADR 0127 publicGateway precedent — a 400 on an unknown
  // surface would leak a cross-tenant surface existence/permission oracle, exactly
  // what the hardened gateway 404s to avoid). A missing tool on a KNOWN surface is a
  // genuine malformed request (400) — the caller already named a surface it can reach,
  // so there is no existence oracle to protect there.
  app.post('/v1/host/sample/anon-surface/dispatch', async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!anonymousActorEnabled()) {
        sendError(res, 404, 'not_found', 'The anonymous-actor surface is not enabled on this host.');
        return;
      }
      const body = (req.body ?? {}) as { surface?: unknown; tool?: unknown; args?: unknown; destination?: unknown };
      const surfaceId = typeof body.surface === 'string' ? body.surface : '';
      const tool = typeof body.tool === 'string' ? body.tool : '';
      const surface = SURFACES[surfaceId];
      if (!surface) {
        // Deliberately the SAME message as the flag-off refusal above — a distinct
        // one would re-open the surface-existence oracle the uniform 404 closes.
        sendError(res, 404, 'not_found', 'The anonymous-actor surface is not enabled on this host.');
        return;
      }
      if (!tool) {
        sendError(res, 400, 'validation_error', '`tool` (non-empty string) is required.');
        return;
      }
      const args = (typeof body.args === 'object' && body.args ? body.args : undefined) as Record<string, unknown> | undefined;
      const destination = typeof body.destination === 'string' ? body.destination : undefined;

      await ensureCanary();

      // §A — the OPAQUE per-session anon principal (host-minted, non-PII).
      const principal = mintAnonPrincipal(`${surfaceId}:seam-session`);
      const now = new Date().toISOString();

      // The durable run owns the decision + audit (owner.principalKind:"anonymous").
      const run = buildRunRecord({
        workflowId: ANON_SURFACE_WORKFLOW_ID,
        tenantId: surface.tenantId,
        metadata: { principalKind: 'anonymous', anonPrincipal: principal },
        // RFC 0165 §B (ADR 0625) — the same anon principal as the Subject.
        owner: anonOwnerStamp(principal),
        now,
      });
      await storage.insertRun(run);

      const emit: AnonRunEmit = async (event) => {
        await storage.appendEvent({ eventId: randomUUID(), runId: run.runId, type: event.type, payload: event.payload, timestamp: new Date().toISOString() });
      };

      // §C — the ONE unified decision (authorize → egress → dispatch).
      const d = decideAnonToolCall({ principal, tenantId: surface.tenantId, grant: surface.grant, tool, args, destination });
      // §D — the RFC 0049 `authorization.decided` audit, attributed to the opaque principal.
      await emitAnonAuthorizationDecided(emit, d.authorization);

      const owner = anonRunOwner(run);

      // §C.2 read tier — build the tenant-scoped RFC 0078 catalog ONLY on dispatch.
      // Cross-tenant ask ⇒ omit the result entirely (fail closed). NEVER reads a
      // secret; `args.probeSecrets` is ignored (the catalog contains no secret).
      let result: unknown;
      if (d.dispatch) {
        const requestedTenant = typeof args?.tenant === 'string' ? args.tenant : undefined;
        if (!requestedTenant || requestedTenant === surface.tenantId) {
          result = {
            tenant: surface.tenantId,
            catalog: [
              ...surface.grant.read,
              ...surface.grant.write.map((w) => w.tool),
              ...surface.grant.egress.map((e) => e.tool),
            ],
          };
        }
      }

      const payload = {
        authorizationDecided: { payload: d.authorization },
        owner,
        ...(d.egress ? { egressDecided: d.egress } : {}),
        ...(d.interrupt ? { interrupt: d.interrupt } : {}),
        ...(result !== undefined ? { result } : {}),
      };

      // Belt-and-suspenders: the anon read path is fail-closed-by-construction, but
      // re-verify the canary cannot appear in ANY response before it leaves the host.
      if (JSON.stringify(payload).includes(CANARY)) {
        log.error('anon_canary_leak_detected', { surface: surfaceId, tool });
        sendError(res, 500, 'internal_error', 'An unexpected error occurred.');
        return;
      }

      res.json(payload);
    } catch (err) {
      next(err);
    }
  });
}
