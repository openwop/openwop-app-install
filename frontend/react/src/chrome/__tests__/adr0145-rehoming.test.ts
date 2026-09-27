import { describe, it, expect } from 'vitest';
import { FEATURES } from '../features.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Toggles that were RETIRED when their feature graduated to always-on — they never
 *  appear in `/assignments`, so a `hubTab.featureId` naming one is permanently invisible.
 *  Mirrors `backend/.../features/index.ts` RETIRED_TOGGLE_IDS; the backend parity test is
 *  the authority, this is the local tripwire. */
const RETIRED_TOGGLES = new Set(['evals', 'scheduled-agent-chats', 'model-router', 'chat-widget']);
/** Ids that DO register a toggle default (enough for the models hub assertion below). */
const REGISTERED_TOGGLES = new Set(['campaign-intel', 'campaign-brief', 'campaign-connectors', 'campaign-orchestration']);
import { visibleHubRoutes, tabIdOf } from '../hubProjection.js';

/**
 * ADR 0145 — surface re-homing. Asserts the manifest wiring that consolidates
 * five scattered Platform surfaces: two new consoles project their own tabs (and
 * only their own), the legacy nav entries collapse via `hiddenWhenFeature` while
 * their routes stay reachable, and Channels / Work patterns move to their correct
 * homes. Pure manifest derivations — a manifest edit that breaks the IA is caught.
 */
const byPath = (p: string) => FEATURES.find((r) => r.path === p);

/**
 * ADR 0718 D2 — WHAT THE ROUTER ACTUALLY RENDERS for a path.
 *
 * `byPath` above is `FEATURES.find`, i.e. MANIFEST ORDER. That is not how the app
 * resolves a path: `App.tsx` selects a SITE-tier route by path BEFORE the router runs
 * (shell selection must precede routing), so a `site` claimant pre-empts an `admin` one
 * regardless of manifest order.
 *
 * The distinction was not academic. The test below used to assert
 * `byPath('/leaderboard')?.element` is truthy under the name "keeps the legacy routes
 * reachable for deep links" — and passed, because `find` returned the `evals` entry,
 * while the router renders `kicktodo-engagement`'s gamification page. A green test,
 * named for reachability, asserting it of a route that is not reachable.
 */
const resolves = (p: string) =>
  FEATURES.find((r) => r.tier === 'site' && r.path === p) ?? FEATURES.find((r) => r.path === p);
const all = (): boolean => true;

describe('ADR 0145 — Models console', () => {
  it('projects exactly Routing + Leaderboard, in order', () => {
    expect(visibleHubRoutes(FEATURES, all, true, 'models').map(tabIdOf)).toEqual(['model-router', 'leaderboard']);
  });

  // ADR 0434 — the `models` toggle graduated to always-on: it only ever chose a
  // NAV SHAPE (hub vs two standalone entries), never a capability.
  it('the /models container is admin-tier, always-on (no featureId), and is not itself a tab', () => {
    const m = byPath('/models');
    expect(m?.tier).toBe('admin');
    // A graduated feature has no assignment, so `useFeatureVisible` resolves a
    // stale featureId to NOT-visible — which would hide the hub outright.
    expect(m?.nav?.featureId).toBeUndefined();
    expect(m?.hubTab).toBeUndefined();
  });

  it('permanently subsumes the standalone Routing + Leaderboard nav (ADR 0144 precedent)', () => {
    // They drop their nav blocks rather than keep a `hiddenWhenFeature: 'models'`
    // that can never fire — otherwise the hub AND the standalone entries render.
    expect(byPath('/model-router')?.nav).toBeUndefined();
    // The EVALS entry carries no nav — but ADR 0718: it is not the entry that renders.
    // `kicktodo-engagement` also claims `/leaderboard` and DOES supply a nav entry, so
    // asserting the evals entry alone says nothing about what the rail shows.
    expect(FEATURES.find((r) => r.path === '/leaderboard' && r.ownerFeatureId === 'evals')?.nav).toBeUndefined();
  });

  it('keeps /model-router reachable for deep links (no redirect)', () => {
    expect(byPath('/model-router')?.element).toBeTruthy();
    expect(resolves('/model-router')?.ownerFeatureId).toBe('model-router');
  });

  it('ADR 0718 — /leaderboard resolves to kicktodo-engagement, NOT to the evals leaderboard', () => {
    // The corrected claim. ADR 0145 intended the legacy standalone routes to stay
    // deep-link-reachable; for `/leaderboard` that promise is NOT kept, because a second
    // feature owns the path and wins by site-tier pre-emption. Stating the truth here is
    // the point — the previous assertion was green on the false version.
    expect(resolves('/leaderboard')?.ownerFeatureId).toBe('kicktodo-engagement');
    expect(resolves('/leaderboard')?.tier).toBe('site');
  });

  it('ADR 0719 (corrects ADR 0718) — the model leaderboard is reachable via a tab that ACTUALLY RENDERS', () => {
    // ADR 0718 asserted `hubTab?.hub === 'models'` here and called it "projected into the
    // models console". That checks the DECLARATION, not the VISIBILITY — the same error
    // as the guard ADR 0718 was written to fix, committed while writing about it.
    //
    // It was also FALSE at the time: the tab declared `featureId: 'evals'`, whose toggle
    // is RETIRED, so `useFeatureVisible` filtered it out and the console rendered Routing
    // only. ADR 0718's retarget to `/models?tab=leaderboard` therefore landed users on
    // the wrong tab — right fix, wrong stated reason. ADR 0719 D1 removed the stale id.
    //
    // This asserts through the REAL projection, with `isVisible` modelling the hook:
    // an absent `featureId` is always visible; a named one must resolve.
    const isVisible = (featureId?: string): boolean => !featureId || REGISTERED_TOGGLES.has(featureId);
    const tabs = visibleHubRoutes(FEATURES, isVisible, true, 'models');
    expect(tabs.map(tabIdOf), 'BOTH tabs must survive the projection').toContain('leaderboard');
    expect(tabs.find((t) => tabIdOf(t) === 'leaderboard')?.ownerFeatureId).toBe('evals');
  });

  it('ADR 0719 — no models/chat-deployment tab is gated on a RETIRED toggle', () => {
    // The generator, not just the instance: a graduated feature has no registered toggle,
    // so naming it here filters the tab out silently. The backend owns the authoritative
    // check (`hub-tab-featureid-parity.test.ts`); this is the FE-side tripwire.
    for (const hub of ['models', 'chat-deployment'] as const) {
      const declared = FEATURES.filter((f) => f.hubTab && f.hubTab.hub === hub);
      for (const d of declared) {
        const id = d.hubTab?.featureId;
        expect(
          !id || !RETIRED_TOGGLES.has(id),
          `${hub}: tab ${d.path} is gated on '${id}', a RETIRED toggle — it will never render`,
        ).toBe(true);
      }
    }
  });

  it('ADR 0718 D1 — no inbound link sends a MODEL surface to the gamification board', () => {
    // The user-visible half. Both sites used to point at `/leaderboard`; the Arena one
    // was a BACK button, so it navigated out of the feature the user was in.
    const tile = readFileSync(join(SRC, 'features/dashboard/tiles/ModelLeaderboardTile.tsx'), 'utf8');
    const arena = readFileSync(join(SRC, 'features/evals/ArenaPage.tsx'), 'utf8');
    for (const [name, src] of [['ModelLeaderboardTile', tile], ['ArenaPage', arena]] as const) {
      expect(src, `${name} must not link to the bare /leaderboard`).not.toMatch(/to=?["'{ ]*['"]\/leaderboard['"]/);
      expect(src, `${name} must use the canonical console tab`).toContain('/models?tab=leaderboard');
    }
  });
});

describe('ADR 0145 — re-graduated tabs gate on their toggle', () => {
  // evals + scheduled-chats are toggle-gated (PR #895): their tab carries a
  // `featureId` so a disabled feature shows in NEITHER the rail nor the console.
  // The always-on surfaces (model-router, chat-widget) carry no featureId.
  // ── ADR 0719 — THESE THREE TESTS USED TO PIN THE DEFECT ────────────────────
  //
  // They asserted that the Leaderboard and Scheduled tabs are "dropped when `evals` /
  // `scheduled-agent-chats` is disabled", under the title "gates tabs/nav for
  // RE-GRADUATED surfaces only". Both premises are false and the product catalog says
  // so: FEATURES.md:206-207 record both features as "graduated off its toggle
  // 2026-06-24 — always-on", and their backends declare no `toggleDefault`.
  //
  // So there is no disabled state to drop for. What the stale `featureId` actually did
  // was make `useFeatureVisible` read an ABSENT `/assignments` entry, which is `false` —
  // filtering the tab out PERMANENTLY. The tests locked that in and read as coverage.
  //
  // Rewritten to assert the real contract, with the gating behaviour still tested
  // against a feature that genuinely IS toggle-gated.

  it('ADR 0719 — a GRADUATED surface carries no featureId, so its tab always renders', () => {
    for (const p of ['/leaderboard', '/scheduled-chats', '/model-router', '/widgets']) {
      const r = FEATURES.find((f) => f.path === p && f.hubTab);
      expect(r?.hubTab?.featureId, `${p}: a graduated feature must not name a retired toggle`).toBeUndefined();
    }
    // …and with a hook that resolves NOTHING (every id unknown), both tabs still render,
    // because an absent featureId short-circuits to visible.
    const nothingRegistered = (id?: string): boolean => !id;
    expect(visibleHubRoutes(FEATURES, nothingRegistered, true, 'models').map(tabIdOf)).toEqual(['model-router', 'leaderboard']);
    expect(visibleHubRoutes(FEATURES, nothingRegistered, true, 'chat-deployment').map(tabIdOf)).toEqual(['scheduled-chats', 'widgets']);
  });

  it('ADR 0719 — gating still works where a toggle REALLY exists (campaigns)', () => {
    // The control: removing the gating assertions entirely would leave the projection's
    // toggle filter untested. `campaign-intel` is genuinely toggle-gated.
    const off = (id?: string): boolean => !id || id !== 'campaign-intel';
    const tabs = visibleHubRoutes(FEATURES, off, true, 'campaigns').map(tabIdOf);
    expect(tabs, 'a genuinely disabled feature IS dropped').not.toContain('intel');
    expect(tabs.length, 'and the others survive').toBeGreaterThan(0);
  });

  it('ADR 0434 — the subsumed surfaces keep no standalone nav', () => {
    expect(byPath('/leaderboard')?.nav).toBeUndefined();
    expect(byPath('/model-router')?.nav).toBeUndefined();
  });
});

describe('ADR 0145 — Chat deployment console', () => {
  it('projects exactly Scheduled runs + Website widget, in order', () => {
    expect(visibleHubRoutes(FEATURES, all, true, 'chat-deployment').map(tabIdOf)).toEqual(['scheduled-chats', 'widgets']);
  });

  it('the /chat-deployment container is workspace-tier (ADR 0610 D6 / CDC-2), gated on its toggle, and is not itself a tab', () => {
    const c = byPath('/chat-deployment');
    // CDC-2: the two subsumed backend surfaces (scheduled-agent-chats, chat-widget) are
    // `workspace:write`, so the console FE tier must not over-claim `admin`. Backend stays authority.
    expect(c?.tier).toBe('workspace');
    expect(c?.nav?.featureId).toBe('chat-deployment');
    expect(c?.hubTab).toBeUndefined();
  });

  it('CDC-2 witness: a NON-admin caller sees BOTH console tabs (workspace-tier is not dropped)', () => {
    // Before ADR 0610 D6 the tabs were admin-tier, so `visibleHubRoutes(..., isAdmin=false, …)`
    // dropped them (r.tier !== 'admin' || isAdmin) — an entitled workspace:write non-admin opened
    // the console to an EMPTY tab set. Now both tabs are workspace-tier and survive the filter.
    const asNonAdmin = visibleHubRoutes(FEATURES, all, false, 'chat-deployment').map(tabIdOf);
    expect(asNonAdmin).toEqual(['scheduled-chats', 'widgets']);
    // And the subsumed routes themselves are workspace-tier, matching their backend authority.
    expect(byPath('/scheduled-chats')?.tier).toBe('workspace');
    expect(byPath('/widgets')?.tier).toBe('workspace');
  });

  it('collapses the standalone Scheduled chats + Widgets nav once enabled', () => {
    expect(byPath('/scheduled-chats')?.nav?.hiddenWhenFeature).toBe('chat-deployment');
    expect(byPath('/widgets')?.nav?.hiddenWhenFeature).toBe('chat-deployment');
  });
});

describe('ADR 0145 — consoles are isolated by the hub discriminator', () => {
  it('access / models / chat-deployment share no tabs', () => {
    const access = visibleHubRoutes(FEATURES, all, true, 'access').map(tabIdOf);
    const models = visibleHubRoutes(FEATURES, all, true, 'models').map(tabIdOf);
    const chat = visibleHubRoutes(FEATURES, all, true, 'chat-deployment').map(tabIdOf);
    const overlap = (a: string[], b: string[]): string[] => a.filter((x) => b.includes(x));
    expect(overlap(access, models)).toEqual([]);
    expect(overlap(access, chat)).toEqual([]);
    expect(overlap(models, chat)).toEqual([]);
  });
});

describe('ADR 0145 — re-filed destinations', () => {
  it('Channels redirects into the unified chat — ADR 0154 retired the standalone nav', () => {
    // ADR 0154 Phase 3 supersedes ADR 0145 §4: /channels is now a redirect shim
    // (no nav entry) — channels live in the chat Conversations rail.
    const ch = byPath('/channels');
    expect(ch?.tier).toBe('workspace');
    expect(ch?.nav).toBeUndefined();
  });

  it('Work patterns sits in the Operations group (admin-tier)', () => {
    const wp = byPath('/work-patterns');
    expect(wp?.tier).toBe('admin');
    expect(wp?.nav?.group).toBe('Operations');
  });
});
