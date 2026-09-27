/**
 * Dynamic Sales Maps — the backend feature module (ADR 0282).
 *
 * Geographic visualization of territories (choropleth by attainment) + dealer/
 * outlet pins. The MAP itself is frontend (a CSP-safe bundled-GeoJSON SVG
 * choropleth — no external tile CDN); the backend owns only the geocoding seam +
 * cache (P2, BYOK Connection). Host-extension only — no OpenWOP RFC.
 *
 * Ships `off` (ADR 0001 §6); `bucketUnit: 'tenant'`. P1 registers only the toggle
 * (the map is composed from already-scoped territory/dealer data); the geocode
 * route lands in P2.
 *
 * @see docs/adr/0282-dynamic-sales-maps.md
 */

import type { BackendFeature } from '../types.js';
import { registerSalesMapsRoutes } from './routes.js';

export const salesMapsFeature: BackendFeature = {
  id: 'sales-maps',
  registerRoutes: (deps) => {
    registerSalesMapsRoutes(deps);
  },
  toggleDefault: {
    id: 'sales-maps',
    label: 'Dynamic Sales Maps',
    description: 'Geographic visualization — territory choropleth coloured by attainment (ADR 0272) + dealer/outlet pins (ADR 0281). CSP-safe bundled-GeoJSON SVG map with a mandatory data-table fallback.',
    category: 'Sales',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'sales-maps',
  },
  // The choropleth colours territories by attainment — works best with Territories on.
  recommends: ['territories'],
};
