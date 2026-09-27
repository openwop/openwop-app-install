# REPORT-A — Slice A: governance / contract RFCs (pass 2, 2026-08-18)

Scope: RFC 0147, 0148, 0149, 0155, 0156 (existing); proposed RFC 0160 (Signed
Conformance Evidence and Release Attestations) and RFC 0164 (Normative Lifecycle and
Publication Coherence). RFC 0154 §E / UQ3 / G4 and the app's ADR 0550 signer inspected
for 0160.

Baselines verified against: spec `54f29548` (2026-08-17 17:08 -0400), app `9b2af4839`
(#3325), roadmap `c60ee3645`. Prior audit treated as hypotheses; every "confirmed" below
carries my own citation. Read-only; no suites run. Cheap scripts run:
`node scripts/rfc-conformance-coverage.mjs` (fs scan only).

Delta fa968b428 → 9b2af4839: only #3325 (ADR 0553 P3). Files touched:
`backend/typescript/conformance/run.ts` (+`OPENWOP_TEST_SECONDARY_API_KEY` for the RFC 0153
§D cross-caller leg), MCP client/audit/cache, `docs/adr/0553`, a cross-reference note in
`docs/adr/0554` (H53 `finalizeRun` guard). Nothing in this slice's surface (certify.ts,
sign-attestation.mjs, deploymentAttestation.ts, discovery.ts, ADR 0550/0556) changed.
The only effect on my artifacts is that RFC 0147's ledger criterion 5 ("app has not
wired either invoke seam") is now stale by one more phase.

---

## RFC 0147 — Protocol Integrity and Standards-Readiness Program

### 1. Identity
- Path: `/Users/david/dev/openwop/RFCS/0147-protocol-integrity-and-standards-readiness-program.md`, 398 lines.
- `Status:` line verbatim (:7): `| **Status**        | `Accepted` |`
- Last substantive edit: `9eb52572 2026-08-16 09:33 -0400 feat(conformance): RFC 0148 acceptance closed out — named witness scenarios, coverage guide, migration runbook; six 0152…`
- Sections: Summary, Motivation, Proposal §A (10 program invariants) §B–§J (workstreams 1–9), Wire shape, Version axes, Audit events, Compatibility (+6-item migration package), Conformance (14 named program scenarios), Alternatives (6), Unresolved questions (10), Implementation notes (child table 0148–0156), Acceptance criteria (12 boxes: 2 ticked — OpenAPI/examples and register sweep), References.
- Companion: `RFCS/registers/0147-…gaps.md` (24 rows, last `c6ff5a89` 08-16), `…risks.md` (20 rows, last `6c603a19` 08-16 13:50), `docs/RFC-0147-SELF-AUDIT.md` (header "Updated 2026-08-12", last touched by `9eb52572` 08-16 09:33).

### 2. What it decides
- Umbrella `safety-fix` program; adds no wire field itself (:227). Nine child RFCs each classify their own surface (:13).
- §A.1 (:42): freeze on new **non-essential optional wire** until Workstreams 1–3 Accepted **and** every Critical risk Closed/transferred. §A.3/§A.5: no `Accepted` on shape-only evidence; every behavioural MUST needs a witness/skip/failure. §A.6: high-risk RFCs must complete the full comment window, waivers may not shorten it. §A.9: INTEROP-MATRIX / KNOWN-LIMITS / PROTOCOL-STATUS updated when evidence changes. §A.10: the RFC's own status is never evidence.
- §I/§J: standards-readiness gates (two unaffiliated maintainers, WG activation, waiver retirement, retrospective review, external audit, Tier-3 host, evidence-tier-labelled matrix) and the release/claims table (7 claims × minimum evidence).
- Alternatives rejected: patch independently, v2-only, "app issue", more scenarios without runner change, self-attestation, do-nothing (:329-336).

### 3. Artifact quality
- **Status vs its own §I** (:157-171 "Before this program may reach `Accepted`: … two maintainers … audit … Tier-3"; :7 `Accepted`). Not a hidden contradiction — the Updated cell (:10) and §A.10 say the flip is a waiver and not evidence — but the RFC is `Accepted` in violation of its own §I preconditions, and `docs/RFC-0147-SELF-AUDIT.md` §A.5/§A.6 records "VIOLATED". Recorded honestly; still a structural oddity a reader must be told about (roadmap treats "Accepted" as complete elsewhere).
- **Ledger staleness (acceptance criteria are hand-maintained and lag main by hours-to-a-day):**
  - Criterion 4 (:363): "a host that advertises `compensation.supported` … (none does; the legs resolve to `blocked`)". Stale since `cb3a12b5` 2026-08-16 22:26 (openwop-app `d209d8009` executes `compensation-behavior` 6/6 + `compensation-recovery` 3/3 strict, local boot) and `4d9283f2` 08-17 (deployed-wire on `app.openwop.dev` `756a9938d`) — `INTEROP-MATRIX.md:281`.
  - Criterion 5 (:364): "it has not wired either invoke seam, so the §B behavioural legs are `blocked`". Stale since `9a7f2cba` 08-16 18:13 (deployed-origin A2A 1.0 / MCP credential-free legs) and `d8f9be75` 08-17 (RFC 0153 §B/§D deployed-wire) — `INTEROP-MATRIX.md:289,293-294`; and app #3325 (ADR 0553 P3) landed after that.
  - Criterion 6 (:365): "no host advertises `auth.workloadIdentity`; the legs resolve to `blocked`" — openwop-app advertises it when env-configured and passed `workload-identity-chain-bounds` 4/4 on local boot at `3653cd90d` (`INTEROP-MATRIX.md:295`; app ADR 0556 status line). True only for the deployed origin (env-gated OFF).
  - Criterion 3 says "Still carried … §D fenced-effect partition scenarios" — correct.
- **Register staleness:** `…risks.md:18` R9 "Later 2026-08-16: … Still no host advertises, so still unwitnessed" was written at 13:50 (`6c603a19`); `cb3a12b5` (22:26) falsified it. `…gaps.md:31` G22 "no single generated assurance manifest ties them together" — `docs/ASSURANCE-STATUS.json` + `scripts/generate-assurance-status.mjs` landed 08-16 (#1041/#1042; last regenerated `54f29548`). `…risks.md:21` R12 "no advertiser — behavioural rows blocked" — see criterion 6.
- **Self-audit staleness** (`docs/RFC-0147-SELF-AUDIT.md`): header ":3 Updated 2026-08-12"; §A.3 "0151–0154 have no witnesses because they have no implementation" (false: `compensation-behavior`, `workload-identity-behavior`, `a2a-/mcp-version-negotiation` exist and openwop-app passes them); §A.4 "does not yet carry executed-assertion counts — that is bundle v2, which is carried" (bundle v2 landed `b7d9bb8b`/`78167652`/#1018); §A.5 "Accepted with no evidence at all — no spec prose, no schema, no conformance" (all four now have schema+prose+scenarios); §A.8 "not satisfied … examples still not extracted" (landed #1020 `normative-example-extraction.test.ts`); "Genuinely absent 42 of 73" — the script now reports **29 absent / 26 present / 18 aliased** (my run of `scripts/rfc-conformance-coverage.mjs`, 2026-08-18).
- **Correction notes:** present in the acceptance list (criterion 5's "corrected 2026-08-16 from §A/§B legs pass"). None for the three stale criteria above.
- **Part V template:** has decision + phased plan + claims table; no verification record (commands/limits), no claim record; the "phase→commit table" lives only in the annotated checkboxes.
- **Vacuous/unmeetable as phrased:** criterion 12 "new independent assessment … A- or better" is external; §I "at least two maintainers unaffiliated" vs `GOVERNANCE.md:97` "three independent organizations" for WG activation (see 0156).

### 4. Implementation reality on current main
| Workstream | State | Evidence level | Witness |
|---|---|---|---|
| WS1 (0148) | LANDED in full at corpus; app consumes the ledger | test-seam (reference hosts local-boot bundle v2, `openwop-examples#14`); app deployed-live via `deploy.sh --certify` | `conformance-execution-witness`, `conformance-advertised-seam-required`, `certification-bundle-{v2,non-vacuous,redaction}`, `certification-floor-enforcement`, `runner-ledger`; app `conformance/certify.ts:54` |
| WS2 (0149) | LANDED 5/6; lifecycle gate scoped ≥0147 | server-free | `openapi-resolved-paths`, `openapi-asyncapi-sdk-parity`, `capability-example-root-layout`, `discovery-canonical-family-no-shadow`, `protocol-version-grammar`, `rfc-lifecycle-coherence`, `normative-example-extraction` |
| WS3 (0150) | slice B; ledger says §D host witness + lease recovery + Py/Go vectors carried | — | — |
| WS4 (0151) | LANDED shape/events/behaviour; app deployed-wire (`INTEROP-MATRIX.md:281`) | deployed-live (advert/§B/§D), local-live (§C/§E/§F) | slice B |
| WS5 (0152/0153) | shape+negotiation landed; app deployed-wire for credential-free + MCP §B/§D | deployed-live; **official-peer OPEN** | slice C |
| WS6 (0154) | schema+prose+threat model+behaviour+chain-bounds; suite/SDK SLSA provenance | local-live on app (env-gated OFF in prod) | `workload-identity-{profile,behavior,chain-bounds}`; `scripts/verify-published-provenance.sh` |
| WS7 (0155) | rename/alias, manifest, registry backfill LANDED; budget/Stable rules OPEN (governance) | server-free | `profile-discovery-core-alias`, `core-manifest-and-extension-registry` |
| WS8 (0156) | manifest+SLA source LANDED; everything else EXTERNAL | server-free | `generate-assurance-status.mjs --check` (no scenario files) |
| WS9 | manifest says 0/7 claims permitted | server-free | `docs/ASSURANCE-STATUS.json` |
| §A.1 freeze | **still binding**: R3, R9 "Open — unwitnessed", R12 "Mitigated… no advertiser", R14 "Open, Critical, externally gated" (`…risks.md:12,18,21,23`) | — | — |

Generated views that exist: `docs/PROTOCOL-STATUS.md` (RFC statuses, counts, ops — `--check` gated), `docs/ASSURANCE-STATUS.{json,md}` (governance/waivers/audit/Tier-3/risks/claims — `--check` gated), `scripts/rfc-conformance-coverage.mjs` (**not** in `scripts/openwop-check.sh` — lines 107-175 list the gated generators; coverage script absent). No per-child acceptance-item view exists.

### 5. Roadmap bullet-by-bullet (roadmap :120-141)
- "Track every child RFC and every external gate in one generated status view" — **OPEN**. Two generated views (`PROTOCOL-STATUS.md`, `ASSURANCE-STATUS.md`) cover status + external gates but not per-child acceptance items; the RFC 0147 checklist (:359-371) is hand-maintained and stale (§3).
- "Require all acceptance items classified complete/carried/externally gated" — **PARTIAL**: `rfc-lifecycle-coherence.test.ts:59-62` requires only *any* ≥12-char parenthetical or one of a few keywords; no vocabulary, no machine classification.
- "Keep the protocol gap and risk registers synchronized" — **OPEN**: S11 sweep (`bbeacebe` 04:12 08-16) already lags — G22, R9, R12 (§3).
- "Close every Critical gap" — **OPEN/EXTERNAL**: Critical risks R3, R9, R12 need a fencing/compensation/WI host witness; R14 human.
- "Independent reassessment ≥ A-" / "Raise target to A+" — **EXTERNAL**.
- Exit evidence (children complete; audit/maintainers/Tier-3; assessment) — **EXTERNAL**.

### 6. Cross-artifact
- Owns the freeze every other slice must argue against; the roadmap never mentions §A.1 (confirmed: `grep -c 'freeze' docs/OPENWOP-A-PLUS-ROADMAP.md` = 0).
- The generated status view the roadmap wants under RFC 0147 and again under proposed RFC 0164 is the same deliverable — an extension of `generate-protocol-status.mjs`/`generate-assurance-status.mjs`. Double-owned.
- Part III: no row names 0147 directly; consistent.

### 7. Defects & gates-that-cannot-fail
- **D1 — `docs/PROTOCOL-STATUS.md` "Reference Host Conformance Evidence" has been an EMPTY table since 2026-06-11.** `scripts/generate-protocol-status.mjs:165` matches `startsWith('| Host | Passed | Failed | Skipped | Todo | Total | Pass rate')`; `4aa80535` (2026-06-11, "normalize Markdown formatting") padded the header in `INTEROP-MATRIX.md:258` to `| Host                                                        | Passed …`, so `parseInteropPassRates()` returns `[]` and the section renders header-only (`docs/PROTOCOL-STATUS.md:202-205`). `--check` is green because generated == committed. A generated authoritative index with a silently dead section is exactly the RFC 0164 premise — and it lived through two program sweeps. Fix: 1-line regex; add a non-vacuity leg (rows > 0). Owner: corpus (0147 §A.9 / 0149 §D).
- **D2 — hand ledgers lag by hours**: three RFC 0147 criteria, R9/R12/G22, and the whole self-audit (§3). Owner: corpus docs. Size: doc sweep + move the per-child view into a generator.
- **D3 — `scripts/rfc-conformance-coverage.mjs` not gated** and its alias table is stale (`delegation-no-scope-amplification.test.ts` reported absent although `workload-identity-chain-bounds.test.ts` carries it and `SECURITY/invariants.yaml` registers `delegation-no-scope-amplification` against it). Over-reports 0154 absences (5 → 4).
- Cannot-fail: `PROTOCOL-STATUS --check` (D1). The self-audit has no gate at all.

### 8. Verdict
Roadmap treatment: **stale in the direction of under-crediting** (it copied the RFC's own hand ledger, which lags landings by hours), and it omits the §A.1 freeze that governs the roadmap's own proposed RFCs. The artifact needs (a) a ledger/register/self-audit re-sweep or, better, a generated per-child acceptance view (extend the two existing generators, don't fork to 0164), (b) the D1 fix. Priority: **P2 corpus refresh; the external gates (audit, maintainers, Tier-3) are the P0 for the whole program and no document changes them.**

---

## RFC 0148 — Non-Vacuous Conformance and Certification Evidence

### 1. Identity
- Path: `RFCS/0148-non-vacuous-conformance-certification.md`, 156 lines. `Status:` (:7): `` `Accepted` ``.
- Last edit: `9eb52572 2026-08-16 09:33` (same commit as 0147).
- Sections: Summary, Motivation, §A ledger, §B strict, §C bundle v2 (+ two "Landed" design notes), §D invalidation, §E security, Compatibility (90-day window, ends 2026-11-10 per runbook), Conformance (5 named scenarios), Alternatives, UQ (4; UQ2 resolved), Implementation notes, Acceptance (7/7 ticked), References.

### 2. What it decides
- Requirement-level dispositions `executed-pass|executed-fail|skipped|inapplicable|blocked` (§A :28-36); `blocked` in a claimed floor invalidates the profile; plain return/empty body never `executed-pass`.
- Strict mode fails on blocked/unclassified/missing seam (§B :40); advertise-and-opt-out forbidden.
- Bundle v2 shape (§C :44-70): totals ×5, closed `requirements[]`, `witnessSha256`, `scenarioManifestSha256`, `targetConfigurationSha256`; verifier rejects duplicates/missing floor/contradictions/mismatched totals; undefined floor is unprovable (:75).
- v1 bundles inventoried and invalidated (§D); invariant `certification-no-vacuous-pass` + redaction (§E); safety-fix with 90-day window.
- Rejected: file-level aggregation, vitest file status, fail-when-unadvertised, do-nothing (:121-124).

### 3. Artifact quality
- **Internal contradiction (body vs register):** §C :87 "`openwop-replay-fork` is deliberately left unspecified … a discovery-conditional floor a flat required-list cannot express" vs `conformance/src/lib/profiles.ts:645-651` (`'openwop-replay-fork': { required: [], conditional: [...] }`, landed `2a19cea1` 2026-08-16 04:53, #1026) and register G7 "~~Carried~~ CLOSED 2026-08-16 (later the same day, suite 1.120.0)". The body was edited at 09:33 the same day (`9eb52572`) without correcting :87. MyndHyve now certifies `openwop-replay-fork` on that conditional floor (`INTEROP-MATRIX.md:3`, `54f29548`).
- **Stale code comment contradicting code:** `conformance/src/cli.ts:384-390` "THE HONEST LIMIT … the runner … does not read the RFC 0148 §A requirement ledger, because scenarios do not yet record into it" sits immediately above `:397 deriveRequirementDispositions(states, ledgerEntries, …)`, the ledger read. Confirmed (prior audit d1).
- **§E invariant `certification-no-vacuous-pass` is NOT registered**: `grep -c 'id: certification-no-vacuous-pass' SECURITY/invariants.yaml` = 0 (only `profile-claim-floor-not-overstated`, RFC 0155's, is). §E says "Add protocol invariant …" and acceptance item 7 is ticked.
- **UQ1 (what `witnessSha256` covers) and UQ3 (signing here or 0154) remain open** while every acceptance box is ticked — the boxes are honest about it (item 1's "Earlier annotation" trail) but the field is dead wire in the schema (below).
- Correction notes: several, well kept ("Superseded annotation, kept for the record").
- Part V: has decision + implementation record inline; no verification record (commands/resource limits); claim record only via inventory doc.

### 4. Implementation reality on current main
- §A ledger — LANDED (`conformance/src/lib/requirement-ledger.ts`, `setup.ts:247-283` records per FILE with `assertionCount = expect.getState().assertionCalls`); identity is **per scenario file** (`requirement-registry.ts:26-33` `openwop.floor.<file>`, prefix groups `openwop.floor.any.<prefix>`), by design "first tranche" (:1-22 comment) — the roadmap's leg-level identity is OPEN. Evidence: test-seam.
- §B strict — LANDED (`soft-skip.ts` `seamAbsent` throws under `OPENWOP_REQUIRE_BEHAVIOR`; `conformance-advertised-seam-required.test.ts`).
- §C bundle v2 — LANDED schema (`schemas/certification-bundle-v2.schema.json`), emitter (`cli.ts:397-430`), verifier (`certification-bundle-verify.ts`, 8 rejection kinds at :188-243: not-v2, unknown-disposition, reason-missing, duplicate-requirement, totals-mismatch, secret-canary, unwitnessed-requirement, vacuous-pass). **Not implemented:** `witnessSha256` — schema-optional (:87), never written by the emitter (`cli.ts:415-421` maps only id/scenario/disposition/detail/assertionCount), never read by the verifier (grep = 0 hits outside the schema and one fixture in `certification-bundle-v2.test.ts:65`). `scenarioManifestSha256` is a hash of the sorted scenario **ids** (`cli.ts:412-413`), not of scenario content; `targetConfigurationSha256` = baseUrl+discovery sha+strict flag (:417-419). Neither is re-derived/verified by the consumer verifier (grep in verify.ts = 0). Host identity = `{name, version, vendor?}` from discovery `implementation` (`cli.ts:345-353`); no source revision in the corpus emitter — the app's own emitter adds `host.commit` (`backend/typescript/conformance/certify.ts:424`), permitted by `host.additionalProperties: true` (schema :22).
- §D — LANDED (`docs/CERTIFICATION-BUNDLE-INVENTORY.md`, rows 2–5 reissued v2 `openwop-examples#14`; app bundle v2 published at `certificationBundleUrl`, `discovery.ts:1303`).
- §E — redaction LANDED (`scrubEvidence`, secret-canary reject); invariant NOT registered.
- App side: `conformance/certify.ts` consumes the same ledger and derivation (`:54,:320`), emits `bundleVersion: '2'` (`:373,:427`); ADR 0550 P4 shipped 08-17 (`54229aa61`). Evidence level for the app: **deployed-live** (`INTEROP-MATRIX.md:3` "openwop-app deploy #3 `3318d7062` … `contractProvenance.suiteVersion 1.135.2` first honest value").
- Nothing changed between fa968b428 and 9b2af4839 for this RFC.

### 5. Roadmap bullet-by-bullet (roadmap :143-172)
- Leg/assertion-level requirement identity — **OPEN** (`requirement-registry.ts:26-33`, per file by declared scope).
- One execution witness per required behaviour — **PARTIAL**: per-file `assertionCount > 0` (`certification-bundle-verify.ts:167`); "one unrelated assertion certifies a behavioural file" is exactly what this does not exclude.
- Populate and verify `witnessSha256` — **OPEN** (dead field; UQ1 open).
- Bind witness to host revision, suite revision, discovery digest, machine-contract digest, runtime configuration class — **PARTIAL**: suite version + discovery sha + config sha present; host revision only in the app emitter (`certify.ts:424`), not required by schema; machine-contract (schema/OpenAPI) digest absent — the app's `contractProvenance.corpusStamp` is a discovery field, not bound in the bundle.
- Reject missing/zero-assertion/unclassified/stale/duplicated/mismatched — **PARTIAL**: missing/zero/unclassified/duplicated/totals YES (verify.ts kinds); **stale NO** (no expiry field or logic; only `generatedAt`); tampered `scenarioManifestSha256`/`targetConfigurationSha256`/discovery digest **not checked**.
- Automatic invalidation after host/schema/profile/suite changes — **OPEN** (RFC 0156 UQ5 owns periods; nothing implemented).
- Deterministic reproduction commands — **OPEN** (inventory cites `--certify --bundle-version 2` generically at `CERTIFICATION-BUNDLE-INVENTORY.md:29`; no per-bundle command/env/commit recipe).
- Compose with proposed 0160 for signatures — see 0160: owner is RFC 0154 §E + 0148 G4 ("0148 owns digest; 0154 decides attestations/signatures", `registers/0148-…gaps.md:13`).
- Reissue all official bundles after final format — **DONE for the current v2** (rows 2–5, MyndHyve #11, app deploys); will re-open if leg-level ids/witness digest land.
- Required tests: early return ✓ (`conformance-execution-witness.test.ts`); missing seam strict ✓ (`conformance-advertised-seam-required.test.ts`); one unrelated assertion ✗ **OPEN**; tampered totals ✓ / witness-suite-discovery digests ✗ **OPEN**; redaction keys+values ✓ (`certification-bundle-redaction.test.ts`, "values AND keys" per acceptance item 4); verifier sabotage ✓ (`certification-bundle-non-vacuous.test.ts`).

### 6. Cross-artifact
- Feeds RFC 0155 §E (canonical ids + `aliases` — schema :47, used by `--certify` since S6), RFC 0156 §D/§E (Tier-3 = "corrected bundle v2, no blocked in floor"), RFC 0154 §E (bundle MAY be wrapped in the attestation format), app ADR 0550.
- Freeze: safety-fix, inside WS1 — not frozen. Any leg-level id / witness-digest change is a bundle-v2 revision (schema `requirements[]` is closed) → suite minor + reissue.
- Part III row "Vacuous or weak certification evidence → RFC 0148, RFC 0160 / ADR 0550, ADR 0580 / signed requirement-level bundle": correct owners for the unsigned half; "0160" should read "0154 §E".

### 7. Defects & gates-that-cannot-fail
- **D4 — `witnessSha256` is dead wire** (schema :87 optional; emitter never writes; verifier never reads). Either define UQ1 and emit+verify, or delete the field before anyone treats its presence in the schema as evidence. Small (emitter+verifier+schema+test). Owner: corpus 0148.
- **D5 — per-file assertionCount is the whole witness** (`setup.ts:274-283`, `verify.ts:167`); a `.not.toBe(404)` in an unrelated `it()` certifies the file. Medium (leg-level ids = registry redesign; G3 measured 168 run-time-interpolated sites). Owner: corpus 0148 (+ app certify.ts consumer).
- **D6 — verifier does not re-derive `scenarioManifestSha256`** although the bundle carries `results.passed/failed/skipped` from which the emitter computed it (`cli.ts:412-413`) — a free tamper check left on the table. Tiny.
- **D7 — `certification-no-vacuous-pass` unregistered** while item 7 is ticked. Tiny (invariants.yaml row pointing at `certification-bundle-non-vacuous.test.ts`).
- **D8 — `cli.ts:384-390` comment contradicts `:397`.** Tiny.
- **D9 — RFC body §C:87 contradicts `profiles.ts:645` + G7 CLOSED.** Doc correction note.
- Cannot-fail: none found in the runner-integrity scenarios (they carry sabotage legs); the *field* `witnessSha256` is a claim with no gate behind it.

### 8. Verdict
Roadmap treatment: **accurate on residue, under-credits what landed** (7/7 boxes; app consumes and deploys the ledger). What the artifact needs: amend for leg-level ids + a real witness digest (or strike the field), register the invariant, add the manifest re-derivation, correct §C:87, and route signing to 0154 §E. **P1** — every downstream "signed evidence" claim (0154 §E, ADR 0550, proposed 0160) signs over these numbers; a signature over a per-file `assertionCount` is only as good as D5.

---

## RFC 0149 — Machine-Contract and Version Reconciliation

### 1. Identity
- Path: `RFCS/0149-machine-contract-and-version-reconciliation.md`, 139 lines. `Status:` (:7) `` `Accepted` ``.
- Last edit: `65574f3c 2026-08-16 docs(0149): UQ3 measured — one deployed 1.0.0 (MyndHyve tier-2), no corpus normalization`.
- Sections: §A URL resolution (landed note), §B examples + authoring lint (landed note, two deferred defects), §C version grammar, §D lifecycle coherence (+ extraction landed), §E no-shadow, Compatibility, Conformance (6 named), Alternatives, UQ (4; 1–3 resolved, 4 measured/triaged), Acceptance (5/6 ticked; lifecycle gate open, scoped ≥0147).

### 2. What it decides
- One `/v1` per resolved operation; `/.well-known/openwop` unversioned; SDK/AsyncAPI parity (§A). Root-layout examples; authoring lint for wrapper / distance-one typo / vendor shadow; runtime stays open (§B). `protocolVersion` = `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$` (§C). Lifecycle gate + example extraction (§D). `discovery-canonical-family-no-shadow` (§E).
- Rejected: strip `/v1` from paths, `additionalProperties:false` on discovery, semver patch in protocolVersion, do-nothing (:107-110).

### 3. Artifact quality
- Well-corrected in place (UQ4's "first hypothesis was wrong" note :117). No internal contradiction found.
- Acceptance item 5 honestly OPEN with reason ("200 bare items pre-0147").
- **§D second half never got a gate and its measurement is now falsified:** UQ4 (:117) says the "Stable spec describes its RFC as pending" search "returned no hits (recorded as unproven, not clean)". There ARE hits (see D10 below) — two Draft spec docs describe their owning RFC as `Active` although both are `Accepted`, and one Stable doc calls an Accepted RFC "in flight".
- Part V: no verification record (commands) but each landed section names its scenario and the red-then-green observation (:36, :52).

### 4. Implementation reality on current main
- §A LANDED (`openapi-resolved-paths.test.ts`, `openapi-asyncapi-sdk-parity.test.ts` + `spec/v1/operation-path-manifest.json`, `--check` gated at `scripts/openwop-check.sh:115`). **SDK half of parity is `blocked` in hosted CI**: `openapi-asyncapi-sdk-parity.test.ts:29-46,254` records `openwop.requirement.rfc0149.sdk-path-parity` `blocked` when `openwop-sdks` is unreachable; `.github/workflows/{pr-checks,openwop-spec}.yml` check out only this repo (`actions/checkout@v6` at pr-checks:31,46,78; spec:45; no `OPENWOP_SDKS_DIR`). So the merge gate never executes the SDK leg — witnessed only on a local sibling checkout. Evidence level: server-free (local).
- §B LANDED — wrapper leg + typo leg (`capability-example-root-layout.test.ts`), **with a false-negative predicate** (D10a).
- §C LANDED (`protocol-version-grammar.test.ts`; schema pattern == `profiles.ts` predicate leg).
- §D extraction LANDED (`normative-example-extraction.test.ts`: 26 declared; non-vacuity floor leg :172; inverse guard :204; sabotage :234; only ```json/jsonc fences, `spec/v1` only — :76). Lifecycle gate LANDED for `Accepted` RFCs ≥0147 (`rfc-lifecycle-coherence.test.ts:44,59-62,91-156`); **the "Stable/Draft spec vs owning-RFC status" half has no leg** (legs: bare-item annotation, cohort self-binding, Parked-tripwire — :94-203).
- §E LANDED (`discovery-canonical-family-no-shadow.test.ts`; invariant registered).
- No change fa968b428→9b2af4839.

### 5. Roadmap bullet-by-bullet (roadmap :174-197)
- "Correct the remaining gRPC capability example that uses a top-level `capabilities` wrapper" — **DONE-as-defect / OPEN-as-fix**: `spec/v1/grpc-transport.md:172-183` (`{ "supportedTransports": [...], "capabilities": { "grpc": {...} } }`). Not caught because `capability-example-root-layout.test.ts:81-82` flags a wrapper only when `"capabilities":` is the **first** key after `{` (`body[1]`). Confirmed prior audit.
- "Remove stale language saying accepted work is still 'in flight'" — **OPEN, TRUE**: `grpc-transport.md:201` "added … by RFC 0094 (in flight) … Until RFC 0094 lands, the schema does not yet carry the block" — RFC 0094 `Accepted` 2026-06-11 (`RFCS/0094-…:10`), the schema carries `grpc` (`schemas/capabilities.schema.json:371,376`), the scenario exists (`conformance/src/scenarios/grpc-transport.test.ts`). Introduced by `50fb8a40` (2026-06-11), same day the RFC flipped.
- "Validate all normative JSON and YAML examples, incl. tables, nested fences, partial fragments" — **PARTIALLY FALSE-PREMISE / OPEN**: JSON whole instances DONE (26); fragments were *decided* prose by §D (:82 "the rest are fragments and stay prose") — re-opening that is a scope amendment, say so; YAML and RFCS/ **OPEN** (extractor: `^```(json|jsonc)` only, `spec/v1` only — `normative-example-extraction.test.ts:76`).
- "Run canonical-family typo detection across all spec documents and applicable RFCs" — **DONE** (UQ2 :115: distance-one on discovery-shaped objects, `spec/v1` + RFCs ≥0149, 53 objects, 0 findings; third leg of root-layout test). Roadmap stale.
- "OpenAPI, AsyncAPI, schemas, SDK operation manifests, prose examples → one operation inventory" — **DONE at corpus** (`operation-path-manifest.json`, parity test); SDK half only witnessed locally (§4).
- "Fail when an accepted RFC's normative document is Draft without an explicit lifecycle annotation" — **OPEN** (no leg; see D10b: 10 Draft docs with Accepted owners, two mis-stating the owner's status).
- "Sabotage-test every extractor so a zero-match parser cannot report success" — **DONE for the extraction test** (:172 non-vacuity floor, :234 sabotage) and the root-layout/lifecycle tests assert reach (`rfc-lifecycle-coherence.test.ts:94`); the wrapper miss is a false-negative predicate, a different class than zero-match. **NOT done for `generate-protocol-status.mjs`** (D1: zero rows → success).
- Exit evidence "zero known example contradictions / zero op-path differences / lifecycle mismatches classified" — **OPEN** on the first and third (D10), DONE on paths.

### 6. Cross-artifact
- Owns everything proposed RFC 0164 lists except the vocabulary (below). Overlaps RFC 0155/0161 on typo/shadow (Part III row "Capability typo/ghost risk → RFC 0155, RFC 0161" is **mis-owned**: the typo lint is 0149 §B UQ2, shadow is 0149 §E; 0155 owns registry/naming).
- Freeze: safety-fix/editorial; not frozen.
- Part III "Contract/example drift → RFC 0149, RFC 0164 / ADR 0583 / machine parity gate": correct owner is 0149 alone.

### 7. Defects & gates-that-cannot-fail
- **D10a — wrapper-lint false negative**: `capability-example-root-layout.test.ts:81-82` (`body[1]` must be `"capabilities": {`); misses `grpc-transport.md:172-183`. Tiny fix (scan all root keys; keep the ```diff carve-out). Then fix the example. Owner: corpus 0149 §B.
- **D10b — spec-status-vs-owner-status contradictions exist and no gate reads them**: `spec/v1/self-hosted-runner.md:3` "Status: Draft · v1.x (2026-07-02) — RFC 0122 `Active`" (RFC 0122 `Accepted` 2026-07-02, `RFCS/0122-…:10`; line introduced `960d2382`); `spec/v1/frontend-plugin-packs.md:3` "Status: Draft · v1.x — RFC 0117 `Active`" (RFC 0117 `Accepted` 2026-07-06, `RFCS/0117-…:10`; line `a6510fe1` 2026-06-27); `spec/v1/grpc-transport.md:201` "RFC 0094 (in flight)". Ten `Draft` spec docs have `Accepted` owners (agent-runtime/0097, agent-workspace/0059, compensation/0151, form-content-packs/0137, frontend-plugin-packs/0117, multi-agent-execution/0037, portability/0098, prompts/0027, self-hosted-runner/0122, workflow-chain-packs/0013 — statuses from each RFC's `Status` cell). Most are annotated (which is what 0164 asks for); two are wrong. Fix: a `rfc-lifecycle-coherence` leg that parses `spec/v1/*.md:3` for `RFC NNNN \`Status\`` and compares. Small. Owner: corpus 0149 §D.
- **D11 — README numeric banner ungated**: `README.md:68` "48 of 55 `spec/v1/*.md` at `Stable` … Eight" vs the tree (60 docs: **49 Stable / 11 Draft**, my scan of the `Status:` line); `README.md:69` `@openwop/openwop` v1.6.1 (published 1.7.0), `@openwop/openwop-conformance` v1.73.0 (`conformance/package.json` 1.136.3). `scripts/check-doc-tallies.mjs:50-77` gates only invariant tallies + scenario-file counts; `generate-protocol-status.mjs` does not count Stable/Draft docs. Owner: corpus 0149 §D / 0147 §A.9.
- Cannot-fail: SDK-parity leg in hosted CI (honest `blocked`, but a green merge gate that never runs the leg).

### 8. Verdict
Roadmap: **accurate on the two concrete defects, stale on the typo lint (done), and re-opens a decided question (fragments) without saying so.** The artifact needs the §D second-half leg (D10b — the live contradictions are now known), the D10a predicate fix + example repair, README tallies into a generator, and a note that SDK parity is CI-blocked. **P2**, but D10a/D10b/D11 must precede Phase 5's "zero contradictions" gate.

---

## RFC 0155 — Core Profile and Extension Discipline

### 1. Identity
- Path: `RFCS/0155-core-profile-and-extension-discipline.md`, 126 lines. `Status:` (:7) `` `Accepted` ``.
- Last edit: `56fd0c48 2026-08-16 docs(0155): SDKs carry no profile-derivation helper — nothing to canonicalise; matrix rows already canonical (#1045)`.
- Sections: §A names, §B manifest, §C registry (+ closed record example, `stable` bar), §D budget (12/4), §E claims/certification, §F security invariant, Compatibility, Conformance (7 named), Alternatives, UQ (5; UQ3 resolved), Acceptance (2/6 ticked; item 1 unticked though its annotation says landed except the §F half).

### 2. What it decides
- `openwop-discovery-core` canonical; `openwop-core` deprecated alias deriving iff canonical derives; unqualified "OpenWOP conformant" ⇒ `openwop-core-standard`; claims state all profiles (§A). Generated core-standard manifest, parity-gated (§B). `extensions.json` closed records with maturity/owner/capabilityPath/deps/securityTier/minSuite/evidenceTier; `stable` requires prose+schemas+non-vacuous conformance+SDK+**Tier-3** (§C). Budget 12 concurrent non-stable / 4 security-high Active; steward-alone waiver forbidden (§D). Bundle v2 canonical ids, aliases in `aliases`; badge distinctness (§E). `profile-claim-floor-not-overstated`; vendor `openwop-*` ids need an RFC (§F).
- Rejected: redefine `openwop-core`, remove it, unbounded catalog, Tier-3-before-Active, do-nothing (:93-97).

### 3. Artifact quality
- **Budget trap (§D vs the backfilled registry):** §D :63 "initial proposed budget is 12, with no more than four security-high extensions simultaneously Active" vs `spec/v1/extensions.json` measured 2026-08-18: **73 records, all `draft` (non-stable), `securityTier` high **41** / medium 27 / low 5, `evidenceTier` null ×73** (my `node -e` count). Approving §D as written makes the corpus 6× over budget on day one; no budget leg exists (`grep -i budget core-manifest-and-extension-registry.test.ts` = 0 hits; register G1 "budget uncalibrated"). UQ1 (:101) is open, so this is a known-unresolved, but the acceptance item 4 wording "Budget … governance-approved" would, if ticked as-is, be self-contradictory.
- No JSON Schema for `extensions.json` (`ls schemas | grep -i exten` = none); closure is enforced by the test only.
- Item 1 unticked with a "landed" annotation — mildly confusing; the carried half (§F dependency/security-tier validation) is stated.
- Part V: implementation record inline; verification record partial (suite versions named); claim record via `profiles.md` §"Claim vocabulary".

### 4. Implementation reality on current main
- §A LANDED (`profiles.ts` `PROFILE_NAMES[0]='openwop-discovery-core'`, `DEPRECATED_PROFILE_ALIASES`; `profile-discovery-core-alias.test.ts`; `--certify` writes `aliases`, schema :47). App ADR 0550 P4 (public exact-profile claims) shipped 08-17 on this (`docs/steward/AGRADE-WIRE-BLOCKED-RESIDUE.md:116-137`).
- §B LANDED (`spec/v1/core-standard-manifest.json`, generator `--check` at `openwop-check.sh:111`, parity leg).
- §C LANDED registry + coverage (`generate-extension-registry-coverage.mjs --check`, `openwop-check.sh:116`); Tier-3-before-Stable **enforced** (`core-manifest-and-extension-registry.test.ts:121-135`, red iff any `stable` record has null `evidenceTier`); deps resolve; owner/capabilityPath resolve; 72 covered / 0 uncovered / 4 core / 14 metadata of 90 (`extensions.json` coverage block).
- §D OPEN (governance; no leg). §E LANDED for bundle ids/aliases; badges are a site concern (unscanned). §F half registered (`profile-claim-floor-not-overstated`), extension-claim validation OPEN (bundle v2 carries no extension claims — needs a 0148 schema amendment).
- No SDK helper exists to canonicalise: `grep -rln 'deriveProfiles|openwop-core-standard|openwop-discovery-core'` in `/Users/david/dev/openwop-sdks` (`7a62218` 08-16) = nothing (confirmed 56fd0c48).
- Evidence level: server-free; Tier-3 for `stable` — external.

### 5. Roadmap bullet-by-bullet (roadmap :297-309)
- "Approve the extension budget and Stable maturity rules" — **EXTERNAL (governance) + UNMEETABLE-AS-PHRASED**: 12/4 vs 73/41; re-derive (UQ1) first, then add a leg.
- "Require Tier-3 evidence before an extension becomes Stable" — **DONE** (`…registry.test.ts:121`); roadmap stale.
- "Generate claim and badge vocabulary from the profile registry" — **OPEN**: vocabulary is prose (`profiles.md` §"Claim vocabulary") and the claim tokens are hand-coded in `scripts/generate-assurance-status.mjs:141-147`; badges unbuilt.
- "Require every public compatibility claim to name exact profiles" — **DONE in prose (§A/§E, `profiles.md`) + INTEROP rows canonical**; enforcement only via the 0156 token scan (this repo only).
- "Add SDK profile-derivation helpers" — **NEW ASK, not residue** (no helper exists; 56fd0c48 measured). Fine to want; don't file it as 0155 residue.
- "Enforce extension dependencies and canonical-family shadow prevention" — **DONE** (deps leg; shadow = 0149 §E invariant).
- "Compose with RFC 0161 for the protocol-v2 closed namespace" — **EXTERNAL to v1 / slice C**; note `capabilities.schema.json` root stays open by RFC 0073/0149 alt 2 decision.

### 6. Cross-artifact
- Depends on 0148 (bundle v2 ids/aliases; floor invariant), feeds 0156 §E row 1 (`OpenWOP conformant` = core-standard + bundle v2) and ADR 0550 P4. Extension-claim validation needs a 0148 bundle amendment (double owner).
- Freeze: additive names/registry — the RFC is a WS7 repair, not new optional wire.
- Part III rows: "Capability typo/ghost risk → 0155, 0161" mis-owned (0149); "Independent implementation → 0155, 0156, 0163" fine.

### 7. Defects & gates-that-cannot-fail
- **D12 — budget stated but unenforceable and already violated** (§3). Owner: governance (UQ1) then corpus leg.
- **D13 — no schema for `extensions.json`**; the test is the only shape gate. Small.
- **D14 — claim vocabulary duplicated** (prose in `profiles.md` vs tokens in `generate-assurance-status.mjs:141-147`; two of seven rows have empty token lists — see 0156 D15). Small: one generator.
- Cannot-fail: none in the registry test (it has reach assertions and the Tier-3 leg is red-able by editing one record).

### 8. Verdict
Roadmap: **partially stale (Tier-3-before-Stable and shadow are done) and carries a budget trap.** Artifact needs: UQ1 re-derived from the measured cohort, a schema for the registry, one generated claim vocabulary, and the §F extension-claim half after a 0148 amendment. **P3 corpus; the governance decisions (budget, Stable rules) are P0-external like everything in 0156.**

---

## RFC 0156 — Governance, Independent Assurance, and Claims Policy

### 1. Identity
- Path: `RFCS/0156-governance-independent-assurance-and-claims.md`, 129 lines. `Status:` (:7) `` `Accepted` ``.
- Last edit: `8b54c5cf 2026-08-16 docs(0156): §G one security-response SLA source — SECURITY/response-sla.json, gated (#1042)`.
- Sections: §A maintainers, §B waiver retirement/retrospective, §C audit, §D Tier-3, §E claims table, §F assurance manifest, §G operational commitments, Compatibility, Conformance (6 named), Alternatives, UQ (6, all open), Implementation notes ("should remain Draft until named candidates and audit funding exist" :110), Acceptance (1/7 ticked).

### 2. What it decides
- Two unaffiliated maintainers + WG activation before Active; cross-org approval + full window for high-risk changes; steward keeps one vote (§A). Waivers retire; generated waiver ledger; retrospective review with `ratified|corrective-rfc-required|provisional|withdrawn`, silence ≠ ratified (§B). External audit states `not-started…complete`; empty findings ≠ clean (§C). Tier-3 = independent org + bundle v2 core-standard no-blocked + one current interop profile + provenance + independent signoff (§D). Seven gated claims (§E). Generated `docs/ASSURANCE-STATUS.json` + CI claim-token gate (§F). One SLA source; annual/quarterly reviews (§G).
- Rejected: wait for organic growth, treat MyndHyve as independent, self-audit+bounty, advisory claims, do-nothing (:93-97).

### 3. Artifact quality
- **Internal contradiction:** :110 "This RFC … should remain Draft until named candidates and audit funding exist" vs :7 `Accepted` (flipped 08-12 by the waiver §B says must retire — acceptance item 2 :115 says so: "moving the wrong way").
- **§A vs GOVERNANCE/RFC 0038 threshold:** :28 "at least two maintainers unaffiliated with the original steward … RFC 0038's working-group charter MUST activate" — but the charter's tripwire is **three independent organizations** (`GOVERNANCE.md:97`; `RFCS/0038-…:10,76-78`, Parked on that). Two maintainers from one new org satisfy the first clause and cannot satisfy the second; the roadmap DoD inherits the weaker "two". Not a contradiction inside 0156 (the clauses are conjunctive), but a hidden third requirement the acceptance item :114 ("Two independent maintainers appointed and RFC 0038 activated") does not spell out.
- **Stale annotation:** :117 "the v2 bundle schema does not exist yet either" — bundle v2 landed 08-12/16 (0148 item 1). Not corrected at the 08-16 edit.
- **Named scenarios all absent**: `assurance-status-valid`, `claims-evidence-gate`, `audit-state-honesty`, `waiver-ratification-ledger`, `maintainer-affiliation-quorum`, `tier3-evidence-bundle` — 6/6 absent (`rfc-conformance-coverage.mjs` output); the function lives in `scripts/generate-assurance-status.mjs --check` (gated at `openwop-check.sh:175`) — acceptable, but the RFC's Conformance section is then a list of files that will never exist; amend to name the script.
- Part V: acceptance items carry sources; no verification record.

### 4. Implementation reality on current main
- §A–§D: **EXTERNAL / OPEN**. `MAINTAINERS.md` one maintainer (`ASSURANCE-STATUS.json.governance`); waivers derived **41** (`.waivers.bootstrapWaiversExercised`, incl. 0147–0157) vs the hand ledger in `MAINTAINERS.md:116-143` (**26 rows ending RFC 0094**, tripwire note :147 "records 26"); retrospective reviews 0; audit `unscheduled`, tracker "Vendor outreach sent: null" (`SECURITY/external-audit-engagement.md §8` via manifest); Tier-3 `false`.
- Protocol-repo governance mechanics: branch protection = required check "Validate spec corpus (server-free)", `required_pull_request_reviews: null`, `enforce_admins: false` (`gh api repos/openwop/openwop/branches/main/protection`, 2026-08-18) — cross-org review is not enforceable by tooling today and there is nobody to review.
- §E/§F LANDED: `docs/ASSURANCE-STATUS.{json,md}` derived, `--check` gated; 0/7 claims permitted; token scan over README/ROADMAP/governance/security/compat/INTEROP/docs/conformance-README (`generate-assurance-status.mjs:225-250`). Site repo unscanned (RFC says so :118). Sanity: `~/dev/openwop-site` (`fb6b733` 07-07) has no gated-token hits; it does say "vendor-neutral by construction" / "vendor-neutral wire protocol" (`site/content/faq.md:15`, `comparisons/a2a-openwop-mcp.md:13`) — adjacent to the gated "vendor-neutral standard" phrase, not identical.
- §G: SLA source LANDED (`SECURITY/response-sla.json`, `check-doc-tallies.mjs`); cadence records OPEN.
- Internal Medium findings: `SECURITY/internal-pre-audit-findings.json` (untouched since `52e920b6` 2026-05-17): 13 findings — high 3 (all fixed), **medium 4 open**, low 4, info 2; records carry no owner/target date; the manifest does not count them (`grep internal generate-assurance-status.mjs` = 0).
- Evidence level: server-free; everything that matters is external.

### 5. Roadmap bullet-by-bullet (roadmap :311-328)
- Appoint two independent maintainers / activate WG / remove tie-break / retire waivers / retrospective review / commission audit / remediate / Tier-3 / cross-org review / recurring reviews — **EXTERNAL** (ten bullets), with the 2-vs-3 caveat above.
- "Resolve or time-bound the current Medium internal findings" — **OPEN** (4 open medium, no dates, uncounted by the manifest).
- "Keep A/A+ claims blocked until the evidence is machine-verifiable" — **DONE with two holes** (D15/D16).

### 6. Cross-artifact
- Depends on 0148 (Tier-3 = bundle v2), 0155 (claim vocabulary), 0152/0153 (real-peer rows), 0150/0151 (multi-region / best-in-class rows). Consumes every `RFCS/registers/*.risks.md`.
- Freeze: R14 (single maintainer) is a Critical risk that keeps §A.1 binding — the roadmap's new-wire RFCs are gated on THIS RFC's human work.
- Part III: "Disabled CI and unprotected merges → RFC 0156 claims policy" — **mis-owned**: RFC 0156 contains no CI/branch-protection requirement ("CI" appears only in §F "CI MUST fail if README/site claim tokens exceed"); "Vulnerable production dependencies → Security policy and RFC 0156 claims gate" — 0156 owns no dependency policy; "External security assurance → RFC 0156 / ADR 0585" — the operative owner is `SECURITY/external-audit-engagement.md`.

### 7. Defects & gates-that-cannot-fail
- **D15 — two claim rows can never fire**: `generate-assurance-status.mjs:142-143` `current-A2A compatible` / `current-MCP compatible` have `tokens: []`. Confirmed. Tiny (add tokens: "A2A 1.0 compatible", "current A2A", "MCP 2026-07-28 compatible", "current MCP").
- **D16 — five of seven `permitted` values are constants** (`:141-147`: fully-conformant, current-A2A, current-MCP, multi-region, best-in-class hard-coded `false`); only `independently validated` (`t3 && audited`) and `vendor-neutral` (`crossOrg && t3`) are derived — and `crossOrg = orgs >= 2` (`:135`), the weaker threshold. When the A2A official-peer run lands (unblocked per slice C), the row stays `false` until someone edits the script — a permitted claim gated by a constant is a gate that cannot go green **or** red on evidence. Small: derive from INTEROP-MATRIX rows / register state; align to 3 orgs or record why 2.
- **D17 — `EXEMPT_CONTEXT` is broad** (`:223`: `no|not|until|requires?|needs?|coverage|claim…` within 90/60 chars): "OpenWOP is the industry standard for orchestration; no other protocol …" is exempted by the trailing "no". False-negative surface; the plain-claim case does fire. Small: tighten to negation immediately preceding, or list-allow specific sentences.
- **D18 — `MAINTAINERS.md` waiver ledger stale/duplicative** (26 hand rows vs 41 derived; sets differ — the hand ledger predates 0101–0157). Delete or generate. Tiny.
- **D19 — internal Medium findings uncounted and undated** (§4). Small: add owner/target fields + a manifest section.
- Cannot-fail: the token gate for the two empty rows (D15).

### 8. Verdict
Roadmap: **accurate that it is almost entirely human/external**; misses D15–D19 and the 2-vs-3-org threshold. Artifact needs: correct :110/:117 annotations, restate §A with the three-org tripwire (or amend GOVERNANCE), amend Conformance to name the script, and the small script fixes. **P0 external (maintainers/audit/Tier-3 gate everything, including the freeze) / P2 corpus.**

---

## Proposed RFC 0160 — Signed Conformance Evidence and Release Attestations

### 1. Premise check
The roadmap gives no "why a new artifact is required" paragraph for 0160 (roadmap :406-421 lists decisions only). Its motivating gap ("incomplete signed conformance and release attestations", :81) is TRUE: no certification bundle is signed (0148 G4 "no bundle is signed", `registers/0148-…gaps.md:13`; 0154 G4 "bundles unsigned", `registers/0154-…gaps.md:11`); the app's signer is unwired (ADR 0550 status line: "residue: nothing invokes `scripts/sign-attestation.mjs` (no deploy pipeline calls it)" — confirmed, `scripts/deploy.sh:219-238` runs `--certify` and never calls the signer). But the DECISION space is already owned (§2), so the premise for a *new number* under roadmap rule 6 is weak.

### 2. Existing owners
- Signed evidence envelope compatible with SLSA/in-toto → **RFC 0154 §E** (:76 "The project MUST publish provenance attestations for spec releases, conformance packages, SDK packages, and official packs. Each attestation binds artifact digest, source revision, builder/workflow identity, build invocation, dependency lock digest, and publication identity. Certification bundle v2 … MAY be wrapped in the same signed attestation format. Verification MUST fail closed …"), UQ3 (:123 "Which in-toto/SLSA predicate becomes the canonical provenance envelope?"), G4 (`registers/0154-…gaps.md:11`); RFC 0148 UQ3 (:130) + G4 (:13 "0148 owns digest; 0154 decides attestations/signatures").
- Bind digests → 0148 §C (`scenarioManifestSha256`, `targetConfigurationSha256`, discovery digest) + 0154 §E list; the app binds commit/containerDigest(env)/discoveryDigest/evidence digest/suite version (`scripts/sign-attestation.mjs:113-146`).
- Builder identity, issuance/expiry → 0154 §E; expiry periods → **RFC 0156 UQ5** (:105) / R19; the app's payload has `issuedAt/expiresAt` 30 days (`sign-attestation.mjs:41,144-145`).
- Offline verifier → 0148 consumer verifier (`certification-bundle-verify.ts`) + app `host/deploymentAttestation.ts` `verifyAttestation` (:165-195, checks expiry) + `scripts/verify-published-provenance.sh` (needs the npm registry — not offline).
- Redaction rules → **RFC 0148 §E** (landed: `scrubEvidence`, `certification-bundle-redaction.test.ts`).
- Evidence-level vocabulary → `INTEROP-MATRIX.md` header vocabulary (S10) + `GOVERNANCE.md` tiers (prose only; no bundle field).
- Prohibit A/A+ on unsigned/expired → **RFC 0156 §E/§F** (claims table + manifest).

### 3. Genuinely new residue
- The predicate/envelope choice itself (0154 UQ3): DSSE + SLSA provenance v1 (already what npm OIDC emits for suite+SDK, `verify-published-provenance.sh:6-9`) vs the app's bespoke `openwop-app.deployment-attestation.v1` (`sign-attestation.mjs:113`) — two formats in the ecosystem today.
- An **evidence-level field** on bundle v2 (`schema|server-free|test-seam|local-live|deployed-live|official-peer|independent-host|external-audit`) — none exists in `certification-bundle-v2.schema.json`.
- Nonce/supersession/revocation semantics — none anywhere.
- Image-digest binding as REQUIRED (app: `containerDigest: process.env.OPENWOP_ATTEST_CONTAINER_DIGEST ?? null`, optional).
- A signing-key policy (who holds the key; the app rule "a signer may only sign what it can verify", `sign-attestation.mjs:8-22`, is the right invariant to lift).
- App-side nit: `sign-attestation.mjs:139` `profiles: Object.keys(discovery.json?.capabilities ?? {})` reads the DEPRECATED `capabilities` mirror (`routes/discovery.ts:1871-1877` keeps it for the migration window) and lists capability FAMILY names under a key called `profiles` — it will silently become `[]` when the mirror is dropped, and it is not the RFC 0155 profile set anyway.

### 4. Wire/freeze/compat
- Additive, capability-neutral (bundle v2 wrapper + a schema field) — but bundle v2 `requirements[]` is closed and any top-level addition is a bundle-schema minor + reissue. Not blocked by §A.1 (WS1/WS6 repairs), but a **new optional wire field is exactly what §A.1 freezes unless argued essential** — argue it as part of 0148/0154 (existing workstreams), not a tenth RFC.
- Compat: the app's bespoke envelope would become a second format to deprecate.

### 5. Recommendation
**AMEND RFC 0154 §E (predicate = DSSE + SLSA v1; bundle-v2 wrapper; evidence-level field; expiry/supersession; key policy) and strike RFC 0148 UQ1/UQ3 by reference; the app wires `sign-attestation.mjs` into `deploy.sh` under ADR 0550 (already its recorded residue) and migrates the payload to the chosen envelope. DON'T author 0160.** Acceptance tests (falsifiable):
- `artifact-provenance-verification.test.ts` (0154's own named absent scenario): a bundle with a flipped byte in `results.totals` under a valid signature → REJECT; a valid DSSE over a bundle whose `evidenceLevel` is `deployed-live` but whose `host.commit` ≠ the readiness `build.commit` → REJECT. Red today (no signer, no field).
- Bundle-v2 schema leg: `evidenceLevel` REQUIRED enum; a bundle without it fails validation. Red today.
- Expiry leg: `expiresAt < now` → verdict `expired`, and `generate-assurance-status.mjs` demotes the claim. Red today (manifest reads no bundle expiry).
- App: `deploy.sh` produces `build-meta/attestation.json` and `/api/readiness` (or the Operations projection) verifies it — a deploy without the file refuses to ship, like the certify stamp at `deploy.sh:229-236`. Red today.

---

## Proposed RFC 0164 — Normative Lifecycle and Publication Coherence

### 1. Premise check
Roadmap :480-494 lists six normative decisions and "Compatibility: editorial and process"; no "why new" paragraph. The underlying gap is REAL — I found live, uncaught contradictions (D1 dead generated section since 06-11; D10b two Draft docs mis-stating their owner RFC as `Active`; `grpc-transport.md:201` "in flight"; README:68-69 stale tallies/versions; the RFC 0147 ledger/self-audit/registers lagging by hours). But five of six bullets are already decided by RFC 0149 §D + 0147 §A.9/§C(8) + 0156 §F, and the enforcement holes are implementation gaps in existing generators, not missing decisions.

### 2. Existing owners
- "Accepted RFC requirements must appear in normative specs or carry an implementation-status annotation" → 0147 §A.10 + 0149 §D first sentence (:80) + the third axis of `rfc-conformance-coverage.mjs` (Affects paths exist — 0 absences; ungated).
- "Draft specs cannot silently carry released mandatory behavior" → 0149 §D second half (:80 "or when a Stable/FINAL spec describes its owning RFC as pending acceptance"), UQ4 "unproven, not clean" (:117) — **no leg**; D10b shows the inverse case (Draft spec, Accepted owner, wrong owner status) is live.
- "Stale open/in-flight/UQ sections fail CI when contradicted" → 0149 §D + 0147 §C(8) "status-sensitive linting"; landed only as annotated-vs-bare for RFCs ≥0147.
- "Acceptance items machine-classified complete/carried/externally gated" → 0149 §D + `rfc-lifecycle-coherence.test.ts:59-62` (any parenthetical counts; no vocabulary).
- "Every external gate must name required evidence" → 0156 §F manifest `requires` strings (`generate-assurance-status.mjs:141-147`) + `docs/ASSURANCE-STATUS.md`.
- "Generated protocol status becomes the authoritative publication index" → 0147 §A.9 + `generate-protocol-status.mjs --check` (with D1 dead section) + `generate-assurance-status.mjs --check`.

### 3. Genuinely new residue
- A **classification vocabulary** for acceptance items (`complete|carried|externally-gated`) with the external-gate→evidence table generated per RFC.
- The **RFC→spec projection annotation** (which spec section implements which RFC §) — nothing machine-readable today.
- Retroactivity policy (0149 UQ4 measured: ~200 bare items pre-0147; a blanket gate would be disabled).
- A per-child acceptance view (the same thing RFC 0147's roadmap bullet asks for).

### 4. Wire/freeze/compat
Host-local/editorial/process; no wire; not frozen.

### 5. Recommendation
**AMEND RFC 0149 §D (vocabulary + spec-status leg + retro policy) and extend the two generators; DON'T author 0164** — a new process RFC would be another hand-maintained artifact of the kind that is decaying here. Acceptance tests (falsifiable):
- `rfc-lifecycle-coherence` new leg: for each `spec/v1/*.md` whose `:3` names `RFC NNNN \`Status\``, the status equals `RFCS/NNNN-*.md`'s cell → **red today** on `self-hosted-runner.md:3` and `frontend-plugin-packs.md:3`.
- Leg: an `Accepted` RFC's unticked item must match `^\((complete|carried: .+|externally gated: .+)\)` → red today on most 0147–0157 items (they use free-form parentheticals) — hence the retro policy must land with it.
- `generate-protocol-status.mjs`: reference-host table rows > 0 or fail → **red today** (D1).
- README banner counts derived (`49 of 60` etc.) and versions read from `conformance/package.json`/CHANGELOG → red today (D11).
- `rfc-conformance-coverage.mjs` added to `openwop-check.sh` with a ratchet (absent count may not grow; alias table entries must resolve to files) → red if someone names a scenario and ships none.

---

## Corrections to prior audit

- **0154 invariant count**: the prior audit's summary row says "4/7 invariants unregistered" (`PRIOR-AUDIT.txt:61`) and its detail says "3/7 invariants" registered (:297). Both are right by different counting: `SECURITY/invariants.yaml` registers `delegation-tenant-audience-bound`, `delegation-no-scope-amplification`, `delegation-chain-bounded` (partial), `delegation-chain-acyclic` (the RFC's `delegation-chain-bounded-acyclic` split in two) = 4 ids covering 3 of the 7 §F names; unregistered by name: `workload-identity-cryptographically-bound`, `delegation-provenance-not-authorization`, `sender-constraint-no-bearer-downgrade`, `provenance-attestation-digest-bound` (grep counts). Say "4 named-but-unregistered", not "4/7 registered".
- **0154 G4 "no attestation predicate / signing service"** (`registers/0154-…gaps.md:11`, sweep 04:12 08-16) is now stale for the suite/SDK half — `f082abd1` (14:12) landed npm OIDC SLSA v1 provenance + `verify-published-provenance.sh`. Prior audit credited the provenance but did not flag the register row as stale.
- **RFC 0147 self-audit "42 absent scenarios"** — the script now reports 29 absent (my run); prior audit did not re-run it.
- **RFC 0148 §C:87 vs G7** — the prior audit did not catch that the RFC body still says `openwop-replay-fork` is "deliberately left unspecified" although the conditional floor landed (`2a19cea1`) five hours before the body's last edit, and MyndHyve now certifies on it.
- **RFC 0149 §D second half "no hits"** — prior audit repeated 0149 UQ4's "unproven, not clean"; there ARE two concrete hits (`self-hosted-runner.md:3`, `frontend-plugin-packs.md:3`) plus the "in flight" line. New finding.
- **`docs/PROTOCOL-STATUS.md` dead section (D1)** — not in the prior audit; it undercuts the prior audit's own recommendation to "extend generate-protocol-status.mjs" without noting the generator already silently emits an empty table.
- **RFC 0156 §F claim gate**: prior audit's "2 of 7 rows empty token lists" confirmed (`:142-143`); additionally 5 of 7 `permitted` values are constants and `crossOrg` uses `>= 2` orgs (D16) — the prior audit noted the hard-coded `false` for two rows only.
- **Prior audit's "protocol repo is already protected with a required green check"** — confirmed (`Validate spec corpus (server-free)`), with the caveat that reviews are not required and admins are not enforced.
- **Nothing in this slice moved between fa968b428 and 9b2af4839** except the RFC 0147 criterion-5 staleness deepening (#3325 = ADR 0553 P3); the prior audit's "H53 STILL unmerged" is resolved (#3325 merged).
- Prior audit line 27 "0160 is RFC 0154 §E's open UQ3; 0164 is RFC 0149 §D + 0147 §A.9" — **confirmed** with citations above.

## Priority summary
- P0 (human): two/three-org maintainers, audit outreach (never sent), Tier-3 host — gates RFC 0147 §A.1 freeze release, 0155 Stable, 0156 entirely.
- P1 (corpus): 0148 leg-level ids + real witness digest or strike the field (D4/D5), amend 0154 §E as the signing home (0160 → amendment) and wire the app signer under ADR 0550.
- P2 (corpus): 0149 D10a/D10b/D11 before Phase 5; 0147 ledger/self-audit/register re-sweep + generated per-child view (0164 → 0149 §D amendment); D1 dead generated section; 0156 D15–D19.
- P3: 0155 registry schema, one claim-vocabulary generator, budget leg once UQ1 is re-derived.
