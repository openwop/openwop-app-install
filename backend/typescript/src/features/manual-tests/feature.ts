/**
 * Manual-test runner backend (ADR 0183) — durable per-user run persistence for the `/test`
 * runner. No toggle: the surface is admin-tier on the frontend and the routes are authed +
 * structurally self-scoped (a caller only touches their own runs). Host-extension, no wire.
 *
 * @see docs/adr/0183-manual-test-runner-feature-parity.md
 */
import type { BackendFeature } from '../types.js';
import { registerManualTestsRoutes } from './routes.js';

export const manualTestsFeature: BackendFeature = {
  id: 'manual-tests',
  registerRoutes: (deps) => registerManualTestsRoutes(deps),
};
