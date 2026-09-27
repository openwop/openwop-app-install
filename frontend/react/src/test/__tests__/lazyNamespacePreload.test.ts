import { describe, expect, it } from 'vitest';

import {
  assertNamespacesPopulated,
  findUnpopulatedNamespaces,
  type ResourceBundleReader,
} from '../lazyNamespacePreload.js';

/** A stand-in for the i18next instance, so the failing arms are reachable. */
function readerOf(bundles: Record<string, unknown>): ResourceBundleReader {
  return { getResourceBundle: (_lng, ns) => bundles[ns] };
}

describe('lazy-namespace preload check', () => {
  it('passes when every namespace resolved copy', () => {
    const reader = readerOf({ projects: { title: 'Projects' }, crm: { title: 'CRM' } });
    expect(findUnpopulatedNamespaces(reader, ['projects', 'crm'])).toEqual([]);
    expect(() => assertNamespacesPopulated(reader, ['projects', 'crm'])).not.toThrow();
  });

  it('names a namespace that never registered at all', () => {
    const reader = readerOf({ crm: { title: 'CRM' } }); // `projects` absent
    expect(findUnpopulatedNamespaces(reader, ['projects', 'crm'])).toEqual(['projects']);
    expect(() => assertNamespacesPopulated(reader, ['projects', 'crm']))
      .toThrow(/did not register: projects/);
  });

  // The arm `hasResourceBundle` would have PASSED — the bundle exists, the copy
  // does not, and `t()` goes on returning the raw key. This is the whole reason
  // the check counts keys rather than asking whether a bundle is present.
  it('names a namespace registered as an EMPTY bundle', () => {
    const reader = readerOf({ projects: {}, crm: { title: 'CRM' } });
    expect(findUnpopulatedNamespaces(reader, ['projects', 'crm'])).toEqual(['projects']);
    expect(() => assertNamespacesPopulated(reader, ['projects', 'crm']))
      .toThrow(/did not register: projects/);
  });

  it('names every unpopulated namespace, not just the first', () => {
    const reader = readerOf({ projects: {}, crm: { title: 'CRM' }, billing: undefined });
    expect(() => assertNamespacesPopulated(reader, ['projects', 'crm', 'billing']))
      .toThrow(/did not register: projects, billing/);
  });

  it('treats a non-object bundle as unpopulated rather than crashing', () => {
    const reader = readerOf({ projects: 'not-a-bundle' });
    expect(findUnpopulatedNamespaces(reader, ['projects'])).toEqual(['projects']);
  });

  it('explains the misleading downstream symptom in the message', () => {
    const reader = readerOf({});
    expect(() => assertNamespacesPopulated(reader, ['projects']))
      .toThrow(/reads like a render bug/);
  });
});
