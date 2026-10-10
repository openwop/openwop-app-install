import { lazy } from 'react';
import type { FrontendFeature } from '../registry.js';
const ShowcasePage = lazy(() => import('./ShowcasePage.js').then(m => ({ default: m.ShowcasePage })));
export const showcaseFeature: FrontendFeature = {
  id: 'showcase',
  routes: [{ path: '/showcase', element: <ShowcasePage />, tier: 'site', auth: 'optional', archetype: 'detail' }],
};
