# ADR 0077 - Data classification, PII log masking & retention sweep

**Status:** Accepted (implemented 2026-06-19 — Phases 1–3; see Phase correction notes)
**Date:** 2026-06-19
**PRD:** the supplied product brief behind ADR 0078 — §Data Model & Classification (Public/Internal/Confidential-PII; 365-day retention; PII purge), §Threat Model (PII exposure in logs → control: log masking for all PII fields), §Compliance (Right to Explanation, audit trail). Factored out of ADR 0078 because this is **horizontal platform hardening** that protects every feature, not that suite alone.
**Depends on / composes:** ADR 0028 (connector-action governance — `host/governanceService.ts`, where `retention` config already lives but the sweep is unbuilt), ADR 0020 (consent), the GDPR subject-erasure fan-out (`host/subjectErasure.ts`), the log scrubber (`byok/textRedaction.ts`, `observability/logger.ts`), the error-envelope sanitizer (`middleware/sanitize.ts`).
**Surface:** host-internal — a classification taxonomy + a PII-aware log-masking layer + a retention sweep daemon. No new external routes beyond admin config under `/v1/host/openwop-app/governance/*`.
**RFC gate:** **no new RFC.** Logging, classification, and retention are host-internal concerns; nothing on the OpenWOP wire changes.

## Why this exists

The audit found three real gaps the PRD requires that the platform does **not** yet cover:

1. **PII log masking — PARTIAL.** `byok/textRedaction.ts` + `middleware/sanitize.ts` scrub **credentials/entropy-shaped secrets** (JWTs, `sk-`/`xai-` keys, long hex) from logs (SEC-8). They do **not** mask arbitrary PII (employee names, emails, phone). The PRD's §9 control is "log masking for all PII fields."
2. **Data classification — MISSING.** No Public/Internal/Confidential-PII taxonomy exists. Governance has `retention` config fields but no classification labels on entities.
3. **Retention sweep — MISSING.** `host/governanceService.ts` *stores* `retention: { assistantGraphDays?, sourceDerivedDays? }` but the **sweep daemon is unbuilt** (it was assumed to be "ADR 0029's" — ADR 0029 is actually evals/health-indexing, so the sweep has no owner). GDPR on-demand erasure (`subjectErasure.ts`) exists, but **time-based retention** does not.

These are not suite-specific: every feature that stores PII (CRM, profiles, KB, comments) benefits. Building them here, once, is the single-source-of-truth move.

## Feature-refinement audit

| Concept | Existing owner (`file:line`) | Decision |
|---|---|---|
| Credential/secret log scrub | `byok/textRedaction.ts` (per-line, `OPENWOP_LOG_SCRUB`); `observability/logger.ts` (applies to msg+fields) | **Extend** — add a PII-field masking pass alongside the secret scrub; do not replace it. |
| Error-envelope sanitization | `middleware/sanitize.ts` (`sanitizeForErrorMessage`, `sanitizeDetails`) | **Extend** with PII patterns/field-name awareness. |
| Retention config storage | `host/governanceService.ts` (`GovernancePolicy.retention`) (ADR 0028) | **Own the sweep** — add the daemon the config always implied; tombstone, never silent cascade. |
| On-demand subject deletion | `host/subjectErasure.ts` (cross-feature `purgeSubject` fan-out) (ADR 0020 consent) | **Reuse** — the retention sweep calls the SAME per-feature purge handlers; one deletion path, time-triggered. |
| Agent-memory secret redaction (SR-1) | `host/subjectMemory.ts` (`scrubSecretShaped` chokepoint) | **Reuse the chokepoint pattern** — PII masking is a sibling pass at the same boundaries. |

**No collision.** Governance owns retention config; we add the missing executor. Erasure owns per-feature purge; we add a time trigger. The log scrubber owns redaction; we add a PII pass. Nothing is forked.

## Decision

1. **Classification taxonomy** — a small `DataClassification = 'public' | 'internal' | 'confidential-pii'` label, attachable to feature data models (a field on durable rows + a registry of PII field-names per entity). Features declare which fields are PII (e.g. employee name, email). The default for unlabeled data is `internal` (fail-safe-ish; PII must be explicitly labeled to get masking — see Open Questions on default).

2. **PII-aware log masking** — extend the log pipeline (`textRedaction.ts` + `logger.ts` fields pass) with a PII masking layer: (a) field-name-aware masking (a configurable PII field-name set → values replaced with a stable hash or `«redacted-pii»`), and (b) optional pattern masking (email/phone regex) behind a flag. Off by default to avoid over-masking; **on by default for `confidential-pii`-classified contexts**. Composes with the existing secret scrub (both run).

3. **Retention sweep daemon** — a periodic sweep (same lease/idempotency pattern as `scheduleDaemon.ts`) that, per tenant + classification, finds rows past their retention window and invokes the existing `subjectErasure` per-feature purge handlers (tombstone, never silent cascade). `confidential-pii` defaults to the PRD's 365-day window; `internal` configurable; agent-interaction logs honored. Auditable: every purge emits an audit row.
   > **Correction (ADR 0081 P5 follow-up — `confidential-pii` is now OPT-IN, no 365 default):** once ADR 0081 P5 added retention purgers for durable, user-authored records (contacts/profiles/comments), the implicit 365-day `confidential-pii` default became a data-loss footgun — registering *any* governance policy (e.g. a provider allowlist) silently enrolled a tenant's PII in deletion the moment `OPENWOP_RETENTION_SWEEP_ENABLED=true`. `SWEPT` `confidential-pii` `defaultDays` is therefore flipped to `null` (opt-in, matching `internal`): a PII purge now runs **only** when an admin explicitly sets `retention.confidentialPiiDays`. The PRD's 365 is the recommended value an admin *sets*, not an implicit default. (`host/retentionSweepDaemon.ts`; opt-in guaranteed by `retention-sweep.test.ts`.)

**Data model:** the **retention *window* config** per `(tenant, classification)` extends
`GovernancePolicy.retention` (tenant-scoped, durable, admin-editable — Phase 3). The
**PII field registry** does NOT live in governance: it is a process-global, code-declared,
static map owned by a dedicated host module `host/dataClassification.ts` (Phase 1), into
which features register via `declarePiiFields(...)` (the `registerSubjectEraser` side-effect
pattern). Two different lifecycles, two owners — deliberately not conflated. No new external
storage for the registry.

> **Phase 1 correction (architect review 2026-06-19):** the taxonomy + registry ship in a new
> `host/dataClassification.ts`, NOT in `governanceService.ts` (which is tenant config; the
> registry is static + code-declared). Registry is a synchronous `Map<entity, Set<field>>`
> with a per-entity query (`isPiiField`) AND an entity-agnostic union (`isKnownPiiFieldName`) —
> the latter is what the Phase-2 value-only log deep-walk can call (it loses entity context).
> Default classification is `internal` (operational; `confidential-pii`-by-default = mask
> everything, rejected). A `looksLikePiiName` heuristic ships for Phase-2 secondary masking +
> a lint. Features declare at module load (`crm.contact`, `users.user` first); a test asserts
> the high-risk entities are registered (catches a missing side-effect import).

> **Phase 2 correction (architect review 2026-06-19):** Decision §2's "off by default" is
> **overturned → ON by default** (Matrix row 2 likewise). The off-by-default rationale assumed
> value-regex masking; the implemented pass is **key-targeted** (masks only values whose KEY
> is a declared PII field or a high-precision heuristic match), so it cannot over-mask
> operational fields — shipping it off would just leave PII in logs. Other corrections:
> (a) a NEW key-aware walk `maskPiiDeep` was required — `sanitizeFreeTextDeep` is value-only
> and loses the key, so it could not be extended in place; (b) **fields-only** — the log `msg`
> string is secret-scrubbed but NOT PII-masked (masking it would need value-content regex, the
> rejected alternative); (c) format = `pii_<first-10-hex of sha256(value)>` — PLAIN keyless
> SHA-256 for cross-restart correlation; documented as correlation-preserving pseudonymization,
> NOT encryption (low-cardinality PII is dictionary-reversible — acceptable for the
> casual-exposure threat model; Open Q2's "reversible only with the key" HMAC framing is thus
> superseded); (d) two independent flags `OPENWOP_LOG_MASK_PII` + `OPENWOP_LOG_MASK_PII_HEURISTIC`
> (both default ON), gated separately from `OPENWOP_LOG_SCRUB`; (e) `middleware/sanitize.ts`
> (error envelopes) is **NOT** extended in Phase 2 (a 4xx echoes the caller's own input — not a
> log leak; the ADR audit-table "extend sanitize.ts" row is declined); (f) **known property:**
> registry-driven masking is only as complete as the loaded module graph — masking unit tests
> must import the declaring services to populate the registry.

> **Phase 3 correction (architect review 2026-06-19):** Decision §3 + audit-table line
> "reuse the existing `subjectErasure` per-feature purge handlers" is **overturned — it is
> infeasible**. `SubjectEraser` is subject-keyed + age-blind; retention is time-based +
> subject-agnostic, and erasing a subject would delete their FRESH rows too. Phase 3 ships a
> **new sibling seam `registerRetentionPurger(fn)`** (`host/retentionPurger.ts`) — the
> registration *pattern* of `subjectErasure` is reused, the *handlers* are not. Each feature
> implements "delete my rows of classification C older than `cutoffIso` for `tenantId`" (only
> the feature knows its age field). Other points: (a) the **sweep daemon emits the audit row
> itself** (`storage.appendAudit`, action `governance.retention.purged`) — erasure does NOT
> audit, so this is the daemon's job; the audit row IS the tombstone (no separate tombstone
> store exists). (b) `GovernancePolicy.retention` extended with `confidentialPiiDays`
> (default 365) + `internalDays` (no default — operational data isn't auto-deleted);
> `public` is never swept. (c) Daemon mirrors `refreshDaemon`/`scheduleDaemon`: pure
> `processRetentionSweep(deps, now)`, per-(tenant,classification,day) `claimIdempotency`
> lease (no double-sweep across the fleet), explicit `listGovernedTenants()` enumeration
> (fail-closed — never a wildcard/cross-tenant purge), default-OFF via
> `OPENWOP_RETENTION_SWEEP_ENABLED` gating the *start*. (d) **Realistic scope:** seam +
> daemon + config + **one** wired purger (`analytics`, whose events are PII-bearing); full
> per-feature coverage is a documented rollout, exactly as `subjectErasure` started with
> analytics+email.

## Feature Evaluation Matrix (governance-scoped)

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature-package | Not a feature-package — **core governance extension** (`host/governanceService.ts` + the log pipeline + a daemon). Features *opt in* by declaring classified fields. |
| 2 | Toggle | Retention sweep gated by an env flag (`OPENWOP_RETENTION_SWEEP_ENABLED`, default off until validated, like other daemons); PII masking gated by `OPENWOP_LOG_SCRUB` siblings. |
| 8 | RBAC + isolation | Retention config behind `host:org:manage`/admin scope; sweep runs per-tenant (no cross-tenant purge); fail-closed (never purge on ambiguous tenant). |
| 9 | Replay/fork | Masking is a logging concern (no run-state effect); purge tombstones are deterministic and audited. |

## Phased plan

1. **Classification taxonomy + PII field registry** — the label type + per-entity PII declarations for the highest-risk features first (insights-suite, profiles, CRM). *Gate:* unit tests on the registry.
2. **PII log masking** — the masking pass in `textRedaction.ts`/`logger.ts`/`sanitize.ts`. *Gate:* a "no PII in logs" test (employee name in → masked out) + the existing secret-scrub tests still pass.
3. **Retention sweep daemon** — the periodic sweep calling `subjectErasure` purge handlers, per classification window, audited. *Gate:* a sweep test (row past window → tombstoned + audit row; row within window → untouched; cross-tenant isolation).

## Alternatives weighed

- **Mask everything by regex (no classification).** Rejected — over-masks legitimate operational logs and still misses structured PII; field-name-aware classification is precise and auditable.
- **Rely on GDPR on-demand erasure only.** Rejected — the PRD requires *time-based* retention + proactive log masking, which on-demand erasure doesn't provide.
- **Bundle into ADR 0078.** Rejected — this protects every feature; bundling would scope horizontal platform safety to one feature and invite drift.

## Open questions

1. **Default classification** — unlabeled data = `internal` (operational default) vs `confidential-pii` (safest). Lean `internal` with a lint/audit that flags entities storing obvious PII fields without a label, to avoid silent under-classification.
2. **Masking determinism** — stable per-value hash (preserves correlation in logs) vs opaque `«redacted-pii»` (no correlation). Lean stable-hash for debuggability, reversible only with the key (held host-side).
3. **Retention granularity** — per-classification windows (proposed) vs per-entity overrides. Start per-classification; add overrides if a feature needs them.
4. **Right-to-Explanation (PRD §11)** — AI-derived readiness scores need an explanation trail; this likely rides the audit-trail + provenance work in ADR 0078 (Verify Source) rather than this ADR. Cross-referenced, not owned here.

## RFC verdict

**Host-internal — no new RFC.** Classification, log masking, and retention are entirely host-side; no wire shape, capability, or event changes.
