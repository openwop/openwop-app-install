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
 * Sabotage: a feature declaring `offline` without its file, an unowned navigation,
 * reading params as literal, reversing the "below" direction, or ignoring
 * `publicRoutes` each red a case.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRONTEND_FEATURES } from '../../features/registry.js';
import { findOfflineDeclarationFiles } from '../../../scripts/gen-service-worker.mjs';
import { navigationOwnershipErrors, staticPrefix } from '../offlineOwnership.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';

const REGISTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'features', 'registry.ts');

describe('ADR 0873 D1 — build and runtime see the same declarations', () => {
  it('every offline.ts the build reads is set, unchanged, on its FrontendFeature — and nothing else declares', async () => {
    const files = findOfflineDeclarationFiles(readFileSync(REGISTRY, 'utf8'), REGISTRY);
    const fromFiles = new Map<string, unknown>();
    for (const f of files) fromFiles.set(f.id, ((await import(/* @vite-ignore */ f.file)) as { offline: unknown }).offline);
    const fromRuntime = new Map(FRONTEND_FEATURES.filter((f) => f.offline).map((f) => [f.id, f.offline]));
    expect([...fromRuntime.keys()].sort()).toEqual([...fromFiles.keys()].sort());
    for (const [id, offline] of fromFiles) expect(fromRuntime.get(id), id).toBe(offline);
  });

  it('every declared navigation is under one of its feature\'s own routes', () => {
    expect(FRONTEND_FEATURES.flatMap(navigationOwnershipErrors)).toEqual([]);
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
