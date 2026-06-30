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
# Build context: `apps/workflow-engine/` (the parent of `backend/`) so
# both the backend source AND the shared `providers.json` are reachable.
# Conformance fixtures are vendored as real files (symlinks would
# survive `gcloud run deploy --source`'s upload but break Docker COPY's
# build-context isolation). Run `scripts/sync-fixtures.sh` after any
# canonical fixture change.
#
# Deploy (from repo root):
#   gcloud run deploy openwop-app-backend \
#     --source apps/workflow-engine/ \
#     --region us-central1 --allow-unauthenticated
#
# Run locally (without docker build):
#   cd apps/workflow-engine/backend/typescript && npm run dev

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
COPY backend/typescript/package.json backend/typescript/package-lock.json* ./
RUN npm install --include=dev

COPY backend/typescript/tsconfig.json backend/typescript/vitest.config.ts ./
COPY backend/typescript/src ./src

RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────
FROM node:22-slim@sha256:20b3a9e4bdfe6ee8cc7b14cc360fca2fb6d06f671e06aeb36feaa832364209dd AS runtime

WORKDIR /app

# Re-install production deps only. better-sqlite3 ships a prebuilt binary
# for node22 on linux-x64; the postinstall picks it up without rebuild.
COPY backend/typescript/package.json backend/typescript/package-lock.json* ./
RUN npm install --omit=dev

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
