/**
 * ADR 0922 D2 — destination adapters by kind (the resolver-registry pattern,
 * ADR 0013). The campaign-ops services are the only callers. A destination with
 * no registered adapter cannot be added.
 */
import type { DestinationAdapter, DestinationKind } from '../types.js';
import { cmsPageAdapter } from './cmsPage.js';
import { emailTemplateAdapter } from './emailTemplate.js';

// The email adapter answers `destination_unavailable` while the tenant's `email`
// toggle is off (ADR 0922 matrix row 2), so registering it unconditionally is safe.
const adapters = new Map<DestinationKind, DestinationAdapter>([
  [cmsPageAdapter.kind, cmsPageAdapter],
  [emailTemplateAdapter.kind, emailTemplateAdapter],
]);

export function adapterFor(kind: DestinationKind): DestinationAdapter | undefined {
  return adapters.get(kind);
}
