# ADR 0625 — RFC 0165: v2 preparation wire shapes (`protocolVersions[]`, `owner.subject`, `OpenWOP-*` dual emission, discovery `ETag`)

Status: implemented

## Context

RFC 0165 (`openwop/openwop` #1173, suite 1.155.0; Active) lands three additive v1.x shapes so the v2 cut can delete rather than invent: a root `protocolVersions` array beside the scalar; an optional, issuer-scoped `owner.subject` record (`schemas/subject.schema.json`) on the run snapshot and the `run.started` owner echo, with a rule for runs that predate it and a rule for forks; and dual emission of the `OpenWOP-*` webhook header family plus a standard `ETag` on discovery. `Active → Accepted` gates on this host (tier-1) and MyndHyve (tier-2) each doing all of it non-vacuously.

What this host had before this ADR, and why each piece was a real gap rather than a rename:

- **Discovery** served only the custom `Capabilities-Etag`; no `ETag`, no `If-None-Match`, no `304`. `protocolVersion` was a literal `'1.1'` with no array.
- **Runs** carried no principal column in either storage backend; identity rode `metadata`. `RunSnapshot.owner` was emitted for RFC 0132 anonymous-actor runs ONLY (its TypeScript type pinned `principalKind: 'anonymous'`), so an authenticated run had no owner block at all and nothing to hang a subject on.
- **`run.started`** carried `{ workflowId }` only.
- **`:fork`** copied `tenantId` from the source but re-stamped `metadata.actingUserId` to the forking caller (ADR 0024 §4/D2 confused-deputy guard) — correct for credential resolution, but with no separate owner-of-record there was no field that RFC 0165 §B.4's "copy verbatim" could apply to.
- **Webhooks** dual-emitted, but the second family was ADR 0538's pre-spec combined encoding (`openwop-signature: t=…,v1=…`, `openwop-subscription-id`) — a value RFC 0165 §C.1 now forbids under that very header name, since `OpenWOP-Signature` MUST equal `X-openwop-Signature` (`sha256=hex`).

## Decisions

1. **One projection, three consumers.** `host/runOwner.ts` is the single owner of `{ tenant, principal?, principalKind?, subject }`. `projectRunSnapshot` (`routes/runs.ts`), the `run.started` echo (`executor/executor.ts`) and the fork all read it; the `anonRunOwner` special case is folded in.
2. **`subjectId` IS `owner.principal`.** Both are the same truncated SHA-256 of the RBAC subject (`callerSubject(req)`), so RFC 0165 §B.2 holds by construction and neither is PII (SECURITY `subject-record-opaque`). Anonymous runs keep the already-opaque RFC 0132 `anonPrincipal`.
3. **Owner of record ≠ credential identity.** The stamp lives on the RESERVED `metadata.owner` key (joined to `stripReservedRunMetadata`, so a client can never name its own owner — witnessed). `metadata.actingUserId` keeps its ADR 0024 role and its fork re-stamp; `metadata.owner` is copied verbatim onto a fork (§B.4). The two are orthogonal and the fork block says so.
4. **Lanes attested, never guessed.** `oidc:` subjects → `oidc` with the configured issuer; `saml:` → `saml` with `keyClass: "opaque-idp"` (the class `subjectLinkService.ts` links on) and the IdP entityID; `apikey:` / env keys / the test seam → `api-key`, kind `workload`. A durable `user:<id>` cookie session and an anonymous cookie session have NO lane in the RFC 0165 enum (the host is its own credential authority; RFC 0132's surface is not an auth-profile). Both take the RFC's own floor for an unattestable lane, `api-key` (§B.3's rule, applied at mint time), with an issuer that names the real authority (`urn:openwop-app:session`, `urn:openwop-app:anon-surface`). Reported upstream as RFC 0165 gap G6 rather than papered over with a plausible-looking lane.
5. **Legacy reads are honest.** A run with no stamp reads back with `issuer: "urn:openwop:legacy"`, `subjectId == principal`, `lane: "api-key"`, `kind: principalKind ?? "user"` (§B.3); no `principalKind` is invented for a pre-stamp authenticated run (RFC 0132: absent ⇒ unconstrained). A stamp whose `subjectId` disagrees with its principal — a host bug, never a client input — falls back to the legacy form rather than emit a payload that fails the spec's own invariant.
6. **`protocolVersions` is derived, not a second literal.** `PROTOCOL_VERSION` / `PROTOCOL_VERSIONS` in `routes/discovery.ts`; a ROOT property like `contractProvenance`, deliberately not mirrored into the deprecated `capabilities` wrapper.
7. **`ETag` is the same validator as `Capabilities-Etag`**, over the exact bytes served; `If-None-Match` (weak-tolerant, via the RFC 0115 helper `ifNoneMatchSatisfied`) → `304`. `ETag` added to the CORS expose list. `Capabilities-Etag` keeps its semantics through v1.x (deprecated, removeIn 2.0).
8. **The poll cursor no longer loses the first event.** `GET /v1/runs/{id}/events/poll?lastSequence=N` is spec-defined as "events with sequence > N" (`version-negotiation.md` §"Poll cursor"). Every storage backend's `listEvents` is already strictly-after, and the route added 1 on top — with this host's first event at sequence 1, `lastSequence=0` dropped `run.started` on every run. The RFC 0165 §B.2 echo scenario was the first suite leg to read the first event through that cursor, and caught it. Fixed by mapping the cursor 1:1; witnessed in the same test. (The host numbers its first event 1 where `run-event.schema.json` says 0 — a separate, pre-existing divergence, out of scope here and recorded as a follow-up.)
9. **ADR 0538 Phase 2 closes here.** The `OpenWOP-*` family now carries the spec's values (`Webhook-Id`, `Event-Type`, `Timestamp`, `Signature: sha256=…`, `Signature-Algorithm: v1`); the combined `t=,v1=` encoding and `openwop-subscription-id` are removed, not joined. No consumer of the old encoding remains: the openwop-sdks helpers were fixed and released (TS 1.9.0 / Py 1.7.0 / Go v1.6.0) as part of RFC 0165.

## Implementation record

| Item | Where |
| --- | --- |
| Owner + Subject projection, lanes, legacy synthesis, consistency guard | `backend/typescript/src/host/runOwner.ts` (new) |
| Reserved `metadata.owner`; `buildRunRecord({ owner })` | `src/host/runDispatch.ts` |
| Stamp at creation: `POST /v1/runs`, workflow-author draft, creative-briefs reel, anon surface (both lanes) | `src/routes/runs.ts`, `src/features/workflow-author/routes.ts`, `src/features/creative-briefs/routes.ts`, `src/host/anonymousActor.ts`, `src/routes/anonSurfaceSeam.ts` |
| Snapshot `owner` for every run with a principal (type widened from anon-only) | `src/routes/runs.ts` `projectRunSnapshot` |
| `run.started` owner echo | `src/executor/executor.ts` |
| Fork keeps `metadata.owner` verbatim (documented beside the ADR 0024 re-stamp) | `src/routes/runs.ts` `:fork` |
| `protocolVersions`, `ETag` + `304` | `src/routes/discovery.ts`; `src/middleware/cors.ts` |
| Poll cursor `lastSequence` maps 1:1 onto the strictly-after `listEvents` (was +1; lost `run.started`) | `src/routes/runs.ts` events/poll |
| `OpenWOP-*` header family | `src/host/webhookDeliveryWorker.ts` |
| Suite pin `^1.159.0`; vendored schemas at `openwop-conformance/v1.159.0` (`schemas/CORPUS_TAG`) | `backend/typescript/package.json`, `schemas/` |

**Witnesses (in-process).** `test/rfc0165-owner-subject.test.ts` — 10 legs: `protocolVersions` grammar/uniqueness/containment/root-only; `ETag` == `Capabilities-Etag`, `304` on exact and weak match, `200` on mismatch; an env-key run's snapshot owner (`api-key`/`workload`, `subjectId == principal`, opaque, no `keyClass`/`actor`), the `run.started` echo equal to the snapshot block, and the fork's owner equal to the source's; the §B.3 legacy synthesis for `actingUserId`-only and anon-marker-only runs; no owner without a principal; verbatim stamp with tenant forced; the §B.2 disagreement fallback; a forged client `metadata.owner` stripped; actor-chain depth. Updated: `test/webhook-delivery-queue.test.ts` (both families value-identical; old encoding gone; the `OpenWOP-*`-only verification recipe), `test/run-event-payload-conformance.test.ts` (registers `subject.schema.json` so the echo validates for real).

## Conformance schema + suite

`@openwop/openwop-conformance@1.159.0`: `protocol-versions-array`, `owner-subject-shape`, `identity-owner-shape` (server-free), `owner-subject-echo` (gated on a run whose snapshot carries `owner.subject` — non-vacuous here), the discovery `ETag` leg in `capabilities-change-detection`, and the dual-emission legs in `webhook-signed-delivery`. Run under `npm run test:conformance -- --filter <name>` with `OPENWOP_REQUIRE_BEHAVIOR=true`; results recorded in `conformance.md` § RFC 0165.

## References

- RFC 0165 — `openwop/openwop` `RFCS/0165-v2-preparation-wire-shapes.md` (#1173, `69a420b0`); `schemas/subject.schema.json`; `spec/v1/replay.md` §"Fork ownership"; `spec/v1/webhooks.md` §"Headers"; `spec/v1/capabilities-change-detection.md` §"Cache validators".
- RFC 0048 (owner triple), RFC 0132 (`principalKind`, anonymous), RFC 0159/0163/0164 (subject linking; ADR 0613/0620/0623), RFC 0115 (`ifNoneMatchSatisfied`).
- ADR 0024 §4/D2 (acting user on forks), ADR 0538 (webhook header encoding; Phase 2 closed here), ADR 0601 (`PrincipalAuth`).
