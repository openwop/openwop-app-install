# ADR 0052 — Versioned app releases + built-in migrations (and the `/cut-app-release` skill)

**Status:** implemented (Phases 1–5). Backend: version SSoT (`/VERSION` → `src/version.ts`)
surfaced at `/readiness` + recorded in `__app_meta` (sqlite mig 28 / postgres mig 25); the
boot-time app-migration runner (`host/appMigrations.ts`). Tooling: `CHANGELOG.md`,
`RELEASES.md`/`releases.json`, `scripts/{bump-version,check-migration-integrity}.mjs`, and
the `/publish-whitelabel` → `/cut-app-release` skill rename/rework. Docs: `DEPLOY.md`
§ "Upgrading". The one **companion change in `openwop/openwop-app-install`** —
`publish-release.yml` cutting immutable `vX.Y.Z` + maintaining the `latest` alias — lands
there, not here (flagged in the skill).
**Date:** 2026-06-15
**Toggle:** none — this is release-engineering / operability infrastructure, not a
product feature-package.
**Capability:** no new `AgentCapabilityId`. Surfaces the existing `service.version`
honestly (see D4); no new wire field.
**Depends on / composes:** the existing forward-only DB migration runner
(`storage/{sqlite,postgres}/schema.ts`), the white-label publish flow
(`scripts/publish-install-repo.sh`, `scripts/build-whitelabel-zip.sh`,
`.claude/skills/publish-whitelabel/`), `CHANGELOG`/`ROADMAP.md`/`FEATURES.md`
conventions, ADR 0001 §1.5 (feature migrations never own a private schema counter),
ADR 0003/0010 (existing data-migration precedents). Distinct from the spec-corpus
`/release` skill (`.agents/skills/release/`), which versions the **OpenWOP protocol +
SDKs + conformance** — a different artifact.
**Surface:** repo tooling + boot-time migration runner + the public install-repo
release. No `/v1` route contract changes beyond surfacing `service.version`.
**RFC gate:** **NO new RFC.** Host/app release engineering; nothing touches the OpenWOP
wire (surfacing the already-defined `service.version` at `/readiness` is honesty, not a
new field). See § RFC gate.

## Why this exists

openwop-app ships to self-hosters and white-label vendors as a downloadable bundle, and
today that bundle is a **rolling `whitelabel` release** — a single moving tag whose assets
are overwritten on every publish (`.claude/skills/publish-whitelabel/SKILL.md:126-129`:
*"A single `whitelabel` tag keeps the `/install/` URL stable … For immutable per-release
bundles you'd switch to `vX.Y.Z` tags"*). That means a customer cannot pin, audit, or
reason about "which version am I on, and what do I have to do to upgrade." There is no
app **release version**, no operator-facing release notes, and no app-level upgrade
contract.

What openwop-app **does** already have is the hard part of most release systems — a
**forward-only, skip-intermediate DB migration runner**: a numbered `MIGRATIONS` map +
`LATEST_SCHEMA_VERSION` + a `__schema_version` table, applied `current+1 … LATEST` on boot
(`storage/sqlite/schema.ts:709-742`, `storage/postgres/schema.ts:633-663`). This is, in
effect, the **WordPress `db_version`/`dbDelta` model**. The gap is the **app version axis
on top of it**, plus the release pipeline and the operator upgrade story.

This ADR decides how openwop-app cuts **immutable, semver-versioned releases with built-in
migrations a customer can safely apply to upgrade from any prior version**, and reworks +
renames the publish skill to `/cut-app-release`.

## Research — how mature self-hosted OSS ships versioned upgrades

Surveyed three deliberately different philosophies; the findings drive the decisions.

| Dimension | **WordPress** | **GitLab** | **PostgreSQL** |
|---|---|---|---|
| **Version scheme** | NOT semver; first two digits = major (features/APIs, ~every 4–5 mo), third = minor (security/maintenance, auto-installed); counts upward (6.9→7.0 == 6.8→6.9) | Monthly `MAJOR.MINOR.patch`; breaking changes batched into majors; deprecations pre-announced | `MAJOR.MINOR`; major = storage-format may change, minor = bug/security only |
| **Schema/app version coupling** | **Decoupled** — `db_version` integer ≠ WP version; on upgrade if code's `$wp_db_version` > stored `db_version`, run `upgrade_NNN()` steps + `dbDelta()` | Migrations tied to release; **background (post-deploy) migrations** run async after upgrade | **Decoupled** — minor never changes storage; major may |
| **Skip intermediate versions?** | Yes — `dbDelta` is idempotent (adds missing cols/indexes, preserves data); upgrade steps replay forward | **No, past "required stops"** — must upgrade *through* x.2/x.5/x.8/x.11 so background migrations drain; `upgrade_path.yml` is the SSoT | Minor: yes (swap binaries). Major: `pg_upgrade` in-place per hop |
| **Migration mechanics** | `dbDelta()` idempotent CREATE TABLE diffing + sequential `upgrade_NNN()` data steps; runs on first admin load post-update | Regular (blocking) + background (async, batched) migrations; must finish before next stop | `pg_upgrade --link` reuses data files (near-zero downtime); else dump/restore |
| **Rollback** | None first-class — restore from backup | Restore from backup; background migrations make down-paths impractical | Keep old cluster / restore |
| **Release notes** | Per-version, operator-facing, security clearly flagged | Per-version + an **upgrade-path tool**; deprecations list; required-stop call-outs | Release notes per minor/major; explicit "this requires pg_upgrade" |
| **Operator checklist** | "5-minute upgrade," back up first, DB upgrade auto-runs | Back up, follow the required-stop path, drain background migrations, check deprecations | Back up, downtime window, run pg_upgrade, verify |

Plus the two conventions we already half-use: **SemVer** (`MAJOR.MINOR.PATCH`: breaking /
additive-compatible / fix; `0.x` = anything may change) and **Keep a Changelog**
(`[Unreleased]` + Added/Changed/Deprecated/Removed/Fixed/Security, dated releases).

**What we adopt vs. skip:**
- **Adopt (WordPress):** decouple the app version from the schema version; keep the
  idempotent, forward-only, skip-intermediate migration runner as the default upgrade
  path; auto-run migrations on boot; operator-facing release notes with security flagged.
- **Adopt (GitLab):** a **required-stop** escape hatch for the rare migration that can't be
  safely skipped, recorded in one SSoT manifest — but OFF by default (most of our
  migrations are small/additive).
- **Adopt (PostgreSQL / SemVer):** **immutable per-version artifacts**; semver to
  communicate breaking-vs-additive to integrators (we make wire-capability claims, so the
  WP "just count up" scheme would under-inform). Forward-only + restore-from-backup
  rollback.
- **Skip:** WordPress's non-semver counting; GitLab's *mandatory* required-stops on every
  cadence (overkill at our migration sizes); first-class down-migrations (maintenance tax,
  unsafe for data migrations).

## Boundaries / existing-seam audit (MANDATORY)

- **Migration runner already exists and is the WP model.** Forward-only numbered
  `MIGRATIONS`, `LATEST_SCHEMA_VERSION` (sqlite 25 / postgres 22 at audit), `__schema_version`
  table, `applyMigrations()` loops `current+1 … LATEST` and writes the new version
  (`sqlite/schema.ts:709-742`). Fresh install (`current=0`) inserts `LATEST`; upgrade
  updates it. **Idempotent** (`CREATE TABLE IF NOT EXISTS` / `addColumnIfTableExists`,
  `sqlite/schema.ts:695-707`). **Data migrations already supported** (e.g. sqlite mig-21
  backfills `agent_run_activity` from `runs`). → **Compose, do not fork.** ADR 0001 §1.5:
  a feature MUST NOT own a private schema-version counter — there is ONE counter.
- **App version is split + not surfaced.** `backend/typescript/package.json:3` and
  `frontend/react/package.json:3` are both `0.1.0` (can drift); runtime version is the env
  `OPENWOP_SERVICE_VERSION` (default `0.1.0`, `src/index.ts:115-130`); `/readiness`
  (`routes/health.ts`) exposes **no version**. → no single source of truth; the deploy can't
  be version-verified.
- **Publish is rolling.** `build-whitelabel-zip.sh` `git archive HEAD` → strip secrets/meta
  → `publish-install-repo.sh` mirrors into the public `openwop/openwop-app-install`, whose
  `publish-release.yml` cuts the **rolling `whitelabel`** release + sigstore attestation
  (single release authority, no per-version tag).
- **No root `CHANGELOG.md`.** ADRs + `ROADMAP.md`/`FEATURES.md` are the de-facto log; none
  is operator-facing release notes.
- **`/release` is a different artifact** — the spec corpus (TS/Python/Go SDK + conformance,
  `.agents/skills/release/`). Keep separate; this ADR is the **app**.

## Decisions

### D1 — Two independent version axes (app SemVer ⟂ schema counter)
- **App release version = SemVer `MAJOR.MINOR.PATCH`** (single source of truth, D4):
  - **MAJOR** — a breaking change to a customer-facing contract: removing/renaming a
    host-extension route or config/env var, dropping an advertised capability, a migration
    that is **not** safe for the prior binary (needs ordered downtime), or raising a minimum
    in a breaking way.
  - **MINOR** — additive & backward-compatible: a new feature/toggle/route, a new
    advertised capability, **or any forward-only additive DB/app migration**.
  - **PATCH** — bug/security fix with no contract or schema change.
  - **`0.x` (today `0.1.0`)** — per SemVer §4, breaking changes MAY land in a `0.MINOR`
    bump during bootstrap; documented as the pre-1.0 caveat.
- **Schema version = the existing `LATEST_SCHEMA_VERSION` integer**, unchanged mechanism,
  **decoupled** from the app version (WordPress `db_version` ≠ WP version; Postgres minor
  doesn't bump storage format). Most releases will not bump it.
- **One-way coupling rule:** a release that bumps `LATEST_SCHEMA_VERSION` (or adds an
  app-migration, D5) MUST be **≥ MINOR** (additive) or **MAJOR** (non-backward-compatible).
  A release with no migration may be any level. *(Resolves the app-version ↔ schema-version
  open question: independent axes + this single constraint.)*

### D2 — Skip-intermediate by default; required-stops only when forced
The runner already replays every migration `current+1 … LATEST` in one boot, so a customer
on app version *N* upgrading to *N+k* gets all migrations applied in order — **skipping
intermediate APP versions is safe by default** (the WordPress model). Adopt + formalize.
Add a GitLab-style **required-stop** escape hatch: a release MAY declare itself a required
stop (a destructive/long data migration, or a breaking config change needing manual
operator action). Required stops live in **one SSoT manifest** (`RELEASES.md` +
machine-readable `releases.json`) that `/cut-app-release` reads and the upgrade docs render.
Default: **no required stops.**

### D3 — Forward-only; rollback = redeploy prior image + restore DB backup
No down-migrations (the runner is forward-only and stays that way — reversibility is a
maintenance tax and unsafe for data migrations; WordPress/Postgres/GitLab all effectively
do restore-from-backup). The operator upgrade contract (D6) **REQUIRES a backup before
upgrade**; rollback = redeploy the prior versioned image + restore the snapshot.

### D4 — One canonical app version, stamped + surfaced + recorded
- **SSoT:** a single root `VERSION` (or root `package.json` `version`) is authoritative.
  The build stamps it into the backend image (`OPENWOP_SERVICE_VERSION`) and the SPA, and
  `/cut-app-release` bumps it + both package.jsons **in lockstep**.
- **Surface it:** add `version` to `/readiness` (and `service.version` in
  `/.well-known/openwop`, already a host field) so a deploy is version-verifiable — closing
  the gap where the live app reports no version.
- **Record the applied app version:** persist it (a small `__app_meta` row, sibling to
  `__schema_version`) on boot, so an upgrade can detect "from version X" and a fresh install
  (no row) is distinguished from an upgrade (older row). *(Resolves "where applied version
  is recorded + fresh vs upgrade.")*

### D5 — App-level migrations, not only schema
Some upgrades need **non-schema** one-shots (re-seed a pack, move a config key, rewrite
stored blobs, backfill from an external source) — ADR 0003's identity adopt-migration and
ADR 0010's notifications lift-and-shift are precedents. Add a parallel **app-migration
runner**: version-keyed (a monotonic app-migration counter), run on boot **after** schema
migrations, **idempotent**, **forward-only**, recorded in `__app_meta`. Same discipline as
the schema runner; it does NOT fork the schema counter (ADR 0001 §1.5).

### D6 — Release notes + operator upgrade contract (Keep a Changelog)
Add a root **`CHANGELOG.md`** (Keep-a-Changelog: `[Unreleased]` + Added/Changed/Deprecated/
Removed/Fixed/Security). `/cut-app-release` collapses Conventional Commits since the last
tag into reader-facing notes, and every release MUST carry an **"Upgrading from `<prev>`"**
operator section flagging: required-stop status (D2), which schema/app migrations will run,
breaking config/env changes, **backup + downtime** expectations, and **post-upgrade
verification** (`/readiness` returns the new `version`; smoke the changed surface). ADRs stay
the deep "why"; CHANGELOG is the operator "what + how to upgrade."

### D7 — Immutable `vX.Y.Z` releases; `latest` is a moving alias
The publish flow moves from the single rolling `whitelabel` tag to **immutable
`vMAJOR.MINOR.PATCH` releases** in the install repo — each carrying the bundle + sigstore
attestation + release notes + the migration/required-stop manifest. Keep **`latest`** (and
the existing `whitelabel` name as its alias) pointing at the newest stable so the
`/install/` URL stays stable (SKILL.md:126-129 already anticipates this). Versioned releases
are the source of truth; `latest` is convenience.

### The skill: rename `/publish-whitelabel` → `/cut-app-release`
New responsibilities (supersedes the rolling-only flow):
1. **Compute the next semver** from the change set (Conventional Commits → major/minor/patch),
   enforcing the D1 schema-bump ⇒ ≥ minor constraint.
2. **Bump the SSoT version + both package.jsons in lockstep** (D4).
3. **Generate release notes** — collapse commits into `CHANGELOG.md` + the "Upgrading from"
   section (D6); update `RELEASES.md`/`releases.json` (D2/D7).
4. **Migration-integrity gate (pre-publish):** every `LATEST_SCHEMA_VERSION` gap has a
   migration; migrations are forward-only + idempotent (re-run is a no-op); the required-stop
   manifest is consistent; app-migration counter is contiguous.
5. **Build the versioned bundle + tag `vX.Y.Z`**, mirror to the install repo; CI cuts the
   **immutable** release + repoints `latest`.
6. Keep `/release` (spec corpus) untouched and distinct.

## Data model / artifacts (additive)

```
VERSION                      # NEW — root SSoT for the app semver (or root package.json version)
CHANGELOG.md                 # NEW — Keep-a-Changelog, operator-facing
RELEASES.md + releases.json  # NEW — release manifest incl. required-stop flags (D2/D7)

// storage — sibling to __schema_version (D4/D5), both adapters
__app_meta(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)   # app_version, app_migration_version
// app-migration runner: APP_MIGRATIONS: Record<number,(ctx)=>Promise<void>>, forward-only, idempotent

// runtime
GET /readiness → { ..., version }            # NEW field (D4)
/.well-known/openwop service.version          # populated from the SSoT (already a host field)
```

## Phased plan

- **Phase 1 — version SSoT + surfacing + recording.** Root `VERSION`; build stamps it;
  `/readiness` returns `version`; `__app_meta` records applied app version on boot; fresh-vs-
  upgrade detection.
- **Phase 2 — release notes + manifest.** `CHANGELOG.md` (Keep a Changelog) + the "Upgrading
  from" template; `RELEASES.md`/`releases.json` with the required-stop field.
- **Phase 3 — app-migration runner.** Boot-time, post-schema, version-keyed, idempotent,
  forward-only, recorded in `__app_meta`; one example migration to prove the seam.
- **Phase 4 — `/cut-app-release` skill.** Rename + rework `publish-whitelabel`; semver
  computation, lockstep bump, notes generation, migration-integrity gate, versioned bundle +
  `latest` alias; install-repo `publish-release.yml` updated to cut immutable `vX.Y.Z`.
- **Phase 5 — operator docs.** `DEPLOY.md` upgrade section + the operator upgrade contract
  (backup → apply → verify); document the `0.x` caveat and the multi-instance migration rule.

## RFC gate

**NO new RFC.** This is host/app release engineering. The only wire-adjacent change is
populating `service.version` (an existing `/.well-known/openwop` host field) and adding
`version` to the non-normative `/readiness` host endpoint — honesty, not a new contract.
Migrations, versioning, release artifacts, and the skill are all host-internal. `/release`
(the spec corpus) remains the home for any actual protocol/SDK/conformance version change.

## Alternatives weighed

- **WordPress-style non-semver counting.** Rejected — the app advertises OpenWOP
  capabilities; integrators need breaking-vs-additive signalled, which "count up" hides.
- **Mandatory required-stops on a fixed cadence (GitLab).** Rejected as default — our
  migrations are small/additive; the skip-intermediate runner already handles N→N+k. Kept
  as an **opt-in** escape hatch (D2).
- **First-class down-migrations / reversible migrations.** Rejected — maintenance tax,
  routinely wrong for data migrations; forward-only + backup is the OSS norm (D3).
- **Couple app version == schema version.** Rejected — most releases have no schema change;
  Postgres/WP both decouple (D1).
- **Keep only the rolling `whitelabel` tag.** Rejected — no immutable provenance, can't
  pin/audit a customer's version, weaker per-version attestation (D7). `latest` alias keeps
  the stable URL.

## Open questions

- **Auto-apply on boot vs. an explicit `migrate` admin step.** WordPress auto-runs on first
  admin load; GitLab is explicit. Lean: **auto on boot** for schema (matches today) +
  **gate destructive app-migrations** behind a required-stop / env flag.
- **Support / LTS window** — how long a `MAJOR.MINOR` keeps getting security patches. Defer
  to a follow-up once cadence is known.
- **White-label vendor versioning** — how a vendor fork's version relates to upstream (e.g.
  build-metadata suffix `1.4.2+vendorname`).
- **Multi-instance rolling-deploy safety** — an additive forward-only migration MUST be safe
  for the old and new binaries running concurrently (expand/contract). Capture as a
  migration-authoring rule in Phase 5; consider an integrity-gate lint.

## Phase → commit/test (filled on implementation)

| Phase | Status | Tests |
|---|---|---|
| 1 — version SSoT + surface + record (`/VERSION`, `src/version.ts`, `index.ts`, `routes/health.ts`, `__app_meta` sqlite mig 28 / pg mig 25, `host/appVersion.ts`) | implemented | `test/app-version-migrations.test.ts` (recording), `test/readiness.test.ts` (`version` on /readiness), migration-journey + storage-parity green |
| 2 — CHANGELOG + release manifest (`CHANGELOG.md`, `RELEASES.md`, `releases.json`) | implemented | n/a (docs) |
| 3 — app-migration runner (`host/appMigrations.ts`) | implemented | `test/app-version-migrations.test.ts` — order, forward-only, idempotent, counter |
| 4 — `/cut-app-release` skill (`.claude`+`.agents/skills/cut-app-release/`, `scripts/{bump-version,check-migration-integrity}.mjs`) | implemented | `check-migration-integrity.mjs` runs green |
| 5 — operator upgrade docs (`DEPLOY.md` § Upgrading) | implemented | n/a (docs) |

## References

- WordPress — [Version Numbering](https://make.wordpress.org/core/handbook/about/release-cycle/version-numbering/), [Releasing Minor Versions](https://make.wordpress.org/core/handbook/about/release-cycle/releasing-minor-versions/), [`dbDelta()`](https://developer.wordpress.org/reference/functions/dbdelta/), [Upgrading WordPress](https://developer.wordpress.org/advanced-administration/upgrade/upgrading/)
- GitLab — [Upgrade paths](https://archives.docs.gitlab.com/18.1/update/upgrade_paths/), [Avoiding required stops](https://docs.gitlab.com/development/avoiding_required_stops/)
- PostgreSQL — [Upgrading a cluster](https://www.postgresql.org/docs/current/upgrading.html), [`pg_upgrade`](https://www.postgresql.org/docs/current/pgupgrade.html), [Versioning policy](https://www.postgresql.org/support/versioning)
- Conventions — [Semantic Versioning 2.0.0](https://semver.org/), [Keep a Changelog](https://keepachangelog.com/)
