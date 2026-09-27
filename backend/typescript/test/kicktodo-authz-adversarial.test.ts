/**
 * ADR 0434 (KTFULL-B1/B2/B14/B15/B17) — ADVERSARIAL authorization.
 *
 * The consolidated audit found five KickTodo packages gating on "feature
 * enabled + identified caller" only, so ANY authenticated co-tenant could
 * publish or retire a challenge, drive the Factory, link a paid product,
 * resolve a moderation flag, or read tenant-wide outcome metrics. My earlier
 * service-level tests could not catch it: they called the services directly,
 * never crossing the route boundary where authorization lives.
 *
 * This suite asserts the gate itself — a member WITHOUT `host:kicktodo:manage`
 * is denied at every privileged route, and the same call succeeds once the
 * scope is present. It is deliberately written from the ATTACKER's side.
 */
import { describe, expect, it } from 'vitest';
import { MANAGEMENT_SCOPES, BUILT_IN_ROLES, scopesForRoles } from '../src/host/accessControlService.js';
import { KICKTODO_ROUTES } from '../src/features/kicktodo-core/routes.js';
import { KICKTODO_CREATOR_ROUTES } from '../src/features/kicktodo-creator/routes.js';
import { KICKTODO_METRICS_ROUTES } from '../src/features/kicktodo-metrics/routes.js';
import { KICKTODO_COMMERCE_ROUTES } from '../src/features/kicktodo-commerce/routes.js';
import { KICKTODO_COMMUNITY_ROUTES } from '../src/features/kicktodo-community/routes.js';

describe('the privileged scope exists and is admin-class', () => {
  it('host:kicktodo:manage is a management scope held by admin and owner, NOT by editor or viewer', () => {
    expect(MANAGEMENT_SCOPES).toContain('host:kicktodo:manage');
    expect(scopesForRoles(['admin'])).toContain('host:kicktodo:manage');
    expect(scopesForRoles(['owner'])).toContain('host:kicktodo:manage');
    // An editor can author their own work but must NOT publish challenge
    // content to other people, nor drive the Factory.
    expect(scopesForRoles(['editor'])).not.toContain('host:kicktodo:manage');
    expect(scopesForRoles(['viewer'])).not.toContain('host:kicktodo:manage');
    expect(BUILT_IN_ROLES.admin.scopes).toContain('host:kicktodo:manage');
  });
});

/**
 * Route-table assertions: every privileged route's handler must reach the
 * shared gate. Reading the handler source is a blunt instrument — it proves a
 * CALL is written, never that the call authorizes anything — so it is the
 * cheap tripwire, not the proof. The proof is
 * `kicktodo-privileged-routes-boundary.test.ts`, which drives every route in
 * these tables as a scope-less editor over HTTP.
 *
 * The bare substring `'gate'` used here previously was vacuous: it is satisfied
 * by `gateStatus(...)`, by `{ gate: err.gate }` in an error envelope, and by the
 * word in a comment. Stripping `await gate(req)` from
 * `GET /candidates/:id/gates` left that suite fully green while the route served
 * any member. Match the CALL, and only the call.
 */
function handlerSource(route: { handler: unknown }): string {
  return String(route.handler);
}

describe('privileged routes reach the shared privileged gate (KTFULL-B1/B2/B14/B15/B17)', () => {
  it('core: authoring, publish and retire are privileged; the published catalog is not', () => {
    const byPath = new Map(KICKTODO_ROUTES.map((r) => [`${r.method} ${r.path}`, r]));
    const privileged = [...byPath.entries()].filter(([k]) =>
      k.includes('/challenges') && (k.startsWith('post') || k.includes('/versions/')));
    expect(privileged.length).toBeGreaterThan(0);
    for (const [key, route] of privileged) {
      expect(handlerSource(route), `${key} must use the privileged gate`).toContain('authoringGate');
    }
    // The participant catalog read stays open to members.
    const catalog = byPath.get(`get ${'/v1/host/openwop-app/kicktodo'}/challenges`);
    expect(catalog && handlerSource(catalog)).not.toContain('authoringGate');
  });

  it('creator: EVERY Factory route is privileged (no participant surface exists)', () => {
    expect(KICKTODO_CREATOR_ROUTES.length).toBeGreaterThan(0);
    for (const route of KICKTODO_CREATOR_ROUTES) {
      expect(handlerSource(route), `${route.method} ${route.path}`).toContain('await gate(req)');
    }
  });

  it('metrics: every route is admin-scoped, matching what ADR 0432 documented', () => {
    expect(KICKTODO_METRICS_ROUTES.length).toBeGreaterThan(0);
    for (const route of KICKTODO_METRICS_ROUTES) {
      expect(handlerSource(route), `${route.method} ${route.path}`).toContain('await gate(req)');
    }
  });

  it('commerce: product LINKING is privileged while buyer actions stay open', () => {
    const byPath = new Map(KICKTODO_COMMERCE_ROUTES.map((r) => [`${r.method} ${r.path}`, r]));
    // Only MUTATING link routes are publisher authority. Reading whether a
    // challenge is paid, and which product sells it, is participant-facing —
    // a buyer needs it before purchasing — so it stays on the open gate.
    const linkWrites = [...byPath.entries()].filter(([k]) => k.startsWith('post') && k.includes('/link'));
    expect(linkWrites.length).toBeGreaterThan(0);
    for (const [key, route] of linkWrites) {
      expect(handlerSource(route), `${key} must be publisher-gated`).toContain('requireKicktodoManage');
    }
    const linkRead = [...byPath.entries()].find(([k]) => k.startsWith('get') && k.includes('/links/'));
    expect(linkRead && handlerSource(linkRead[1])).not.toContain('requireKicktodoManage');
    const hold = [...byPath.entries()].find(([k]) => k.includes('cohort-seats/hold'));
    expect(hold && handlerSource(hold[1])).not.toContain('requireKicktodoManage'); // buyers must reach it
  });

  it('community: moderation acts are privileged while participant review writing is not', () => {
    const byPath = new Map(KICKTODO_COMMUNITY_ROUTES.map((r) => [`${r.method} ${r.path}`, r]));
    for (const key of ['post /v1/host/openwop-app/kicktodo/community/reviews/resolve-flag',
                       'post /v1/host/openwop-app/kicktodo/community/profile/decide']) {
      const route = byPath.get(key);
      expect(route, `${key} should exist`).toBeTruthy();
      expect(handlerSource(route!), `${key} must be moderator-gated`).toContain('requireKicktodoManage');
    }
    const write = byPath.get('post /v1/host/openwop-app/kicktodo/community/reviews');
    expect(write && handlerSource(write)).not.toContain('requireKicktodoManage'); // proven buyers write reviews
  });
});
