/**
 * P4-continuation coverage — every page-spotlight triple (core spec + the
 * feature-routed literals) registers a resolvable action. The backend half
 * pins each builtin def to the same actionIds.
 */
import { describe, it, expect } from 'vitest';
import { registerPageSpotlight } from '../pageSpotlight.js';
import { CORE_PAGE_SPOTLIGHTS } from '../corePageSpotlights.js';
import { getWalkthroughAction, __resetWalkthroughRegistryForTests } from '../actionRegistry.js';

const FEATURE_SPOTLIGHTS: ReadonlyArray<readonly [string, string, string]> = [
  ['inbox.page.view', '/inbox', 'inbox.page'],
  ['projects.page.view', '/projects', 'projects.page'],
  ['media.page.view', '/media', 'media.page'],
  ['cms.page.view', '/cms', 'cms.page'],
  ['publishing.page.view', '/publishing', 'publishing.page'],
  ['users.page.view', '/users', 'users.page'],
  ['connections.page.view', '/connections', 'connections.page'],
];

describe('page spotlights (P4 continuation)', () => {
  it('all core + feature triples register resolvable actions', () => {
    __resetWalkthroughRegistryForTests();
    for (const [a, r, anchor] of [...CORE_PAGE_SPOTLIGHTS, ...FEATURE_SPOTLIGHTS]) registerPageSpotlight(a, r, anchor);
    for (const [a] of [...CORE_PAGE_SPOTLIGHTS, ...FEATURE_SPOTLIGHTS]) expect(getWalkthroughAction(a), a).toBeTruthy();
    expect(CORE_PAGE_SPOTLIGHTS.length + FEATURE_SPOTLIGHTS.length).toBe(18);
  });
});
