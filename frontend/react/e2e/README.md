# The Playwright lane

Browser tests for the SPA. **They run in the default merge gate** (`npm run ci`) —
see [ADR 0509](../../../docs/adr/0509-e2e-lane-merge-gate.md).

```bash
npm run ci                    # the gate — runs this lane automatically
npm run test:e2e              # the parallel pass (excludes @serial)
npm run test:e2e:serial       # the @serial pass, workers=1
npm run ci:e2e-report         # did the lane actually run, and was it green?
```

The lane needs a backend with the test seams. `scripts/ci.sh` boots one, picks free
ports, and tears down **only the process it started**. Running the specs directly
means booting one yourself — see *Running by hand* below.

---

## Five traps. Each produces a confusing green or red.

These are not hypothetical; every one cost real time, and four of them produce a
result that looks like a product bug.

### 1. An explicit `tenantId` locks you OUT of admin-tier pages

`login(ctx, email, tenantId)` with a tenantId makes that workspace *somebody
else's* as far as the session is concerned, so `basis` never resolves
`tenant-owner` and `chrome/AdminLayout` renders **"Administrator access
required"** instead of the page. Every assertion below then runs against a deny
card.

Omit the tenantId when the spec needs admin (`hub-suspense.spec.ts`,
`devtools-gate.spec.ts` do this). No spec caught this before, because
`feature-routes.spec.ts` only asserts "didn't crash" — and a deny card doesn't
crash.

### 2. In dev the app calls the backend DIRECTLY, not through `/api`

There is no `.env.development`, so `client/config.ts` falls back to
`http://localhost:8080`. `page.request` (relative URL) **does** go through the
Vite `/api` proxy. Point them at different backends and everything reads
anonymous while looking fine.

Set **all three together**:

```bash
OPENWOP_DEV_PROXY_TARGET=http://localhost:PORT   # what page.request reaches
VITE_OPENWOP_BASE_URL=http://localhost:PORT      # what the APP calls
VITE_OPENWOP_SSE_BASE_URL=http://localhost:PORT  # what collab's WebSocket uses
```

This exact gap shipped a red merge gate: auto-port selection moved the backend
off 8080 while the app kept calling 8080. Before that, the CI backend was always
on 8080 and the default matched *by coincidence*.

### 3. Collab's WebSocket uses a THIRD URL

`canvas/useCollab.ts` connects to `config.sseBaseUrl`. Miss it and the editor
renders but never syncs — which reads as a collab bug.

### 4. Feature-toggle config is SHARED, not tenant-scoped

`feature-toggles/admin/configs/<id>` is one row. Two tests writing it in parallel
fight, and the page under assertion sees whichever landed last — measured, as
opposite results on consecutive runs. `devtools-gate.spec.ts` is
`mode: 'serial'` for this reason and restores the prior value in `afterAll`.

### 5. axe only flags what it RENDERS

A green a11y run does **not** mean the app is clean — it means the rendered
routes are. 21 `aria-prohibited-attr` violations were invisible to it simply
because no spec rendered those paths; they needed a static check
(`scripts/check-aria-prohibited.mjs`). Don't read lane-green as app-clean.

---

## Writing a spec that can actually fail

The lane has been burned by tests that could not fail, so these are conventions,
not suggestions.

**Assert both polarities of a gate.** `toHaveCount(0)` passes on a 404, an
anonymous session, a crashed page, and above all **a selector that is simply
wrong**. Assert the *same selector* present-when-on and absent-when-off; the ON
case is the positive control. This caught two real authoring errors in
`devtools-gate.spec.ts` — a nav that is admin-tier and never on `/dashboard`, and
a route that was `/test`, not `/manual-tests`.

**Prove the page rendered before asserting an absence.** A deny card, a 404 or an
empty state satisfies most negative assertions. `viewport.spec.ts` requires
`main` visible, *not* a known degenerate state, *and* a minimum rendered height.

**Read racing facts in ONE `evaluate()`.** Two sequential `await expect`s can
straddle a state change. `hub-suspense.spec.ts` snapshots "still suspended" and
"chrome still present" in a single tick, because sequentially they would both
pass on a broken build.

**Sabotage-probe it.** Break the thing the test covers and confirm *that* test
goes red — and that the others stay green, which is what proves per-case wiring.
If you cannot make it fail, you have not written a test.

---

## Running by hand

```bash
# 1. a backend with the test seams, on a free port
cd backend/typescript && npm run build
OPENWOP_TEST_AUTH_ENABLED=true OPENWOP_FEATURE_TOGGLES_DEV_OPEN=true \
OPENWOP_DEMO_MODE=true OPENWOP_STORAGE_DSN=memory:// \
OPENWOP_CORS_ORIGINS=http://localhost:5199 \
OPENWOP_SESSION_SECRET=local-e2e-session-secret-at-least-32-characters-long \
PORT=8099 node lib/index.js

# 2. the specs, with ALL THREE urls naming that backend (trap 2)
cd frontend/react
OPENWOP_DEV_PROXY_TARGET=http://localhost:8099 \
VITE_OPENWOP_BASE_URL=http://localhost:8099 \
VITE_OPENWOP_SSE_BASE_URL=http://localhost:8099 \
OPENWOP_E2E_PORT=5199 npm run test:e2e
```

`OPENWOP_E2E_PORT` gives a worktree its own Vite port. `reuseExistingServer` is
**off** by default and that is deliberate — see the comment in
`playwright.config.ts`: reuse once let a suite bind another worktree's server and
pass without executing its own code.

---

## What's quarantined, and what isn't covered

- **`collab.spec.ts` is `@serial` and ADVISORY.** Two live WebSocket clients fail
  deterministically on a loaded machine, so it runs in its own `--workers=1` pass
  and its result is ledgered but does **not** block the gate. It is quarantined,
  not skipped — a quarantine that stops a test executing is indistinguishable
  from deleting it.
- **Four specs skip behind opt-in env vars** (`feature-routes`, `feature-gated`,
  `collaborative-project`, `walkthrough-replay`). The file count overstates what
  a default run executes.
- **No screen-reader coverage.** `live-region.spec.ts` tests the announcement
  *precondition* against a real accessibility tree; what VoiceOver or NVDA
  actually *says* happens inside the AT process and no automated test reaches it.
