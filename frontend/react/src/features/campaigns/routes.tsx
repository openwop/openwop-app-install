/**
 * Campaign Studio console (ADR 0200 Phase 2) — route + nav fragment.
 *
 * One workspace destination (`/campaign-studio`) consolidating the Campaign Studio
 * chain (Briefs, Campaigns, Performance, Intelligence) into a tabbed console. The
 * page PROJECTS its tabs from the FEATURES manifest, so this module stays tiny: a
 * lazy page + a single nav entry, gated on the `campaigns` toggle (default OFF,
 * bucket `tenant`). OFF ⇒ the four campaign features keep their standalone Marketing
 * nav; ON ⇒ they collapse here.
 *
 * IMPORTANT: do NOT import `FEATURES` here — `routes.tsx` is evaluated while the
 * manifest is still being composed, so a static import would cycle. The page reads
 * the manifest at render time via its lazy import (the ModelsHubPage precedent).
 */
import { lazy } from 'react';
import { MegaphoneIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const CampaignStudioHubPage = lazy(() =>
  import('./CampaignStudioHubPage.js').then((m) => ({ default: m.CampaignStudioHubPage })),
);

const routes: FeatureRoute[] = [
  {
    path: '/campaign-studio',
    element: <CampaignStudioHubPage />,
    tier: 'workspace', archetype: 'standard-index',
    nav: {
      group: 'Marketing',
      label: 'Campaign Studio',
      labelKey: 'navLabel',
      icon: MegaphoneIcon,
      hint: 'Briefs, campaigns, performance & intelligence in one place',
      hintKey: 'navHint',
      order: 25,
      featureId: 'campaigns',
    },
  },
];

export const campaignsFeature: FrontendFeature = { id: 'campaigns', routes };
