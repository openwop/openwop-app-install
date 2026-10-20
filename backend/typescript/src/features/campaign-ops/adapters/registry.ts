/**
 * ADR 0922 D2 — destination adapters by kind (the resolver-registry pattern,
 * ADR 0013). The campaign-ops services are the only callers. A destination with
 * no registered adapter cannot be added.
 */
import type { DestinationAdapter, DestinationKind } from '../types.js';
import { cmsPageAdapter } from './cmsPage.js';

const adapters = new Map<DestinationKind, DestinationAdapter>([[cmsPageAdapter.kind, cmsPageAdapter]]);

export function adapterFor(kind: DestinationKind): DestinationAdapter | undefined {
  return adapters.get(kind);
}
