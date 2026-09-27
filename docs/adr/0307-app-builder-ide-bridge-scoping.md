# ADR 0307 — App-Builder IDE Bridge: scoping decision (host seams shipped; client artifact gated)

Status: Accepted (2026-07-07) — a SCOPING decision; no code ships with this ADR.

> **Correction 2026-07-17:** the client-extension scope of this ADR is superseded
> by **ADR 0393** (app-builder external integration — GitHub two-way sync + MCP
> control server; no bespoke IDE extension will be built). The host seams named
> here remain valid and are extended by 0393.

## Context

The MyndHyve baseline includes a ~35-file `plugins/ide` subsystem plus a
`vscode-extension/` artifact: connect-to-IDE, sync status, build output,
conflict detection/resolution, diff/merge preview. ADR 0305 Phase H committed to
scoping — not building — this in the parity program.

## Decision

**The host half of an IDE bridge is ALREADY SHIPPED** by this program's seams,
and they are hereby named as the bridge contract a client consumes:

| Bridge concern | Existing host seam |
|---|---|
| Pull the design | `GET …/app-builder/orgs/:orgId/canvases/:canvasId` (state + version) |
| Push edits + conflict DETECTION | `PATCH …/canvases/:canvasId` with `expectedVersion` → 409 `canvas_version_conflict` |
| Merge bases / history | the Phase-E version API (`GET versions`, `GET versions/:id`, `POST …/restore`) |
| Materialize code | the Phase-C generators via `generateScrubbed` (ZIP export route; 6 targets) |
| Ship code | the ADR 0306 publish route (governed `github-publish`) |
| Auth | the standard session/API auth — no device-pairing scheme is invented |

**The client half — a VS Code extension — is a SEPARATE-REPO artifact** (the
`openwop-cli` precedent: protocol-consuming clients live in their own repos)
and is NOT deliverable inside this application. Its creation is a distinct
product decision with its own gate.

**Deliberately NOT built now** (the no-parallel-architecture / honest-surface
rule): a host-side "IDE sync" push subscription (WebSocket/SSE canvas feed) and
a device-pairing token scheme. Both would be consumer-less surfaces — new auth
attack surface advertising capability nothing exercises.

## Falsifiability / activation trigger

If (and when) an extension artifact materializes and its sync loop measurably
needs push over polling, the live-push follow-on activates as a new ADR —
the run-event SSE path is the in-repo precedent for a subscription surface.

## Consequence for ADR 0305

Phase H is complete as scoped. The parity program's phase table marks H
`scoped (this ADR)`; the residue (extension artifact + optional live-push) is
recorded here, not silently dropped.
