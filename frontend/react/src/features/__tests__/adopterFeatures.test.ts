/**
 * ADR 1031 P1/P2 — the adopter feature seam, frontend half.
 *
 * An adopter repo ships `src/adopter/features/<dir>/routes.tsx`, discovered by an
 * eager `import.meta.glob` in `features/adopterFeatures.ts`. Red under:
 *  - a module missing its `<camelDir>Feature` export being skipped instead of
 *    refused (the adopter's UI would silently vanish);
 *  - modules not taken in path order, or the export name not camel-cased;
 *  - an id that differs from its directory being REFUSED — since ADR 1031 P2 the
 *    id names the owning backend feature, so one feature may have several
 *    packages;
 *  - an adopter package attaching to a FIRST-PARTY feature id being composed (it
 *    would merge nav and tabs into a feature it does not own), or several adopter
 *    packages of one adopter id being refused;
 *  - first-party features not returned unchanged when there are no adopter ones;
 *  - a duplicate dashboard tile id being accepted (it would corrupt a persisted
 *    layout slot) or feature tiles not following the host tiles;
 *  - a feature tile not translating in its own namespace.
 *
 * Fixtures are in-memory module maps: openwop-app never commits `src/adopter/`.
 * Three checks run over the real registry and are live only in an adopter
 * checkout (vacuous in openwop-app, a recorded ceiling): the registry ends with
 * the discovered adopter features, every composed tile names its toggle, every
 * declared review renderer is registered on first lookup. ADR 1031 P3 (#5512)
 * removed first-party KickTodo, the only declarer of tiles and renderers. A stub
 * declarer that makes them live upstream is new coverage (human ask TST-GMB-H1).
 *
 * Sabotage-witnessed (w90, 2026-11-06): dropping the export check, the sort or
 * the camel-casing; adding an id-equals-directory check; loosening the first-party
 * duplicate check; refusing duplicate adopter ids; changing the no-adopter return;
 * dropping the tile-id check or reversing tile order; ignoring a tile's namespace —
 * each reds its case. Dropping registry composition or renderer registration stays
 * green upstream (the ceiling above).
 */
import { lazy } from 'react';
import { describe, expect, it } from 'vitest';
import { collectAdopterFrontendFeatures, composeFrontendFeatures, ADOPTER_FRONTEND_FEATURES } from '../adopterFeatures.js';
import { FRONTEND_FEATURES, type FrontendFeature } from '../registry.js';
import { featureDashboardTiles, featureReviewArtifactRenderers } from '../featureExtensions.js';
import { composeDashboardTiles } from '../dashboard/allTiles.js';
import type { DashboardTileDef } from '../dashboard/tileTypes.js';
import { tileNamespace } from '../dashboard/tileTypes.js';
import { getReviewArtifactRenderer } from '../../chat/reviews/reviewArtifactRenderers.js';
import { CheckSquareIcon } from '../../ui/icons/index.js';

const feat = (id: string): FrontendFeature => ({ id, routes: [] });

describe('collectAdopterFrontendFeatures', () => {
  it('an empty glob (openwop-app itself) yields no features', () => {
    expect(collectAdopterFrontendFeatures({})).toEqual([]);
  });

  it('takes each module\'s <camelId>Feature export, sorted by path', () => {
    const out = collectAdopterFrontendFeatures({
      '/src/adopter/features/zeta-thing/routes.tsx': { zetaThingFeature: feat('zeta-thing') },
      '/src/adopter/features/alpha/routes.tsx': { alphaFeature: feat('alpha') },
    });
    expect(out.map((f) => f.id)).toEqual(['alpha', 'zeta-thing']);
  });

  it('refuses a module without the convention export', () => {
    expect(() => collectAdopterFrontendFeatures({ '/src/adopter/features/alpha/routes.tsx': { other: feat('alpha') } }))
      .toThrow(/must export alphaFeature/);
  });

  it('accepts an id that is not its directory — the id names the owning backend feature (ADR 1031 P2)', () => {
    // e.g. a `acme-studio` package that is the `acme-creator` feature's frontend.
    const out = collectAdopterFrontendFeatures({ '/src/adopter/features/acme-studio/routes.tsx': { acmeStudioFeature: feat('acme-creator') } });
    expect(out.map((f) => f.id)).toEqual(['acme-creator']);
  });
});

describe('composeFrontendFeatures', () => {
  it('returns the first-party elements unchanged with no adopter features', () => {
    const fp = [feat('crm')];
    expect(composeFrontendFeatures(fp, [])).toEqual(fp);
  });

  it('refuses an adopter package that attaches to a first-party feature id', () => {
    expect(() => composeFrontendFeatures([feat('crm')], [feat('crm')])).toThrow(/duplicate adopter feature id: crm/);
  });

  it('allows several adopter packages of one adopter feature (ADR 1031 P2)', () => {
    // e.g. two packages (a participant app and its admin console) of one backend feature.
    expect(composeFrontendFeatures([feat('crm')], [feat('kick'), feat('kick')]).map((f) => f.id)).toEqual(['crm', 'kick', 'kick']);
  });

  it('the real registry ends with exactly the discovered adopter features', () => {
    // Vacuous in openwop-app (no `src/adopter/`); live in an adopter checkout.
    expect(FRONTEND_FEATURES.slice(FRONTEND_FEATURES.length - ADOPTER_FRONTEND_FEATURES.length)).toEqual(ADOPTER_FRONTEND_FEATURES);
  });
});

describe('FrontendFeature.dashboardTiles', () => {
  const tile = (id: string, ns?: string): DashboardTileDef => ({
    id, label: id, labelKey: id, descriptionKey: `${id}Desc`, icon: CheckSquareIcon, category: 'Work',
    requiredTier: 'workspace', defaultEnabled: false, defaultOrder: 900, defaultSize: 'half', resizable: false,
    component: lazy(() => import('../dashboard/tiles/PersonalNoteTile.js')),
    ...(ns ? { i18nNamespace: ns } : {}),
  });

  it('appends feature tiles after the host tiles and refuses a reused tile id', () => {
    expect(composeDashboardTiles([tile('ask')], [tile('kick-today', 'kick')]).map((t) => t.id)).toEqual(['ask', 'kick-today']);
    expect(() => composeDashboardTiles([tile('ask')], [tile('ask')])).toThrow(/duplicate dashboard tile id 'ask'/);
  });

  it('a feature tile translates in its own namespace; a host tile in `dashboard`', () => {
    expect(tileNamespace(tile('kick-today', 'kick'))).toBe('kick');
    expect(tileNamespace(tile('ask'))).toBe('dashboard');
  });

  it('every tile the composed features declare names its owning toggle', () => {
    // A feature tile with no owningFeatureToggle would stay on the grid when the
    // feature is switched off. Vacuous in openwop-app since ADR 1031 P3 (#5512)
    // removed first-party KickTodo, the only declarer; live in an adopter checkout
    // that declares tiles.
    expect(featureDashboardTiles().filter((t) => !t.owningFeatureToggle).map((t) => t.id)).toEqual([]);
  });
});

describe('FrontendFeature.reviewArtifactRenderers', () => {
  it('every declared renderer is registered by the first lookup', () => {
    // Sync declarations and the lazy `extensions.reviewArtifactRenderers` (ADR 1031 P2).
    // Vacuous in openwop-app since ADR 1031 P3 (#5512) removed first-party KickTodo,
    // the only declarer; live in an adopter checkout that declares renderers.
    for (const r of featureReviewArtifactRenderers()) {
      expect(getReviewArtifactRenderer(r.artifactTypeId), r.artifactTypeId).toBe(r.component);
    }
  });
});
