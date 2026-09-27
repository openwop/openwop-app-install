/**
 * The workspace/org selector every org-scoped page starts with — and the three
 * states its read actually has.
 *
 * THE IDIOM THIS REPLACES, copy-pasted across 17 pages:
 *
 *     const [orgs, setOrgs] = useState<Org[] | null>(null);
 *     const [orgId, setOrgId] = useState('');
 *     useEffect(() => {
 *       void listOrgs().then((o) => { setOrgs(o); setOrgId((c) => c || (o[0]?.orgId ?? '')); })
 *         .catch(() => setOrgs([]));   // <-- here
 *     }, []);
 *     useEffect(() => { if (orgId) load(orgId); }, [orgId]);
 *
 * `[]` collapses two different facts into one value: "this tenant has no
 * workspaces" and "we could not read them". The consequence is not cosmetic,
 * because `orgs` GATES A LATER FETCH: `orgId` stays `''`, the load effect never
 * fires, and the page's own rows state stays at its initial sentinel. So the
 * failure surfaces as a permanent skeleton, or as a "No workspaces — create one
 * to …" instruction, in a state that never failed at all. Hardening the rows read
 * (which several of these pages had done, carefully) cannot catch it: THE STATE
 * THAT FAILED IS NOT THE STATE THE PAGE RENDERS.
 *
 * So the read gets a third state and the caller is handed all three. Deliberately
 * state-only, NOT a rendered component: each page's failure copy names its own
 * subject ("the widget list", "the domain list") in its own i18n namespace, and a
 * shared card would either lose that or force a prop soup. Three lines per page
 * at the top of the render is the right amount of duplication.
 *
 * CORRECTION (2026-08-05, `HG-4`) — the paragraph above is OVERTURNED, and it
 * was overturned by the exact failure it predicted. "Three lines per page" was
 * written 18 times and diverged twice over: 9 of 18 pages ended up mixing
 * "workspace" and "organization" WITHIN ONE SCREEN (three used a third noun,
 * "stores"), and the three-state BRANCH ORDER — failed above empty above
 * loading — was independently got wrong on nine surfaces, each shipping a
 * skeleton with no terminal condition or a failed read dressed as an empty
 * account. A lint rule can check a noun; only a component can encode an order.
 *
 * `ui/OrgSelectionState` now renders these three states. The prediction here
 * was half right and worth preserving: losing the per-feature subject IS what
 * happened on the first attempt — centralising dropped twelve `orgsFailedBody`
 * clauses for one generic sentence, and a review caught it. The answer was not
 * to keep duplicating; it was to give the component `emptyBody`/`failedBody`
 * slots so the feature keeps its clause and the shared frame keeps the noun.
 *
 * The fetcher is injected because each feature has its own `listOrgs` — same
 * shape, different module. That also makes this trivially testable without a
 * network seam.
 */
import { useCallback, useEffect, useState } from 'react';

/** The shape every feature's `Org` shares; extra fields ride along untouched. */
export interface OrgLike { orgId: string; name?: string }

export interface OrgSelection<T extends OrgLike> {
  /** `null` while the first read is in flight. `[]` ONLY when the read succeeded
   *  and the tenant genuinely has none — never as a failure sentinel. */
  orgs: readonly T[] | null;
  /** `''` until an org is selected. Gate dependent loads on this, as before. */
  orgId: string;
  setOrgId: (id: string) => void;
  /** The read FAILED. Check this ABOVE any loading or empty branch, or the
   *  spinner/instruction wins and the distinction is decorative. */
  orgsFailed: boolean;
  /** Re-runs the read. Must be wired to the retry control: this hook's effect is
   *  the only place the read happens, so a retry that merely clears the error
   *  would restore the permanent skeleton it exists to remove. */
  retry: () => void;
}

/**
 * @param listOrgs    the feature's own org lister
 * @param enabled     pass a feature-toggle gate to defer the read (default true)
 * @param initialOrgId a pre-selected org — a `?org=` deep link or a seeded prop.
 *   Honoured if the read confirms it exists, so a shared link lands where it
 *   says. Without this the hook would silently redirect every deep link to the
 *   first org, which is a quieter version of the same lie this hook exists to
 *   stop: showing one thing while claiming another.
 */
export function useOrgSelection<T extends OrgLike>(
  listOrgs: () => Promise<T[]>,
  enabled = true,
  initialOrgId = '',
): OrgSelection<T> {
  const [orgs, setOrgs] = useState<readonly T[] | null>(null);
  const [orgId, setOrgId] = useState(initialOrgId);
  const [orgsFailed, setOrgsFailed] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    void listOrgs()
      .then((o) => {
        if (cancelled) return;
        setOrgs(o);
        setOrgsFailed(false);
        // Keep an existing selection if it is still present, else take the first.
        setOrgId((cur) => (cur && o.some((x) => x.orgId === cur) ? cur : (o[0]?.orgId ?? '')));
      })
      .catch(() => {
        if (cancelled) return;
        // NOT `setOrgs([])`. `orgs` stays null (nothing is known) and the failure
        // gets its own flag, so the caller can tell "none" from "couldn't read".
        setOrgsFailed(true);
      });
    return () => { cancelled = true; };
    // `listOrgs` is intentionally not a dep: callers pass a module-level function,
    // and depending on it would re-fetch on every render for any caller that
    // passes an inline arrow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, reload]);

  const retry = useCallback(() => setReload((n) => n + 1), []);
  return { orgs, orgId, setOrgId, orgsFailed, retry };
}
