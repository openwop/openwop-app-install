import { lazy } from 'react';

// P4 continuation — this page's walkthrough spotlight (lazy chunk, boot-eager trigger).
void import('../../walkthroughs/pageSpotlight.js').then((m) => m.registerPageSpotlight('cms.page.view', '/cms', 'cms.page'));
import { FileTextIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CmsPage = lazy(() => import('./CmsPage.js').then((m) => ({ default: m.CmsPage })));

// ADR 0027: CMS is always-on (no `featureId`) and lives in the admin-tier
// 'Content' group (back-office content tooling), not the main workspace rail.
const routes: FeatureRoute[] = [
  {
    // Deep-linkable detail: /cms/p/:orgId/:pageId opens that page's editor
    // (scope in the URL so a shared link is self-contained). Same component.
    path: '/cms/p/:routeOrgId/:routePageId',
    element: <CmsPage />,
    tier: 'admin', archetype: 'admin',
  },
  // ADR 0592 §2 (CMSLU-1) — the TRANSLATOR surface. ADR 0205 D1 grants a
  // plain member locale-scoped overlay rights, but /cms is admin-tier behind
  // AdminLayout, so the grantee could never reach the editor that honors
  // their grant (built-but-unreachable). These workspace-tier routes render
  // the SAME CmsPage in a narrowed translator mode (one editor, two chrome
  // contexts — never a second editor component). Presentation-only: the
  // server's grant narrowing stays the authority; a member with NO grant
  // gets an honest empty state, never widened access.
  {
    path: '/cms/translate/:routeOrgId/:routePageId',
    element: <CmsPage translatorSurface />,
    tier: 'workspace', archetype: 'detail',
  },
  {
    path: '/cms/translate',
    element: <CmsPage translatorSurface />,
    tier: 'workspace', archetype: 'standard-index',
    // Toggle-gated nav (`cms-localization`): the item shows only where the
    // feature is on; per-user grant state is the PAGE's job (empty state).
    // 'Studio' — the workspace content-authoring cluster ('Content' is the
    // ADMIN-tier group; a workspace item there would mint a stray group).
    nav: {
      group: 'Studio',
      label: 'Translations', labelKey: 'cmsTranslateLabel',
      icon: FileTextIcon,
      hint: 'Translate page content you were granted', hintKey: 'cmsTranslateHint',
      order: 21,
      featureId: 'cms-localization',
    },
  },
  {
    path: '/cms',
    element: <CmsPage />,
    tier: 'admin', archetype: 'admin',
    nav: {
      group: 'Content',
      label: 'CMS', labelKey: 'cmsLabel',
      icon: FileTextIcon,
      hint: 'Pages + page builder', hintKey: 'cmsHint',
      order: 20,
    },
  },
];

export const cmsFeature: FrontendFeature = { id: 'cms', routes };
