# ADR 0367 — Signed pack trust tier: reviewed, signed packs load main-frame; unsigned stay sandboxed

Status: Implemented (2026-07-14) — Phases 1–3 landed

## Context (/architect track A — boundaries + threat model first)

ADR 0300 loads pack UI in a sandboxed iframe (opaque origin, `allow-scripts`
only, RPC-only bridge). That is the CORRECT boundary for untrusted code — a
malicious pack cannot read the session, BYOK material, or act as the user —
but it caps quality: no shared design tokens, no ONE-chat embedding, no
first-party feel. The product wants partner-grade packs with native quality.

**Boundaries audit:** the verification primitives already exist and have one
owner each — Ed25519 signature verification lives in the pack loaders
(`host/workflowChainPackLoader.ts`, `canvasContentPackLoader.ts`,
`promptPackLoader.ts`; the registry pipeline signs with the openwop-team key
and publishes SRI per RFC 0013/0043); the marketplace feature owns install UX;
ADR 0300 owns the sandbox lane. Nothing models "trust tier" yet — this ADR
adds the POLICY and one loader lane; it must not fork a second
signature-verification implementation (extract the existing verify into ONE
shared `host/packSignature.ts` consumed by all loaders — the shared-helper
rule).

**Threat model (the load-bearing analysis):** a Tier-1 pack runs arbitrary JS
in the authenticated main frame. The signature therefore IS the security
boundary, which relocates risk from the browser to three places that must
each be first-class:
1. **Key custody** — the openwop-team private key (already held offline per
   the publish recipe). A leaked key = every deployment compromised: document
   custody + rotation in SECURITY notes; the verifier must support key
   ROTATION (multiple pinned public keys with ids) and REVOCATION.
2. **Review integrity** — signing is a claim that a HUMAN reviewed that exact
   artifact. Each VERSION is signed after review; an update is unsigned until
   re-reviewed (no auto-update into unreviewed code). The review checklist is
   part of this ADR's Phase 1 deliverable, not folklore.
3. **Revocation** — a pinned revocation list (pack id + version) checked at
   serve time; revoked ⇒ fall back to sandbox or refuse (fail-closed), never
   silently keep serving.

## Decision

Three trust tiers, each with one lane:
- **T0 first-party**: compiled features (ADR 0001; composable per ADR 0366).
- **T1 reviewed+signed**: pack UI whose EXACT version carries a valid
  openwop-team Ed25519 signature + SRI loads in the MAIN frame via dynamic
  import, with full design-system/i18n/chat integration.
- **T2 community/unsigned**: the ADR 0300 sandbox, unchanged. Absence of a
  valid signature ⇒ T2, always — fail-closed by construction.

**The CSP resolution (the hard mechanism question):** the frontend pins
script hashes (`check-csp-script-hash`) and must stay self-contained, so T1
modules are NOT fetched from the registry by the browser. Instead the
BACKEND is verifier and origin: it serves the module at
`/v1/host/openwop-app/trusted-plugins/:packId/:version.mjs` ONLY after
re-verifying signature + SRI + non-revoked at serve time; the SPA
dynamic-imports from its own API origin (same-origin `script-src 'self'`
scope — no CSP weakening, no third-party origin). The FE import additionally
carries the SRI hash. Toggle kill-switch (`trusted-plugins`, default OFF)
gates the whole lane; per-pack disable rides the existing pack admin.

**Marketplace honesty:** listings label the tier explicitly ("Reviewed &
signed — runs with full access" vs "Community — sandboxed"), and the install
consent for T1 states the access plainly. RBAC: installing/enabling T1 is
operator/superadmin, not workspace-member.

**RFC verdict: none.** Signing/SRI ride the already-Accepted registry RFCs
(0013/0043); tier semantics are host policy under non-normative surfaces.

## Alternatives rejected
- **Soften the sandbox** (Shadow DOM + SES/compartments): a JS-level fence
  around a leaky DOM; not a security boundary. Rejected.
- **One tier, everything signed**: kills the community lane's zero-friction
  contribution path the sandbox exists to enable. Rejected.
- **Browser fetches from the registry with CSP allowlisting**: third-party
  origin in CSP + registry availability coupling. Rejected for the
  backend-origin serve.

## Phases
| Phase | Scope | Gate |
|---|---|---|
| 1 | Policy: review checklist, key custody/rotation/revocation doc, ONE shared `packSignature.ts` (refactor existing loaders onto it) | /architect on the checklist; no behavior change |
| 2 | **LANDED** — the T1 lane: `GET …/ui-plugin/trusted/:name/plugins/:pluginId/entry.mjs` (toggle `trusted-plugins` default OFF; `verifyPinned` manifest + `verifyDetachedPinned` module bytes re-verified at EVERY serve; uniform 404 on toggle-off/unsigned/tampered/revoked/unknown-key), honest tier labels + `trustedEntryPath` in `/packs`, FE `TrustedPluginHost` (same-origin dynamic import, `mount(el)` contract, fail-closed). | /code-review + security-focused /architect; route tests incl. tampered/revoked/unsigned → fail-closed (`test/trusted-plugin-lane.test.ts`, 6 pins) |
| 3 | **LANDED** — `packs/vendor.openwop.trusted-demo` signed with the REAL `openwop-team-1` key (manifest + module-bytes signatures), committed PUBLIC keyring `deploy/trusted-keys/`, publish/review/custody/rotation/revocation doc `docs/trusted-pack-publishing.md` (absorbs the Phase-1 policy-doc residue), `/ui-plugins` prefers the trusted viewer. | `test/trusted-pack-committed.test.ts` pins the committed artifacts end-to-end over HTTP (signature drift = red CI); local boot smoke |

### Correction note (Phase 2 implementation, 2026-07-14)

Two decisions sharpened during implementation, recorded rather than rewritten:

1. **The T1 payload is a separate ES module, and the signature must cover the
   CODE.** The sandbox `entry` is HTML (srcdoc); the main-frame lane serves the
   sibling `<entry-basename>.mjs` instead, dynamic-imported with a
   `mount(el): cleanup` contract. A manifest-only signature would leave the
   actually-served bytes unattested — so the lane requires a second detached
   signature `<module>.mjs.sig` over the exact module bytes
   (`verifyDetachedPinned`), verified with the SAME pinned key at every serve.
2. **Signing refs live in the `pack.sig.json` sidecar, not the manifest.** The
   frontend-plugin manifest schema is wire-pinned (`additionalProperties:
   false`, RFC 0117); adding a `signing` block there would be a wire change
   needing an RFC. The existing RFC 0117 §Signing sidecar
   (`{keyId, manifest, signatureFile}`) already names the key, so the host maps
   it into `verifyPinned`'s shape — pure host-extension, no wire touch.

## Open questions
- Whether T1 packs may declare `dependsOn` toggles (compose with ADR 0194).
- Version-pinning UX when a deployment holds an older reviewed version than
  the registry's latest unreviewed one (expected: stay pinned, badge it).
- Interaction with ADR 0366 distributions (a manifest may exclude the
  `trusted-plugins` lane entirely for hard-compliance customers).
