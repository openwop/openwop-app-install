# ADR 0873 — Web offline: one generated service worker, declared per feature, network-first

Status: Accepted (P1, P2, D12 and D13 implemented; P3 not started)

Date: 2026-10-11

## Context

Book AI (session `bookai-2c`) needs installable, offline-capable app shells for its
routes. No ADR covers offline for the web app: ADR 0181 is the native desktop/mobile
shell, ADR 0413 the native participant client, ADR 0436 the KickTodo participant
experience. What exists today, read on `origin/main` (`c179bda01`):

- **One service worker, push only.** `frontend/react/public/sw-push.js` handles
  `push` and `notificationclick`, calls `skipWaiting()` + `clients.claim()`, and has
  **no `fetch` listener**. `src/notifications/pushSubscription.ts:65` registers it at
  scope `/`, and only when the user enables push. Its `isSafeActionUrl` copy is pinned
  by `src/notifications/__tests__/swPushActionUrlParity.test.ts` (ADR 0816 D7).
- **`FrontendFeature`** (`src/features/registry.ts`) has `id`, `routes` and
  `publicRoutes` only. Features are composed into `FRONTEND_FEATURES`, which a
  distribution narrows at build time (`scripts/gen-distribution.mjs`).
- **The app shell is not `index.html` in production.** The Hosting predeploy hook
  (`scripts/prepare-hosting-shell.cjs`, ADR 0384 P4) renames `dist/index.html` to
  `app-shell.html`. The `**` catch-all rewrite serves it, and `/` falls through to the
  Cloud Run document, which caches the shell for `OPENWOP_SPA_SHELL_TTL_S` (60 s).
- **Hosting rewrites much more than `/api` to Cloud Run.** MEASURED: `firebase.json`
  has 38 rewrites on the `app` target, and **37 go to Cloud Run**: `/api/**`,
  `/v1/**`, `/.well-known/**`, `/`, `/p/**`, `/runs/**`, `/agents/**`,
  `/workflows/**`, `/interrupts/**` and others. Several of these are also browser
  navigations (a run link is a `/runs/<id>` navigation).
- **A missing static file returns HTML with status 200.** The `**` rewrite answers
  any path with no file. The stale-chunk handler in `src/main.tsx:34–50` exists
  because of this: a pruned `assets/*.js` comes back as `text/html`.
- **A manifest exists.** The `openwop-brand-html` Vite plugin emits
  `manifest.webmanifest` with `start_url: '/'`, and `index.html` links it. `/` is the
  Cloud Run document, so an installed app could never launch offline as things stand.
- **CSP.** The document CSP is `default-src 'self'; script-src 'self' …`. With no
  `worker-src`, CSP falls back to `script-src`, so a same-origin `/sw.js` is already
  allowed. The `.js` header block carries no CSP, so the worker's own
  `importScripts` are unrestricted.

Book AI's proposal (via openwop-app-78) is:
- an optional `offline` field on `FrontendFeature`;
- one generated `/sw.js` with the push handlers folded in, and `sw-push.js` kept as
  a shim;
- network-first navigations;
- same-origin GET only;
- a fixed never-cache list;
- purge on activate and on sign-out;
- a build that fails on rules outside the feature's own routes;
- no CSP change.

This ADR adopts that shape. It changes four things the code above makes necessary:
- **D4:** the never-cache set is derived from `firebase.json`, not listed by hand.
- **D2:** the worker scripts are permanent, because a deleted one is answered by the
  catch-all with HTML.
- **D9:** the manifest's `start_url`.
- **D10:** `Service-Worker-Allowed` is unnecessary.

## Decision

**D1 — The seam is an optional `offline` field on `FrontendFeature`. It is data,
not code.**

```ts
offline?: {
  /** Route paths that get the cached shell when the network is unreachable.
   *  Each must be a path this feature owns, either a `routes[].path` or a path
   *  its `publicRoutes[].match` accepts, and none may be in the D4 never-cache set. */
  navigations: string[];
  /** Extra build-output files to precache, beyond the shell and the route
   *  chunk graphs the generator derives (D6): non-hashed public files under
   *  `dist/` (e.g. `/bookai/` marks and fonts). Exact paths; globs are not allowed. */
  precache?: string[];
  /** Same-origin static paths only (never a navigation, never D4). */
  runtime?: { match: string; strategy: 'swr' | 'network-first'; maxEntries: number }[];
  /** D12. Absent = 'fail-closed' (the default). */
  entitlement?: 'fail-closed' | 'last-known';
}
```

No feature writes worker code. The generator (D2) is the only place behaviour lives,
so every rule below holds for every feature by construction.

> **Correction (P2, 2026-10-12) — where the data lives.** The build cannot evaluate a
> feature's React route module, so the declaration lives in a **data-only sibling**
> of the module the registry imports, `src/features/<dir>/offline.ts`
> (`export const offline: FeatureOffline`, `import type` only). The feature sets
> the same object on its `FrontendFeature`. The build loads the file with Vite's
> `runnerImport`, and only for features the composed registry (a distribution's,
> when set) imports. `src/sw/__tests__/offlineDeclarations.test.ts` pins the two
> sides: every file is set unchanged on its feature, and nothing declares inline.
> A navigation is a **literal path that covers itself and everything below it**
> (`/books` covers `/books/shelf`); params, globs, `/` and trailing slashes are
> refused.
>
> > **Correction (2026-10-19, Book AI proposal P24) — a declaration may be
> > build-only.** "The feature sets the same object on its `FrontendFeature`" is
> > now required only when the file sets `entitlement`. The runtime reads
> > `FrontendFeature.offline` for nothing else (`registry.ts` `featureRoutes`
> > stamps `ownerOfflineEntitlement`; `lastKnownEntitlementFeatureIds`), and the
> > build reads the file, so a fail-closed declaration with no `entitlement`
> > behaves the same with the runtime field unset. Leaving it unset keeps the
> > declaration out of the entry chunk, which matters to a distribution whose
> > entry share is full (Book AI: 1,013 of 1,024 B). Pinned by
> > `declarationParityErrors` (`src/sw/offlineOwnership.ts`): a runtime value
> > still needs its file and must be that file's value, and a file with
> > `entitlement` must be on the runtime. The ownership check (D4) takes the
> > file's declaration when the runtime field is unset.

**D2 — One worker, generated at build: `/sw.js`.**
- **What it holds.** A Vite `generateBundle` step emits `sw.js`. It contains the push
  handlers, moved verbatim from `sw-push.js`, and the offline tables computed from
  `FRONTEND_FEATURES`. The ADR 0816 D7 parity test moves to the new source.
- **The shim.** `public/sw-push.js` becomes a permanent shim, `importScripts('/sw.js')`.
- **Both files are permanent.** Browsers update an installed worker by refetching its
  script URL. Here a deleted script would come back as `200 text/html` from the `**`
  rewrite. The update then fails, and the old worker keeps running indefinitely, with
  whatever fetch handler it had. A build-output test fails if either file is missing
  or is not JavaScript.

**D3 — One registration URL and one scope.**
- **One constant.** `SW_URL = '/sw.js'`, scope `/`, is exported from one module.
  `main.tsx` and `pushSubscription.ts` both import it.
- **Why a second URL breaks it.** A browser keeps one registration per scope. Calling
  `register()` with a different script URL at the same scope replaces that
  registration's worker. Two call sites with two URLs would reinstall the worker on
  every boot and every push enable, and each activation purges the offline caches (D6).
- **When `main.tsx` registers.** It registers at boot only when the build's offline
  table is non-empty (a build-time constant), and never under the native shell
  (`isNativeShell()`, `native/nativeBridge.ts:86`). The Electron and iOS shells (ADR
  0181) keep their own offline story, and a second cache layer there is unmeasured.
- **Empty table.** When the table is empty, `sw.js` has **no `fetch` listener at
  all**. A pass-through listener would still start the worker for every request.

**D4 — The never-cache set is derived from `firebase.json`, never listed by hand.**
- **What the generator reads.** It reads the hosting config the build deploys to:
  by default this repo's `firebase.json`, target `app`. A distribution on its own
  Firebase project (Book AI is moving to one) names its config with
  `VITE_SW_HOSTING_CONFIG` + `VITE_SW_HOSTING_TARGET`. When the offline table is
  non-empty, the build fails if that config cannot be read. The generator treats
  every `run` destination in it as never-cache, which includes `/`. Cross-origin requests and
  non-GET requests are also never cached.
- **What the build refuses.** It fails if a declared navigation or `runtime.match`
  intersects that set, or if a navigation is not under one of the declaring feature's
  own `routes[].path`.

  > **Correction (P2, 2026-10-12).** The ownership half ("not under the feature's own
  > routes") needs the React route modules, so it runs in the **vitest lane**
  > (`offlineDeclarations.test.ts`, `navigationOwnershipErrors`), which `npm run ci`
  > runs, and not in `vite build`. Every data-only check (shape, D4 intersection,
  > D9 `start_url`, the hosting config being readable, D6 budget) does fail the
  > build itself. A navigation must equal or sit below the literal prefix of an
  > owned route (never `/`), or be accepted by an owned `publicRoutes[].match`; a
  > navigation broader than its routes (`/admin` for `/admin/kicktodo`) is refused.
  > `VITE_SW_HOSTING_CONFIG` is absolute or relative to the repo root.
- **Why derived.** A hand list (`/api/**`, `/v1/**`, `/.well-known/**`, `/`) would
  already miss 33 of the 37 Cloud Run rewrites, and it would drift with each new one.
- **The guarantee.** Tenant data only ever reaches the browser through those rewrites
  or a cross-origin `*.run.app` stream. So **the cache can hold only public build
  output**, a property that follows from the construction rather than a review.

**D5 — Navigations are network-first, with no timeout race.**
- **Online.** A declared navigation goes to the network, using navigation preload so
  the worker's start-up costs nothing.
- **Offline.** The cached shell (`/app-shell.html`, the post-predeploy name) is served
  **only when `fetch` rejects** (no network). A slow response or an HTTP error status
  is passed through as it is.
- **Why no timeout fallback.** A timeout fallback would serve a stale shell on a slow
  connection, which is the failure the `main.tsx` stale-chunk reload exists to repair.
- **Pinned.** The `app-shell.html` name is coupled to `prepare-hosting-shell.cjs` by a
  test.

> **Correction (P2, 2026-10-12) — undeclared navigations.** With navigation preload
> enabled, a navigation the worker does not answer would leave the preload request
> unused, so the browser could fetch the document twice. The engine therefore
> answers every same-origin navigation: a declared one network-first, and every
> other one (including `/` and each D4 route) with the preload response or a plain
> `fetch`. It never reads or writes a cache for those, so they fail exactly as the
> network does. This applies only to a build whose table is non-empty.

**D6 — Versioned, atomic caches.**
- **Naming.** The shell cache is named by the hash of the precache list. It holds the
  shell plus the chunk graph of each declared route, so shell and chunks always come
  from the same build.
- **The graph.** The generator derives each graph from Vite's build manifest: the
  route's lazy module, closed over **both its static `imports` and its
  `dynamicImports`**, recursively, with CSS and assets included.
  - *Why dynamic too:* a route that loads its screens with `import()` (Book AI's
    `/books` loads nine areas, including the manuscript editor, through
    `lazyAreas.tsx`) would otherwise open offline to a shell whose every unvisited
    screen fails.
  - *Budget:* a dynamic closure can reach shared app-wide lazy chunks, so the build
    prints each feature's precache size and **fails over a budget**:
    `OPENWOP_SW_PRECACHE_MAX_KB`, gzip, default 1500. Book AI's areas are about
    400 kB gzip. Raising the budget is a visible, reviewed change; silently
    precaching half the app is not.
- **Hashed assets.** Files under `/assets/` are immutable by name, so the worker
  serves them cache-first from **any retained version**.
- **Retention.** On activate it keeps the **current and previous** versions and purges
  older ones. A tab left open across a deploy then finds its old chunks in the
  previous cache instead of hitting the HTML rewrite. That makes the `main.tsx` reload
  rarer, and it stays as the recovery.
- **Never HTML for a script.** The worker never answers a script or style request
  with HTML. On a miss it passes the request to the network unchanged.

**D7 — Keep `skipWaiting()` + `clients.claim()`.** Push already depends on immediate
activation (`sw-push.js` does both today). The previous-version cache (D6) is what
makes an immediate takeover safe for tabs still running the old build.

**D8 — Purge on sign-out, never unregister.**
- **The purge.** `auth/hardSignOut.ts` posts a message, and the worker deletes every
  offline cache. D4 already guarantees no tenant data is cached, so this is defence in
  depth: no shell outlives the session on a shared machine.

  > **Correction (P2, 2026-10-12).** The page deletes the caches itself
  > (`src/sw/offlineCaches.ts`, through CacheStorage, which it shares with the
  > worker), so the purge does not depend on a worker being installed or awake. It
  > runs at the top of `auth/firebase.ts` `signOut()`, before the Firebase early
  > return. Every sign-out path goes through that function: `SignInButton`, the
  > invite account switch, and `hardSignOut`. Hooking only `hardSignOut` would have
  > missed an ordinary sign-out.
- **No unregister.** Unregistering would destroy the push subscription, which belongs
  to the registration.

**D9 — The manifest's `start_url` must be launchable offline.**
- **Today.** `start_url: '/'` is a Cloud Run document, so an installed app cannot open
  offline.
- **The change.** The manifest emitter takes `VITE_PWA_START_URL`, which defaults to
  `/` and so changes nothing.
- **Build check.** When the offline table is non-empty, the build fails if
  `start_url` is in the D4 set or is not a declared navigation.
- **Book AI.** Its distribution sets it to its landing route.

**D10 — Headers. No CSP change, and no `Service-Worker-Allowed`.**
- **`Cache-Control`.** `firebase.json` gains a header block for `/sw.js` and
  `/sw-push.js` with `Cache-Control: no-cache`. The `.js` block currently gives them
  Hosting's default caching. `no-cache` lets a fix reach clients on their next
  navigation.
- **No `Service-Worker-Allowed`.** It is needed only for a scope above the script's
  own path, and `/sw.js` already sits at `/`.
- **No CSP change.** Per Context, `script-src 'self'` covers the worker.

**D12 — Offline entitlement: fail closed by default, `last-known` by opt-in.**
- **Default.** `EntitlementGuard` cannot reach the server offline, so it fails closed
  to an offline notice.
- **Why the opt-in exists.** A feature with its own offline data needs its route to
  render offline. Book AI has an ordered save queue and an encrypted device copy
  (`suite/offlineQueue.ts`, `suite/offlineStore.ts`). Failing closed would make that
  data unreachable.
- **What `entitlement: 'last-known'` does.** The guard may accept the last positive
  entitlement result it saw online, under these rules:
  - **Keyed** by (userId, tenantId, featureId); another user or tenant never matches.
  - **Only on a network error.** It is consulted only when the entitlement read fails
    to reach the server. A 401, a 403 or an explicit "not entitled" answer is
    authoritative and deletes the record.
  - **Bounded** by a host-set TTL (`VITE_OFFLINE_ENTITLEMENT_TTL_H`, default 24 h).
  - **Stored in `localStorage`.** It must survive an installed app's cold start, which
    is a new session, so `sessionStorage` would never be read.
  - **Deleted** by the same sign-out path as D8 (`auth/hardSignOut.ts`).
- **What it cannot grant.** It grants nothing on the server: every write still
  enforces entitlement on reconnect. The worst case, a revoked entitlement, leaves a
  user drafting into their own device copy for up to the TTL. The feature's sync must
  then surface the refusal without losing the draft.

> **Correction (D12 implementation, 2026-10-12) — the default did not exist yet.**
> "`EntitlementGuard` cannot reach the server offline, so it fails closed" was
> FALSE when written, and the P2 note below repeated it. MEASURED on `e5359a513`:
> a failed resolution set every feature to its fallback, `locked: false`, and the
> guard renders children whenever `locked` is false, so offline it **failed open**.
> `fetchEntitlements` also turned every non-OK status into `'*'`. D12 therefore
> builds the default as well as the opt-in. As implemented:
> - **"Offline" means a network failure only** (`TypeError`/`AbortError` from
>   `fetch`, either read). An HTTP failure keeps today's degrade-to-render.
> - **The identity is the subject the answer was resolved FOR**, which
>   `GET …/feature-toggles/assignments` now echoes as `caller: { tenantId,
>   principalId }`: the ACTIVE workspace. (The first cut keyed on `/me`, whose
>   `tenantId` is the HOME tenant (`resolveCallerUser`) while entitlements answer
>   for the active one (`tenantOf`), so a grant earned in workspace X would have
>   rendered offline in workspace Y. Found in review; ADR 0508's home-vs-active
>   family.) An answer for a new identity drops every grant; sign-out deletes
>   everything; a backend without the echo records nothing.
> - **Nothing is stored unless a feature opts in**, identity included.
> - **Only the first resolution decides "offline".** A failed refresh leaves the
>   state as it was, so it never swaps a mounted page for the notice (UI-ENT-1b).
>   *(Corrected 2026-10-12, D12 follow-up: as merged in #4734 this was true of
>   `offline` only. A failed refresh still reset the answer to the fallback, so
>   `locked` read false and a paywalled feature showed UNLOCKED, and every
>   toggle-gated feature vanished, on any 5xx or network blip. Found from a review
>   nit on the wording. Now a refresh that fails keeps the previous answer whole,
>   except on a 401/403, where the answer it would keep is no longer the caller's.
>   Presentation only: the server gates either way. Pinned by four tests in
>   `offlineEntitlement.test.tsx`, red when the keep is removed (2) and when it also
>   keeps on a 401 (1).)*
> - **Recovery is automatic:** the browser's `online` event re-resolves, and while
>   `navigator.onLine` stays true (a reset connection, a captive portal) the
>   provider re-resolves at 2 s, 5 s and 15 s before leaving it to the button.
> - **This changes behaviour for every user today**, not only for declaring
>   features: any guarded route whose first access read fails at the network now
>   shows the notice where it used to render.
> - **Only a real answer records a grant:** a 2xx, or the billing-off 404 (`'*'`,
>   unrestricted). A 5xx or a 401/403 on the entitlement read still renders as
>   `'*'` but records nothing, and a 401/403 on either read deletes the grants.
> - **Online, a grant is never consulted**, so it cannot unlock a locked feature.
> - **Scope:** only `workspace` and `admin` routes are wrapped by the guard.
>   `site`-tier and `publicRoutes` pages never were, so for a navigation declared
>   there neither the default nor the opt-in applies.
> - **The offline path is in the entry chunk by construction.** The worker
>   precaches the shell as the entry's STATIC import graph (D6), so the notice
>   and the grant store cannot be lazy: a lazy chunk would fail to load at the one
>   moment it is needed. MEASURED cost: +1.0 kB gzip on the entry (128.3 kB of 129, 751 B left).

**D11 — The rollback is a build with an empty table.**
- **What it does.** Such a build ships a `sw.js` with no `fetch` listener, whose
  `activate` deletes all offline caches.
- **How fast.** Installed clients pick it up at their next navigation update check,
  immediately given D10's `no-cache`.
- **Never delete `sw.js`** (D2).

**D13 — A distribution can purge the caches of the worker it replaces.** *(Added
2026-10-18, MyndHyve cutover; amends D7 and D11.)*
- **The gap.** D11 deletes only `openwop-offline-*`. A distribution that takes over
  an origin that ran a different app inherits that app's registration at `/sw.js`,
  and the update check installs this worker over it. MyndHyve's was a Workbox worker
  (`vite-plugin-pwa`, `skipWaiting` + `clientsClaim`) that answers every navigation
  from its precached `index.html`. So the first navigation after the cutover is
  served the old build by the old worker, and its lazy chunks then hit the `**`
  rewrite (`200 text/html`): a blank page. D7's immediate takeover replaces the
  worker but not the page it already served, and the old caches stay forever.
- **The change.** `VITE_SW_LEGACY_CACHE_PURGE` is a comma-separated list of cache
  names, where a trailing `*` makes a prefix. When set, the generated worker gets
  one more `activate` listener (`sw/legacy-purge.js`). It deletes the listed caches
  and, only when it deleted one, claims the open tabs and reloads them onto the
  network. A browser is reloaded at most once, because the caches are gone after;
  one that never ran the old app is never reloaded.
- **Default.** Unset, the worker text is byte-identical to before. The build refuses
  a bare `*`, an inner `*`, and any entry that could match `openwop-offline-*`.
- **Not unregister.** D8 still holds: the registration, and any push subscription,
  survives. A previous app's OTHER worker URLs are the distribution's own concern
  (a static stub at that URL, like D2's shim).

## Failure modes weighed

| Failure | How this design behaves |
|---|---|
| **Stale shell after a deploy** | Online navigations always hit the network (D5), so a cached shell is served only with no network at all. The shell and its chunks are cached as one version (D6), so an offline shell never references chunks from another build. |
| **SPA-shell TTL interplay** (`/` serves a 60 s-stale shell after a frontend deploy) | `/` is in the D4 set, so the worker never touches it and the TTL window is unchanged. Previous-version retention (D6) slightly improves it: a stale `/` shell's old chunks may still be served from cache instead of the HTML rewrite. |
| **Push-subscription continuity** | The subscription belongs to the scope-`/` registration and survives a change of worker. Existing installs update `sw-push.js` to the shim, and the next boot re-registers `/sw.js` at the same scope: one reinstall, same registration. D8 never unregisters. A single URL (D3) prevents flip-flopping. This needs a real-browser check (Verification 4). |
| **Two registration URLs** | Ruled out structurally (D3, one constant). |
| **A deleted worker script wedges clients** | Ruled out (D2: permanent, with a test). |
| **Tenant data in the cache** | Not reachable (D4: every Cloud Run rewrite and every cross-origin request is excluded). |
| **Offline shell, online-only data** | The worker supplies a shell, not data. Each declaring feature must render an honest offline state for its API calls. Its entitlement check fails closed offline unless the feature opts into `last-known` (D12). Offline data stores (IndexedDB, background sync) are feature-owned and outside this seam; Book AI's already exist. |
| **Public routes and capability tokens** | A public route may be declared (D1). A token carried in the URL fragment (Book AI's reader, `#t=…`) is never sent to the network or the worker, and the cached shell holds no reader data. A token in a path or query string would be part of a navigation request, and it is never cached either, because only the shell is cached for a navigation. |
| **Cache eviction under storage pressure** | An evicted cache becomes a network miss: the offline launch fails visibly, and nothing wrong is served. |
| **White-label distributions** | The table is generated from the composed `FRONTEND_FEATURES`, so an excluded feature contributes no rules. |

## Alternatives

- **`vite-plugin-pwa` / Workbox.**
  - *For:* mature precache manifests, strategies and cleanup.
  - *Against:*
    - Folding push in requires `injectManifest` mode, which means writing our own
      worker anyway.
    - Its default `navigateFallback` is cache-first, the stale-shell risk D5 avoids,
      so it would have to be reconfigured.
    - The never-cache set would still have to be derived from `firebase.json`.
    - It adds a dependency tree to every build.
  - *Verdict:* the rule set is small, so a generator of a few hundred lines is less to
    own. If rules grow (background sync, offline data), `injectManifest` is the
    upgrade path, and D1's data shape carries over unchanged.
- **One worker per feature, each with a narrower scope.**
  - *For:* isolation.
  - *Against:*
    - The browser picks the most specific scope, so the `/` push worker would no
      longer control those pages.
    - Every feature shares the same `app-shell.html` and common chunks, so each cache
      would duplicate them.
    - N workers means N update checks and N purge paths.
  - *Verdict:* rejected.
- **No service worker** (offline only through the native shells, ADR 0181/0413).
  - *For:* zero web risk.
  - *Against:* it doesn't meet the ask.
  - *Verdict:* it stays the default for every feature that declares nothing.
- **A classic cache-first app shell.**
  - *For:* the fastest offline launch.
  - *Against:* it serves stale shells after every deploy and fights the `main.tsx`
    recovery.
  - *Verdict:* rejected (D5).

## Delivery plan

| Phase | Content | Gate |
|---|---|---|
| **P1 — consolidate, no behaviour change** | `sw.js` generated with the push handlers only (no `fetch`); `sw-push.js` becomes the shim; the D3 constant; D2 permanence test; parity test retargeted; D10 headers | `npm run ci`; a real-browser push check (Verification 4) before deploy |
| **P2 — the offline engine with an empty table** | D1 field, D4 derivation and build failures, D5–D8 and D11 in the generator; no feature declares yet, so production behaviour is unchanged | `npm run ci` |
| **P3 — Book AI declares** | Book AI adds its `offline` block (`/books`, `/book-recovery`, `/book-reader`; `entitlement: 'last-known'`) and, in its own build only, `VITE_PWA_START_URL=/books` plus the D4 hosting config of its own Firebase project; its offline states | `npm run ci` + Verification 2–3 |

Backend: none. Wire: none (no RFC): this is frontend build output and Hosting headers.

> **Correction (D12, 2026-10-12):** D12 adds one additive field to a host-extension
> route, `caller` on `GET /host/openwop-app/feature-toggles/assignments`
> (non-normative, no RFC). The SPA treats its absence as "record nothing".

## Verification (planned)

1. **Generator unit tests.**
   - D4 derivation from a fixture `firebase.json`.
   - The build fails for:
     - a navigation outside the feature's routes;
     - a match in the never-cache set;
     - a `start_url` that isn't launchable.
   - An empty table emits no `fetch` listener.
   - Each test is sabotage-witnessed.
2. **Playwright offline e2e** (`context.setOffline(true)`).
   - A declared route launches from the cached shell.
   - A dynamically imported screen never opened online (Book AI: the manuscript
     editor) loads offline from the precache (D6).
   - A `last-known` route renders offline inside its TTL. It fails closed after the
     TTL, for another tenant, and after sign-out (D12).
   - An undeclared route and `/` fail as the network does.
   - No request matching the D4 set is ever served from the cache.
3. **Deploy-across e2e.**
   - Build A installed, then build B deployed: an open tab on A lazy-loads a chunk
     from the previous-version cache.
   - A fresh online navigation gets B's shell.
4. **Push continuity (real Chromium, manual or headed).**
   - With a push subscription made under `sw-push.js`, deploy P1.
   - `getSubscription()` must return the same endpoint after the boot that
     re-registers `/sw.js`.
   - This is the one claim that cannot be proven in jsdom, so P1 does not deploy
     without it.


**Verification 2–3: built (2026-10-12).** The lane is opt-in and uses fixture builds, because no feature declares `offline` on main.
- **Command:** `npm run test:e2e:offline` (`playwright.offline.config.ts`, `*.offline.ts`).
- **Fixture:** `scripts/build-offline-fixture.mjs` writes a temporary `kicktodo` declaration (`/guide`, `/discover`) and builds two variants, A and B. They differ only in the entry chunk, so B prunes about 1,000 of A's hashed files. The script deletes the declaration again even if the build fails. It also lifts the precache budget, because kicktodo is over it (see open question 4).
- **Server:** `e2e/offlineFixtureServer.ts` stands in for Hosting.
  - It serves the static file, then the D4 rewrites taken from `firebase.json` itself, then the `**` shell.
  - "Offline" is the server going away (connection refused), not `context.setOffline`. Whether emulation reaches a worker's own fetches depends on the browser build, which is the thing under test.

Covered by `e2e/serviceWorkerOffline.offline.ts`:
- **V2 launch:** a declared route reloads offline from the cached shell. A lazy screen the tab never opened online renders offline, with every chunk coming from the worker.
- **V2 refusals:** offline, an undeclared route, `/` and `/runs` fail with a network error. An `/api` read made successfully online fails offline (D4).
- **V3 deploy-across:** a tab open across the A→B deploy keeps both versions' caches. It lazy-loads A's pruned chunks from the previous cache as JavaScript, with no stale-chunk reload. A fresh online load gets B's shell.

Sabotage witnesses, each a patched `sw.js` that turned the named test red:

| Patched `sw.js` | Red |
|---|---|
| `/assets/` not served from the cache | V2 launch, V3 |
| declared navigations pass through (no shell fallback) | V2 launch, V2 refusals |
| every navigation falls back to the shell | V2 refusals |
| retention keeps one version, not two | V3 |

The last row was green until the test waited for `activated`. The push handlers' `activate` claims the tab while the engine's `activate` is still pruning, so `controllerchange` arrives before retention has run. That is harmless for the engine and was a race in the test only.

Not covered here: the D12 legs. They need a `last-known` declaration and join this file with D12 or P3.

## Implementation record

| Phase | What landed | Witness |
|---|---|---|
| **P1** (2026-10-12) | `sw/push-handlers.js` (moved verbatim from `public/sw-push.js`); `scripts/gen-service-worker.mjs` + the `openwop-service-worker` Vite plugin emit `dist/sw.js` and serve it at `/sw.js` under `vite dev`; `public/sw-push.js` is the permanent `importScripts('/sw.js')` shim; `src/sw/swUrl.ts` is the one `SW_URL`/`SW_SCOPE` (`pushSubscription.ts` uses it); `scripts/check-sw-permanence.mjs` runs after `vite build`; `firebase.json` `/@(sw\|sw-push).js` → `Cache-Control: no-cache` | `scripts/__tests__/serviceWorker.test.ts` (no `fetch` listener; shim loads exactly `SW_URL`; no second URL in `src/`; the D10 header; the real permanence gate on five fixture trees); `swPushActionUrlParity.test.ts` now runs the generated `/sw.js` |

**Verification 4 — PASSED 2026-10-12** (Google Chrome 154.0.8037.99, real FCM, a
local server that mimics the `**` rewrite). The harness subscribed under `main`'s
`sw-push.js`, switched the server to P1's shim + generated `/sw.js`, ran the
browser's update check of the old URL, then `register('/sw.js', { scope: '/' })`.
In every run the endpoint was identical before, after the shim update, and after
the re-registration, with exactly one registration; a negative-control
resubscribe always got a different endpoint. A real push sent through FCM was
shown under the shim and under `/sw.js` in every run, with an off-origin
`actionUrl` coerced to `/inbox`. The one flaky leg was the push sent to the OLD
worker seconds after a brand-new subscription (sometimes a 410, sometimes accepted
and never shown): it runs before any P1 code is involved, so it is FCM warm-up,
not this change.

**P1 was not to deploy until Verification 4 passed** (a push subscription made under
`sw-push.js` keeps its endpoint after the app re-registers `/sw.js`). Until a push
enable runs on new code, existing installs keep their `sw-push.js` registration,
which now loads the same handlers through the shim, so push delivery is unchanged
either way. `main.tsx` does not register at boot in P1: D3 ties boot registration
to a non-empty offline table, which is P2.

| **P2** (2026-10-12) | `scripts/gen-service-worker.mjs` grows the engine: D4 derivation (`deriveNeverCache`, Firebase globs → anchored RegExps), the D1 shape check, D4/D9 refusals, `prepareOfflineBuild` (config time) and `computePrecache` (D6 graphs, version hash over contents, gzip budget). `sw/offline-engine.js` (D5–D7: atomic install with the shell stored last and HTML-for-a-script refused, current + previous retention, navigation preload, network-first navigations, cache-first `/assets/`, network-first extras, runtime `swr`/`network-first` with `maxEntries`, never HTML stored) is included only for a non-empty table; otherwise `sw/offline-purge.js` (D11: activate deletes every offline cache and disables preload, still no `fetch`). The Vite plugin runs post and sets `__OPENWOP_SW_OFFLINE__`; `src/sw/bootRegistration.ts` (D3, called from `main.tsx`, skipped under the native shell); `src/sw/offlineCaches.ts` purge from `signOut()` (D8); `FrontendFeature.offline` + `src/sw/offlineTypes.ts` (D1); manifest `start_url` from `VITE_PWA_START_URL` (D9). No feature declares, so the shipped `sw.js` is the push handlers plus the D11 purge. | `scripts/__tests__/offlineEngine.test.ts` (43 tests: D4 from a fixture and from the real `firebase.json`, 37 rules; every refusal; the D6 graph, budget and version on a fixture bundle; the generated worker RUN against a simulated worker global for D3/D5/D6/D7/D11); `src/sw/__tests__/offlineDeclarations.test.ts` (parity + ownership); `src/sw/__tests__/offlineBoot.test.ts` (D3 registration, D8 purge, including via `signOut()`) |

**P2 witness build (2026-10-12, uncommitted, reverted).** With `documents` declaring
`/documents` via `offline.ts`, these were checked in turn:

| Build | Result |
|---|---|
| default `start_url` | refused (D9: `/` is a Cloud Run rewrite) |
| `VITE_PWA_START_URL=/documents` | emitted a `sw.js` with a `fetch` listener, 95 precache URLs and 37 never-cache rules; the entry chunk calls `register(SW_URL, {scope})` at boot; the manifest says `/documents` |
| adding `/runs` | refused (D4) |
| `OPENWOP_SW_PRECACHE_MAX_KB=1000` | refused (D6 budget) |
| adding `/crm` | the ownership test went red |
| dropping the field from `FrontendFeature` | the parity test went red |

**Measured for open question 4:** `documents`' closure over static and dynamic
imports is **1,316.7 kB gzip over 91 files**, close to the 1,500 kB default. Its
dynamic imports reach shared app-wide lazy chunks (the diff view, the chart
renderer), which is exactly the reach D6 warned about. A feature whose route
modules import broadly will meet the budget before Book AI's ~400 kB does.

**D12 is not in P2.** The `entitlement` field is accepted and shape-checked, but
`EntitlementGuard` does not yet read it: every route still fails closed offline.
D12 must land before P3 declares `entitlement: 'last-known'`.

> **Correction (2026-10-12):** "every route still fails closed offline" was false;
> they failed OPEN (see the correction note above D11). D12 has since landed.

| Phase | What landed | Witness |
|---|---|---|
| **D12** (2026-10-12) | Backend: `caller` echo on the assignments route. SPA: `featureToggles/lastKnownEntitlement.ts` (grants keyed by the echoed principal + ACTIVE tenant + feature in `localStorage`, TTL `VITE_OFFLINE_ENTITLEMENT_TTL_H` default 24 h, revoke, clear); `FeatureAccessProvider` tells a network failure from an HTTP one, decides "offline" on the first resolution only, exposes `useAccessOffline()`, re-resolves on the `online` event and on a bounded backoff, and records grants for `lastKnownEntitlementFeatureIds()` only; `fetchEntitlements` throws on non-404 errors so a 5xx/401/403 is never read as an answer; `featureRoutes()` stamps `ownerOfflineEntitlement`; `EntitlementGuard` fails closed offline to the static `OfflineEntitlementState` unless `last-known` holds a grant; `signOut()` clears the grants beside the D8 purge. Strings in all four locales. | `backend/typescript/test/feature-toggles-assignments-caller.test.ts` (real sign-in, real `ws:` workspace, switch: the echo follows the switch while `/me` keeps the home tenant; red when the echo is the home tenant). `src/featureToggles/__tests__/offlineEntitlement.test.tsx` (25 tests: the store rules; the REAL provider + guard for default fail-closed on either read, an HTTP error not offline, `last-known` inside/outside the TTL, a grant never unlocking a locked feature online, the `online` re-resolve, the bounded auto re-resolve, a failed refresh keeping the page, what is and is not recorded (2xx under the echoed subject, a switch to another workspace, billing-off 404, 5xx, 403, 401, no echo, no opt-in); the offline modules imported statically). Nine sabotages each turned it red: offline never set; the grant ignored; a 5xx recorded; the grant consulted online; a 403 not revoking; a refresh setting offline; no auto re-resolve; the key ignoring the echo; recording without an opt-in. |

The Verification 2 leg for D12 (Playwright, `context.setOffline(true)`) needs a
feature that declares `last-known`, so it runs with P3.

**Seen while building D12, owed to P3:** the lazy locale chunks (`i18n-pt-BR`,
`-fr`, `-es`) are dynamic imports off the entry, so the D6 shell does not precache
them. Offline, a non-English user's strings depend on a chunk that is not cached.
Not measured in a browser yet.

| Phase | What landed | Witness |
|---|---|---|
| **D13** (2026-10-18) | `parseLegacyCachePurge` + `sw/legacy-purge.js`; the Vite plugin reads `VITE_SW_LEGACY_CACHE_PURGE` at config time and passes it to every `generateServiceWorker` call | `scripts/__tests__/offlineEngine.test.ts` (D13 block: unset is byte-identical with and without a table; parse and refusals; the worker RUN with open tabs deletes exactly the listed caches and reloads each tab once, a second activation reloads nobody, a browser without legacy caches is never reloaded, the engine's caches survive) |

## Open questions

1. ~~The Electron shell.~~ **Answered 2026-10-11 (bookai-2c review):** skip
   registration under the native shell. Book AI does not use the native shells.
   Folded into D3.
2. ~~Book AI's landing route.~~ **Answered:** `/books`, set only in Book AI's own
   build. Book AI is moving to its own Firebase project, and the shared default build
   keeps `/`. Folded into D4, D9 and P3.
3. **Retention depth.** Is "current + previous" (D6) enough for tabs left open across
   two deploys in a day? Book AI agrees with it but has no data. Measure preloadError
   reloads before and after P2.
4. **The precache budget's default** (D6, 1500 kB gzip). It is set from one feature's
   measurement (Book AI, about 400 kB). Revisit when a second feature declares.
   **Measured 2026-10-12 (the V2–V3 fixture):** `kicktodo` declaring `/guide` and
   `/discover` comes to **2,195.1 kB gzip over 227 files**, so the default refuses
   it. With `documents` (1,316.7 kB), that makes two broad features at or over the
   line, against Book AI's ~400 kB. The budget is doing its job: a feature whose
   routes import app-wide lazy chunks gets refused rather than shipping a 2 MB
   install. It is not yet evidence that the default should move.

## Review record

- **2026-10-11, bookai-2c** (PR #4700 comment 6110442268). It raised two blockers for
  Book AI: the dynamic-import graph (adopted as their option (a), with a budget,
  in D6) and offline entitlement (adopted as D12, keyed, network-error-only, and
  TTL-bound). It also answered open questions 1–2. D2, D4, D5 and D9 were accepted as
  written.
