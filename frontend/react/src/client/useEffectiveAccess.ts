/**
 * Cached React read of the CALLER's effective access (ADR 0196 Phase 4 /
 * ADM-8). One `GET /access/effective` per page load, module-cached and
 * shared by every consumer (the Sidebar admin entry, AdminLayout) so the
 * shell never fans out per-item reads (the rate-limit fan-out rule).
 *
 * This is PRESENTATION-ONLY filtering: the backend stays the authority
 * (every admin route 403s on its own — `accessControlService`). Fail-closed
 * on the UI side too: until resolved (and on any fetch error) the caller
 * reads as `basis:'none'` with no roles, so admin chrome stays hidden.
 *
 * Demo host: an anonymous visitor resolves `basis:'tenant-owner'` server-side
 * (the demo single-tenant exception), so the demo keeps its full nav.
 * Re-resolves when the signed-in identity changes.
 */
import { useEffect, useState } from 'react';
import { getEffectiveAccess, type EffectiveAccess } from './accessClient.js';
import { onAuthChange } from './config.js';

const NONE: EffectiveAccess = { roles: [], scopes: [], basis: 'none' };

let cached: EffectiveAccess | null = null;
let inflight: Promise<EffectiveAccess> | null = null;
let authSubscribed = false;
const listeners = new Set<(a: EffectiveAccess) => void>();

function resolve(): Promise<EffectiveAccess> {
  if (!inflight) {
    inflight = getEffectiveAccess()
      .catch(() => NONE) // fail-closed presentation
      .then((a) => {
        cached = a;
        for (const fn of listeners) fn(a);
        return a;
      });
  }
  return inflight;
}

/** Drop the cache (identity changed) and re-resolve for all subscribers.
 *  Subscribed ONCE at module level (lazily) — a per-hook subscription would
 *  fire N invalidations per auth change and null `inflight` N times, kicking
 *  off N redundant fetches. */
function subscribeAuthOnce(): void {
  if (authSubscribed) return;
  authSubscribed = true;
  onAuthChange(() => {
    cached = null;
    inflight = null;
    void resolve();
  });
}

/** True when the caller should see admin-tier chrome: the workspace owner, a
 *  member holding the built-in admin/owner role, OR a member whose (custom)
 *  roles grant any `host:*:manage` scope — the exact scope family the admin
 *  panels themselves check (`host:{org,members,teams,groups,roles}:manage`).
 *  Presentation only; each page's backend check remains the authority. */
export function isAdminCaller(a: EffectiveAccess): boolean {
  return (
    // The env-bound superadmin is a DIFFERENT authority from membership and was
    // never part of this predicate, so a pure superadmin (no org role) saw no
    // Admin entry while every admin route would have answered — MEASURED on a
    // white-label first bring-up, 2026-09-06. Same predicate the routes use,
    // projected by /access/effective for the caller's own resolution only.
    a.superadmin === true ||
    a.basis === 'tenant-owner' ||
    a.roles.includes('admin') ||
    a.roles.includes('owner') ||
    a.scopes.some((s) => s.startsWith('host:') && s.endsWith(':manage'))
  );
}

/**
 * True when the caller can actually CREATE an organization — i.e. the empty-org
 * state may offer "Create an organization" rather than "ask an administrator".
 *
 * Deliberately NARROWER than `isAdminCaller`, and the gap is the point: that
 * predicate admits any `host:*:manage` scope, so a member holding only
 * `host:teams:manage` reaches `/orgs` and finds the create form disabled
 * (`OrgsListPanel.tsx` gates it on `host:org:manage` alone). Offering them a CTA
 * would route them to a control they cannot use — a designed empty state naming
 * a next action nobody can take is worse than naming none.
 *
 * Presentation only; the backend remains the authority.
 */
export function canManageOrgs(a: EffectiveAccess): boolean {
  return (
    a.basis === 'tenant-owner' ||
    a.roles.includes('admin') ||
    a.roles.includes('owner') ||
    a.scopes.includes('host:org:manage')
  );
}

export function useEffectiveAccess(): EffectiveAccess {
  return useEffectiveAccessState().access;
}

/**
 * ADR 0203 — the same cached read WITH a resolved discriminator. The bare
 * hook can't distinguish "still resolving" from "resolved to none"; a page
 * gate needs that difference so first paint shows a loading state, never a
 * deny flash.
 */
export function useEffectiveAccessState(): { access: EffectiveAccess; resolved: boolean } {
  const [state, setState] = useState<{ access: EffectiveAccess; resolved: boolean }>(
    () => (cached !== null ? { access: cached, resolved: true } : { access: NONE, resolved: false }),
  );
  useEffect(() => {
    let live = true;
    const push = (a: EffectiveAccess) => { if (live) setState({ access: a, resolved: true }); };
    listeners.add(push);
    subscribeAuthOnce();
    void resolve().then(push);
    return () => { live = false; listeners.delete(push); };
  }, []);
  return state;
}

/**
 * ADR 0659 D7 (`CMNT-UX-20`) — the caller's effective access IN ONE ORG.
 *
 * The module cache above is tenant-wide and deliberately unkeyed, because the
 * chrome it feeds (the Admin entry, AdminLayout) is tenant-wide. An ORG-scoped
 * control cannot use it: `resolveEffectiveAccess` without an `orgId` takes the
 * FIRST member row for the subject in the tenant, so a person who is an editor
 * in org B and a viewer in org A would resolve as an editor while looking at
 * org A — the affordance would be live and the route would still 403.
 *
 * THREE states, and the third is the point. `null` means "not answered" — a
 * failed or unresolved access read is NOT "you lack permission", and claiming it
 * would be the §4.6 false-read shape this feature already fixed once. Callers
 * render the control LIVE while `null` (the backend is, and stays, the only
 * authority — it refuses with a typed status the UI maps to localized copy) and
 * only state a permission fact once one is known.
 *
 * One request per (org) per page load, in-flight shared, like `loadOrgMembers`
 * — N panels on one screen must not fan out N reads against the per-IP budget.
 */
/**
 * The read's outcome is a TAGGED value, not a nullable one. A bare
 * `.catch(() => null)` would hand every subscriber an absence it cannot tell
 * from "still resolving" — the failed-read sentinel family
 * (`scripts/check-failed-read-sentinels.mjs`) one level up from the empty array.
 * `{ ok: false }` says "asked, and could not be told", which is a different fact
 * from "not asked yet" even though both render the same way here.
 */
type OrgAccessResult = { ok: true; access: EffectiveAccess } | { ok: false };

const orgCache = new Map<string, EffectiveAccess>();
const orgInflight = new Map<string, Promise<OrgAccessResult>>();

export function useOrgEffectiveAccess(orgId: string): EffectiveAccess | null {
  const [state, setState] = useState<EffectiveAccess | null>(() => orgCache.get(orgId) ?? null);
  useEffect(() => {
    if (!orgId) { setState(null); return; }
    const hit = orgCache.get(orgId);
    if (hit) { setState(hit); return; }
    let live = true;
    setState(null);
    let p = orgInflight.get(orgId);
    if (!p) {
      p = getEffectiveAccess({ orgId })
        .then((a): OrgAccessResult => { orgCache.set(orgId, a); return { ok: true, access: a }; })
        .catch((): OrgAccessResult => ({ ok: false }))
        .then((r) => { orgInflight.delete(orgId); return r; });
      orgInflight.set(orgId, p);
    }
    void p.then((r) => { if (live) setState(r.ok ? r.access : null); });
    return () => { live = false; };
  }, [orgId]);
  return state;
}

/** Test seam — the org cache is module-level, so a suite that renders two orgs
 *  in one file would otherwise read the first one's answer. */
export function resetOrgEffectiveAccessCache(): void {
  orgCache.clear();
  orgInflight.clear();
}
