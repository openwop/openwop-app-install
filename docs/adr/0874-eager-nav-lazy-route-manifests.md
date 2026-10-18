# ADR 0874 — Entry-chunk headroom: shrink the preload plumbing, keep one route manifest

Status: implemented (P1 shipped; P2 measured and REJECTED by its own W-NAV gate — see D3's correction)

Composes ADR 0001 (feature-first packages; `FrontendFeature.routes`), ADR 0139
(configurable navigation; `FEATURES` is the one route + nav manifest), ADR 0144/0145
(hub consoles project tabs from `FEATURES`), ADR 0419 (`EntitlementGuard` keys on the
stamped `ownerFeatureId`), ADR 0641 (the `site` tier is shell-selected before the
router). Answers the "next structural lever" note in
`frontend/react/scripts/check-bundle-budget.mjs` ("split `src/chrome`'s route
manifest"), restated in the 2026-10-11 request as: split each feature's route
manifest into EAGER nav metadata and LAZY route elements.

## Context

### The budget, measured today

On `942d52c10` (origin/main, 2026-10-11) `check-bundle-budget.mjs` reports the entry
at **130.9 kB gzip against a 132.0 kB ceiling: 1,140 B of headroom.** (The 0.6 kB in
the request came from a 2026-09-20 sourcemap.) The ledger's contract is "when this is
tight, CODE-SPLIT — do not raise it", so the next growth needs a split.

Raw minified bytes in the entry, attributed per source file from its sourcemap
(436,683 B total):

| Bucket | Raw B | Share |
|---|---:|---:|
| react-dom | 130,405 | 29.9 % |
| `src/features/*/routes.tsx` (88 route modules) | 55,632 | 12.7 % |
| `src/chrome` (incl. `features.tsx` 18,895, the core manifest) | 48,177 | 11.0 % |
| react-router | 38,293 | 8.8 % |
| `src/client` | 25,708 | 5.9 % |
| `src/notifications` | 20,580 | 4.7 % |
| `src/auth` | 16,910 | 3.9 % |
| `src/ui` | 15,416 | 3.5 % |
| `@openwop/openwop` | 15,057 | 3.4 % |

Two of 78's input numbers are already settled: `@openwop/openwop-v1` left the SPA on
2026-09-28 (b6ad5dffb) and is absent here.

### What a route manifest actually costs

The manifests are already lazy where it matters: every page is
`lazy(() => import('./XPage.js'))` (164 such declarations across the 88 route
modules, 44 more in `chrome/features.tsx`). The page code is not in the entry. What
IS in the entry, per lazy page, is Vite's preload plumbing:

```js
x0=f.lazy(()=>_(()=>import("./CompanyDetailPage-DTmBjwPF.js"),
  __vite__mapDeps([74,1,47,55,75,53,54,58,59])).then(e=>({default:e.CompanyDetailPage})))
```

- **225** `__vite__mapDeps([...])` call sites, **12.3 kB raw** of index arrays;
- one shared **17.0 kB raw** table of hashed chunk filenames
  (`"assets/CompanyDetailPage-DTmBjwPF.js", …`) — high-entropy hashes, so it barely
  compresses;
- the per-page `lazy(()=>…then(e=>({default:e.X})))` boilerplate.

The rest of a route module is metadata the shell genuinely consumes before any page
renders (path, tier, `auth`, `chrome`, archetype, `nav`, `hubTab`), English
`label`/`hint` fallbacks, and in some modules load-time side effects
(`void import('./walkthroughActions.js')…`, page-spotlight and tab-kind
registration in campaigns, commerce, cms, connections, claude-code).

### Who reads the manifest, and what they need eagerly

| Consumer | Reads | Needs eagerly |
|---|---|---|
| Shell selection, `site` tier (`App.tsx:276`) | `path`, `tier`, `auth` | yes — before the router |
| `<Routes>` + `EntitlementGuard` (`App.tsx:483`, `:503`) | `path`, `tier`, `ownerFeatureId`, `element` | path/tier/owner yes; element only on match |
| `chromeFor()` / `mainClass` | `path`, `chrome` | yes |
| `resolveNav` → rail, admin rail, settings, ⌘K (ADR 0139) | `nav.*`, `path`, `tier` | yes (the palette itself is lazy, `App.tsx:21`) |
| Hub consoles (`AccessHubPage.tsx:182`, `ModelsHubPage.tsx:81`, `ChatDeploymentHubPage.tsx:89`, `CampaignStudioHubPage.tsx:83`) | `hubTab`, `element` | element only when the tab opens |
| `AdminLayout` wayfinding | `parentPath`, `nav` | yes |
| Deep links (bookmarks, notification clicks) | the same match path as `<Routes>` | yes |

So "eager nav metadata" is not just nav: matching, shell selection and the entitlement
guard need path/tier/auth/chrome/owner up front. Only `element` is deferrable, and
it is already a lazy component.

### Measurements of each lever

Each experiment edits a scratch copy of `942d52c10`, runs `vite build`, and measures
the entry at gzip level 6 (what the budget uses). Baseline is 130.9 kB.

| # | Experiment | Entry gzip | Δ |
|---|---|---:|---:|
| E1 | Stub every page `lazy(import)` in the 88 feature route modules (upper bound for lazy feature elements) | 121.3 | −9.6 |
| E2 | E1 + the 44 core lazies in `chrome/features.tsx` (upper bound, all elements) | 115.0 | −15.9 |
| E3 | E2 + empty English `label`/`hint` fallbacks (upper bound, keys-only nav strings) | 112.4 | −2.6 more |
| **E4** | **One real import per feature, rest stubbed — the shape of a per-feature lazy "elements" module** | **128.1** | **−2.8** |
| E5 | `build.modulePreload: false` (config only) | 120.5 | −10.4 |
| E6 | Hash-only names for non-entry chunks, `assets/c-[hash].js` (config only) | 127.1 | −3.8 |
| E7 | E5 + E6 | 119.7 | −11.2 |

E4 is the decisive row. The requested design moves each feature's page imports into a
lazily loaded per-feature module. The entry would then hold one import per feature
(about 88). Each still carries its own dependency list and hashed filenames, so the
realistic saving is about 2.8 kB, not the 9.6 kB upper bound. The upper bound (E1/E2)
is reachable only by putting all elements behind one lazy module. Every authenticated
boot renders a route, so every boot would fetch that module before its first page:
bytes move off the entry but stay on the critical path, now as a sequential hop.

## Decision

### D1 — Keep ONE route manifest; do not split route modules into eager + lazy halves

`FEATURES` stays the single manifest (ADR 0139). Route modules are not split into a
nav file and an elements file. Reasons:

1. **It doesn't pay.** The realistic saving is −2.8 kB (E4), against a change to 88
   route modules, the core manifest, four hub consoles, and `FeatureRoute.element`.
2. **It adds a second registry.** An elements map keyed by `path` duplicates the
   manifest's key. It can drift (a route with no element, an element with no route)
   and would need its own ratchet. ADR 0139's Phase 0 review already rejected a
   second canonical-route registry for hubs.
3. **It adds a waterfall to every first visit:** elements module, then page chunk.
   That widens the stale-chunk window below, rather than narrowing it.
4. **Route modules have load-time side effects** (walkthrough, spotlight and
   tab-kind registration) that must keep running at boot. A split would have to move
   them somewhere eager anyway.

### D2 — Phase 1: hash-only names for unbudgeted async chunks (−3.8 kB, no runtime cost)

Set `build.rollupOptions.output.chunkFileNames` to a function. Chunks that a budget
or tool keys on by NAME keep `[name]-[hash].js`:
- the `manualChunks` outputs: `i18n`, `i18n-<locale>`, `firebase`, `katex`,
  `markdown`;
- any `PER_CHUNK_GZIP_BUDGET` key. `check-bundle-budget.mjs:508` matches overrides
  by `name-` prefix.

Every other chunk becomes `c-[hash].js`. The entry keeps `index-[hash].js`:
`check-bundle-budget.mjs:505/543`, `check-csp-script-hash.mjs`, and
`verify-deploy.sh`/CLAUDE.md's `assets/index-*.js` probes all depend on that name.
Read the name-keyed list from one module that both `vite.config.ts` and the budget
script import, so they cannot drift. Debuggability stays: sourcemaps name every
source, and only the hashed URL loses its prefix.

### D3 — Phase 2: `build.modulePreload: false` (−10.4 kB alone, −11.2 kB with D2), gated on two witnesses

This drops the JS dependency lists and the filename table for preloads. Two facts are
verified in the installed Vite 7.3.5 source (`node_modules/vite/dist/node/chunks/config.js`):
- **CSS still loads:** `:23661` keeps `.css` deps when `modulePreload === false`.
  28 `__vite__mapDeps` sites remain in E5's entry, and they are the CSS-bearing ones.
- **The stale-chunk reload still fires:** the helper is still emitted
  (`_(()=>import("./CompanyDetailPage-….js"),[])` in E5), and its body ends
  `return baseModule().catch(handlePreloadError)` (`:23432`). So `vite:preloadError`,
  and `main.tsx:44`'s one-shot reload, fire on any failed lazy import, not only
  preloaded ones.

The cost is real: a page's shared JS dependencies are no longer fetched in parallel
with the page chunk. The browser finds them only when it parses the page chunk, so
each page's first visit pays about one extra round trip. That is why this phase is
gated rather than bundled with D2. Ship it only when both of these hold:
- **W-STALE (runtime):** a Playwright test against `vite preview` of a D3 build
  deletes a route chunk, navigates to that route, and asserts exactly one reload,
  then the current page. Sabotage: remove the `main.tsx:44` listener and the test
  must go red.
- **W-NAV (latency):** first-visit navigation to four heavy routes (`/crm`,
  `/slides/:id`, `/builder`, `/books`) under a throttled profile (Fast 3G, 4× CPU),
  measured before and after. Record the **median and p75** of the added time per
  route. `/books` is included at Book AI's review: it has the deepest lazy graph
  (TipTap plus area prefetch through `import()`).
  - Accept if the median added time stays under 150 ms per route.
  - **If `/books` p75 exceeds ~300 ms**, keep JS deps for that graph through
    `modulePreload.resolveDependencies`, even if the medians pass.
  - Otherwise, if the gate fails, use the same middle option for the chat home
    route's chunk graph.

  Re-measure the entry either way.

> **CORRECTED 2026-10-12 — D3 is REJECTED by its own gate. Do not ship
> `modulePreload: false`.** Both witnesses were run (`ecf3dbd70`+P1 vs the same
> tree with `modulePreload: false`, two `vite preview` builds, 5 interleaved runs
> per route, 4× CPU, first client-side visit from `/dashboard`, measured to the
> last route JS chunk):
>
> | Route | Fast 3G (562.5 ms RTT) added, median / p75 | Fast 4G (165 ms RTT) added, median / p75 |
> |---|---:|---:|
> | `/crm` (29 chunks) | +604 / +612 ms | +182 / +171 ms |
> | `/slides/:id` (23) | +558 / +556 ms | +170 / +171 ms |
> | `/builder` (8) | +625 / +635 ms | +178 / +175 ms |
>
> The cost is **exactly one round trip per first route visit**, on every route,
> and both profiles fail the 150 ms median bar. The middle option does not
> rescue it: the round trip is paid wherever JS preload lists are dropped, so
> restoring them for the routes that matter restores their bytes too. The
> reclaimed 7.2 kB is worth ~40 ms once per cold load on Fast 3G and <10 ms on
> Fast 4G — less than one route visit pays. `/books` was not measured: it is not a
> route in this app (Book AI is a separate project), so Book AI's p75 clause is moot
> here.
>
> **W-STALE passed** on the D3 build and on today's build: the one-shot reload
> fires without JS preload lists, as the Vite source reading said. With the
> `main.tsx` listener renamed, the test goes red (one document load, not two). It
> stays as a standing guard: `frontend/react/e2e/staleChunk.built.ts`, run with
> `npm run build && npm run test:e2e:built` (production build under
> `vite preview`; not wired into `npm run ci`).
>
> The next entry headroom therefore comes from the follow-ons below (lazy auth UI,
> post-session notifications connect) or D5, not from preload plumbing.

### D4 — Ratchet the ceiling down after each phase

Lower `ENTRY_GZIP_BUDGET` to (measured entry + 1 kB), rounded up to the kB, in the
same PR as each phase. Otherwise the reclaimed headroom becomes slack that absorbs
the next regression unnoticed — the ledger's #4034 lesson. Expected ceilings: about
129 kB after D2, about 121 kB after D3.

> **AMENDED 2026-10-18 — a declared white-label entry share (user decision).** D4
> calibrated the ceiling on the DEFAULT build. It left no room for a white-label
> distribution's own registered features. Book AI keeps ~0.83 kB gzip in the
> entry (route metadata and lazy loaders, plus an eager offline sign-out cleanup
> that must run while offline). By the time it adopted v0.5.0, the host's own
> entry had grown to 128.8 kB, so Book AI was 565 B over with no change of its
> own.
>
> Three options were weighed: split ~0.7 kB more from the host (unknown effort; D3
> was rejected), raise the ceiling for every build, or give distributions an
> allowance. The user chose the **allowance**:
> - A named distribution's `distributions/<name>.json` may declare
>   `entryShareBytes` (gzip bytes, capped at **1024**) and an `entryShareReason`.
> - Its entry budget is the host ceiling **plus** that share, and
>   `check-bundle-budget.mjs` reports the two numbers separately.
> - The default distribution cannot declare one, so the host's own ceiling, and
>   this ratchet, are unchanged at 129 kB.
>
> Tests: `frontend/react/scripts/__tests__/entryShare.test.ts`.

### D5 — Considered and not adopted now: keys-only nav strings (≤ −2.6 kB)

Removing the English `label`/`hint` fallbacks where `labelKey`/`hintKey` exist saves
at most 2.6 kB (E3 is an upper bound; it also blanked keyless items). It
changes the i18n contract: a missing key would render the key, not English. It needs
`check-i18n` to prove every `labelKey`/`hintKey` resolves in `en/nav`. Revisit if
D2+D3 headroom is spent.

### Follow-ons from the request (not decided here)

Each is an independent split, and each needs its own before/after measurement:
- **Lazy auth UI:** `src/auth` is 16.9 kB raw in the entry today. The request's
  ~13 kB was measured on the stale sourcemap.
- **Connect `notificationStore` after a session exists**, as 8398ab84a did for
  `reviewStatusStore`: `src/notifications` is 20.6 kB raw. `App.tsx` connects it in
  an effect gated on `sessionBearing`, but it imports it statically.

## Stale-chunk failure handling

- **Today:** after a deploy, an open tab's old chunk names 404. Hosting answers with
  `index.html`, the lazy import rejects, `vite:preloadError` fires, and
  `main.tsx:44` reloads once (a 10 s `sessionStorage` guard prevents loops). A
  rejection that bypasses the helper reaches the page `ErrorBoundary`, which shows a
  manual reload button.
- **D2:** no change. Names change shape, and the hashes still change on every deploy.
- **D3:** no change in mechanism (`:23432`), witnessed by W-STALE.
- **The rejected D1 split** would have doubled the stale exposure per first visit
  (two chunks, two chances to 404).

## Alternatives weighed

| Option | Entry Δ | Cost now | Debt / risk | Reversible |
|---|---:|---|---|---|
| Raise the ceiling | 0 | trivial | breaks the ledger contract; the next lever is still unbuilt | yes |
| Per-feature eager/lazy split (the request) | −2.8 (E4) | 88 modules + core + 4 hubs + type change | second path-keyed registry; waterfall; side-effect relocation | costly |
| One lazy elements module for all routes | ≤ −15.9 (E2) | as above | the bytes stay on every boot's critical path, as a sequential hop | costly |
| **D2 hash-only names** | **−3.8** | config + one shared list | none at runtime | **yes, one line** |
| **D3 modulePreload off** | **−10.4 (−11.2 with D2)** | config + 2 witnesses | +1 RTT per first page visit (gated) | **yes, one line** |
| D5 keys-only nav strings | ≤ −2.6 | 108 nav blocks | i18n contract change | yes |

The deciding forces are, first, the bytes actually removed per unit of
architectural change, and second, ADR 0139's single manifest. D2 and D3 remove more
than the requested split's upper bound for features, and change no code shape.

## RFC gate

None. This is build configuration and SPA chunking only. No wire, capability,
endpoint or run-event change.

## Phases

| Phase | Change | Witness | Target entry |
|---|---|---|---|
| P1 (D2+D4) | function `chunkFileNames` + shared name-keyed list; lower the ceiling | budget script still finds every named override, and fails if a named key matches no chunk; `npm run build` green | ≈ 127.1 kB, ceiling 129 |
| P2 (D3+D4) | `modulePreload: false` (or the `resolveDependencies` middle option) | W-STALE (sabotage-red), W-NAV numbers recorded here | ≈ 119.7 kB, ceiling 121 |
| Follow-ons | lazy auth UI; post-session notifications connect | per-split before/after | measured per PR |

## Open questions

1. W-NAV threshold: is a 150 ms median per first visit acceptable on the throttled
   profile, or should P2 go straight to the `resolveDependencies` middle option?
   (Product call, after the numbers.) **Book AI review (2026-10-11, PR #4701
   comment):** 150 ms median is acceptable for `/books`. A `/books` p75 above
   ~300 ms selects the middle option for that graph, as D3 now records. Book AI's
   share of the entry is guarded at ≤ 1 KiB (now ~0.6 kB). the offline service-worker proposal's precache (PR #4700)
   derives from the build manifest, so it composes with D2's renaming.
2. ~~Does any tooling key on async chunk name prefixes?~~ **Answered while
   drafting, on `942d52c10`:** no, apart from the budget overrides D2 already
   preserves. The `firebase.json` header rules match by extension
   (`**/!(*.@(js|css|…))`, `:279+`). `verify-deploy.sh:318`,
   `test-deploy-gates.sh:553` and `write-build-info.mjs` read only
   `assets/index-*.js`. P1 should re-run that grep, since a new consumer could land
   before it does.
3. After P2, should the ledger's "next structural lever" comment name the
   notifications and auth follow-ons, which become the largest remaining first-party
   entry buckets?

## Implementation record

| Phase | What landed | Measured | Witness |
|---|---|---|---|
| P1 (D2+D4) | `scripts/chunkNames.mjs` (the one name-keyed list) → `vite.config.ts` `chunkFileNames`; `check-bundle-budget.mjs` imports the list, refuses an override key missing from it, and refuses a key that matches no built chunk (default distribution only). `ENTRY_GZIP_BUDGET` 132 → **129 kB**. | Entry **127.1 kB** gzip on `ecf3dbd70` + P1 (E6 predicted 127.1). 1,036 async chunks now `c-[hash].js`; `index`, `i18n`, `i18n-<locale>`, `firebase`, `katex`, `markdown` keep their names. | `scripts/__tests__/chunkNames.test.ts` runs the real budget gate on fixture `dist/` trees; disabling the dead-override check turns 2 of its 6 tests red. `npm run build` green. |
| P2 (D3+D4) | **Rejected, not shipped.** `modulePreload: false` built and measured; entry 119.9 kB, but +1 RTT per first route visit (D3 correction). | W-NAV: +558–625 ms (Fast 3G), +170–182 ms (Fast 4G) median. | W-STALE kept as a standing guard (`e2e/staleChunk.built.ts`, `playwright.built.config.ts`, `npm run test:e2e:built`), sabotage-red. |

**Open question 2, re-run for P1 on `ecf3dbd70`:** still no consumer of async chunk
name prefixes. The ADR 0873 service worker (`scripts/gen-service-worker.mjs`, merged
after this ADR was written) has no precache and reads no asset names;
`verify-deploy.sh`, `test-deploy-gates.sh` and `write-build-info.mjs` still read only
`assets/index-*.js`; `check-branding.sh` globs `assets/*.js`.

**Seen while measuring, not caused by P1:** one async chunk is 148.2 kB gzip against
the 150 kB per-chunk ceiling (a rename does not change content). It now prints as
`c-<hash>.js`; its sourcemap names its sources.

