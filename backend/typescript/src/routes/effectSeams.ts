/**
 * RFC 0173 §C.1 / ADR 0635 — `GET /host/effect-seams`.
 *
 * CANONICAL, NOT A TEST SEAM. This is the one endpoint in the effect-seam story
 * that is production surface: `spec/v2/facets/replay.schema.json` pins
 * `effectSeamsManifest` to the literal `/host/effect-seams`, so a host advertising
 * `replay` serves it unconditionally — not behind `OPENWOP_TEST_SEAM_ENABLED`, and
 * not only when a suite is pointed at it. Gating it would make the advertised facet
 * a path that 404s for the consumer the facet exists to inform.
 *
 * It is registered in the normal route table (unlike the conformance-seam ALIAS,
 * which must precede the routers it rewrites onto) because it is a route of its
 * own with nothing to rewrite. It answers at `/v1/host/effect-seams` and, via the
 * protocol negotiator's unversioned major-2 rewrite, at `/host/effect-seams`.
 */
import type { Express, Request, Response } from 'express';

import { SEAM_ROWS } from '../host/effectSeamManifest.js';
import { buildCommit } from '../host/buildInfo.js';

export const EFFECT_SEAMS_PATH = '/v1/host/effect-seams';

/**
 * The address the `replay.effectSeamsManifest` facet must carry.
 *
 * The v2 schema pins it as a `const` — `/host/effect-seams` — so a literal in
 * the advert would validate today and silently stop describing this route the
 * moment the route moves. Derived from the served path instead, so the claim and
 * the handler cannot drift apart. The `/v1` prefix is what the protocol
 * negotiator's unversioned major-2 rewrite strips (see the docblock above).
 */
export const V2_EFFECT_SEAMS_PATH = EFFECT_SEAMS_PATH.replace(/^\/v1/, '');

/** The manifest body, built fresh per request so the build stamp is never memoised
 *  from a previous container's value. */
export function effectSeamManifestBody(): Record<string, unknown> {
  return {
    manifestVersion: '1',
    host: {
      name: 'openwop-app',
      // `buildCommit()` returns the literal 'unknown' when the deploy was not
      // stamped. That is reported AS 'unknown' rather than omitted or faked: the
      // schema requires `id`, and a consumer reading 'unknown' learns the true
      // thing (this build cannot identify itself), where a plausible-looking
      // substitute would teach it something false.
      build: { kind: 'commit', id: buildCommit() },
    },
    seams: SEAM_ROWS,
  };
}

export function registerEffectSeamRoutes(app: Express): void {
  app.get(EFFECT_SEAMS_PATH, (_req: Request, res: Response) => {
    // No auth gate: the manifest is a self-declaration about the host's own
    // shape, carries no tenant data, and is named by a public capability facet.
    res.status(200).json(effectSeamManifestBody());
  });
}
