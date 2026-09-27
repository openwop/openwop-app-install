# Cloud Run-shape image for the workflow-engine reference application.
#
# Multi-stage Node 22-slim + esbuild bundle. The runtime image carries
# the bundled JS + the externals npm marks (better-sqlite3 native
# binding, etc.) + the parent-dir `providers.json` AI-provider catalog
# + the in-tree conformance fixtures (vendored into
# `apps/workflow-engine/conformance-fixtures/` from the canonical
# `conformance/fixtures/` via `scripts/sync-fixtures.sh`, so the
# deployed sample BE can stand in as a black-box conformance target
# per RFC 0024 etc.).
#
# Build context: the REPO ROOT, so both the backend source AND the shared
# `providers.json` are reachable. (Corrected 2026-08-10: this header described
# an `apps/workflow-engine/` context left over from the monorepo this app was
# extracted from. Every COPY below is repo-root-relative and always has been —
# the documented command was the stale part, not the paths.)
# Conformance fixtures are vendored as real files (symlinks would
# survive `gcloud run deploy --source`'s upload but break Docker COPY's
# build-context isolation). Run `scripts/sync-fixtures.sh` after any
# canonical fixture change.
#
# Deploy: use `scripts/deploy.sh` (ADR 0530). By hand, from the repo root:
#   node scripts/write-build-commit.mjs        # REQUIRED — see build-meta below
#   gcloud run deploy openwop-app-backend \
#     --source . \
#     --region us-central1 --project openwop-dev --quiet
#
# Run locally (without docker build):
#   cd backend/typescript && npm run dev

# ── Builder stage ────────────────────────────────────────────────────────
FROM node:22-slim@sha256:20b3a9e4bdfe6ee8cc7b14cc360fca2fb6d06f671e06aeb36feaa832364209dd AS builder

WORKDIR /app

# better-sqlite3 needs build tools at install time. Removed from the
# runtime stage below.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

# Build context is `apps/workflow-engine/`; pull only the backend
# subtree for `npm install` + esbuild.
# `npm ci`, NOT `npm install` (#2680, rationale CORRECTED in #2696 — the original
# claim that this image shipped a broken Azure backend was WRONG; see below).
#
# npm >= 11.5 has a regression that prunes the transitive dependencies of an
# optionalDependency during `npm install`: `@azure/identity` +
# `@azure/keyvault-keys` land WITHOUT `@azure/core-rest-pipeline`, so the Azure
# Key Vault KMS backend becomes present-but-unloadable. A/B inside this very
# image — same lockfile, same command, only npm differs:
#
#     npm 10.9.8 (what node:22-slim pins)  -> 466 pkgs, @azure/identity LOADS
#     npm 11.6.2 (installed over it)       -> 464 pkgs, ERR_MODULE_NOT_FOUND
#
# So the built image was NEVER broken, and `npm install` was not shipping a bug.
# `npm ci` is here to make that independent of luck: the moment node:22-slim bumps
# its bundled npm past 11.5, `npm install` would start silently shipping the
# pruned tree. `npm ci` installs exactly the lockfile and additionally fails loudly
# when package.json and the lockfile disagree.
#
# The lockfile is REQUIRED (npm ci errors without one); that is deliberate. It also
# makes the churn rule load-bearing: on npm >= 11.5 a local `npm install` rewrites
# package-lock.json with the PRUNED resolution, and committing that would poison
# this build for everyone — `npm ci` faithfully installs whatever the lockfile says.
COPY backend/typescript/package.json backend/typescript/package-lock.json* ./
RUN npm ci --include=dev

COPY backend/typescript/tsconfig.json backend/typescript/vitest.config.ts ./
COPY backend/typescript/src ./src
# `npm run build` = `node scripts/build.mjs` since ADR 0366 P1b — the builder
# needs the build script itself (a missing COPY here fails the image build).
COPY backend/typescript/scripts ./scripts

RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────
FROM node:22-slim@sha256:20b3a9e4bdfe6ee8cc7b14cc360fca2fb6d06f671e06aeb36feaa832364209dd AS runtime

WORKDIR /app

# Re-install production deps only. better-sqlite3 ships a prebuilt binary
# for node22 on linux-x64; the postinstall picks it up without rebuild.
COPY backend/typescript/package.json backend/typescript/package-lock.json* ./
RUN npm ci --omit=dev

# Bundle (./lib/index.js) + shared provider catalog. catalog.ts resolves
# `../providers.json` relative to `lib/`, so providers.json must land at
# `/app/providers.json` (sibling of lib/, parent of lib/index.js).
COPY --from=builder /app/lib ./lib
COPY providers.json ./providers.json

# Conformance fixtures, vendored at `conformance-fixtures/` (kept in sync from
# the canonical `conformance/fixtures/` via `scripts/sync-fixtures.sh`). Used by
# the `capabilities.fixtures` advertisement + black-box conformance runs, and by
# `host/{index,promptStore,promptCompose}.ts`, which now ALL resolve the dir via
# `locateRepoDir(__dirname, 'conformance-fixtures', ...)` — a layout-independent
# upward walk that lands on `/app/conformance-fixtures/` (sibling of `lib/`),
# matching the source-tree layout. (host/index.ts's lookup is lazy/tolerant —
# returns null when absent; the prompt loaders throw if absent, so the dir MUST
# be present in the default image.) One landing spot now that all three consumers
# share the same resolver + dir name.
#
# Gated by the `INCLUDE_CONFORMANCE_FIXTURES` build arg (default `true` for the
# openwop reference deploy). Forks that don't bundle the conformance surface set
# it `false`: docker build --build-arg INCLUDE_CONFORMANCE_FIXTURES=false ...
# When `false`, the image ships without the fixtures dir; the host's lookup
# returns null and `capabilities.fixtures` advertises an empty array.
ARG INCLUDE_CONFORMANCE_FIXTURES=true

# COPY can't be conditional on a build arg; the `conformance-fixtures` dir is
# always in the build context, so we conditionally REMOVE it post-COPY.
COPY conformance-fixtures ./conformance-fixtures
RUN if [ "$INCLUDE_CONFORMANCE_FIXTURES" != "true" ]; then \
      rm -rf ./conformance-fixtures; \
    fi

# JSON Schemas, vendored at `apps/workflow-engine/schemas/` (kept in
# sync from the canonical repo-root `schemas/` via
# `scripts/sync-schemas.sh`). The bundled `lib/index.js` walks parents
# from `/app/lib` via `host/_repoPath.ts::locateRepoSchemasDir()`
# looking for a sibling `schemas/` containing sentinels like
# `ai-envelope.schema.json` and `prompt-pack-manifest.schema.json`.
# Landing them at `/app/schemas/` makes the walk resolve on the first
# parent step. Without this, the module-load-time `SCHEMAS_DIR =
# locateRepoSchemasDir(__dirname, ...)` constants in
# `envelopeAcceptor.ts` and `promptPackLoader.ts` throw and the
# revision fails to start.
COPY schemas ./schemas

# Local-mount pack source. `bootstrap/mountLocalPacks.ts` symlinks
# `core.openwop.*` and `vendor.*` packs into the runtime pack dir at
# boot, and `bootstrap/agentPackResolver.ts::loadAllLocalAgents()`
# eager-loads every manifest agent into the AgentRegistry so the
# `/v1/agents` inventory + the Agents-tab Install-from-registry page
# reflect the local repo's packs. Without this COPY,
# `resolveLocalPacksDir()` walks up from `/app/lib`, finds no `packs/`
# dir, and the production revision shows zero agents even though local
# dev sees ~30.
#
# Vendored from repo-root `packs/` via `scripts/sync-packs.sh` (the
# canonical source is outside this build context). Run sync-packs.sh
# before `gcloud run deploy` when pack manifests change. Same pattern
# as `schemas/` + `conformance-fixtures/` above.
COPY packs ./packs

# Vendored bundle catalog (ADR 0366 P3): the marketplace's read-only
# feature-bundles endpoint serves `distributions/bundles.json` at runtime —
# absence degrades gracefully (the endpoint reports no catalog).
COPY distributions ./distributions

# In-tree workflow-chain packs (RFC 0013). The app-builder feature registers its
# design/repair chain at BOOT and hard-requires
# `examples/workflow-chain-packs/app-builder/pack.json` via
# `locateRepoDir(__dirname, 'examples', 'workflow-chain-packs/app-builder/pack.json')`
# (features/app-builder/designWorkflow.ts) — a fatal startup error if absent. The
# `workflowChainPackLoader` also reads this dir as a default root. Without this
# COPY the container exits(1) at boot ("design_chain_registration_failed"). Lands
# them at `/app/examples/workflow-chain-packs/` (sibling of `lib/`) so the upward
# walk resolves. Same vendoring pattern as `schemas/` + `packs/` above.
COPY examples/workflow-chain-packs ./examples/workflow-chain-packs

# In-tree connection packs (RFC 0095). `defaultConnectionPackRoots()` reads
# `<repo>/examples/connection-packs` as a default seam root — without this COPY a
# deployed container registers only the BUILTIN providers, so pack-only providers
# (e.g. `cohere-rerank`, the KB external reranker — ADR 0351 KB-8) silently can't
# be connected in production. Same vendoring pattern as workflow-chain-packs above.
COPY examples/connection-packs ./examples/connection-packs

# Deploy provenance (ADR 0518 correction). `build-meta/commit.txt` is written by
# `scripts/write-build-commit.mjs` before the source upload and read at runtime by
# `host/buildInfo.ts`, which locates this dir by walking up from `lib/` using
# `.gitkeep` as the sentinel.
#
# WHY IT IS IN THE IMAGE RATHER THAN AN ENV VAR: `OPENWOP_BUILD_COMMIT` is set on
# the SERVICE, so a bare `gcloud run deploy` — correct, since passing no `--set-*`
# is what preserves the live secret + env binding — PRESERVES the PREVIOUS deploy's
# value. The new revision then runs new code while reporting the old SHA with
# `stamped: true` (measured 2026-08-10: rev 00631 ran e65ff6888, reported 43b539ed2).
# A file in the image cannot drift that way: new code always means a new image.
#
# `commit.txt` is gitignored, so a clean clone has only `.gitkeep` here — that is
# why the COPY targets the DIRECTORY. (It is re-admitted to the Cloud Build upload
# by a `!build-meta/commit.txt` negation in .gcloudignore, which MUST stay below
# that file's `#!include:.gitignore` — last match wins, and above it the file
# silently drops out of the upload.)
#
# A FRESH checkout built without the writer reports `unknown`, which
# `scripts/verify-deploy.sh` hard-fails. A REUSED deploy checkout is the case to
# watch: the gitignored file persists there, so skipping the writer bakes the
# previous deploy's SHA instead. `scripts/preflight-deploy.sh` Gate 4 is what
# catches that; this COPY cannot.
COPY build-meta ./build-meta

# CPython-WASI runtime (ADR 0146 Phase 4a) — OPTIONAL, needed ONLY when an operator sets
# `OPENWOP_CODE_EXEC_RUNTIME=wasi`. Run `scripts/sync-pythonwasm.sh` before `gcloud run deploy`
# to populate `backend/typescript/vendor/python-3.12.0.wasm` (SHA-256-pinned, gitignored). The
# tracked `.gitkeep` keeps this COPY a no-op on builds that don't enable the in-process runtime.
COPY backend/typescript/vendor ./vendor

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Run as the unprivileged built-in `node` user (uid 1000) rather than root
# (CC-1). The boot path writes to the app tree — bootstrap/mountLocalPacks.ts
# symlinks packs into the runtime pack dir, and the default sqlite DSN creates
# ./data — so chown the tree to `node` first; otherwise those writes EACCES.
# (Hardening: the base image is digest-pinned above — FROM node:22-slim@sha256:…
#  — for reproducible builds. Refresh the digest when bumping the base: pull the
#  tag and copy the registry's docker-content-digest into both FROM lines.)
RUN chown -R node:node /app
USER node

CMD ["node", "lib/index.js"]
