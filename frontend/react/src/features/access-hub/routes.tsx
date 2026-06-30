/**
 * Access Hub frontend feature (ADR 0144) — route + nav fragment.
 *
 * One admin destination (`/access`) that consolidates the scattered Credentials
 * + Identity surfaces into a tabbed console. The page PROJECTS its tabs from the
 * FEATURES manifest, so this module stays tiny: a lazy page + a single nav entry,
 * gated on the `access-hub` toggle (default OFF, bucket `tenant`).
 *
 * IMPORTANT: do NOT import `FEATURES` here — `routes.tsx` is evaluated while the
 * manifest is still being composed, so a static import would cycle. The page
 * reads the manifest at render time via its lazy import (see AccessHubPage).
 */
import { lazy } from 'react';
import { LockIcon } from '../../ui/icons/index.js';
import type { FeatureRoute } from '../../chrome/featureTypes.js';
import type { FrontendFeature } from '../registry.js';

const AccessHubPage = lazy(() => import('./AccessHubPage.js').then((m) => ({ default: m.AccessHubPage })));

const routes: FeatureRoute[] = [
  {
    path: '/access',
    element: <AccessHubPage />,
    tier: 'admin',
    nav: {
      group: 'Access & data',
      label: 'Access',
      labelKey: 'accessHubLabel',
      icon: LockIcon,
      hint: 'Credentials, connections & access in one place',
      hintKey: 'accessHubHint',
      order: 0,
      // ADR 0144 §Correction (2026-06-26): graduated off its feature toggle to a
      // permanent admin surface (the Connections/Users precedent) — no featureId.
    },
  },
];

export const accessHubFeature: FrontendFeature = { id: 'access-hub', routes };
