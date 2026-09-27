/**
 * Developer tools (ADR 0196 — Gate B of the enterprise-posture seam).
 *
 * A ROUTE-LESS feature: it exists only to register the `developer-tools`
 * toggle that gates the frontend's engineering/inspector surfaces (the
 * network inspector, the per-turn envelope inspector, the manual-test
 * runner nav). Those surfaces read `useFeatureAccess('developer-tools')`;
 * there is no backend surface to mount, and deliberately no packs and no
 * workflow surface — this is a gating seam, not a product feature.
 *
 * Default posture: OFF — a clean / white-label install is inspector-free
 * out of the gate. On the PUBLIC DEMO the default is ON (demo-aware
 * default, ADR 0196 OQ-4 resolved): the reference deployment exists to
 * teach the wire, so its inspectors show by default. Either way a stored
 * admin override (FeatureTogglePanel) wins over the default
 * (`getEffectiveConfig`: `store.get(id) ?? def`), so an operator's choice
 * is never fought at boot — write-if-absent semantics with zero writes.
 */

import type { BackendFeature } from '../types.js';
import { demoMode } from '../../host/demoMode.js';

export const developerToolsFeature: BackendFeature = {
  id: 'developer-tools',
  // No HTTP surface — the toggle is the whole feature (see header).
  registerRoutes: () => {},
  toggleDefault: {
    id: 'developer-tools',
    label: 'Developer tools',
    description:
      // DTU-3 — a security-relevant toggle must signpost what it REVEALS, not just
      // which surfaces it adds. The network inspector shows raw request and response
      // bodies; an operator deciding whether to turn this on for a tenant is deciding
      // who can read those. Naming the surfaces alone left that implicit.
      'Engineering surfaces: the network inspector, the per-turn envelope (wire-shape) inspector, and the manual-test runner. '
      + 'The network inspector shows RAW request and response bodies for this browser session — anything the app sends or receives. '
      + 'Headers are never captured and credential-NAMED JSON fields are scrubbed best-effort, but ordinary payloads and returned '
      + 'records (customer data, documents, model output) are shown as-is, so enable it only for people who may see that data. '
      + 'OFF for a clean install; the public demo defaults ON. Showcase CONTENT is governed separately by demo mode (ADR 0196).',
    category: 'Platform',
    status: demoMode() ? 'on' : 'off',
    bucketUnit: 'tenant',
    salt: 'developer-tools',
  },
};
