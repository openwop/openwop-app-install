/**
 * RFC 0095 / RFC 0120 conformance test seams — `host-sample-test-seams.md` §10.
 *
 *   POST .../connection-packs/install       { manifest }
 *   POST .../connection-packs/resolve       { provider, simulateBuiltinVersion? }
 *   POST .../connection-packs/consent-plan  { provider, requested: ('read'|'write')[] }
 *   POST .../connection-packs/egress-check  { provider, requestHost }   (RFC 0120 item 10)
 *
 * Each handler is registered at BOTH the host-namespaced product path
 * (`/v1/host/openwop-app/connection-packs/*`) AND the spec-canonical alias the
 * vendored suite drives (`/v1/host/sample/connection-packs/*`) — the same
 * product+alias posture as the RFC 0118 `dispatch/fanout` seam. The published
 * suite (`@openwop/openwop-conformance` ≥1.46.0) POSTs the `sample` path; without
 * the alias the behavioral legs soft-skip (404) instead of running.
 *
 * The seams route through the SAME validation + resolution + consent +
 * egress-matching code the production paths use (`connectionPackLoader.ts`,
 * `providerRegistry.ts`, the ADR 0024 §3 read-first/write-re-consent split, and
 * `host/connectionInjection.ts::hostMatchesApi` — the SAME eTLD+1 dot-anchored
 * matcher `brokeredEgress` pins credentialed egress with). They only supply the
 * manifest / simulated built-in / probe inputs that production sources from the
 * pack roots, the compiled-in catalog, and a live connector request.
 *
 * SECURITY: `install` registers a caller-supplied provider definition into the
 * live registry (it could re-point a provider's endpoints), and `resolve`
 * accepts a synthetic built-in — so the whole family is gated on
 * OPENWOP_TEST_SEAM_ENABLED (OFF by default), the same posture as the
 * RFC 0059 workspace cross-owner seam. `egress-check` is a pure DECISION probe —
 * it sends no credential and makes no outbound request — but it rides the same
 * gate for namespace consistency. Per `host-sample-test-seams.md`
 * §"Production safety", production deployments keep the whole family 404.
 *
 * @see spec/v1/host-sample-test-seams.md §10 (openwop monorepo)
 * @see spec/v1/connection-packs.md §Manifest clauses 2/4/6/8 + items 10–15 (RFC 0120)
 */

import type { Express, Request, Response } from 'express';
import {
  installConnectionPackManifest,
  seamResolveProvider,
} from '../features/connections/connectionPackLoader.js';
import { getProvider } from '../features/connections/providerRegistry.js';
import { hostMatchesApi } from '../host/connectionInjection.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('routes.connection-pack-seam');

/** The product (host-namespaced) + spec-canonical (suite-driven) base paths. */
const SEAM_BASES = ['/v1/host/openwop-app/connection-packs', '/v1/host/sample/connection-packs'] as const;

interface ConsentStep {
  groups: Array<{ key: string; access: 'read' | 'write' }>;
  includesWrite: boolean;
}

/** ADR 0024 §3 / RFC 0095 §B.4 — read scopes first; write groups are a
 *  SEPARATE re-consent step, never bundled into the initial authorization.
 *  Derived from the same provider-registry scope groups `mintConsentUrl` +
 *  `writeScopesOf` (oauthFlow.ts) consume. */
function planConsent(providerId: string, requested: Array<'read' | 'write'>): ConsentStep[] | null {
  const manifest = getProvider(providerId);
  if (!manifest) return null;
  const steps: ConsentStep[] = [];
  if (requested.includes('read')) {
    steps.push({
      groups: (manifest.scopes.read ?? []).map((g) => ({ key: g.key, access: 'read' as const })),
      includesWrite: false,
    });
  }
  if (requested.includes('write')) {
    steps.push({
      groups: (manifest.scopes.write ?? []).map((g) => ({ key: g.key, access: 'write' as const })),
      includesWrite: true,
    });
  }
  return steps;
}

function handleInstall(req: Request, res: Response): void {
  const body = (req.body ?? {}) as { manifest?: unknown };
  if (body.manifest === undefined || body.manifest === null || typeof body.manifest !== 'object') {
    res.status(400).json({ error: 'validation_error', details: { message: 'manifest (object) required' } });
    return;
  }
  res.status(200).json(installConnectionPackManifest(body.manifest));
}

function handleResolve(req: Request, res: Response): void {
  const body = (req.body ?? {}) as { provider?: unknown; simulateBuiltinVersion?: unknown };
  if (typeof body.provider !== 'string' || body.provider.length === 0) {
    res.status(400).json({ error: 'validation_error', details: { message: 'provider (string) required' } });
    return;
  }
  const simulate = typeof body.simulateBuiltinVersion === 'string' ? body.simulateBuiltinVersion : undefined;
  res.status(200).json(seamResolveProvider(body.provider, simulate));
}

function handleConsentPlan(req: Request, res: Response): void {
  const body = (req.body ?? {}) as { provider?: unknown; requested?: unknown };
  const requested = Array.isArray(body.requested)
    ? body.requested.filter((r): r is 'read' | 'write' => r === 'read' || r === 'write')
    : [];
  if (typeof body.provider !== 'string' || requested.length === 0) {
    res.status(400).json({
      error: 'validation_error',
      details: { message: 'provider (string) + requested (("read"|"write")[]) required' },
    });
    return;
  }
  const steps = planConsent(body.provider, requested);
  if (steps === null) {
    res.status(422).json({ error: 'connection_provider_unresolved', details: { provider: body.provider } });
    return;
  }
  res.status(200).json({ steps });
}

/**
 * RFC 0120 item 10 — the egress allow-list DECISION probe. Resolves the
 * provider's curated `apiHosts` and answers whether a credential-bearing egress
 * to `requestHost` would be PERMITTED, using the SAME `hostMatchesApi` matcher
 * `host/brokeredEgress.ts` pins with. Fails closed (`allowed:false`) for an
 * unresolved provider, a provider with no declared `apiHosts`, and any host that
 * does not match under the dot-anchored eTLD+1 rule. No credential is read and
 * no outbound request is made — it only reports the gate's verdict.
 */
function handleEgressCheck(req: Request, res: Response): void {
  const body = (req.body ?? {}) as { provider?: unknown; requestHost?: unknown };
  if (
    typeof body.provider !== 'string' || body.provider.length === 0 ||
    typeof body.requestHost !== 'string' || body.requestHost.length === 0
  ) {
    res.status(400).json({ error: 'validation_error', details: { message: 'provider (string) + requestHost (string) required' } });
    return;
  }
  const manifest = getProvider(body.provider);
  if (!manifest) {
    res.status(200).json({ allowed: false, code: 'connection_provider_unresolved' });
    return;
  }
  const apiHosts = manifest.apiHosts ?? [];
  if (apiHosts.length === 0) {
    // RFC 0120 — a provider with no declared apiHosts can reach nothing credentialed.
    res.status(200).json({ allowed: false, code: 'no_api_hosts' });
    return;
  }
  const allowed = apiHosts.some((ah) => hostMatchesApi(body.requestHost as string, ah));
  res.status(200).json(allowed ? { allowed: true } : { allowed: false, code: 'egress_host_not_allowed' });
}

export function registerConnectionPackSeamRoutes(app: Express): void {
  if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') {
    log.info('connection-pack seams disabled (set OPENWOP_TEST_SEAM_ENABLED=true to enable)');
    return;
  }
  log.warn(
    'connection-pack seams ENABLED — /v1/host/{openwop-app,sample}/connection-packs/* installs caller-supplied provider definitions. NEVER enable in production.',
  );

  for (const base of SEAM_BASES) {
    app.post(`${base}/install`, handleInstall);
    app.post(`${base}/resolve`, handleResolve);
    app.post(`${base}/consent-plan`, handleConsentPlan);
    app.post(`${base}/egress-check`, handleEgressCheck);
  }
}
