# ADR 0427 — workflow-chain-pack registry-fetch signature verification (the M1 signing leg)

Status: **implemented** (P1+P2, 2026-07-18; record below)

**Requirements source:** `docs/kicktodo-prd.md` §12 Wave 3 + the folded review finding **M1** (PRD:609): node/agent/plugin packs verify against the host-held Ed25519 keyring (ADR 0367), but **workflow-chain packs fetched from a registry do not** — `src/host/workflowChainPackLoader.ts` documents the gap itself ("no signature check here", line 26).
**Depends on:** ADR 0367 (pinned keyring + revocation), `packSignature.ts` (`verifyPinned`, `loadPinnedKeyring`, `verifyDetachedPinned` — the primitives are BUILT), ADR 0415/0420 (the consumers: executable third-party challenges).
**Surface:** host trust machinery — not a feature package, **no toggle**, an env-flag posture. **NO new RFC.**

## Why this exists

A third-party paid challenge that ships an executable workflow-chain pack is remote code selection by a non-operator. Every other pack lane already refuses unsigned/revoked content; the chain-pack registry-fetch lane is the one door left unlocked. This ADR closes it — and it is the falsifiable trigger recorded on **ADR 0420 P4** ("vacuously satisfied while no executable challenge packs exist"): the moment such packs exist, THIS must already be enforced.

## Boundaries audit

- **Primitives exist — compose, don't rebuild:** `packSignature.ts:121 verifyPinned`, `:77 loadPinnedKeyring`, `:108 verifyDetachedPinned`. No second verification path, no second keyring.
- **One loader:** `workflowChainPackLoader.ts` is the single registry-fetch consumer; built-in (in-tree) chains and operator-pinned packs are already covered by the existing review posture and stay exempt from the new REQUIREMENT (they carry no third-party trust claim).
- **No wire surface:** verification is host-internal; nothing advertised; conformance unaffected.

## Decision

- `workflowChainPackLoader.ts` verifies every REGISTRY-FETCHED chain pack with `verifyPinned` against the ADR 0367 keyring before any part of it is loadable.
- **Posture flag `OPENWOP_REQUIRE_CHAINPACK_SIGNATURES`** (env, default **unset**): unset → verify and LOG (`chainpack_signature_unverified` warn, load proceeds — today's behavior, observable); set → **fail closed** (`failed`/`revoked`/`unsigned` ⇒ the pack does not load, typed error, never a silent skip). The deploy that opens third-party executable challenges MUST set it — recorded in the ADR 0420 P4 trigger and the deploy checklist.
- **Publisher keys:** third-party publishers get per-publisher key ids in the pinned keyring (the ADR 0367 flow); revocation is immediate on next load. Key distribution/rotation stays an operator action — no self-serve key upload in this ADR.
- Cached/installed packs re-verify on load (bytes-at-rest are not trusted state).

## Phased plan

| Phase | Ships |
|---|---|
| **P1** | Verification call + posture flag in the loader; typed failure; tests: unsigned/failed/revoked/trusted × flag set/unset; built-in chains unaffected. |
| **P2** | Publisher-key operator flow documented (keyring add/revoke runbook) + the deploy-checklist line tying the flag to third-party-challenge opening; ADR 0420 P4 correction note pointing here. |

## Implementation record

| Phase | Landed |
|---|---|
| P1 — `verifyPinned` in `loadWorkflowChainPacks` for REGISTRY-INSTALLED packs only (verified BEFORE any chain registers — no fail-open partial loads); `OPENWOP_REQUIRE_CHAINPACK_SIGNATURES=true` ⇒ unsigned/failed/revoked packs rejected as collected `workflow_chain_pack_signature_<verdict>` errors (boot never aborts); unset ⇒ observable `chainpack_signature_unverified` warn. Exemption boundary (operator-override + in-tree roots) test-pinned; trusted + revoked verdicts exercised with REAL Ed25519 signatures in test; loader regression suites green. **Implementation finding:** the chain-pack schema's signing block has no `keyId` field — the pinned key id rides `publicKeyRef` (the registry manifest documents it as the legacy ALIAS of `keyId`); the loader normalizes the alias before the pinned check rather than editing the upstream-owned schema | kicktodo/0427-signing |
| P2 — operator runbook (below) + the deploy-gate line; ADR 0420 P4 correction note pointing here | kicktodo/0427-signing |

## Operator runbook (P2)

1. **Pin a publisher key:** place the PEM under `OPENWOP_TRUSTED_PACK_KEYS_DIR` and add `{ "keyId": "<id>", "file": "<name>.pem" }` to that dir's `index.json` (the ADR 0367 keyring).
2. **Revoke a version:** append `"<packName>@<version>"` to the JSON array at `OPENWOP_TRUSTED_PACK_REVOCATIONS`. An unreadable revocation file EMPTIES the keyring (fail-closed by design — packSignature.ts).
3. **Enforce:** `gcloud run services update openwop-app-backend --update-env-vars OPENWOP_REQUIRE_CHAINPACK_SIGNATURES=true …` (merge flags, never `--set-*`). **This flag MUST be set before the deploy that opens third-party executable challenges** — it is the ADR 0420 P4 trigger.
4. Watch `chainpack_signature_unverified` warns BEFORE enforcing to inventory unsigned packs.

## Alternatives weighed

- **A feature toggle instead of an env flag** — rejected: trust posture must not vary per tenant/cohort; it is a deployment property (same reasoning as `OPENWOP_REQUIRE_BEHAVIOR`).
- **Verify only at install time** — rejected: bytes at rest drift from the trust decision; load-time verification is the invariant the other lanes already hold.
- **Self-serve publisher key upload** — rejected here: key custody is the whole game; operator-mediated pinning first, self-serve is its own future decision.

## Open questions

1. Signature format for chain packs published before this lands (none exist third-party — moot unless D5 content ops externalizes early).

## RFC verdict

**Host work, no new RFC.** Host-internal trust enforcement; no wire shape, capability, or normative claim changes.
