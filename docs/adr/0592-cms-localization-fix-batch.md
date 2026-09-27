# ADR 0592 — CMS content-localization fix batch (feature 23/71)

Status: implemented
Date: 2026-08-20
Inputs: docs/steward/CODEBASE-ASSESSMENT.md feature-23 §(`CMSL-`), UX-ASSESSMENT §(`CMSLU-`), WORKFLOWS-ASSESSMENT §(`CMSLWF-`) — merged PR #3421 (`ed6af71f2`).

One ADR for the whole batch, ordered by irreversibility. Four decisions were
genuinely architectural (each ran through the `/architect` options evaluation);
the rest are recorded fixes. No wire touch anywhere: every change is a
host-extension route/store/SPA concern (RFC 0103 delivery behavior is
unchanged and stays pinned by its existing tests), so **no new RFC** is needed.

---

## §1 Optimistic concurrency on the page write lane (CMSL-1 ⇄ CMSLU-3 — Blocker)

**Decision.** An OPTIONAL `expectedVersion` pin in the PATCH body, enforced
inside `updatePage` itself (the service read is the authoritative one): a
mismatch throws 409 `conflict` `{currentVersion, expectedVersion}`. The SPA
editor ALWAYS sends the pin and renders a designed conflict state
(reload-their-version vs explicit overwrite — overwrite refetches a FRESH pin;
the editor lane never sends pinless again). The feature's own machine writers
are pinned the same way: the submit auto-translate merge (ONE bounded
re-read-and-re-merge on conflict, missing-only against the fresh sections so a
human overlay written inside the window WINS over the AI draft) and
`surface.updateSectionDraft` (read+checks+apply re-run once; a second conflict
propagates typed). `clone` pins to the created version.

**Alternatives rejected.** If-Match/ETag (a second precondition idiom beside
the house body-shaped approval pin); server-side per-section merge (changes
PATCH deletion semantics and would rework the translator diff-guard); locking
(does not fix stale-writer-wins — the 2026-08-03 deploy-clobber lesson).

**Disclosed residuals.** (a) The pin is optional, so pinless API callers keep
last-write-wins — making it required would break clone/agent/API callers in
one move; the SPA lane is the one where humans lose work. (b) A translator API
client that omits the pin retains the route-read→service-read TOCTOU window on
the grant diff (pre-existing, tiny; the service pin closes it whenever sent).
(c) `restoreVersion` stays unpinned by design — deliberate snapshot
replacement IS restore semantics, and it bumps `version`, so a concurrent
pinned save 409s correctly against it.

**Witnesses** (deterministic — memory:// never interleaves handlers, so no
witness races HTTP handlers; feature-22 F1): two-writer version arithmetic;
the interleaved human write inside the auto-translate window via the mocked
headless resolver; the interleaved write inside `updateSectionDraft`'s window
via a one-shot pass-through `contentLocales` hook. All born red.

## §2 Translator access (CMSLU-1 — Blocker)

**Decision** (architect option b). Workspace-tier routes `/cms/translate`
(+ `/:orgId/:pageId`) render the SAME `CmsPage` in a narrowed translator mode
— one editor, two chrome contexts, never a second editor component. A new
self-read `GET …/locale-grants/mine` (`workspace:read`, self-scoped — no
subject parameter, no enumeration surface) drives the surface; it is
deliberately NOT toggle-gated (mirror of the §9 CMSL-3 ruling: enforcement is
unconditional, so the member's view of their own narrowing must be too). Nav
is toggle-gated (`featureId: cms-localization`) in the workspace Studio group;
a member with no grant gets an honest ACCESS empty state (it makes no content
claims); a FAILED grant probe renders its own state, never "no access".
Translator mode narrows the PRESENTATION to what the server already permits
(granted-locale overlay tabs, base read-only, no structure/workflow/admin
affordances) — the server's fail-closed ADR 0205 D1 narrowing remains the
authority, so this mode can never widen access.

**Alternatives rejected.** Moving `/cms` to workspace tier (widens back-office
nav to every member); a dedicated slim translator component (a second
sections editor that would drift — the "no second chat" doctrine
generalized); a per-route access predicate in the chrome manifest (new
mechanism for one consumer; an async grant probe doesn't fit the sync
manifest).

**Disclosed failure modes.** An ADMIN holding a grant is narrowed server-side
everywhere (ADR 0205 semantics — `denyIfTranslator` has no admin carve-out);
the admin-tier `/cms` shows them controls that 403. Grant-an-admin is operator
error; a settings-panel warning is future polish, not this batch.

## §3 AI-authorship provenance (CMSL-10 ⇄ CMSLU-4 ⇄ CMSLWF-8)

**Decision.** `Section.aiDrafted?: Record<locale, ISO>` — durable, ADVISORY
machine-origin provenance stamped AT THE WRITER: the submit auto-translate
merge, `surface.updateSectionDraft` locale writes (a run/agent-written overlay
is machine-drafted — no human typed it; this includes the chat lane, which
rides the same verb), and the editor's translate-apply. A human edit clears
the stamp in the same payload that carries the edit; sanitization keeps a
stamp only while its overlay exists (orphaned/invalid keys drop — clearing an
overlay clears its provenance for free). The editor renders the §5.3
`chip--ai` provenance chip + a tab AI tag + accessible-name arm. NO backfill:
absence = pre-fix row or human-authored — absence makes no claim.

**Copy paths verified**: PATCH round-trip preserves; version snapshots carry
the stamp and restore returns it (provenance rides the content). Shared-
section detach copies NO stamps — shared localizations are panel-authored
human content today; if a machine writer for shared sections ever ships, it
must stamp at that writer. Not a security boundary: a client can strip stamps
via the PATCH (advisory metadata; the mandatory human gate remains the
control). The stamp value is a bounded opaque string, not trusted as a
timestamp.

## §4 Dispatcher rerouting (CMSLWF-1 — Blocker)

`recordCmsAction` now emits through `emitHostEvent` (the ADR 0208 dispatcher)
instead of calling `deliverHostExtEvent` directly — the dispatcher's webhook
leg rides the SAME delivery seam (delivery stays single, witnessed
exactly-once), and its binding-match + `startWorkflowRun` leg makes an
operator's "on `host.cms.page.published` → start my workflow" binding actually
fire. Class enumerated both directions: cms was the ONLY feature emitting
around the dispatcher. The catalog side stays owned by the ADR 0584
emitter↔catalog parity gate (no hand-added rows). Payloads carry no PII keys.
Note: `emitHostEvent` no-ops pre-boot (`!deps`) — pure-service unit tests
without route registration deliver no webhooks; every existing webhook test
boots `createApp`, so nothing regressed.

## §5 Preview-in-locale (CMSLU-5 — Blocker)

A locale selector on the Public preview feeding a CLIENT-side mirror of the
normative exact→family→base merge (`resolvePreviewLocale.ts` — semantics
unit-pinned so a divergent preview, which would be a preview LIE, fails
tests), plus the honesty badge "Previewing es — N of M sections fall back to
en". Offered locales = the org's configured set (fail-closed by
construction). The public reader is untouched — no `?locale=` override was
added to any HTTP content route (client-side resolution needs none, and a
server override would be new negotiation surface = RFC 0103 territory).

## §6 FE honesty batch (CMSLU-2 / CMSLU-6 / CMSLU-7)

- Dirty guards: the exits CmsPage RENDERS ("Back to pages", org picker) await
  `useConfirmDiscardUnsaved`. The sidebar/browser-back path stays uncovered by
  design (BrowserRouter — no `useBlocker`); tab-close keeps `beforeunload`.
- A failed language-settings read renders a warning notice ("could not be
  read … may still have translations configured") — a failed read no longer
  presents the positive claim "monolingual".
- `CmsApiError` (envelope code + details) + `cmsErrorInfo` map KNOWN codes to
  localized copy at one choke point: the toggle-off 404 by
  `code`+`details.feature` (the `/not enabled/i` English regex is dead in both
  sites), translator denials rebuilt from `details.grantedLocales` (restoring
  the specificity `localizeErrorEnvelope` flattens), `translation_invalid`,
  `host_capability_missing`, bare `forbidden_scope`. Deliberately
  conservative: unmapped codes keep their load-bearing raw messages
  (validation details, the approval-gate 409 explanation). **Deferred**: the
  envelope-layer specificity seam itself and the app-wide error-code program
  (cross-feature scope; this batch ships the CMS slice + the reusable shape).

## §7 Typed translate failure + ONE bounded repair (CMSL-2 ⇄ CMSLWF-4)

`extractJSONStrict` (null = unparseable, honest) + the app-builder repair
shape on every lane: route/sweep (`translateSectionData` → one error-fed
repair → typed 502 `translation_invalid` `{reason, repairAttempted}`), node
pack (`invalid_model_output` typed failure; pack 1.3.0→1.4.0, node 1.1.0, pin
+ FEATURES/ROADMAP synced — the QUAD discipline; the chain pack references
typeIds, not versions, so no chain-pack change), chat tool (mirrors the
route's discrimination instead of the catch-all that masked internal errors as
provider-down — CMSL-12). The sweep SKIPS an invalid pair and continues
(`invalid` count); provider failures still stop it. Cap semantics: an attempt
may make 2 provider calls (initial + repair) — ceiling 2×20, still
hard-bounded. Empty INPUT returns an empty overlay with zero provider calls
(nothing to translate ≠ failure).

## §8 Erasure enumeration (CMSL-4 ⇄ CMSLWF-9)

`eraseCmsSubject` now: anonymizes `cms:sharedsection`
createdBy/updatedBy, `cms:langsettings.updatedBy` (via core-pure
`eraseContentLanguageSettingsSubject`), and `cms:pageexperiment.createdBy`;
returns `{rowsTouched}` (the SubjectEraseReport contract); matches every
subject-key FORM (`subjectKeyForms` — raw + scoped, the silent scoped-vs-raw
no-op closed).

**Census classification move (QUINTET rule, disclosed):** `cms:langsettings`
left `REVIEWED_EXEMPT` (its "no-subject: operator attribution" reason was
wrong — operator attribution IS a subject id) and landed in `ERASED` citing
the new eraser. The gate was not loosened; the store gained real coverage.

**Witness-contradicted prescription (recorded):** CMSLWF-9(a) prescribed
"redact `decidedBy` + `note` on resolved content-publish rows" — but
`decidedBy` was NOT a row field (audit-chain `actor` only, and the
tamper-evident chain is by-design unredactable — the documented lawful-audit
backstop), so the prescription was unimplementable as written and `note` was
unattributable prose (the assistant-action known-residual class). The honest
fix: `resolveApproval` now PERSISTS `decidedBy` on the row (additive KV
field, all kinds), and content-publish graduates from the empty-redactor loop
to `{idFields:['decidedBy'], textFields:['note']}`. Legacy rows carry no
`decidedBy`; their notes stay unattributable — disclosed, the CMSLWF-5
legacy-bounded shape.

## §9 Fast-follows

Degraded-sweep disclosure on response + approval proposal + FE toast, and
workflow buttons disable in flight (CMSL-5/CMSLU-14); grant locales validated
against `supportedLocales` at write, FE pre-validation (CMSL-7/CMSLU-15);
grant REMOVAL exempt from the toggle gate — enforcement is unconditional so
the closable lane must always be reachable — and the falsified FEATURES.md
"Toggle OFF ⇒ CMS byte-identical" claim corrected (CMSL-3); baseLocale change
409s with offenders named while overlays keyed at the new base exist — guard
at the ROUTE (feature layer; `host/contentLocales` stays core-pure)
(CMSL-8); the three public-lane assertions — Vary beside the public
Cache-Control, i18n-UNSET, per-locale withholding on `/v1/content` (CMSL-6);
NODE-PACK-AUDIT cms row refreshed, `NP-CMS-2` minted for the no-I/O-schemas
residue (CMSL-11).

## Deferred (with reasons)

- **Wire-shape items**: widening `LOCALE_RE` beyond `ll`/`ll-CC` (RFC 0103
  territory — CMSL-13); a server-side `?locale=` preview override (new
  negotiation surface); any envelope-kind change. RFC-first, per the house
  rule.
- **App-wide error-code→i18n program** (CMSLU-7's full scope): this batch
  ships the CMS slice + `cmsErrorInfo` as the copyable shape.
- **CMSLU-16 copy-from-base marks a locale translated**: needs a product
  ruling (TODO-CMSL-3's own words) — is a deliberate copy a translation?
  Stamping it `origin:'copy'` changes review semantics; not decided here.
- **CMSLWF-2 replay-floor reclassification of the writer nodes** (QUAD/
  QUINTET across the generated floor + served-set baseline) and **CMSLWF-3
  real-executor chain witness**: real, but they reclassify executor-owned
  artifacts shared by every pack — a separate change with its own blast
  radius, not a rider on a feature batch.
- **CMSLU-8..13, -17..24 polish family** (enum keys, locale-name conventions,
  ghost-text fallback editing, Content-Language reader, ARIA tabpanel wiring,
  catalog value quality): S-effort UX polish rows, left to the UX lane's
  batched pass; none is a data-loss or honesty hazard after this batch.
- **CMSL-14 dormant-locale hygiene, CMSL-D1..D4 debt rows, CMSLWF-5/-6/-7/
  -11/-12**: recorded in the trackers; unchanged priorities.

## Phase → witness record

| § | Landed in | Witnesses (all lane-run green; §1/§4/§7 born red first) |
|---|---|---|
| §1 | `cms-optimistic-concurrency.test.ts` | 6 (two-writer 409 + survival, compat, 400, sweep-window, surface-window, service pin) |
| §2 | `cms-locale-governance.test.ts` +2, `CmsTranslatorSurface.test.tsx` 4 | mine scoping/toggle-off; FE no-grant/failed-probe/narrowed/pinned-save |
| §3 | `cms-ai-provenance.test.ts` 4, `aiProvenance.test.tsx` 4 | writer stamps, copy paths, orphan-drop, human-clear, chips |
| §4 | `cms-host-event-binding.test.ts` 2 | bind→publish→run-starts; exactly-once delivery |
| §5 | `previewLocale.test.tsx` 6 | merge mirror pins + selector/badge component pin |
| §6 | `honestyBatch.test.tsx` 8 | code mapping, settings-failure notice, dirty-guard both arms |
| §7 | `cms-translate-repair.test.ts` 7, `cms-nodes.test.ts` +3 | 502 typed after exactly 2 calls, repair lands, sweep skips, node repair |
| §8 | `cms-erasure.test.ts` +5, coverage census | per-store pins, rowsTouched, key forms, reviewer redaction |
| §9 | governance +3, repair +3, delivery +3 | validation 400, toggle-off removal, baseLocale 409, degrade surfacing, Vary/unset/withholding |

---

## §Corrections — adversarial review of PR #3423 (2026-08-21; 6 findings, folded)

Correction notes, not rewrites: the sections above stand as the reasoning
trail; where a decision was WRONG the note says so here.

- **F1 (Blocker) — §2's translator surface could not save, ever.** The SPA
  always echoed `{title, sections, tags, expectedVersion}` and the D1 guard
  403s a grant-holder on the PRESENCE of title/tags — so every Save from
  `/cms/translate` was refused, and §2's witness never saw it because it
  MOCKED `savePage` (mechanism-without-wiring, the exact class §4's own
  commit message warns about). Corrected: translator mode sends
  `{sections, expectedVersion}` only (save + conflict-overwrite), the
  title/tags editors no longer render there (they violated the CMSLU-18
  rule §2 itself cited), and a COMPOSED witness now replays the byte-exact
  payload shapes against the real route (fixed payload 200; the old echo
  403; actual title/tags changes still 403 — the guard was never changed).
- **F2 — §8's `decidedBy` redaction reintroduced the family it closed.**
  `resolveApproval` persists `decidedBy` on EVERY kind, but redaction was
  registered per-kind on content-publish only — an erased reviewer survived
  DSAR on all other kinds, and the "no first-party subject data" comment
  above the empty-redactor loop was falsified by the very field §8 added.
  Corrected: `decidedBy` (+ the attributed `note`) redacts KIND-INDEPENDENTLY
  in the erasure walk itself, before any per-kind map; content-publish
  reverts to the empty per-kind map; the falsified comment is fixed in
  place. Witnessed on a non-content-publish kind.
- **F3 — the QUAD had a dropped leg.** §7 bumped the pack but not
  `packs/.steward-manifest.json` — `gen-steward-manifest --check` exited 1
  (CI red; deployed, the drifted pack goes UNTRUSTED and stops dispatching,
  ADR 0555 fail-closed). Regenerated + committed; the check is now run
  UNPIPED (piping through `tail` had masked the exit code).
- **F4 — §3's stamps were forgeable through §1's own guard.**
  `assertLocaleScopedSectionsPatch` did not compare `aiDrafted`, so a
  translator granted only `es` could strip or forge `fr`'s stamp with a
  200 — laundering the review signal through the narrowed lane. Corrected:
  out-of-grant `aiDrafted` changes deny per-locale; a translator's own
  locales stay free (editing legitimately clears). Witnessed both
  directions.
- **F5 — §5's preview lied about withheld locales.** The preview resolver
  never saw `localePublishState`, so a withheld locale previewed its overlay
  + "complete" while delivery serves base. Corrected: withheld overlays are
  stripped pre-merge (family fallback included, mirroring `localizePage`),
  the selector marks withheld options, and a warning badge replaces the
  completeness claim.
- **F6 — §9's degrade disclosure missed the double-conflict path.** A second
  merge conflict discarded the drafts silently (swallowed by the best-effort
  catch). The discard stays (the sweep must not fight active human editors)
  and is now disclosed: `autoTranslateDegraded.conflict` on the response +
  toast + proposal.

Witness deltas: FE +3 (translator payload/editors born-red pair, preview
withheld component), backend +4 (composed translator save, kind-independent
reviewer redaction, stamp strip/forge matrix, double-conflict disclosure),
unit +1 (withheld strip incl. family-fallback block).
