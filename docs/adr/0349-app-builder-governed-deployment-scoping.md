# ADR 0349 — App-builder governed deployment: scoping decision (contract shipped; adapters gated)

Status: Accepted (2026-07-10) — a SCOPING decision (the ADR 0307 pattern); no deploy execution ships with this ADR.

**Program:** ADR 0342 Phase 7. **Depends on / composes:** ADR 0348 (the
deployable-artifact contract), ADR 0306 (the governed vendor-write precedent),
ADR 0028/0033 (Connections + `adapterOnly`), ADR 0345 3e + ADR 0346 AI-08 (the
same activation-trigger family). **Research:** gap doc §5.7 EX-06/07/08.

## Decision

**The deploy CONTRACT is already shipped** by this program's seams, and they
are hereby named as what a deploy adapter consumes:

| Deploy concern | Existing seam |
|---|---|
| The deployable artifact | ADR 0348 6c lineage — a reviewed export addressed by its **sha256 hash** (`GET …/canvases/:id/exports`), regenerable byte-for-byte from `(canvasVersion, target)` |
| What the artifact contains | the ADR 0348 bundle: generated source + `openapi.json` + preflight notes (what the target does NOT carry) |
| Environment requirements | the ADR 0343 `envRequirements[]` facet — SYMBOLIC keys; values stay in host Connections/secret management |
| The governed write path | `host/brokeredEgress` + `adapterOnly` connections + per-user consent (the ADR 0306 GitHub-publish shape: route-side only, token never in a node) |
| Human gating | the approval-gate + chain shapes ADR 0346 proved (repair = candidate → review → apply) |

**Deliberately NOT built now** (the honest-surface rule, applied for the third
time in this program after 3e live-mode and AI-08 clarify): a deploy workflow,
a `deploy-adapter` pack kind, and an `app-deploy` sub-toggle. Each would be a
consumer-less or fake surface until a CONCRETE provider integration (Firebase
Hosting / Cloud Run / Cloudflare Pages) is chosen and credentialed — a deploy
button that doesn't deploy is worse than none.

## Falsifiability / activation trigger

When a provider integration is chosen, the follow-on ADR activates ALL of, in
one program: the `app-deploy` sub-toggle (OFF, tenant), the deploy chain in
`vendor.openwop.app-builder.workflows` (select lineage hash → bind env
symbolically → preflight → approval → adapter deploy → smoke check → release
record appended to the SAME lineage collection), the adapter as an
`adapterOnly` connection provider, idempotency keys + typed partial-failure +
rollback notes (gap doc §8), and — the same trigger firing — ADR 0345 3e live
preview over the identical adapter seam. EX-07 (IDE bridge) remains governed
by ADR 0307's own trigger, now strengthened by the hash-addressed lineage it
was waiting for.

## RFC verdict
None now; a deploy-adapter PACK KIND, if made normative cross-host, is an RFC
first (the standing ADR 0342 watch-item).
