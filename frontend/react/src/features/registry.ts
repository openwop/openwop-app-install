/**
 * Frontend feature registry (ADR 0001 §2.2).
 *
 * The single list of separately-distributed feature packages' frontend halves.
 * chrome/features.tsx composes the app's FEATURES from the core routes PLUS the
 * routes collected here — so a new feature is wired by appending its
 * FrontendFeature, never by editing the core manifest.
 *
 * Each FrontendFeature contributes route+nav entries (FeatureRoute[]); a feature
 * gates its own nav/pages on its toggle via useFeatureAccess at render time
 * (Phase 4). Empty until the first product feature (CRM) ships.
 */
import type { FeatureRoute } from '../chrome/featureTypes.js';
import { crmFeature } from './crm/routes.js';
import { csmFeature } from './csm/routes.js';
import { usersFeature } from './users/routes.js';
import { profilesFeature } from './profiles/routes.js';
import { mediaFeature } from './media/routes.js';
import { cmsFeature } from './cms/routes.js';
import { notificationsFeature } from './notifications/routes.js';
import { kbFeature } from './kb/routes.js';
import { publishingFeature } from './publishing/routes.js';
import { sharingFeature } from './sharing/routes.js';
import { formsFeature } from './forms/routes.js';
import { consentFeature } from './consent/routes.js';
import { analyticsFeature } from './analytics/routes.js';
import { connectionsFeature } from './connections/routes.js';
import { emailFeature } from './email/routes.js';
import { commentsFeature } from './comments/routes.js';

export interface FrontendFeature {
  /** Feature id — matches the backend toggle id. */
  id: string;
  /** Route + nav entries appended to the app's FEATURES manifest. */
  routes: FeatureRoute[];
}

/** Every frontend feature the app composes. Append a new feature here. */
export const FRONTEND_FEATURES: FrontendFeature[] = [crmFeature, csmFeature, usersFeature, profilesFeature, mediaFeature, cmsFeature, notificationsFeature, kbFeature, publishingFeature, sharingFeature, formsFeature, consentFeature, analyticsFeature, connectionsFeature, emailFeature, commentsFeature];

/** Flatten every feature's routes for the manifest. */
export function featureRoutes(): FeatureRoute[] {
  return FRONTEND_FEATURES.flatMap((f) => f.routes);
}
