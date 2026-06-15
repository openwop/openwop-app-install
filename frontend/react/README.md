# OpenWOP reference app — React frontend

React + TypeScript SPA consuming `@openwop/openwop`, deployed to Firebase
Hosting (`app.openwop.dev`). See [`../../README.md`](../../README.md) for the
full app overview and [`../../DEPLOY.md`](../../DEPLOY.md) for deploys.

## Run locally

```bash
npm install
npm run dev   # http://localhost:5173
```

The SPA connects to `http://localhost:8080` by default. Override per-env:

```bash
echo 'VITE_OPENWOP_BASE_URL=http://localhost:9000' > .env.local
```

Key env vars (see `.env.production` for the deployed wiring): `VITE_OPENWOP_BASE_URL`,
`VITE_OPENWOP_SSE_BASE_URL` (SSE bypasses the `/api` proxy — see DEPLOY.md),
`VITE_OPENWOP_AUTH_MODE` (`bearer` | `cookie`), `VITE_FIREBASE_*`,
`VITE_ENABLE_NETWORK_RECORDER` (opt-in in prod), `VITE_BRAND_*` (white-label).

## Architecture

The shell renders **entirely from the feature manifest**
(`src/chrome/features.tsx`) — routes, the workspace/admin tier split, nav, the
command palette, and per-route chrome all derive from declarations there. Adding
a page is one manifest entry; `App.tsx` doesn't change. Separately-distributed
feature packages register via `src/features/registry.ts`.

| Area | Where |
|---|---|
| App shell + manifest | `src/chrome/` (`features.tsx`, `Sidebar`, `AdminLayout`) |
| Shared UI primitives | `src/ui/` (`DataTable`, `Modal`, `Notice`, `StateCard`, `StatusBadge`, `Field`/`TextField`/`SelectField`, `Panel`/`Toolbar`/`MetadataRow`) — import via `src/ui/index.ts` |
| API client layer | `src/client/` — `requestJson` (typed, throws `ApiError`), `config` (auth modes), `classifyHttpError` |
| Platform | `src/platform/` — `storage` (key registry, see [STORAGE.md](STORAGE.md)), `telemetry` (pluggable reporter) |
| Chat domain | `src/chat/` — `useChatSession` hook + `lib/chatPersistence`, `lib/chatSessionReducer` |
| Design tokens | `src/styles/global.css` (canonical palette; see `../../DESIGN.md`) |

### Routes (from the manifest)

Workspace tier: `/` (chat home), `/agents*`, `/builder*`, `/boards`, `/inbox`,
`/privacy`.
Admin tier (rendered inside `AdminLayout`): `/admin`, `/mission`, `/runs*`,
`/compare`, `/workforces*`, `/agents/templates*`, `/roster`, `/prompts`,
`/memory`, `/capabilities`, `/cli`, `/orgs`, `/keys`, `/feature-toggles`,
`/example-data`.

All route components except the chat home are `React.lazy`; the shell's
`<Suspense>` renders the fallback.

## Gates

```bash
npm run build   # tsc + prompt/brand/CSS-token + tsx-color + vite + built-css + bundle-budget
npm test        # vitest (unit/component)
npm run lint    # eslint — rules are ERRORS; CI runs with --max-warnings=0
npm run test:e2e # playwright (a11y axe light+dark, modal, keyboard, smoke)
```

- **`npm run build` is the canonical gate** — do not run bare `vite build`; it
  skips the CSS-token / color-literal / bundle-budget checks.
- The **entry-chunk gzip budget** (`scripts/check-bundle-budget.mjs`, 160 kB)
  fails the build if first-load weight creeps up — raise it deliberately.
- **Lint is blocking**: type-safety (`no-explicit-any`, `ban-ts-comment`),
  hooks correctness, and core `jsx-a11y` rules are errors.
- TypeScript runs `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes`.

## Conventions

- New screens use the shared `ui/` primitives (forms via `Field`/`TextField`,
  layout via `Panel`/`Toolbar`) before hand-rolling structure.
- Browser storage goes through `src/platform/storage.ts` + is documented in
  [STORAGE.md](STORAGE.md). **No secret material in browser storage.**
- Network calls go through `src/client/requestJson.ts` (typed, `ApiError`).
- See [DEBT.md](DEBT.md) for the tracked frontend debt register and
  [`../../docs/adr/`](../../docs/adr/) for architecture decisions.
