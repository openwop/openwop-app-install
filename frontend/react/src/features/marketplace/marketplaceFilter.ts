/**
 * Pure faceted-filter logic for the Marketplace browse surface — extracted from
 * MarketplacePage so the predicate + facet derivation are unit-testable (the page
 * only wires state to these). Filters compose (AND): free-text search × type ×
 * category (namespace domain) × vendor × availability status.
 */
import type { Listing } from './marketplaceClient.js';

export type PackStatus = 'installed' | 'available' | 'removed';

/** The pack's domain segment (`feature.crm.nodes` → `crm`) — the "category" facet. */
export const domainOf = (packName: string): string => {
  const parts = packName.split('.');
  return (parts.length >= 2 ? parts[1] : parts[0]) || packName;
};

/** Availability facet: a tombstoned pack reads "removed", else installed/available. */
export const statusOf = (l: Listing): PackStatus =>
  l.tombstoned ? 'removed' : l.installed ? 'installed' : 'available';

const uniqSorted = (xs: string[]): string[] =>
  Array.from(new Set(xs)).sort((a, b) => a.localeCompare(b));

export interface MarketplaceFilters {
  query: string;
  type: string;
  domain: string;
  vendor: string;
  status: '' | PackStatus;
}

export const EMPTY_FILTERS: MarketplaceFilters = { query: '', type: '', domain: '', vendor: '', status: '' };

export interface Facets {
  types: string[];
  domains: string[];
  vendors: string[];
  statuses: PackStatus[];
}

/**
 * Options derived from the loaded catalog, so a facet never offers a value that
 * matches nothing (and Status only lists states that exist — e.g. "removed" shows
 * only to superadmins who can see tombstoned packs).
 */
export const deriveFacets = (listings: readonly Listing[]): Facets => ({
  types: uniqSorted(listings.map((l) => l.category)),
  domains: uniqSorted(listings.map((l) => domainOf(l.packName))),
  vendors: uniqSorted(listings.map((l) => l.author ?? '').filter(Boolean)),
  statuses: uniqSorted(listings.map(statusOf)) as PackStatus[],
});

export const anyFilterActive = (f: MarketplaceFilters): boolean =>
  Boolean(f.query || f.type || f.domain || f.vendor || f.status);

/** Apply all active facets (AND). An empty/absent facet is a no-op. */
export const applyFilters = (listings: readonly Listing[], f: MarketplaceFilters): Listing[] => {
  const q = f.query.trim().toLowerCase();
  return listings.filter((l) => {
    if (q && !`${l.packName} ${l.title} ${l.description ?? ''} ${l.category} ${l.author ?? ''}`.toLowerCase().includes(q)) return false;
    if (f.type && l.category !== f.type) return false;
    if (f.domain && domainOf(l.packName) !== f.domain) return false;
    if (f.vendor && (l.author ?? '') !== f.vendor) return false;
    if (f.status && statusOf(l) !== f.status) return false;
    return true;
  });
};
