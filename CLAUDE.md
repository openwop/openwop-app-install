# CLAUDE.md — openwop-app

The OpenWOP reference application: workflow-engine backend (`backend/typescript/`,
Cloud Run) + React SPA (`frontend/react/`, Firebase Hosting). Extracted from the
`openwop/openwop` monorepo.

- **[`FEATURES.md`](FEATURES.md)** — the product-feature catalog + how the
  feature-toggle / multivariant-testing system works. Read it before adding or
  gating a feature.
- **[`docs/adr/`](docs/adr/)** — architecture decision records (see below).
- **[`DEPLOY.md`](DEPLOY.md)** + `DEPLOY-SMOKE.md` — the full deploy recipe + the
  live verification sequence.

## AI chat — reuse, never recreate (read before adding any "talk to AI" UI)

There is ONE AI chat in this app (`frontend/react/src/chat/`, the RFC 0005
conversation primitive). It already does workflow-running, BYOK, persistence,
conversations, agents, streaming, and HITL interrupt cards. **Do NOT build a new
chat panel or a bespoke "talk to AI" textarea** — that fragments capabilities and
drifts (it happened with the workflow-author `AiAuthorPanel` and was removed).

- **Full chat** is a tab in the left-sidebar nav (`/` → `ChatTab`).
- **To drive AI for a feature:** ship an **agent pack** (persona) + **node pack**
  (tools) and drive it through the existing chat, scoped to that agent — the
  ADR 0058 "chat-drivability = agent + nodes" pattern.
- **To open the chat scoped to an agent/conversation:** deep-link the main chat
  (`navigate('/?agent=<agentId>')` or `?conversation=<id>`) — the agents page +
  `ProjectChatTab` precedent ("No second chat system").
- **To put chat inside another surface:** render the shared
  **`chat/EmbeddedChatPanel`** (ADR 0073) — the turnkey drop-in that owns the BYOK
  gate + agent scoping + an empty-state slot. A feature supplies only the overrides
  (`agentId`, `renderEmptyState?`, `onManageProvider?`, `byokFallback?`) and its own
  chrome; it inherits the gate, scoping, and ephemeral session. It composes the
  slimmed **`ConversationView`** (feed + composer + interrupt cards, NO rails) via
  `EmbeddedConversation`. **Never** reimplement any of this. Import rule: a feature
  that `chat/` does not import back may static-import `EmbeddedChatPanel`; the
  **builder must lazy-import** it (chat/→builder/ edge would cycle). The
  `builder/CreateWithAiPanel` (scoped to the Workflow Architect) is the reference
  consumer.

## Working in parallel sessions (read first)

Multiple Claude Code sessions may share this one checkout. Assume another session
is editing right now. The hard-won git hygiene (same as the upstream spec repo):

- **Branch from `origin/main`, not local.** `git fetch` first; local `main` drifts
  behind constantly. Check `git status -sb` for "behind N" and integrate before
  committing or opening a PR.
- **Prefer your own worktree for risky work.** `git worktree add ../openwop-app-<task> origin/main`.
  Never `git checkout -b` in the shared checkout — it strands the working tree
  other sessions expect on `main`. **Provision a worktree with a real
  `npm install`** — do NOT symlink/copy `node_modules` as a shortcut (the shell
  cwd resets between tool calls, so symlinks land in the wrong dir and break later
  `git checkout`).
- **Never `git stash` / `git clean` / `git reset --hard` the shared tree** — it
  destroys another session's uncommitted work. Before discarding anything, `git
  diff` it against `origin/main`; if it differs, it's someone's unpushed work.
- **Preserve work by committing to a branch, then push.** Don't rely on stash.
- **Before every commit:** `git branch --show-current` (a parallel `checkout` can
  move you) and `git diff --cached` (a parallel write can land between `add` and
  `commit`). Stage explicit paths — never `git add -A`. Re-sync at every
  milestone, not just at branch time. Sign commits (`git commit -s`, DCO).
- **Clean up only your own artifacts** — never delete branches/worktrees/stashes
  you didn't create.

## Verifying changes

- **Frontend:** `( cd frontend/react && npm run build )` — the canonical gate.
  It chains `tsc --noEmit` + the token/CSS integrity checks
  (`check-css-tokens`, `check-tsx-color-literals`, `check-built-css`, branding)
  + `vite build`. **Do NOT verify with bare `vite build`** — it SKIPS those
  gates, so a raw hex literal or an undefined `var(--token)` ships green and
  breaks the real build (this has bitten us).
- **Backend:** `( cd backend/typescript && npm test )` (vitest). Some
  node-pack/runtime tests need `~/.openwop-packs` populated, so a fresh clone
  shows a few pre-existing failures unrelated to your change — diff against
  `origin/main` before blaming your work.
- **Sandbox gotcha:** `npx tsc/vitest/vite` can exit 194 silently — run the entry
  directly instead, e.g. `node node_modules/typescript/bin/tsc --noEmit`,
  `node node_modules/vitest/vitest.mjs run`.
- **Local CI gate (mirror of `.github/workflows/ci.yml`):** `npm run ci` from the
  repo root runs backend build + vitest (testcontainers skipped) and frontend lint
  + build + vitest in one pass. `npm run ci:full` adds the Playwright e2e + live
  testcontainer adapters (need Chromium/Docker). `npm run hooks:install` wires it as
  a pre-push hook (bypass once with `git push --no-verify`). This exists because the
  hosted GitHub Actions jobs currently fail at startup (0 steps run) — an
  account/billing or org Actions-policy matter on the private repo, NOT a code
  defect; until that's restored, `npm run ci` green is the trustworthy signal.

## Tracking architectural changes — ADRs ("ADR 0001" style)

Non-trivial changes to this app (new architecture, a feature-package, a cross-cutting
seam, a wire/replay/auth-affecting decision) are recorded as an **Architecture Decision
Record** before/with the implementation.

- **Where:** `docs/adr/` — one file per decision, named `NNNN-<kebab-slug>.md`,
  zero-padded sequentially (`0001-…`, `0002-…`). The first is
  `docs/adr/0001-feature-first-package-architecture.md`.
- **Status line:** each ADR opens with `Status:` — `Proposed` → `Accepted` →
  `implemented` (or `Superseded by NNNN`). Keep it current as the work lands.
- **What goes in one:** the decision, the alternatives weighed, the trade-offs, a
  phased implementation plan, and an open-questions/decisions checklist. When a phase
  ships, record it (a phase→commit/test table) and mark the ADR implemented.
- **Correct, don't rewrite history:** if implementation overturns a decision (e.g. ADR
  0001 moved the variant stamp from RFC 0056 annotations to `run.metadata` once we found
  annotations don't survive `:fork`), add an inline **correction note** at the affected
  section rather than silently editing the original rationale — the reasoning trail is
  the point.
- **Reference it in commits:** cite the ADR + phase in commit messages
  (`feat(crm): … (ADR 0001 §4 / Phase 4)`) so the code↔decision link is greppable.

Author/refine ADRs with the `/architect` skill when the change touches wire-shape,
capability gating, BYOK, replay/fork safety, or cross-host interop — those are the
decisions an ADR most needs to get right.

### A spec change needs an RFC in `openwop`, not just an ADR here

An ADR records a decision **for this host**. It is NOT a license to change the
OpenWOP wire. If a feature needs anything on the protocol surface — a new
run-event field, capability flag, event type, endpoint contract, auth/scale
profile, or a normative `MUST` — that belongs in a **new RFC in the `openwop`
project** (`../openwop/RFCS/`, authored from `0000-template.md` via the `/prd`
skill) and MUST reach at least `Accepted` *before/with* the host work. This app
is a **conformant host**; advertising a capability whose RFC isn't accepted is a
dishonest wire claim (and `OPENWOP_REQUIRE_BEHAVIOR=true` will fail it). A feature
that rides on an **already-Accepted** RFC needs no new RFC — e.g. ADR 0002's
enterprise SSO implements `openwop-auth-saml` / `openwop-auth-scim` from the
accepted **RFC 0050**, so it is host work. Host-extension routes under
`/v1/host/openwop-app/*` are non-normative and never touch the wire — they never need
an RFC. See `FEATURES.md` § "Adding a feature" for the same rule.

## Deploying the demo app (`app.openwop.dev`)

**Two independent deploys — get this wrong and you ship half a release.** Full
recipe in `DEPLOY.md`; live checks in `DEPLOY-SMOKE.md`. This is the gotcha digest:

- **`app.openwop.dev` = backend (Cloud Run `openwop-app-backend`) + frontend
  (Firebase Hosting target `app`), deployed SEPARATELY.** The root `Dockerfile`
  builds the backend only; the React SPA is a separate Firebase deploy. A
  backend-only redeploy won't ship frontend changes, and vice-versa.
- **Deploy order: backend FIRST, then frontend.** A new SPA calls new backend
  endpoints; if the frontend lands first they 404 until the backend catches up.
  Wait for the Cloud Run revision to serve 100% traffic before `firebase deploy`.
- **Deploy from a CLEAN `origin/main` checkout** (`git worktree add --detach
  /tmp/owp-deploy origin/main`) — never the shared tree, whose uncommitted work
  would ride into the `--source .` upload.
- **Backend redeploy (code change):**
  ```
  gcloud run deploy openwop-app-backend --source . \
    --region us-central1 --project openwop-dev --quiet
  ```
  **Pass NO `--set-secrets` / `--set-env-vars` / `--env-vars-file`.** A bare
  `gcloud run deploy` PRESERVES the live config; the fuller §14 command in
  DEPLOY.md is a stale snapshot and would wipe the 7-secret + env binding. To
  add/rotate ONE binding use the merge flags `--update-secrets` / `--update-env-vars`,
  never `--set-*`. The image vendors `schemas/`, `conformance-fixtures/`, `packs/`
  from the repo root — re-run `scripts/sync-{schemas,fixtures,packs}.sh` only if
  those changed upstream.
- **Frontend:** `( cd frontend/react && npm run build )` then
  `firebase deploy --only hosting:app --project openwop-dev`. `.env.production`
  wires the SPA to `/api` (a Firebase rewrite → Cloud Run) + cookie auth; SSE
  bypasses `/api` via a direct `*.run.app` URL — don't "simplify" that back to
  `/api` (the CDN buffers SSE).
- **Deploy account:** use the account with `run.admin` on `openwop-dev`
  (`gcloud run services list` → `LAST DEPLOYED BY`). The project-*owner* account
  may NOT have Cloud Run perms — the deployer is a different account (private memory).
- **Verify after both deploys:** `curl https://app.openwop.dev/` references the
  same `assets/index-<hash>.js` your local `dist/` built; `/api/readiness` → 200
  (503 only if a managed provider key is unconfigured).
- **Rate-limit gotcha:** `middleware/rateLimit.ts` enforces a per-IP read budget
  (default 60 req/min, separate from the tighter run-creation limits). A page that
  fans out many parallel reads on load can blow a single real user past it → a wall
  of `429`s. Fix WITHOUT a rebuild via an incremental env update (preserves all
  other config):
  ```
  gcloud run services update openwop-app-backend \
    --update-env-vars OPENWOP_RATELIMIT_IP_REQS_PER_MIN=300 \
    --region us-central1 --project openwop-dev
  ```
  Also prefer reducing front-end fan-out (batch reads; don't N+1 a per-row fetch).
