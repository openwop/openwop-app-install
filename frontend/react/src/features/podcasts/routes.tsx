/**
 * Podcasts frontend feature — route + nav fragment (ADR 0086 / ADR 0001 §6).
 * Appended to FRONTEND_FEATURES; nav gated by `featureId: 'podcasts'`.
 */
import { lazy } from 'react';
import { MicIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const PodcastStudioPage = lazy(() => import('./PodcastStudioPage.js').then((m) => ({ default: m.PodcastStudioPage })));

const routes: FeatureRoute[] = [
  {
    path: '/podcasts',
    element: <PodcastStudioPage />,
    tier: 'workspace',
    nav: { group: 'Workspace', label: 'Podcasts', icon: MicIcon, hint: 'Multi-speaker audio overviews of your notebooks', featureId: 'podcasts' },
  },
];

export const podcastsFeature: FrontendFeature = { id: 'podcasts', routes };
