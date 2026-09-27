# ADR 0430 — KickTodo challenge-content localization: translations as first-class immutable versions

Status: **implemented** (P1–P5, 2026-07-19; record below)

**Requirements source:** `docs/kicktodo-prd.md` §14 Localization ("all new UI strings externalized into the app's supported locales; **challenge content locale is versioned separately from UI locale**"), §12 Wave 4 ("Portuguese and Spanish content expansion based on market evidence").
**Depends on / extends:** **ADR 0414 `kicktodo-core`** (`ChallengeDefinition` is the catalog owner) + **ADR 0415 `kicktodo-creator`** (publication authority, rights, evidence lineage). EXTENSION of both — toggle ids unchanged. Composes ADR 0065 (the app's i18n system) and the CMS content-localization precedent (ADR 0064).
**Surface:** host-extension. **NO new RFC.**

## Why this exists

The app's UI ships in 4 locales, but **challenge content has no locale field at all** (verified: `ChallengeDefinition` in `kicktodo-core/types.ts` has no `locale`/`language` member). Wave-4's pt/es expansion therefore has nowhere to land, and — more urgently — the PRD's separation rule is currently unrepresentable: a pt-BR *interface* today renders English *content*, with nothing recording that mismatch.

This is a **versioned-artifact shape change**, which is why it is its own decision rather than a line item in a content-ops ticket: `ChallengeDefinition` versions are immutable and hash-covered (`contentHash`), enrollments freeze against them, and the goals judge replays them. Getting the localization shape wrong later means either mutating published artifacts (forbidden) or a migration of live enrollments.

## Boundaries audit (verified against live code)

- **Catalog owner is `kicktodo-core`; publication authority is `kicktodo-creator`** — this ADR adds fields to the former and gates to the latter. No third owner, no translation service.
- **UI i18n is ADR 0065's** (`src/i18n/resources.ts`, glob-collected per feature). Content locale MUST NOT be derived from it — that is precisely the conflation the PRD forbids. Two independent selectors.
- **CMS already localizes content** (ADR 0064, negotiated over `OPENWOP_I18N_LOCALES`) — the *negotiation* helper is reusable; the CMS's mutable-page model is NOT (challenge versions are immutable, CMS pages are not). Compose the negotiation, not the storage.
- **No route collision:** `/kicktodo/locale*` has zero registrants; Discover filtering rides the existing catalog routes with a query parameter rather than a new namespace.
- **Rights lineage is `kicktodo-creator`'s** — a translation inherits source rights, and that inheritance must be explicit (below), not assumed.

## Decision + data model

**A translation is its own immutable published version with a pointer to its source — not a mutation of, nor a field inside, the source.**

```text
ChallengeDefinition (extended)
  contentLocale: string          // BCP-47; absent on legacy rows ⇒ read as 'en'
  translationOf?: {              // absent ⇒ this IS a source version
    challengeId, version         // the exact immutable source it was translated from
  }
```

- **Why a sibling version, not an embedded `translations{}` map:** an embedded map would mutate a published artifact every time a translation lands (breaking `contentHash` and the immutability contract), and would force every enrollment/replay to carry every locale. A sibling keeps each locale independently hashed, independently publishable, independently retirable, and independently rights-checked.
- **Enrollment binds a specific version** (already true) — so a participant who enrolled in pt-BR replays pt-BR content forever, with no new machinery. `translationOf` is read-only lineage.
- **Discover negotiation:** the catalog read takes the caller's *content-locale* preference (independent of UI locale, defaulting to it) and returns, per challenge lineage, the best available locale — exact match → language match (`pt-BR` → `pt`) → the source. The response states which locale it served so the UI can disclose "shown in English".
- **Publication gates a translation inherits from its source** (`kicktodo-creator`): rights policy (a translation is a derivative work — the source's rights decision governs and is re-recorded, never re-derived), evidence lineage (the source's evidence graph is the translation's; sources are not re-researched), and safety classification (the source's risk tier binds). A translation gate that *re-ran* research would let a translation drift from its evidence — refused by construction.
- **Retirement cascades down the lineage, never up:** retiring a source retires its translations (the safety signal must propagate); retiring one translation leaves the source and its siblings alone.

## Phased plan

| Phase | Ships |
|---|---|
| **P1** | `contentLocale` + `translationOf` on the model; legacy rows read as `'en'` (no backfill migration — absent-means-en, the ADR 0429 default-safety pattern); publish accepts a locale; lineage integrity tests (a translation MUST point at a published source version). |
| **P2** | Discover content-locale negotiation (exact → language → source) + the served-locale disclosure in the response; catalog read tests across all four fallbacks. |
| **P3** | `kicktodo-creator` translation lane: inherited rights/evidence/risk (re-recorded, never re-derived), separation-of-duties publication unchanged, retirement cascade tests. |
| **P4** | Frontend: a content-locale preference independent of the UI locale, the "shown in <locale>" disclosure on challenge detail + Today, i18n ×4, manual-test rows. |
| **P5** | `ctx.features.kicktodo-core` catalog op takes the locale; node + pack bump with pin lockstep; LLM-EXCHANGE row (the factory's translation path is a model surface — closed-world validated like every other authoring path). |

## Feature matrix

1. Package: EXTENDS `kicktodo-core` + `kicktodo-creator` ✔. 2. Toggle: none new (both existing ids unchanged). 3. `ctx` surface: P5 (locale-aware catalog read). 4. Node pack: extends `feature.kicktodo.nodes` (a translate node is P5-optional and, if built, rides the ADR 0415 draft→validate→persist shape). 5. Envelopes: none. 6. Agent pack: none new. 7. Public surface: none (a public catalog would inherit the same negotiation). 8. RBAC: publication authority unchanged — the creator's editor/publisher separation of duties governs translations identically. 9. Replay/fork: each locale version is independently hashed; enrollments bind one version; `translationOf` is immutable lineage — replay is unaffected. 10. Frontend: preference + disclosure, no new nav group.

## Implementation record

| Phase | Landed |
|---|---|
| P1 — `contentLocale` + `translationOf` on the definition (legacy rows read as `en`, no migration) + the LINEAGE INTEGRITY gate in the CATALOG owner: a translation must point at a PUBLISHED source **in the same tenant** (foreign-tenant and missing sources share one uniform message — no existence oracle), must declare a locale, must differ from its source's locale, and may not chain off another translation. All test-pinned | kicktodo/0430-locale |
| P2 — `listPublishedForLocale`: ONE catalog scan, lineages grouped IN MEMORY, negotiated by a PURE `negotiateLocale` helper (exact → same-language → source) — never a per-challenge follow-up read; the served locale and an `exactLocale` flag are returned so a fallback is disclosed, not hidden. `GET /kicktodo/catalog?contentLocale=` | kicktodo/0430-locale |
| P3 — `retireLineage`: retiring a SOURCE retires its translations (a safety signal propagates); retiring a translation leaves the source and siblings untouched. Test-pinned both directions | kicktodo/0430-locale |
| P4 — Discover: a content-locale selector INDEPENDENT of the UI locale (defaults to it, persisted per browser), a labeled `<select>`, and a "Shown in <language>" chip whenever the served locale is a fallback; ux-review fix applied — locales render as language NAMES via `Intl.DisplayNames` (a raw `pt-BR` tag is not a participant-facing label), with a tag fallback; i18n ×4 | kicktodo/0430-locale |
| P5 — `ctx.features.kicktodo-core.catalogForLocale` + the `catalog-for-locale` node; pack **v1.11.0** pin-lockstepped across all six kicktodo features | kicktodo/0430-locale |

**Architect finding that shaped the design (decisive):** `challengeContentHash` is **deliberately NOT extended** to cover `contentLocale`/`translationOf`. The enrollment STAMPS the hash at enroll time (`enrollmentService.ts:171`) and the frozen evidence snapshot embeds that stamped value (`progressService.ts:67`), so changing the covered field set would make freshly-computed hashes disagree with stamped ones on live enrollments. A translation carries a different `id` — which IS covered — so translations hash differently by construction. **Accepted trade-off:** a mislabeled `contentLocale` is caught by the publish gate, not by hash verification. Test-pinned: publishing a translation leaves the source's hash byte-identical.

**Clarification to the Decision section:** a translation is its own **challenge id** with its own version axis — never another version of the source's lineage. Version numbers mean "content revision"; overloading them with locale would make "latest version" meaningless, break per-locale retirement, and collide with enrollment pinning.

## PRD-vs-architecture corrections

- The PRD's "content locale is versioned separately from UI locale" is **implemented as a separate version lineage**, not a locale column on one shared version — the immutability + hash contract forces it, and it is strictly stronger (per-locale retirement and rights records fall out for free).
- **Machine translation is not a publication path.** The PRD's Wave-4 line is content ops; this ADR gives it a home but does not authorize auto-publishing a machine translation: the separation-of-duties gate (ADR 0415 D3) applies unchanged, so a human publisher still completes it.

## Open questions

1. Does a translation get its own quality-evaluation scorecard, or inherit the source's? Recommend **inherit the source's substantive scores, plus a translation-fidelity check** — re-scoring pedagogy per locale is waste; unchecked translation fidelity is a real risk.
2. Should Discover *hide* source-locale challenges when a user's content locale has no translation, or show them with the disclosure? Recommend **show with disclosure** — an empty Discover is a worse failure than an honest "in English".
3. pt-BR is the natural first target (the reviewer is a native speaker — recorded in prior session context); es follows. Sequencing is content ops, not this ADR.

## RFC verdict

**Host work, no new RFC.** Model fields, catalog negotiation, and publication gates are all host-private; nothing on the wire changes.
