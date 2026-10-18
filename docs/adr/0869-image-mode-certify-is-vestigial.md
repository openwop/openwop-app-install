# ADR 0869 — Image-mode certify is vestigial on a v2-only host

Status: implemented (`scripts/deploy.sh`, 2026-10-10)

Date: 2026-10-10

## Context

`scripts/deploy.sh` has two evidence modes (ADR 0735 / WHD-18):

- **Origin mode** (`OPENWOP_CERT_BUNDLE_ORIGIN` set; production). Since ADR 0812
  P3c it builds no image bundle. The host serves the signed v3 bundle that
  `scripts/publish-evidence.sh` cuts against the live service.
- **Image mode** (unset; every white-label adopter). It still ran the in-process
  lane (`npm run test:conformance -- --certify`, ADR 0550 P4) and refused to ship
  unless that lane wrote `build-meta/certification-bundle.json`.

ADR 0812 P3c left image mode as an OPEN item: "adopters who certify in image mode
cannot claim a profile in-process at major 2". On 2026-10-10 the openwop steward
traced the cause. `conformance/run.ts` `emitCertification` → `certify.ts`
`assembleCertification` writes a legacy bundleVersion "2" document, validated by
`schemas/certification-bundle-v2.schema.json` (`claimedProfiles` minItems 1). Its
claims come from `claimedProfilesFor` (`certify.ts:117`), which knows only the
MAJOR-1 rules. A v2 discovery document matches none of them, so the claim list
is empty and the emit fails. **Every image-mode deploy without `--skip-certify`
refused to ship.**

Fixing the emitter was the obvious remedy, and it would not have helped.
**MEASURED on `origin/main`:** the image stamp is served and advertised only at
MAJOR 1.

- `certificationBundleUrl()` gates on `servedBundle(1)`, and its one caller is
  the v1 discovery builder (`routes/discovery.ts:2998`).
- `certificationBundleUrlV2()` is "ORIGIN MODE ONLY, by construction: the image
  carries no major-2 bundle" (`host/conformanceClaims.ts`).
- Major 1 is retired (ADR 0812 P3c: `/v1` answers 410).

So an image-mode stamp reaches no client. The lane cost ~10 minutes per deploy,
blocked every adopter deploy, and would have produced, even if fixed, an
artifact nothing serves.

## Decision

**`scripts/deploy.sh` builds no image bundle in EITHER evidence mode.**

- Image mode prints that the pointer is absent and how to serve evidence: set
  `OPENWOP_CERT_BUNDLE_ORIGIN` and run `scripts/publish-evidence.sh` after the
  deploy. RFC 0089 §D: omitting the pointer "is fully conformant; clients MUST
  tolerate its absence".
- **The major-2 ratchet** (`scripts/check-conformance-major2.sh`) still runs in
  both modes, still refuses to ship on a regression, and `--skip-certify` still
  skips it (`DO_CERTIFY -eq 1`). It is now the only pre-upload conformance gate
  in deploy.sh, as it already was in origin mode.
- `npm run test:conformance` (no `--certify`) remains a merge gate inside
  `npm run ci` (ADR 0550 P1). No code-level conformance coverage is lost.

## Alternatives weighed

1. **Port the emitter to bundle v3 with the v2 rules.** It would produce a valid
   document that is still served nowhere, because the image stamp has no
   major-2 serving path. It would also re-implement `claimedProfilesForV2`, which
   the suite package does not export, so it would drift from the suite.
   Rejected.
2. **Run the upstream `openwop-conformance --certify --bundle-version 3` against
   the in-process host.** The same problem: the result is unservable in image
   mode. Serving a v3 image stamp at major 2 would mean a new serving path for
   evidence ADR 0735 calls "cut before the thing it describes exists". That is
   the dishonest artifact WHD-18 removed. Rejected.
3. **Loosen the v2 schema's `minItems`.** A bundle that claims nothing attests
   nothing. Rejected (the steward said so too).
4. **Keep the lane and tell adopters to use `--skip-certify`.** `--skip-certify`
   also skips the major-2 ratchet, so the documented workaround removed the one
   real gate. Rejected.

## Consequences

- Adopter deploys stop refusing, and keep the major-2 ratchet.
- A deploy is ~10 minutes shorter in image mode.
- `write-build-commit.mjs` still DELETES any stale stamp (the H42 rule), so a
  long-lived checkout cannot ship old evidence. Nothing re-creates the stamp.
- **Left in place, now unused by any deploy:** `run.ts --certify`,
  `certify.ts` and the major-1 image serving path (`servedBundle(1)`,
  `certificationBundleUrl`). They belong to the v1 discovery builder's deletion,
  the remaining ADR 0812 debt, and go with it.

  > **CORRECTED 2026-10-10 — only one of the four went with it.** MEASURED on
  > `3bf8e576f`, after #4674 deleted the v1 discovery builder (ADR 0812 P4):
  > `certificationBundleUrl()` is GONE (`host/conformanceClaims.ts:310` records
  > the deletion). Still present: `servedBundle(1)`, which now gates
  > `conformanceClaims()` (`conformanceClaims.ts:268`, the image-mode claims
  > document whose `evidence.bundlePath` names the image bundle); `run.ts
  > --certify` (`conformance/run.ts:573`); and `conformance/certify.ts` (lazily
  > imported at `run.ts:1257`). No deploy produces the image stamp any more, so
  > in image mode `servedBundle(1)` and the claims document return `undefined`.
  > They are dead code, but deleting them is a separate slice; the v1 deletion
  > did not cover it.
  >
  > **DONE 2026-10-16 (ADR 0812 P4 slice 3).** All three are deleted:
  > `conformance/certify.ts`, `run.ts --certify` (now refused with exit 2 and a
  > pointer to `publish-evidence.sh`), the image reader behind `servedBundle(1)`,
  > `conformanceClaims()`, and the two routes they fed. MEASURED in production
  > before the deletion (origin mode, 2026-10-16 ~04:05Z): both routes already
  > answered 404. The major-2 origin route is unchanged. One dead arm remains in
  > deploy tooling: `check-wire-claims.mjs`'s image-mode claims arm (it SKIPs
  > when no stamp exists, and nothing writes one now).

## Implementation

| Change | Where |
|---|---|
| No image bundle in either mode; correction note on the ADR 0550 P4 block | `scripts/deploy.sh` |
| Gate tests: assert the lane is absent, the ratchet still refuses, and the arm falls through; ordering checks re-anchored on the ratchet (sabotage: re-adding the lane plus an `exit` makes 2 checks red) | `scripts/test-deploy-gates.sh` (272/272) |
| Stale-stamp message no longer says deploy.sh re-runs `--certify` | `scripts/write-build-commit.mjs` |
| Lane 1 correction note | `docs/steward/CERTIFY-RUNBOOK.md` |
| Resolves ADR 0812 P3c's OPEN image-mode item. The pointer note in ADR 0812 follows #4663, which edits the same lines. | — |
