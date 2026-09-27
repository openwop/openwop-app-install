/**
 * Shared e2e session helpers (ADR 0183) — the `test/login` cookie seam + toggle
 * enablement used by the feature-coverage specs. Mirrors the collaborative-project spec's
 * pattern. Requires a backend on :8080 booted with the test seams:
 *
 *   OPENWOP_TEST_AUTH_ENABLED=true OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true \
 *   OPENWOP_STORAGE_DSN=memory:// OPENWOP_SESSION_SECRET=dev-session-secret-at-least-32-characters-long \
 *   OPENWOP_MOUNT_LOCAL_PACKS=false \
 *   node backend/typescript/lib/index.js
 *
 * (`lib/`, NOT `dist/` — `scripts/build.mjs` emits `lib/`, and this line said
 * `dist/index.js` until 2026-08-07, which fails as MODULE_NOT_FOUND.
 * `OPENWOP_MOUNT_LOCAL_PACKS=false` because a backend booted OUTSIDE vitest
 * re-points every `~/.openwop-packs` symlink at THIS worktree — see CLAUDE.md;
 * measured not to affect specs that seed their own `core.noop` fixtures.)
 *
 * and the Vite dev server proxying /api → :8080 (see collaborative-project.spec.ts header).
 *
 * ── THREE TRAPS, each of which produces a CONFUSING GREEN OR RED. Read before
 *    debugging a spec that "should obviously work". ──
 *
 * 1. `login(ctx, email, tenantId)` WITH an explicit tenantId LOCKS YOU OUT of
 *    admin-tier pages. The seam treats that workspace as somebody else's, so
 *    `basis` never resolves `tenant-owner` and `chrome/AdminLayout` renders
 *    "Administrator access required" INSTEAD of the page
 *    (`client/useEffectiveAccess.ts:59`). Every assertion under it then runs
 *    against a deny card. Omit tenantId for the caller's own personal workspace
 *    when the spec needs admin (see `hub-suspense.spec.ts` / `devtools-gate.spec.ts`).
 *    No spec caught this before: `feature-routes.spec.ts` only asserts "did not
 *    crash", and a deny card does not crash.
 *
 * 2. IN DEV THE APP CALLS THE BACKEND DIRECTLY. There is no `.env.development`,
 *    so `client/config.ts:27` falls back to `http://localhost:8080` — the app does
 *    NOT go through the Vite `/api` proxy. `page.request` (relative URL) DOES.
 *    So a backend on any other port silently splits them: your fixtures land in
 *    one server and the page reads another, and everything reads as anonymous.
 *
 *    **SET `VITE_OPENWOP_BASE_URL=/api`.** This trap used to end "point BOTH at
 *    the same place: `OPENWOP_DEV_PROXY_TARGET` + `VITE_OPENWOP_BASE_URL`" — and
 *    pointing the SPA at an absolute backend URL is itself the bug, because ANY
 *    absolute URL is cross-origin from the dev server and the session cookie
 *    then never rides. Same symptom as the port split (the app renders, logged
 *    out, against a backend holding your fixtures), different cause, and the old
 *    advice could not fix it. Cost a full failing run on 2026-08-07.
 *
 *    WHY, precisely — two barriers, and the FIRST one is the decisive one:
 *      (a) `config.authMode` defaults to **`'bearer'`** (`client/config.ts:42`),
 *          and `fetchOpts` adds `credentials: 'include'` only for `'cookie'` (or
 *          a cached Firebase token). So cross-origin the SPA sends NO
 *          credentials. A SAME-ORIGIN `/api` request still sends the cookie,
 *          because fetch defaults to `credentials: 'same-origin'` — that is the
 *          whole reason the proxy route works.
 *      (b) `middleware/cors.ts` emits `Access-Control-Allow-Credentials` only for
 *          an explicit `OPENWOP_CORS_ORIGINS` allowlist; dev's reflect-any
 *          default never emits it (measured). So even setting
 *          `VITE_OPENWOP_AUTH_MODE=cookie` would not rescue the absolute URL
 *          without also setting `OPENWOP_CORS_ORIGINS`.
 *    `/api` clears both at once, and matches production (`.env.production`).
 *    Still set `OPENWOP_DEV_PROXY_TARGET` — that is what `/api` proxies TO.
 *
 * 3. COLLAB'S WEBSOCKET USES A THIRD URL. `canvas/useCollab.ts` connects to
 *    `config.sseBaseUrl` (`VITE_OPENWOP_SSE_BASE_URL`), which falls back to the
 *    same `:8080` default. Set it alongside the other two or the collab specs
 *    open a document on your backend and sync against a different one — which
 *    presents as the editor rendering but never syncing.
 */
import { expect, type APIRequestContext } from '@playwright/test';

/** Host-extension API root, proxied by the dev server to the backend. */
export const API = '/api/v1/host/openwop-app';

interface LoginResponse { user: { userId: string } }

/** test/login (cookie seam) → userId; the `__session` cookie lands in `ctx`'s jar. */
export async function login(ctx: APIRequestContext, email: string, tenantId: string): Promise<string> {
  const res = await ctx.post(`${API}/test/login`, { data: { email, tenantId } });
  expect(res.status(), `login ${email}: ${await res.text()}`).toBe(201);
  return ((await res.json()) as LoginResponse).user.userId;
}

/**
 * Enable a feature toggle for the caller's tenant (needs OPENWOP_FEATURE_TOGGLES_DEV_OPEN).
 * Reads the current config then PUTs it back with status:'on'. Best-effort — returns false
 * if the toggle id is unknown so the caller can skip the route rather than fail the suite.
 */
export async function enableToggle(ctx: APIRequestContext, id: string): Promise<boolean> {
  const get = await ctx.get(`${API}/feature-toggles/admin/configs/${encodeURIComponent(id)}`);
  if (!get.ok()) return false;
  const config = (await get.json()) as Record<string, unknown>;
  const put = await ctx.put(`${API}/feature-toggles/admin/configs/${encodeURIComponent(id)}`, {
    data: { ...config, id, status: 'on' },
  });
  return put.ok();
}
