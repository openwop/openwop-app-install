/**
 * The ONE `useFeatureAccess` return value for tests.
 *
 * `useFeatureAccess` returns EIGHT fields (`FeatureAccessContext.tsx`):
 * `status`, `enabled`, `isBeta`, `variant`, `entitled`, `locked`, `loading`,
 * `resolutionFailed`.
 * Across the suite its mock was hand-written ~40 times and returned one, two,
 * four, or five of them — four of those under a comment reading "Mirror the real
 * shape", which is what makes this worth a module rather than a lint rule. A
 * hand-rolled literal cannot be wrong about a field it never mentions; it can
 * only be SILENT about it, and a silent field reads as `undefined`, which reads
 * as falsy, which is an answer.
 *
 * That is not hypothetical. `useFeatureAccess` returning an OBJECT — while nine
 * pages did `const enabled = useFeatureAccess(id)` and then `if (!enabled)` —
 * shipped to production because the mocks agreed with the pages: a mock that
 * returns `true`, or `{ enabled: true }`, never disagrees with a page that mis-
 * reads the shape. And a mock that omits `loading` cannot fail a page that has
 * no `access.loading` branch, because `undefined` is exactly the value that
 * branch would have skipped anyway. `scheduled-chats` shipped that second
 * defect, and its one-field mock is why nothing was red.
 *
 * So the factory is TYPED as the hook's own return type. A field added to
 * `FeatureAccess` breaks this file — one place — instead of being silently
 * absent from forty call sites.
 *
 * Defaults are the ENABLED, RESOLVED, ENTITLED case, because that is what the
 * overwhelming majority of tests want as their baseline; every field is
 * overridable, and the interesting states are the ones worth spelling out at the
 * call site:
 *
 *     makeFeatureAccess()                       // on, resolved, entitled
 *     makeFeatureAccess({ loading: true })      // toggle UNRESOLVED — `enabled`
 *                                               //   is the fallback false, and a
 *                                               //   page without a loading branch
 *                                               //   renders its "not enabled" card
 *     makeFeatureAccess({ enabled: false, status: 'off' })
 *     makeFeatureAccess({ locked: true, entitled: false })   // ADR 0419 paywall
 *
 * NOTE for adopters: prefer the `importOriginal` spread when mocking the module
 * (`{ ...orig, useFeatureAccess: () => makeFeatureAccess() }`). A bare factory
 * drops every sibling export — `EntitlementGuard`, `useAllFeatureAccess`,
 * `isFeatureVisible` — and the day the page's import graph reaches for one it
 * gets `undefined`, a failure that looks nothing like its cause.
 */
import type { FeatureAccess } from '../FeatureAccessContext.js';

/** Exactly what `useFeatureAccess` returns — the eight fields, no more, no less. */
export type FeatureAccessResult = FeatureAccess & { loading: boolean; resolutionFailed: boolean };

/**
 * Three fields are DERIVED when the caller does not name them, because the real
 * hook derives them and a mock that contradicts itself is a fixture nobody can
 * trust:
 *
 *   - `status` follows `enabled` (`enabled ? 'on' : 'off'`) — which is what a
 *     dozen of the hand-rolled mocks already wrote by hand. Without it,
 *     `makeFeatureAccess({ enabled: false })` would answer `status: 'on'`, a
 *     combination the resolver cannot produce.
 *   - `isBeta` is `status === 'beta' && enabled`, verbatim from the hook.
 *   - `locked` is `enabled && !entitled` (ADR 0419: the toggle is on but the
 *     plan does not entitle it), verbatim from the hook.
 *
 * Anything explicitly passed wins, so a test that wants an impossible shape can
 * still ask for one — deliberately, and visibly at the call site.
 *
 * `loading: false` is likewise deliberate and load-bearing: the default must be
 * a RESOLVED answer, so a test that cares about the unresolved state has to say
 * so rather than inherit it from a mock that forgot the field.
 */
export function makeFeatureAccess(over: Partial<FeatureAccessResult> = {}): FeatureAccessResult {
  const enabled = over.enabled ?? true;
  const status = over.status ?? (enabled ? 'on' : 'off');
  const entitled = over.entitled ?? true;
  return {
    status,
    enabled,
    isBeta: over.isBeta ?? (status === 'beta' && enabled),
    variant: over.variant ?? null,
    entitled,
    locked: over.locked ?? (enabled && !entitled),
    loading: over.loading ?? false,
    // TWIN-UX-1 (failed-read leg) — the default is a resolution that WORKED; a
    // test probing the failed-read state must say `resolutionFailed: true`.
    resolutionFailed: over.resolutionFailed ?? false,
  };
}
