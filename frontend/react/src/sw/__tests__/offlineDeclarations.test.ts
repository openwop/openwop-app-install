/**
 * ADR 0873 D1 — the offline declarations the BUILD reads (`offline.ts` files the
 * composed registry reaches) are exactly the ones the RUNTIME sees
 * (`FrontendFeature.offline`), and every declared navigation is owned by its
 * feature. The ownership half cannot run in the build (it needs the React route
 * modules), so this file is where it is enforced.
 *
 * CEILING (wave 51): no feature ships an `offline.ts` yet (ADR 0873 P2, "nothing
 * declaring"), so case 1's FILE-side half (each file's value set unchanged on its
 * feature) iterates nothing today; its RUNTIME-side half is live — a feature that sets
 * `offline` without the file reds it. It becomes fully live with the first P3 file.
 * DOUBLE GUARD, named: `navigationOwnershipErrors` drops a `'/'` route prefix, but
 * `'/'` + `/` = `'//'` can never prefix a navigation anyway, so the "/" case holds
 * with or without that filter (probe w51g1-od-root-filter).
 * BUILD-ONLY DECLARATIONS (P24): a file with no `entitlement` may leave the runtime
 * field unset, because the runtime reads `offline` only for `entitlement`
 * (`registry.ts` `featureRoutes` / `lastKnownEntitlementFeatureIds`) and the build
 * reads the file. That keeps a declaration out of the entry chunk. A file WITH
 * `entitlement` must still be on the runtime field, unchanged; the ownership case
 * checks the file's declaration when the runtime field is unset.
 * Sabotage: a feature declaring `offline` without its file, a file with
 * `entitlement` missing from the runtime, a runtime value differing from its file,
 * an unowned navigation (runtime or build-only), reading params as literal,
 * reversing the "below" direction, or ignoring `publicRoutes` each red a case.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRONTEND_FEATURES } from '../../features/registry.js';
import { findOfflineDeclarationFiles } from '../../../scripts/gen-service-worker.mjs';
import { declarationParityErrors, navigationOwnershipErrors, staticPrefix } from '../offlineOwnership.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FeatureOffline } from '../offlineTypes.js';

const REGISTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'features', 'registry.ts');

async function declarationsFromFiles(): Promise<Map<string, FeatureOffline>> {
  const files = findOfflineDeclarationFiles(readFileSync(REGISTRY, 'utf8'), REGISTRY);
  const out = new Map<string, FeatureOffline>();
  for (const f of files) out.set(f.id, ((await import(/* @vite-ignore */ f.file)) as { offline: FeatureOffline }).offline);
  return out;
}

describe('ADR 0873 D1 — build and runtime see the same declarations', () => {
  it('every runtime offline value is its offline.ts unchanged, and a file with an entitlement is on the runtime', async () => {
    const fromRuntime = new Map(FRONTEND_FEATURES.flatMap((f) => (f.offline ? [[f.id, f.offline] as const] : [])));
    expect(declarationParityErrors(await declarationsFromFiles(), fromRuntime)).toEqual([]);
  });

  it('every declared navigation is under one of its feature\'s own routes', async () => {
    const fromFiles = await declarationsFromFiles();
    const effective = FRONTEND_FEATURES.map((f) => {
      const offline = f.offline ?? fromFiles.get(f.id);
      return offline ? { ...f, offline } : f;
    });
    expect(effective.flatMap(navigationOwnershipErrors)).toEqual([]);
  });
});

describe('ADR 0873 D1 + P24 — declarationParityErrors', () => {
  const books: FeatureOffline = { navigations: ['/books'] };
  const gated: FeatureOffline = { navigations: ['/books'], entitlement: 'fail-closed' };

  it('accepts a build-only declaration with no entitlement', () => {
    expect(declarationParityErrors(new Map([['books', books]]), new Map())).toEqual([]);
  });

  it('accepts a runtime value that is its file', () => {
    expect(declarationParityErrors(new Map([['books', gated]]), new Map([['books', gated]]))).toEqual([]);
  });

  it('refuses a build-only declaration that sets an entitlement (the runtime would not see it)', () => {
    expect(declarationParityErrors(new Map([['books', gated]]), new Map()))
      .toEqual(['books: offline.ts sets entitlement, so FrontendFeature.offline must be set']);
  });

  it('refuses a runtime value without a file, and one that differs from its file', () => {
    expect(declarationParityErrors(new Map(), new Map([['books', books]])))
      .toEqual(['books: offline is set but the build reads no offline.ts']);
    expect(declarationParityErrors(new Map([['books', books]]), new Map([['books', { navigations: ['/books'] }]])))
      .toEqual(['books: FrontendFeature.offline is not the offline.ts value']);
  });
});

describe('ADR 0873 D4 — navigationOwnershipErrors', () => {
  const route = (path: string): FeatureRoute => ({ path, element: createElement('div'), tier: 'workspace', archetype: 'standard-index' });

  it('reads the literal prefix of a react-router path', () => {
    expect(staticPrefix('/books')).toBe('/books');
    expect(staticPrefix('/cad/:canvasId')).toBe('/cad');
    expect(staticPrefix('/cms/p/:org/:page')).toBe('/cms/p');
    expect(staticPrefix('/')).toBe('/');
    // Stops at the FIRST param: a static segment after it is not part of the prefix.
    expect(staticPrefix('/books/:id/edit')).toBe('/books');
  });

  it('accepts a navigation equal to, or below, an owned route', () => {
    const feature = { id: 'books', routes: [route('/books'), route('/book-reader/:id')], offline: { navigations: ['/books', '/books/area', '/book-reader'] } };
    expect(navigationOwnershipErrors(feature)).toEqual([]);
  });

  it('refuses a navigation outside the feature\'s routes', () => {
    const feature = { id: 'books', routes: [route('/books')], offline: { navigations: ['/crm'] } };
    expect(navigationOwnershipErrors(feature)).toEqual(['books: navigation /crm is not under one of its own routes']);
  });

  it('refuses a navigation BROADER than an owned route (it would cover other features)', () => {
    const feature = { id: 'kt', routes: [route('/admin/kicktodo')], offline: { navigations: ['/admin'] } };
    expect(navigationOwnershipErrors(feature)).toEqual(['kt: navigation /admin is not under one of its own routes']);
  });

  it('never treats a "/" route as owning everything', () => {
    const feature = { id: 'home', routes: [route('/')], offline: { navigations: ['/anything'] } };
    expect(navigationOwnershipErrors(feature)).toEqual(['home: navigation /anything is not under one of its own routes']);
  });

  it('accepts a path a publicRoutes match owns', () => {
    const feature = {
      id: 'reader', routes: [], offline: { navigations: ['/book-reader'] },
      publicRoutes: [{ match: (p: string) => p === '/book-reader', render: () => null }],
    };
    expect(navigationOwnershipErrors(feature)).toEqual([]);
  });
});
