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
 * This suite is the cheap SOURCE tripwire for the participant/privileged SPLIT
 * per route table: which routes CALL a privileged helper, and (for the tables
 * routed through a local `gate` helper) that the helper itself calls
 * `requireKicktodoManage`. It does NOT drive a request. The HTTP proof that the
 * gate fires is `kicktodo-authz-http.test.ts` (every gated route: admin
 * admitted / editor 403 / toggle-off 404) and
 * `kicktodo-privileged-routes-boundary.test.ts` (sweeps EVERY creator + metrics
 * route as an editor). Unique here: a NEW `post …/challenges*` route written
 * with the open `gate` goes red in this file and nowhere else (the authz-http
 * ratchet would file it as OPEN). Grade-tests w40 (g1).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MANAGEMENT_SCOPES, BUILT_IN_ROLES, scopesForRoles } from '../src/host/accessControlService.js';
import { KICKTODO_ROUTES } from '../src/features/kicktodo-core/routes.js';
import { KICKTODO_CREATOR_ROUTES } from '../src/features/kicktodo-creator/routes.js';
import { KICKTODO_METRICS_ROUTES } from '../src/features/kicktodo-metrics/routes.js';
import { KICKTODO_COMMERCE_ROUTES } from '../src/features/kicktodo-commerce/routes.js';
import { KICKTODO_COMMUNITY_ROUTES } from '../src/features/kicktodo-community/routes.js';

describe('the privileged scope exists and is admin-class', () => {
  // TWIN: `kicktodo-authz-scope.test.ts` › "is a management scope, held by
  // admin/owner and NOT by editor/viewer" asserts the same catalog facts (and
  // resolves them through real membership). Kept here because this file is
  // protected; both go red on probe w40g1-adv-editor-gains / scope-editor-gains.
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

/** The body of a routes file's local `async function gate(req: Request)` helper.
 *  A handler that calls `await gate(req)` is only privileged if THAT helper calls
 *  `requireKicktodoManage` — the handler text alone cannot see a hollowed helper
 *  (w40 probe adv-metrics-gate-hollow stayed green before this check existed). */
const FEATURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/features');
function gateHelperBody(pkg: string): string {
  const src = readFileSync(path.join(FEATURES, pkg, 'routes.ts'), 'utf8');
  const m = /async function gate\(req: Request\)[^{]*\{([\s\S]*?)\n\}/.exec(src);
  expect(m, `${pkg}: local gate() helper not found`).not.toBeNull();
  return m![1]!;
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
    const catalog = byPath.get(`get ${'/host/openwop-app/kicktodo'}/challenges`);
    expect(catalog && handlerSource(catalog)).not.toContain('authoringGate');
  });

  // TWIN: `kicktodo-privileged-routes-boundary.test.ts` › "KTFULL-B2 — EVERY
  // Factory route refuses an editor" drives the same table over HTTP (both red on
  // w40g1-adv/bnd-creator-route-ungated). This is the source half.
  it('creator: EVERY Factory route is privileged (no participant surface exists)', () => {
    expect(gateHelperBody('kicktodo-creator')).toContain("requireKicktodoManage(req, 'kicktodo-creator'");
    expect(KICKTODO_CREATOR_ROUTES.length).toBeGreaterThan(0);
    for (const route of KICKTODO_CREATOR_ROUTES) {
      expect(handlerSource(route), `${route.method} ${route.path}`).toContain('await gate(req)');
    }
  });

  // TWIN: boundary › "KTFULL-B15 — EVERY Metrics route refuses an editor" (HTTP).
  it('metrics: every route is admin-scoped, matching what ADR 0432 documented', () => {
    expect(gateHelperBody('kicktodo-metrics')).toContain("requireKicktodoManage(req, 'kicktodo-metrics'");
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
    for (const key of ['post /host/openwop-app/kicktodo/community/reviews/resolve-flag',
                       'post /host/openwop-app/kicktodo/community/profile/decide']) {
      const route = byPath.get(key);
      expect(route, `${key} should exist`).toBeTruthy();
      expect(handlerSource(route!), `${key} must be moderator-gated`).toContain('requireKicktodoManage');
    }
    const write = byPath.get('post /host/openwop-app/kicktodo/community/reviews');
    expect(write && handlerSource(write)).not.toContain('requireKicktodoManage'); // proven buyers write reviews
  });
});
