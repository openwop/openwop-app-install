/**
 * RFC 0095 conformance test seams — `host-sample-test-seams.md` §10.
 *
 *   POST /v1/host/sample/connection-packs/install       { manifest }
 *   POST /v1/host/sample/connection-packs/resolve       { provider, simulateBuiltinVersion? }
 *   POST /v1/host/sample/connection-packs/consent-plan  { provider, requested: ('read'|'write')[] }
 *
 * The seams route through the SAME validation + resolution + consent code the
 * production install/authorize paths use (`connectionPackLoader.ts`,
 * `providerRegistry.ts`, the ADR 0024 §3 read-first/write-re-consent split) —
 * they only supply the manifest / simulated built-in that production sources
 * from the pack roots and the deployment's compiled-in catalog.
 *
 * SECURITY: `install` registers a caller-supplied provider definition into the
 * live registry (it could re-point a provider's endpoints), and `resolve`
 * accepts a synthetic built-in — so the whole family is gated on
 * OPENWOP_TEST_SEAM_ENABLED (OFF by default), the same posture as the
 * RFC 0059 workspace cross-owner seam. Per `host-sample-test-seams.md`
 * §"Production safety", production deployments keep it 404.
 *
 * @see spec/v1/host-sample-test-seams.md §10 (openwop monorepo)
 * @see spec/v1/connection-packs.md §Manifest clauses 2/4/6/8
 */

import type { Express, Request, Response } from 'express';
import {
  installConnectionPackManifest,
  seamResolveProvider,
} from '../features/connections/connectionPackLoader.js';
import { getProvider } from '../features/connections/providerRegistry.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('routes.connection-pack-seam');

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

export function registerConnectionPackSeamRoutes(app: Express): void {
  if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') {
    log.info('connection-pack seams disabled (set OPENWOP_TEST_SEAM_ENABLED=true to enable)');
    return;
  }
  log.warn(
    'connection-pack seams ENABLED — /v1/host/sample/connection-packs/* installs caller-supplied provider definitions. NEVER enable in production.',
  );

  app.post('/v1/host/sample/connection-packs/install', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { manifest?: unknown };
    if (body.manifest === undefined || body.manifest === null || typeof body.manifest !== 'object') {
      res.status(400).json({ error: 'validation_error', details: { message: 'manifest (object) required' } });
      return;
    }
    res.status(200).json(installConnectionPackManifest(body.manifest));
  });

  app.post('/v1/host/sample/connection-packs/resolve', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { provider?: unknown; simulateBuiltinVersion?: unknown };
    if (typeof body.provider !== 'string' || body.provider.length === 0) {
      res.status(400).json({ error: 'validation_error', details: { message: 'provider (string) required' } });
      return;
    }
    const simulate = typeof body.simulateBuiltinVersion === 'string' ? body.simulateBuiltinVersion : undefined;
    res.status(200).json(seamResolveProvider(body.provider, simulate));
  });

  app.post('/v1/host/sample/connection-packs/consent-plan', (req: Request, res: Response) => {
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
  });
}
