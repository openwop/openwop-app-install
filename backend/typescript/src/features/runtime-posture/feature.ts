/**
 * ADR 0742 — Runtime posture (warm / cold) admin surface. Superadmin only,
 * read-only against Cloud Run: it reads the live posture and issues audited
 * change requests; it never applies one.
 *
 * Always-on (no toggle): off Cloud Run it reports "unavailable", so there is no
 * risk surface to gate.
 *
 * @see docs/adr/0742-runtime-posture-admin.md
 */
import type { BackendFeature } from '../types.js';
import { registerRuntimePostureRoutes } from './routes.js';

export const runtimePostureFeature: BackendFeature = {
  id: 'runtime-posture',
  registerRoutes: (deps) => registerRuntimePostureRoutes(deps),
};
