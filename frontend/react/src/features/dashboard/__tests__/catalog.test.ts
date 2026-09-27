/**
 * Dashboard catalog invariants (ADR 0375 Phase 3 + ADR 0377 Wave 1) —
 * regression guards for the architect-review pins baked into ALL_DASHBOARD_TILES:
 *  - Every toggle-gated tile ships defaultEnabled:false (opt-in — keeps
 *    first-paint reads low).
 *  - Every Business tile is toggle-gated + default-disabled. (The ADR 0375-era
 *    "Business ⇒ admin" pin was superseded by ADR 0377's generalized rule —
 *    tile tier = the tier of the page it deep-links to — so Business tiles whose
 *    page is workspace-tier are workspace. The TIER_BY_TILE table below pins the
 *    verified page-tier mapping instead.)
 *  - Pin 4: the to-dos tile is admin-tier (its rows link to the admin-gated /boards).
 *  - Ids, order, and i18n keys are unique/consistent.
 */
import { describe, it, expect } from 'vitest';
import { ALL_DASHBOARD_TILES, defaultLayoutFrom } from '../allTiles.js';

/** ADR 0377 pin — tile tier mirrors the nav tier of the page each tile links to
 *  (verified against chrome/features.tsx + each feature's routes.tsx). A change
 *  here must follow a change to the PAGE's tier, never drift independently. */
const TIER_BY_TILE: Record<string, 'workspace' | 'admin'> = {
  'active-runs': 'workspace', 'recent-conversations': 'workspace', todos: 'admin',
  'scheduled-agents': 'workspace', 'ai-briefing': 'workspace', 'recent-documents': 'workspace', 'kicktodo-today': 'workspace', 'kicktodo-progress': 'workspace',
  'crm-pipeline': 'admin', 'commerce-summary': 'admin', 'campaign-kpis': 'admin',
  'funnel-conversion': 'admin', 'top-priorities': 'admin',
  'approvals-inbox': 'workspace', notifications: 'workspace', 'my-projects': 'workspace',
  'agent-fleet': 'workspace', 'task-deck': 'workspace', 'strategy-health': 'workspace',
  'csm-health': 'workspace', 'advisory-boards': 'workspace', 'recent-notebooks': 'workspace',
  'workforce-ops': 'admin', 'site-traffic': 'workspace', 'ai-spend': 'admin',
  'ad-spend-roas': 'workspace', commissions: 'workspace', 'model-leaderboard': 'admin',
  'live-promotions': 'workspace', 'suggested-automations': 'admin',
  'campaigns-in-flight': 'workspace', 'recent-media': 'admin', 'kb-overview': 'admin',
  'deal-registrations': 'workspace', 'bi-metric': 'workspace',
  // ADR 0377 Wave 2 — chart tiles
  'pipeline-trend': 'admin', 'funnel-daily': 'admin', 'spend-pacing': 'admin',
  'platform-performance': 'workspace', 'cost-by-model': 'admin', 'content-status': 'admin',
  'production-status': 'workspace', 'quota-attainment': 'workspace', 'health-distribution': 'workspace',
  // ADR 0377 Wave 3 — interaction types
  'quick-create': 'workspace', 'continue-working': 'workspace', 'upcoming-agenda': 'workspace',
  'team-workload': 'admin',
  // ADR 0377 Wave 4 — admin-ops health
  'connection-health': 'admin', 'plugin-health': 'admin',
  // ADR 0452 — KickTodo home tiles (participant pages are workspace-tier)
  'kicktodo-today': 'workspace', 'kicktodo-progress': 'workspace',
  'personal-note': 'workspace',
  'mentions-inbox': 'workspace',
};

describe('dashboard catalog invariants', () => {
  it('has unique tile ids and unique default orders', () => {
    const ids = ALL_DASHBOARD_TILES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const orders = ALL_DASHBOARD_TILES.map((t) => t.defaultOrder);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('every tile has a pinned tier matching its deep-link page (ADR 0377)', () => {
    for (const t of ALL_DASHBOARD_TILES) {
      expect(TIER_BY_TILE[t.id], `${t.id} missing from TIER_BY_TILE — add it with the linked page's tier`).toBeDefined();
      expect(t.requiredTier, `${t.id} tier must match its page`).toBe(TIER_BY_TILE[t.id]);
    }
  });

  it('the default-ON set is EXACTLY the pinned launchpad (everything else opt-in)', () => {
    // Home-page graduation follow-through (2026-07-16): the research-backed
    // launchpad ships default-on (5–9-element guardrail). continue-working is
    // the ONE deliberate toggle-gated default (fail-closed absent when
    // `documents` is off; ~6 first-paint reads stay far under the rate budget).
    const DEFAULT_ON = ['active-runs', 'approvals-inbox', 'continue-working', 'notifications', 'quick-create', 'recent-conversations', 'todos'];
    const on = ALL_DASHBOARD_TILES.filter((t) => t.defaultEnabled).map((t) => t.id).sort();
    expect(on).toEqual(DEFAULT_ON);
    for (const t of ALL_DASHBOARD_TILES) {
      if (t.owningFeatureToggle && !DEFAULT_ON.includes(t.id)) {
        expect(t.defaultEnabled, `${t.id} should be opt-in`).toBe(false);
      }
    }
  });

  it('every Business tile is toggle-gated and default-disabled', () => {
    const business = ALL_DASHBOARD_TILES.filter((t) => t.category === 'Business');
    expect(business.length).toBeGreaterThan(0);
    for (const t of business) {
      expect(t.owningFeatureToggle, `${t.id} toggle`).toBeTruthy();
      expect(t.defaultEnabled, `${t.id} default`).toBe(false);
    }
  });

  it('Pin 4 — the to-dos tile is admin-tier (links to the admin-gated /boards)', () => {
    const todos = ALL_DASHBOARD_TILES.find((t) => t.id === 'todos');
    expect(todos).toBeDefined();
    expect(todos!.requiredTier).toBe('admin');
    expect(todos!.owningFeatureToggle).toBeUndefined(); // /boards is core, not toggled
  });



  it('defaultLayoutFrom mirrors each tile default', () => {
    const layout = defaultLayoutFrom(ALL_DASHBOARD_TILES);
    expect(layout).toHaveLength(ALL_DASHBOARD_TILES.length);
    expect(layout[0]).toMatchObject({ id: ALL_DASHBOARD_TILES[0]!.id, enabled: ALL_DASHBOARD_TILES[0]!.defaultEnabled });
  });
});
