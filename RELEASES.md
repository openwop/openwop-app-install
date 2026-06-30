# Releases

Human-readable index of openwop-app releases. The machine-readable source of truth
is [`releases.json`](./releases.json); the per-release "what changed + how to
upgrade" lives in [`CHANGELOG.md`](./CHANGELOG.md). Both are maintained by the
`/cut-app-release` skill (ADR 0052).

## How upgrades work

- **Immutable `vX.Y.Z` releases** (ADR 0052 §D7). `latest` (and the legacy
  `whitelabel` name) is a **moving alias** to the newest stable, so the `/install/`
  download URL is stable while each version is independently pinnable/auditable.
- **Skip intermediate versions freely** (§D2). On boot the app applies every
  pending DB schema migration (`__schema_version`) and app migration (`__app_meta`)
  in order — an instance N upgrading to N+k catches up in one start.
- **Required stops are the exception** (§D2). A release MAY declare
  `requiredStop: true` in `releases.json` when a migration cannot be safely skipped
  or needs a manual operator action; an upgrade must then land on that version
  before continuing. **Default: no required stops.**
- **Forward-only** (§D3). No down-migrations. Rollback = redeploy the prior image
  and restore a pre-upgrade database backup. Always back up before upgrading.

## Required-stop policy

A release SHOULD be marked a required stop only when at least one holds:
- a destructive or long-running data migration that must complete before the next,
- a breaking config/env change requiring manual operator action pre-upgrade,
- a migration not backward-compatible with the prior running binary (no
  expand/contract path for a rolling deploy).

## Version log

### v0.1.0 — 2026-06-30
- **Required stop:** no.
- **Schema:** sqlite 32 / postgres 29 · **App migrations:** 1.
- Inaugural versioned white-label release (ADR 0052) — replaces the rolling
  `whitelabel` tag with an immutable `v0.1.0` + a moving `latest` alias. Captures the
  pre-1.0 app, including the runtime white-label brand + generative theming
  (ADR 0170 / 0171). Fresh install — no prior version to upgrade from.
- [CHANGELOG §0.1.0](./CHANGELOG.md#010--2026-06-30)
