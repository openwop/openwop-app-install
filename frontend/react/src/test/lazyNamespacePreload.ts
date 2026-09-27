/**
 * The preload assertion used by `i18n-setup.ts`, extracted so it can be tested.
 *
 * It lives in its own module for one reason: `i18n-setup.ts` is a `setupFiles`
 * entry whose import has side effects (it bootstraps i18next and awaits every
 * lazy catalog). A test importing it to exercise the check would re-run that
 * bootstrap and could only ever observe the real, passing catalogs — which is
 * to say, it could not test the failing arm at all. The predicate here takes
 * its reader as a parameter, so both arms are reachable from a unit test.
 */

/** The one method of i18next this check needs. Narrow on purpose. */
export interface ResourceBundleReader {
  getResourceBundle(lng: string, ns: string): unknown;
}

/**
 * Count a bundle's keys, treating anything that is not a populated object as
 * empty. Deliberately NOT `hasResourceBundle`: that returns TRUE for a bundle
 * registered as `{}`, which is exactly the failure this check exists to catch
 * — bundle "there", copy absent, `t()` still returning the raw key. Verified
 * against i18next rather than assumed.
 */
function bundleKeyCount(bundle: unknown): number {
  if (bundle === null || typeof bundle !== 'object') return 0;
  return Object.keys(bundle).length;
}

/** Namespaces that resolved no copy, in the order given. */
export function findUnpopulatedNamespaces(
  reader: ResourceBundleReader,
  namespaces: readonly string[],
  lng = 'en',
): string[] {
  return namespaces.filter((ns) => bundleKeyCount(reader.getResourceBundle(lng, ns)) === 0);
}

/**
 * Throw naming every namespace that did not register copy.
 *
 * The message matters as much as the check: the symptom downstream is an
 * assertion failing with "unable to find text", which reads like a render bug
 * in whichever file happened to assert on copy first. Naming the namespace
 * here is what stops that misdiagnosis.
 */
export function assertNamespacesPopulated(
  reader: ResourceBundleReader,
  namespaces: readonly string[],
  lng = 'en',
): void {
  const missing = findUnpopulatedNamespaces(reader, namespaces, lng);
  if (missing.length === 0) return;
  throw new Error(
    `i18n test preload incomplete — these lazy namespaces did not register: ${missing.join(', ')}. `
    + 'Any assertion on their copy would fail as "unable to find text", which reads like a render bug.',
  );
}
