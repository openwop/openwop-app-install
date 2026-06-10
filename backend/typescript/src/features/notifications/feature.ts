/**
 * Notifications (ADR 0010) — the existing notifications subsystem, MIGRATED into
 * the feature-package architecture (ADR 0001). This is a faithful wrap, not a
 * rewrite: the same emit seam, routes, web-push, storage, and UI keep working.
 *
 * The feature OWNS its infra now (the emit-backend install + web-push config,
 * moved off `index.ts`) and toggle-gates its read surface. The toggle is
 * **default ON** (ADR 0001 §6 — a pre-existing surface is seeded on, so no
 * deployment loses the bell on upgrade).
 *
 * @see docs/adr/0010-notifications.md
 */

import type { Request } from 'express';
import type { BackendFeature } from '../types.js';
import { requireFeatureEnabled } from '../featureRoute.js';
import { ensureNotificationEmitterInstalled } from '../../bootstrap/notifications.js';
import { configureWebPush } from '../../notifications/webPush.js';
import { registerNotificationRoutes } from '../../routes/notifications.js';
import { registerPushSubscriptionRoutes } from '../../routes/pushSubscriptions.js';
import { registerNotificationPreferenceRoutes } from './preferencesRoutes.js';

const TOGGLE_ID = 'notifications';
// Gate the WHOLE notifications surface. A string `app.use('/v1/host/sample/
// notifications')` only matches at a `/` boundary, which would LEAK the
// `…notifications:mark-all-read` colon-sub-resource past the gate. This regex
// matches the base followed by `/`, `:`, or end-of-path — so the inbox, SSE,
// push, preferences, AND mark-all-read all 404 when the toggle is off.
const SURFACE_RE = /^\/v1\/host\/sample\/notifications(?:[/:]|$)/;

export const notificationsFeature: BackendFeature = {
  id: TOGGLE_ID,
  registerRoutes: (deps) => {
    const { app, storage } = deps;

    // The feature owns its infra (moved off index.ts): the run-lifecycle emit
    // backend + Web-Push. Core stays decoupled — it emits via setNotificationBackend.
    //
    // NOTE (deferred, ADR 0010 §"Open questions" → "Emit gating when the toggle
    // is OFF"): the emit backend is installed unconditionally, so the toggle
    // gates only the READ surface (this file's middleware), NOT emit. A tenant
    // with notifications OFF still accumulates rows from run events. That's
    // acceptable under the default-ON rollout (few tenants disable it), but a
    // tenant that disables it long-term grows unbounded unread rows — resolving
    // it needs toggle resolution on the hot emit path (weighed against its cost)
    // plus a pruning story. Tracked in the ADR; do NOT silently "fix" by gating
    // emit here without that cost analysis.
    ensureNotificationEmitterInstalled(storage);
    configureWebPush();

    // Toggle-gate the whole notifications surface (inbox, SSE, push, prefs) —
    // backend authority: a tenant with the feature off gets 404, never the
    // surface. A PATHLESS middleware that tests `req.path` itself, NOT
    // `app.use(prefix)`: Express's mount matching enforces a path-SEGMENT
    // boundary, so a prefix gate (string OR regex) would leak the
    // `…notifications:mark-all-read` colon sub-resource past it. Registered
    // BEFORE the route handlers so it runs first.
    app.use(async (req: Request, _res, next) => {
      if (!SURFACE_RE.test(req.path)) { next(); return; }
      try {
        await requireFeatureEnabled(req, TOGGLE_ID, 'Notifications');
        next();
      } catch (err) {
        next(err);
      }
    });

    // The preserved surface (unchanged registrars) + the Phase-2 durable
    // preferences API.
    registerNotificationRoutes(app, { storage });
    registerPushSubscriptionRoutes(app, { storage });
    registerNotificationPreferenceRoutes(app);
  },
  toggleDefault: {
    id: TOGGLE_ID,
    label: 'Notifications',
    description: 'In-app inbox + bell, SSE live feed, Web-Push (VAPID), and durable per-user preferences. Migrated into the feature architecture (ADR 0010); default ON so no deployment loses the surface.',
    category: 'Platform',
    status: 'on', // pre-existing surface — seeded ON (ADR 0001 §6)
    bucketUnit: 'tenant',
    salt: 'notifications',
  },
};
