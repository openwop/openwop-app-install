/**
 * `assertNamespacesPopulated` — the frontend test-setup guard (called from
 * `src/test/i18n-setup.ts`) that every lazy i18n namespace a suite preloads actually
 * registered COPY. Without it a missing namespace surfaces later as "unable to find
 * text", which reads like a render bug in whatever component was under test.
 *
 * It counts KEYS rather than asking `hasResourceBundle`, because an empty bundle is
 * "registered" and still renders raw keys (case 3).
 *
 * Sabotage (wave 51 probes): a constant key count, dropping the non-object guard,
 * reporting only the first namespace, or a message without the downstream symptom
 * each red a case. The "passes" arm (no throw when all are populated) is ALSO enforced
 * by every frontend suite: `i18n-setup.ts` calls this at setup, so breaking the early
 * return reds the setup itself before any case runs (probe w51g1-ln-early: suite
 * error, not a case red). Case 1 owns the claim; the setup is its loudest consumer.
 */
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
