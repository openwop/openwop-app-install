/**
 * `/open-app` (APP_HOME_ENTRY, `chrome/appHome.ts`) exists only in the app shell,
 * and nothing else claims it: it is a reserved path.
 *
 * "Open app" links there when `VITE_BRAND_APP_HOME_PATH` is set, and the entry
 * needs the toggle provider, which only the app shell mounts. If any public
 * matcher above the app shell also claimed `/open-app`, App.tsx would render that
 * public page instead and the visitor would never reach the app. These read the
 * real manifest and the real matchers App.tsx uses to pick the public shell.
 *
 * Sabotage-witnessed: removing the `/open-app` route from the dashboard manifest, or
 * giving it a `site` tier, turns the first case red.
 */
import { describe, it, expect } from 'vitest';
import { matchPath } from 'react-router-dom';
import { FEATURES, featureFor } from '../features.js';
import { FRONTEND_FEATURES } from '../../features/registry.js';
import { APP_HOME_ENTRY } from '../appHome.js';
import { matchSharedToken } from '../../features/sharing/shareRoute.js';
import { matchPresentRemoteToken } from '../../canvas/presentRemoteRoute.js';
import { matchFormFillId } from '../../features/forms/fillRoute.js';
import { matchFunnelView } from '../../features/funnels/viewer/viewRoute.js';
import { matchBookSlug, matchBookManage } from '../../features/crm/bookRoute.js';
import { matchSignToken } from '../../features/crm/signRoute.js';
import { matchPublicPageSlug } from '../../features/site/publicPageRoute.js';
import { matchBlogRoute } from '../../features/site/blogRoute.js';
import { matchPricingRoute } from '../../features/site/pricingRoute.js';
import { matchPrivacyRoute } from '../../features/site/privacyRoute.js';
import { matchDocsIndex, matchDocsSlug } from '../../features/docs/docsRoute.js';
import { matchStoreOrgId } from '../../features/commerce/storeRoute.js';
import { matchPodcastView } from '../../features/podcasts/podcastRoute.js';
import { matchVerifyToken } from '../../features/job-search/verifyRoute.js';

describe('the /open-app entry is an app-shell route only, reserved', () => {
  it('the manifest registers it once, workspace tier, owned by the dashboard', () => {
    expect(APP_HOME_ENTRY).toBe('/open-app');
    const hits = FEATURES.filter((f) => f.path === APP_HOME_ENTRY);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.tier).toBe('workspace');
    expect(featureFor(APP_HOME_ENTRY)?.path).toBe(APP_HOME_ENTRY);
  });

  it('no site-tier route or feature public route matches it', () => {
    expect(FEATURES.filter((f) => f.tier === 'site' && matchPath({ path: f.path, end: true }, APP_HOME_ENTRY) !== null)).toHaveLength(0);
    expect(FRONTEND_FEATURES.flatMap((f) => f.publicRoutes ?? []).filter((r) => r.match(APP_HOME_ENTRY))).toHaveLength(0);
  });

  it.each<[string, (p: string) => unknown]>([
    ['matchSharedToken', matchSharedToken],
    ['matchPresentRemoteToken', matchPresentRemoteToken],
    ['matchFormFillId', matchFormFillId],
    ['matchFunnelView', matchFunnelView],
    ['matchBookSlug', matchBookSlug],
    ['matchBookManage', matchBookManage],
    ['matchSignToken', matchSignToken],
    ['matchPublicPageSlug', matchPublicPageSlug],
    ['matchBlogRoute', matchBlogRoute],
    ['matchPricingRoute', matchPricingRoute],
    ['matchPrivacyRoute', matchPrivacyRoute],
    ['matchDocsIndex', matchDocsIndex],
    ['matchDocsSlug', matchDocsSlug],
    ['matchStoreOrgId', matchStoreOrgId],
    ['matchPodcastView', matchPodcastView],
    ['matchVerifyToken', matchVerifyToken],
  ])('%s does not claim /open-app', (_name, match) => {
    expect(match(APP_HOME_ENTRY) || null).toBeNull();
  });
});
