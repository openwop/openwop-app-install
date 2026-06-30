/**
 * Compat (self-hosted / OpenAI-compatible) endpoint config routes —
 * RFC 0108 + ADR 0121, host-extension surface (NOT a feature-package, per the
 * ADR 0121 evaluation matrix — provider config that rides the BYOK/Connections
 * area).
 *
 *   GET    /v1/host/openwop-app/compat-endpoints?orgId=…    — list (workspace:read)
 *   POST   /v1/host/openwop-app/compat-endpoints            — create (workspace:write)
 *   DELETE /v1/host/openwop-app/compat-endpoints/:id        — delete (workspace:write)
 *
 * Gating: env flag `OPENWOP_COMPAT_PROVIDER_ENABLED` (default OFF). This is the
 * operator opt-in to ALLOW configuring self-hosted endpoints; it is independent of
 * the wire advertisement (`aiProviders.selfHosted[]`), which is separately gated on
 * RFC 0108 reaching Accepted (ADR 0121 Phase 0). Both default closed.
 *
 * §D: the `baseUrl` is operator-private — list/get return it ONLY to the owning org
 * over this authed route (the owner typed it); it never reaches discovery, run
 * events, or another tenant. The stored key is never returned. SSRF: a create
 * validates the base URL against the egress guard up-front (defense in depth — the
 * dispatcher re-checks).
 */
import type { Express, Request } from 'express';
import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../types.js';
import { resolveEffectiveAccess, type Scope } from '../host/accessControlService.js';
import { setSecret, removeSecret } from '../byok/secretResolver.js';
import { isDeniedWebhookHost, webhookPrivateEgressAllowed } from '../host/webhookEgressGuard.js';
import {
  getCompatEndpoint, listCompatEndpoints, putCompatEndpoint, deleteCompatEndpoint,
  type CompatEndpoint, type CompatDeclaredCapabilities,
} from '../host/compatEndpoints.js';

const BASE = '/v1/host/openwop-app/compat-endpoints';

const enabled = (): boolean => process.env.OPENWOP_COMPAT_PROVIDER_ENABLED === 'true';
const tenantOf = (req: Request): string => req.tenantId ?? '_anon';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

function reqString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new OpenwopError('validation_error', `\`${field}\` is required.`, 400, { field });
  return v.trim();
}

async function requireOrgScope(req: Request, orgId: string, scope: Scope): Promise<void> {
  const access = await resolveEffectiveAccess(tenantOf(req), { subject: actingUserOf(req), orgId });
  if (!access.scopes.includes(scope)) {
    throw new OpenwopError('forbidden_scope', `Missing required scope: ${scope}`, 403, { requiredScope: scope, orgId });
  }
}

/** Validate an operator-supplied base URL: https-only + non-private host, unless
 *  private egress is explicitly enabled (true-local dev). Errors never echo the URL (§D). */
function validateBaseUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new OpenwopError('validation_error', 'baseUrl is not a valid URL.', 400, {}); }
  const privateAllowed = webhookPrivateEgressAllowed();
  if (u.protocol !== 'https:' && !privateAllowed) {
    throw new OpenwopError('validation_error', 'baseUrl must be https (set OPENWOP_WEBHOOK_ALLOW_PRIVATE for a local endpoint).', 400, {});
  }
  if (isDeniedWebhookHost(u.hostname) && !privateAllowed) {
    throw new OpenwopError('validation_error', 'baseUrl host is not permitted (private/loopback blocked).', 400, {});
  }
  return raw.replace(/\/$/, '');
}

function parseCaps(v: unknown): CompatDeclaredCapabilities {
  const c = (v ?? {}) as Record<string, unknown>;
  return { vision: c.vision === true, tools: c.tools === true, longContext: c.longContext === true };
}

/** The owner-facing view of an endpoint (includes baseUrl for the owning org; NEVER the key). */
function publicView(e: CompatEndpoint): Omit<CompatEndpoint, 'credentialRef'> & { hasKey: boolean } {
  const { credentialRef, ...rest } = e;
  return { ...rest, hasKey: Boolean(credentialRef) };
}

export function registerCompatEndpointRoutes(app: Express): void {
  // GET — list the org's configured endpoints (workspace:read).
  app.get(BASE, async (req, res, next) => {
    try {
      if (!enabled()) throw new OpenwopError('not_found', 'compat-endpoints disabled (set OPENWOP_COMPAT_PROVIDER_ENABLED=true).', 404, {});
      const orgId = reqString(req.query.orgId, 'orgId');
      await requireOrgScope(req, orgId, 'workspace:read');
      const list = await listCompatEndpoints(tenantOf(req), orgId);
      res.json({ endpoints: list.map(publicView) });
    } catch (e) { next(e); }
  });

  // POST — create an endpoint (workspace:write). The optional key is stored via BYOK.
  app.post(BASE, async (req, res, next) => {
    try {
      if (!enabled()) throw new OpenwopError('not_found', 'compat-endpoints disabled (set OPENWOP_COMPAT_PROVIDER_ENABLED=true).', 404, {});
      const tenantId = tenantOf(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = reqString(body.orgId, 'orgId');
      await requireOrgScope(req, orgId, 'workspace:write');
      const label = reqString(body.label, 'label');
      const baseUrl = validateBaseUrl(reqString(body.baseUrl, 'baseUrl'));
      const id = `compat-${randomUUID()}`; // opaque, non-URL (§A.3)
      const now = new Date().toISOString();
      let credentialRef: string | undefined;
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
        credentialRef = `compat-key:${id}`;
        await setSecret(credentialRef, body.apiKey.trim(), { tenantId });
      }
      const endpoint: CompatEndpoint = {
        id, tenantId, orgId, label, baseUrl,
        ...(credentialRef ? { credentialRef } : {}),
        capabilities: parseCaps(body.capabilities),
        ...(Array.isArray(body.models) ? { models: body.models.filter((m): m is string => typeof m === 'string') } : {}),
        createdAt: now, updatedAt: now,
      };
      await putCompatEndpoint(endpoint);
      res.status(201).json(publicView(endpoint));
    } catch (e) { next(e); }
  });

  // DELETE — remove an endpoint + its stored key (workspace:write; IDOR-404).
  app.delete(`${BASE}/:id`, async (req, res, next) => {
    try {
      if (!enabled()) throw new OpenwopError('not_found', 'compat-endpoints disabled (set OPENWOP_COMPAT_PROVIDER_ENABLED=true).', 404, {});
      const tenantId = tenantOf(req);
      const existing = await getCompatEndpoint(tenantId, req.params.id);
      if (!existing) throw new OpenwopError('not_found', 'Compat endpoint not found.', 404, {}); // uniform 404 (no existence leak)
      await requireOrgScope(req, existing.orgId, 'workspace:write');
      if (existing.credentialRef) await removeSecret(existing.credentialRef, { tenantId });
      await deleteCompatEndpoint(tenantId, req.params.id);
      res.status(204).end();
    } catch (e) { next(e); }
  });
}
