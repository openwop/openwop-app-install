/**
 * GC-1 / KTH-4 — the HTTP half of the KickTodo authz proof (ADR 0506; extended
 * to EVERY `requireKicktodoManage` route by H52, ADR 0554 §P3 recipe).
 *
 * Proves the `host:kicktodo:manage` gate FIRES over a real request — on every
 * route that claims it — not that the handler's source contains a gate. The
 * SCOPE half (the scope is admin-class in the resolver) lives in
 * `kicktodo-authz-scope.test.ts`; this file is the boundary half: authz + toggle
 * gating are only observable at the HTTP boundary (tracker row KTH-4).
 *
 * WHY THIS WAS OPEN SINCE 2026-07-19. The row concluded a route test was
 * impossible: `User` is keyed `(tenantId, principalId)` (ADR 0003), so
 * `test/login` mints a different `userId` per workspace, `callerSubject` returns
 * it, and therefore "a `createMember(subject)` registration cannot be made to
 * match it from the outside". An attempted seam change was written and reverted.
 *
 * The premise is right and the conclusion does not follow. `userIdFor` is a PURE
 * HASH of exactly the two values a test already controls:
 *
 *     user:${sha256(`${tenantId}:${principalId}`).slice(0, 32)}
 *
 * So the caller's subject is DERIVABLE BEFORE the session exists. Provision
 * membership under that value first, then log in, and `auth.ts`'s per-request
 * re-validation (`isWorkspaceMember(session.userId, ws)`) finds a real member
 * instead of falling back to the personal tenant. No identity-model change, no
 * new auth parameter, and — deliberately — no change to `authTestSeam.ts`.
 *
 * That last point is the security one. The row's other exit was a seam that
 * mints a session bound to an arbitrary existing member row; that is an
 * impersonation primitive on a PRE-AUTH route guarded only by an env var
 * (`authTestSeam.ts:34`). Deriving the subject needs none of it.
 *
 * THE RECIPE (ADR 0554 §P3, three measured corrections — each of which first
 * produced a green-but-meaningless leg):
 *   1. log in with `sharedWorkspace: true` — otherwise the seam collapses
 *      `personalTenant` onto the tenant, `isOwnPersonalWorkspace` goes true, and
 *      the scope gate short-circuits BEFORE it consults membership;
 *   2. membership must be in the workspace-ROOT org (`orgId === tenantId`) —
 *      `isWorkspaceMember` matches on that; any other org leaves `auth.ts`
 *      bouncing the session to the personal tenant, where the route 404s;
 *   3. the member row must EXIST BEFORE login — membership is evaluated at
 *      session mint (here: derive the subject with `userIdFor`, create, log in).
 *
 * WHAT EACH ROW PROVES, per gated route (one fixture, one loop):
 *   admin      → NOT 401/403 (200/201/204/400/404/409… all fine: the GATE admitted;
 *                the handler's own validation of an empty body is not the claim);
 *   editor     → EXACTLY 403 (the gate refused a real, in-workspace member);
 *   non-member → ≥ 400 (fail-closed; measured 404 — a non-member is bounced to the
 *                personal tenant by `middleware/auth.ts` where the feature is off,
 *                so the refusal is the auth layer's, not the scope gate's — see
 *                the note at `authTestSeam.ts` "under sharedWorkspace a NON-member
 *                is bounced");
 *   toggle OFF → EXACTLY 404 (an admin in a workspace where the feature is not
 *                enabled: `requireKicktodoManage` runs `requireFeatureEnabled`
 *                FIRST, and a disabled feature is "does not exist").
 *
 * THE RATCHET: the GATED table is checked against the routes SOURCE — every
 * `*_ROUTES` entry whose handler calls a manage-gating helper must have a row,
 * every row must correspond to such an entry, and the OPEN table must contain
 * no gated route. A new `gate(req)`/`requireKicktodoManage(req…)` call site
 * without a proof row goes red HERE, before any HTTP test runs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { enableTenantOverride } from '../src/host/featureToggles/service.js';
import { KICKTODO_CIRCLES_ROUTES } from '../src/features/kicktodo-accountability/routes.js';
import { KICKTODO_COMMUNITY_ROUTES } from '../src/features/kicktodo-community/routes.js';
import { KICKTODO_COMMERCE_ROUTES } from '../src/features/kicktodo-commerce/routes.js';
import { KICKTODO_ROUTES } from '../src/features/kicktodo-core/routes.js';
import { KICKTODO_CREATOR_ROUTES } from '../src/features/kicktodo-creator/routes.js';
import { KICKTODO_METRICS_ROUTES } from '../src/features/kicktodo-metrics/routes.js';
import { KICKTODO_ORG_ROUTES } from '../src/features/kicktodo-organizations/routes.js';
import { CHALLENGE_OUTLINE_BASE_PATH } from '../src/features/kicktodo-creator/outlineDoc.js';

// ---------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
/** `family` ties a row to how its route is registered, for the ratchet:
 *  `array`   — an entry of an exported `*_ROUTES` table (source-checked 1:1);
 *  `inline`  — an `app.<verb>(...)` registered outside the table with an inline
 *              `requireKicktodoManage(` (creator `/author`);
 *  `chassis` — a canvas-editor chassis verb gated through the `authorize:` hook
 *              (ADR 0458 grade-pass B1; the challenge-outline canvas type). */
type Row = { method: Method; path: string; family: 'array' | 'inline' | 'chassis'; body?: unknown };

const K = '/v1/host/openwop-app/kicktodo';
const OUTLINE_ORG = `${CHALLENGE_OUTLINE_BASE_PATH}/orgs/:orgId`;

const A = (method: Method, p: string, body?: unknown): Row => ({ method, path: p, family: 'array', ...(body !== undefined ? { body } : {}) });

/** Every route that MUST refuse an editor with 403 — the manage-gated surface. */
const GATED: ReadonlyArray<Row> = [
  // kicktodo-accountability (1) — Factory seat reconciliation on a circle
  A('POST', `${K}/circles/:id/reconcile-seats`),
  // kicktodo-community (2) — moderation decisions
  A('POST', `${K}/community/profile/decide`),
  A('POST', `${K}/community/reviews/resolve-flag`),
  // kicktodo-commerce (13) — entitlement links, share policy/ledger, payouts
  A('POST', `${K}/entitlements/cohort-seats/link`),
  A('POST', `${K}/entitlements/links`),
  A('GET', `${K}/entitlements/links`),
  A('DELETE', `${K}/entitlements/links/:productId`),
  A('POST', `${K}/entitlements/reconcile`),
  A('GET', `${K}/entitlements/share-policy`),
  A('POST', `${K}/entitlements/share-policy`),
  A('GET', `${K}/entitlements/share-ledger`),
  A('GET', `${K}/entitlements/payout-runs`),
  A('POST', `${K}/entitlements/payout-runs`),
  A('POST', `${K}/entitlements/payout-runs/confirm`),
  A('POST', `${K}/entitlements/payout-runs/cancel`),
  A('GET', `${K}/entitlements/share-ledger.csv`),
  // kicktodo-core (6) — the AUTHORING family (`authoringGate`)
  A('GET', `${K}/admin/exceptions`),
  A('GET', `${K}/admin/exceptions/audit`),
  A('POST', `${K}/challenges`),
  A('GET', `${K}/challenges/:id/versions/:version`),
  A('POST', `${K}/challenges/:id/versions/:version/publish`),
  A('POST', `${K}/challenges/:id/versions/:version/retire`),
  // kicktodo-creator (16 table + 1 inline + chassis) — the Factory has NO participant surface
  A('POST', `${K}/creator/candidates`),
  A('GET', `${K}/creator/candidates`),
  A('GET', `${K}/creator/needs-you`),
  A('GET', `${K}/creator/candidates/:id`),
  A('POST', `${K}/creator/candidates/:id/research`),
  A('POST', `${K}/creator/candidates/:id/submit-publication`),
  A('POST', `${K}/creator/candidates/:id/complete-publication`),
  A('GET', `${K}/creator/candidates/:id/publication`),
  A('GET', `${K}/creator/candidates/:id/gates`),
  A('GET', `${K}/creator/candidates/:id/simulation`),
  A('GET', `${K}/creator/candidates/:id/lessons`),
  A('POST', `${K}/creator/candidates/:id/monitor`),
  A('GET', `${K}/creator/candidates/:id/monitor`),
  A('POST', `${K}/creator/candidates/:id/kill`),
  A('POST', `${K}/creator/candidates/:id/outline`),
  A('POST', `${K}/creator/candidates/:id/outline/apply`),
  { method: 'GET', path: `${K}/creator/author`, family: 'inline' },
  { method: 'GET', path: `${OUTLINE_ORG}/catalog`, family: 'chassis' },
  { method: 'POST', path: `${OUTLINE_ORG}/canvases/from-artifact`, family: 'chassis' },
  { method: 'POST', path: `${OUTLINE_ORG}/canvases/:canvasId/present-remote`, family: 'chassis' },
  { method: 'GET', path: `${OUTLINE_ORG}/canvases/:canvasId`, family: 'chassis' },
  { method: 'PATCH', path: `${OUTLINE_ORG}/canvases/:canvasId`, family: 'chassis' },
  { method: 'DELETE', path: `${OUTLINE_ORG}/canvases/:canvasId`, family: 'chassis' },
  { method: 'GET', path: `${OUTLINE_ORG}/canvases/:canvasId/versions`, family: 'chassis' },
  { method: 'GET', path: `${OUTLINE_ORG}/canvases/:canvasId/versions/:versionId`, family: 'chassis' },
  { method: 'POST', path: `${OUTLINE_ORG}/canvases/:canvasId/versions/:versionId/restore`, family: 'chassis' },
  // kicktodo-metrics (5) — tenant-wide outcome metrics are an administrative view (KTFULL-B17)
  A('GET', `${K}/metrics/activation`),
  A('GET', `${K}/metrics/engagement`),
  A('GET', `${K}/metrics/factory`),
  A('POST', `${K}/metrics/verifier-sample`),
  A('GET', `${K}/metrics/verifier-quality`),
  // kicktodo-organizations (1) — the tenant people directory
  A('GET', `${K}/org-programs/admin/people`),
];

/** KTH-4 participant routes that MUST stay OPEN to a plain member — pinned as
 *  200 for an editor, so "open by design" is asserted, not assumed. Bare GETs
 *  only: a POST needs a body/resource and its 4xx would not distinguish "open"
 *  from "gated". */
const OPEN: ReadonlyArray<{ method: 'GET'; path: string; query?: string; editor?: number }> = [
  { method: 'GET', path: `${K}/catalog` },
  { method: 'GET', path: `${K}/challenges` },
  { method: 'GET', path: `${K}/enrollments` },
  { method: 'GET', path: `${K}/today` },
  { method: 'GET', path: `${K}/plan`, query: '?from=2026-01-01&to=2026-01-07' },
  { method: 'GET', path: `${K}/journal` },
  { method: 'GET', path: `${K}/kickbot` },
  { method: 'GET', path: `${K}/circles` },
  { method: 'GET', path: `${K}/community/profile` },
  { method: 'GET', path: `${K}/entitlements/mine` },
  { method: 'GET', path: `${K}/entitlements/my-earnings` },
  // KTH-4 names `cohort-seats/*`: the by-product read is participant-open; the
  // probe product does not exist, so the OPEN proof is the resource 404 (the
  // gate admitted and the handler looked), never a 403.
  { method: 'GET', path: `${K}/entitlements/cohort-seats/:productId`, editor: 404 },
];

// ---------------------------------------------------------------------------
// The ratchet — table ↔ routes source
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FEATURES = path.resolve(HERE, '../src/features');
const ROUTE_TABLES: ReadonlyArray<{ pkg: string; routes: ReadonlyArray<{ method: string; path: string }> }> = [
  { pkg: 'kicktodo-accountability', routes: KICKTODO_CIRCLES_ROUTES },
  { pkg: 'kicktodo-community', routes: KICKTODO_COMMUNITY_ROUTES },
  { pkg: 'kicktodo-commerce', routes: KICKTODO_COMMERCE_ROUTES },
  { pkg: 'kicktodo-core', routes: KICKTODO_ROUTES },
  { pkg: 'kicktodo-creator', routes: KICKTODO_CREATOR_ROUTES },
  { pkg: 'kicktodo-metrics', routes: KICKTODO_METRICS_ROUTES },
  { pkg: 'kicktodo-organizations', routes: KICKTODO_ORG_ROUTES },
];

const key = (method: string, p: string): string => `${method.toUpperCase()} ${p}`;

/** Static read of one routes file: which `*_ROUTES` entries call a manage-gating
 *  helper (`requireKicktodoManage` itself, or a local `async function x(req)`
 *  whose body calls it — `gate`, `authoringGate`, `payoutGate`), plus the
 *  out-of-table call sites after the array. */
function analyseRoutesSource(pkg: string): { gatedByIndex: boolean[]; methods: string[]; tailInline: number; tailAuthorize: number; total: number } {
  const src = readFileSync(path.join(FEATURES, pkg, 'routes.ts'), 'utf8');
  const helperRe = /async function (\w+)\(req: Request\)[^{]*\{([\s\S]*?)\n\}/g;
  const helpers: string[] = [];
  for (const m of src.matchAll(helperRe)) if (m[2]!.includes('requireKicktodoManage(')) helpers.push(m[1]!);
  const gatingCall = new RegExp(`\\b(?:requireKicktodoManage|${helpers.join('|') || 'NEVER_MATCHES_ANY_HELPER'})\\(req\\b`);
  const arrayStart = src.search(/export const \w+_ROUTES: ReadonlyArray/);
  const arrayEnd = src.indexOf('\n];', arrayStart);
  expect(arrayStart, `${pkg}: routes table not found`).toBeGreaterThan(-1);
  expect(arrayEnd, `${pkg}: routes table end not found`).toBeGreaterThan(arrayStart);
  const table = src.slice(arrayStart, arrayEnd);
  // An entry opens with `{` on its own line, then (optional comment lines) `method:`.
  const entryRe = /\n  \{\n(?:\s*\/\/[^\n]*\n)*\s*method: '(get|post|put|patch|delete)',\n/g;
  const entries = [...table.matchAll(entryRe)];
  const gatedByIndex = entries.map((m, i) => {
    const span = table.slice(m.index!, i + 1 < entries.length ? entries[i + 1]!.index! : table.length);
    return gatingCall.test(span);
  });
  const tail = src.slice(arrayEnd);
  const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
  return {
    gatedByIndex,
    methods: entries.map((m) => m[1]!.toUpperCase()),
    tailInline: count(tail, /await requireKicktodoManage\(req/g),
    tailAuthorize: count(tail, /\bauthorize: \(req\) => requireKicktodoManage\(/g),
    total: count(src, /requireKicktodoManage\(/g),
  };
}

describe('KTH-4 ratchet — the GATED/OPEN tables match the routes source', () => {
  it('every `*_ROUTES` entry that calls a manage-gating helper has a GATED row, and vice versa', () => {
    const expectedGated = new Set<string>();
    const expectedOpen = new Set<string>();
    let totalCallSites = 0;
    const tails: Record<string, { inline: number; authorize: number }> = {};
    for (const { pkg, routes } of ROUTE_TABLES) {
      const a = analyseRoutesSource(pkg);
      totalCallSites += a.total;
      tails[pkg] = { inline: a.tailInline, authorize: a.tailAuthorize };
      // The static parse and the runtime table must describe the SAME entries, in
      // order — otherwise the parse drifted from the file shape and proves nothing.
      expect(a.methods, `${pkg}: static parse ↔ runtime table drift`).toEqual(routes.map((r) => r.method.toUpperCase()));
      routes.forEach((r, i) => (a.gatedByIndex[i] ? expectedGated : expectedOpen).add(key(r.method, r.path)));
    }
    const rows = GATED.filter((r) => r.family === 'array').map((r) => key(r.method, r.path));
    expect(new Set(rows).size, 'duplicate GATED rows').toBe(rows.length);
    // Set equality both ways, with readable diffs on a miss.
    expect([...expectedGated].filter((k) => !rows.includes(k)), 'gated in SOURCE but missing a proof row — add it to GATED').toEqual([]);
    expect(rows.filter((k) => !expectedGated.has(k)), 'GATED row with no gating call in SOURCE — a phantom proof').toEqual([]);
    // OPEN rows must be real ungated table entries (so "open by design" is a
    // claim about the source, and gating one of them later goes red here).
    for (const o of OPEN) expect(expectedOpen.has(key(o.method, o.path)), `OPEN row is not an ungated table entry: ${o.path}`).toBe(true);
    // Out-of-table call sites: ONLY creator's inline `/author` + ONE `authorize:`
    // (the challenge-outline chassis). Any other file growing one goes red.
    for (const { pkg } of ROUTE_TABLES) {
      const want = pkg === 'kicktodo-creator' ? { inline: 1, authorize: 1 } : { inline: 0, authorize: 0 };
      expect(tails[pkg], `${pkg}: out-of-table manage call sites changed — extend GATED (family inline/chassis) then update this`).toEqual(want);
    }
    expect(GATED.filter((r) => r.family === 'inline')).toHaveLength(1);
    // The chassis: every verb `canvasEditorRoutes.ts` registers under `${ORG}/…`
    // MINUS the blank-create POST (registered only under `cfg.blankState`, which
    // the challenge-outline type deliberately does not declare).
    const chassis = readFileSync(path.join(FEATURES, 'canvasEditorRoutes.ts'), 'utf8');
    const chassisVerbs = (chassis.match(/app\.(get|post|patch|delete)\(`\$\{ORG\}\//g) ?? []).length;
    const creatorSrc = readFileSync(path.join(FEATURES, 'kicktodo-creator/routes.ts'), 'utf8');
    const declaresBlank = /registerCanvasEditorRoutes\(deps, \{[\s\S]*?blankState:/.test(creatorSrc);
    expect(GATED.filter((r) => r.family === 'chassis'), 'chassis rows ≠ chassis verbs').toHaveLength(chassisVerbs - (declaresBlank ? 0 : 1));
    // The top-line pin — every `requireKicktodoManage(` CALL in the seven files
    // (comments and imports don't match the paren): accountability 1 inline,
    // community 2 inline, commerce 1 helper (`payoutGate`) + 8 inline, core 1
    // helper (`authoringGate`), creator 1 helper (`gate`) + 1 inline (`/author`)
    // + 1 `authorize:`, metrics 1 helper, organizations 1 inline = 18. Bump it
    // WITH the table, never alone.
    expect(totalCallSites, 'requireKicktodoManage( call-site count moved — did the GATED table move with it?').toBe(20);
  });
});

// ---------------------------------------------------------------------------
// The HTTP proof
// ---------------------------------------------------------------------------

let server: Server;
let BASE = '';
const CANDIDATES = `${K}/creator/candidates`;
const TOGGLES = ['kicktodo-accountability', 'kicktodo-community', 'kicktodo-commerce', 'commerce-connect',
  'kicktodo-core', 'kicktodo-creator', 'kicktodo-metrics', 'kicktodo-organizations'] as const;

/** Log in through the test seam and return the session cookie. */
async function login(subject: string, tenantId: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // `sharedWorkspace: true` — WS is somebody else's workspace that this caller
    // is (or is not) a member of, NOT their home tenant. Without it the seam
    // collapses personal onto active, `isOwnPersonalWorkspace` goes true, and the
    // scope gate short-circuits before it ever consults membership — which is
    // precisely the GC-1 defect that made these refusals unprovable.
    body: JSON.stringify({ subject, tenantId, displayName: subject, sharedWorkspace: true }),
  });
  expect(res.status, 'test seam must mint a session').toBeLessThan(300);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

let WS = '';
let WS_OFF = '';
const ADMIN = 'oidc:gc1-admin';
const EDITOR = 'oidc:gc1-editor';
const OUTSIDER = 'oidc:gc1-outsider';
const ADMIN_OFF = 'oidc:gc1-admin-off';
/** The production-path pair (chassis rows only — see `loginViaSwitch`). */
const ADMIN_P = 'oidc:gc1-admin-prod';
const EDITOR_P = 'oidc:gc1-editor-prod';
const cookies: Record<string, string> = {};

/**
 * The PRODUCTION identity path — sign in to the personal tenant, become a
 * member under the HOME `userId`, then `/workspaces/:id/switch` (which re-mints
 * the cookie with active = WS, personal preserved). Used for the CHASSIS rows
 * only, and here is the measured reason (H52): `canvasEditorRoutes` runs
 * `authorizeOrgScope` → `requireOrgScope` BEFORE the per-type `authorize:` hook,
 * and `requireOrgScope` keys the member lookup on `resolveCallerUser(req).userId`
 * — the canonical HOME-tenant user — while `requireKicktodoManage` keys on
 * `callerSubject(req)` (`req.userId`). Under the derive recipe above the seam
 * mints a WS-keyed session user (`upsertFromPrincipal({ tenantId: WS })`), so the
 * two disagree, `requireOrgScope` finds no member row and 403s the ADMIN — and
 * an editor's 403 on a chassis route would then be the ORG gate's, not the
 * manage hook's: a green-but-meaningless leg. In production the two agree (the
 * session user IS the home user; `orgscope-shared-workspace.test.ts`), so the
 * production path is the honest fixture for a route that stacks both gates.
 */
async function loginViaSwitch(subject: string, roles: string[]): Promise<string> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, displayName: subject }), // NO tenantId: personal tenant, as OIDC leaves you
  });
  expect(res.status, 'test seam must mint a personal session').toBeLessThan(300);
  const personalCookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const { user } = (await res.json()) as { user: { userId: string } };
  await createMember({ orgId: WS, tenantId: WS, displayName: subject, subject: user.userId, roles });
  const sw = await fetch(`${BASE}/v1/host/openwop-app/workspaces/${encodeURIComponent(WS)}/switch`, {
    method: 'POST', headers: { cookie: personalCookie },
  });
  expect(sw.status, `switch into WS must succeed: ${await sw.clone().text()}`).toBe(200);
  return (sw.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

/** `:orgId` → the workspace-root org (`orgId === tenantId`, a `ws:…` id — hence
 *  a single callback pass: a naive second `/:\w+/` sweep would eat the `ws:`
 *  colon); every other param → a value that exists nowhere. */
function fill(p: string, ws: string): string {
  return p.replace(/:(\w+)/g, (_m, name: string) => (name === 'orgId' ? ws : 'h52-missing'));
}
async function call(cookie: string, row: { method: Method; path: string; body?: unknown; query?: string }, ws: string): Promise<Response> {
  const init: RequestInit = { method: row.method, headers: { cookie } };
  if (row.method !== 'GET') init.headers = { ...init.headers, 'content-type': 'application/json' };
  if (row.method !== 'GET') init.body = JSON.stringify(row.body ?? {});
  return fetch(`${BASE}${fill(row.path, ws)}${row.query ?? ''}`, init);
}

beforeAll(async () => {
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });

  const ws = await createWorkspace({ name: 'GC-1 workspace', ownerSubject: 'oidc:gc1-owner' });
  WS = ws.orgId ?? ws.tenantId;
  const off = await createWorkspace({ name: 'GC-1 workspace (features OFF)', ownerSubject: 'oidc:gc1-owner-off' });
  WS_OFF = off.orgId ?? off.tenantId;

  // THE MOVE THE ROW MISSED: derive each caller's future `userId` and register
  // membership under it BEFORE the session exists. Ordering matters — a member
  // created after login is created against the wrong (personal) tenant.
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Admin', subject: userIdFor(WS, ADMIN), roles: ['admin'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: userIdFor(WS, EDITOR), roles: ['editor'] });
  await createMember({ orgId: WS_OFF, tenantId: WS_OFF, displayName: 'Admin (off)', subject: userIdFor(WS_OFF, ADMIN_OFF), roles: ['admin'] });

  // The FEATURE gate runs BEFORE the scope gate (`requireKicktodoManage` calls
  // `requireFeatureEnabled` first), and a disabled feature 404s. Without this,
  // every assertion below would pass on a 404 and prove nothing about the SCOPE
  // — the admin case would fail loudly, but the two refusal cases would go green
  // for entirely the wrong reason. Enable every KickTodo toggle in WS (and
  // commerce-connect, which `payoutGate` additionally requires) so the 403s are
  // real; WS_OFF stays at the compiled default (`status: 'off'` for all eight).
  for (const t of TOGGLES) await enableTenantOverride(t, WS, 'gc1-test');

  cookies[ADMIN] = await login(ADMIN, WS);
  cookies[EDITOR] = await login(EDITOR, WS);
  cookies[OUTSIDER] = await login(OUTSIDER, WS);
  cookies[ADMIN_OFF] = await login(ADMIN_OFF, WS_OFF);
  cookies[ADMIN_P] = await loginViaSwitch(ADMIN_P, ['admin']);
  cookies[EDITOR_P] = await loginViaSwitch(EDITOR_P, ['editor']);
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
});

describe('GC-1 — the kicktodo manage gate over HTTP', () => {
  it('the workspace session is REAL — in `ws:`, membership-derived, not the personal tenant', async () => {
    // The precondition every row below depends on, asserted separately so a
    // fixture failure reads as ITSELF rather than as 52 confusing 403/404s.
    // Two halves, each of which caught a green-but-meaningless leg once:
    //  - admin 404 ⇒ the caller was BOUNCED to the personal tenant (membership
    //    not found at mint — wrong org, or member row created after login);
    //  - editor 200 ⇒ the caller is the implicit PERSONAL owner — the seam
    //    collapsed personal onto active (`sharedWorkspace: true` missing), so
    //    the gate short-circuited without consulting membership at all.
    const admin = await call(cookies[ADMIN]!, { method: 'GET', path: CANDIDATES }, WS);
    expect(admin.status, 'a fallback to the personal tenant shows up as 404').toBe(200);
    const editor = await call(cookies[EDITOR]!, { method: 'GET', path: CANDIDATES }, WS);
    expect(editor.status, 'editor admitted ⇒ personal-owner collapse: `sharedWorkspace: true` is not in effect').toBe(403);
  });

  it('a NON-MEMBER is refused — fail-closed', async () => {
    // No member row: auth falls back to this caller's personal tenant, where it
    // holds no kicktodo authority. Refusal either way, which is the point.
    const res = await call(cookies[OUTSIDER]!, { method: 'GET', path: CANDIDATES }, WS);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  describe.each(GATED.map((r) => [key(r.method, r.path), r] as const))('%s', (_label, row) => {
    // Chassis rows stack `requireOrgScope` under the manage hook — see `loginViaSwitch`.
    const admin = row.family === 'chassis' ? ADMIN_P : ADMIN;
    const editor = row.family === 'chassis' ? EDITOR_P : EDITOR;
    it('ADMIN member is admitted by the gate (never 401/403)', async () => {
      const res = await call(cookies[admin]!, row, WS);
      expect(res.status, `admin refused (${res.status})`).not.toBe(401);
      expect(res.status, `admin refused (${res.status})`).not.toBe(403);
      // 5xx would mean the handler, not the gate, is broken on the probe body —
      // a different defect, but one this table must not paper over.
      expect(res.status, `handler 5xx on the probe request: ${await res.text()}`).toBeLessThan(500);
    });
    it('EDITOR member is REFUSED 403 — the gate fires over HTTP, not just in source', async () => {
      const res = await call(cookies[editor]!, row, WS);
      const body = await res.text();
      expect(res.status, body).toBe(403);
      // The refusal must be the MANAGE gate's, not some earlier scope gate's
      // (the chassis stacks `requireOrgScope`, whose 403 names ITS scope).
      expect(body, 'a 403 from a different gate is not this proof').toContain('host:kicktodo:manage');
    });
    it('NON-MEMBER is refused (≥ 400, fail-closed)', async () => {
      const res = await call(cookies[OUTSIDER]!, row, WS);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
    it('feature toggle OFF ⇒ 404 even for an admin (toggle gate runs first)', async () => {
      const res = await call(cookies[ADMIN_OFF]!, row, WS_OFF);
      expect(res.status, await res.text()).toBe(404);
    });
  });

  describe.each(OPEN.map((r) => [key(r.method, r.path), r] as const))('OPEN by design — %s', (_label, row) => {
    it('a plain EDITOR member is admitted (200, or the pinned resource code — never 403)', async () => {
      const res = await call(cookies[EDITOR]!, row, WS);
      expect(res.status, await res.text()).toBe(row.editor ?? 200);
    });
    it('feature toggle OFF ⇒ 404 (still feature-gated)', async () => {
      const res = await call(cookies[ADMIN_OFF]!, row, WS_OFF);
      expect(res.status, await res.text()).toBe(404);
    });
  });
});
