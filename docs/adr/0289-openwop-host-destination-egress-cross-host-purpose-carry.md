# ADR 0289 — `openwop-host` destination egress + cross-host purpose-label carry (CDP W1.1)

**Status:** Accepted

**Depends on:** ADR 0266 (CDP-D destination-sync hub — the single non-ad egress owner;
this adds its first real onward send + a new destination kind), ADR 0268 (CDP-F purpose
/ consent — §5 cross-host propagation, deferred to "ships with the RFC"), ADR 0024
(Connections — BYOK peer credentials), RFC 0128 (`permittedPurposes` — **Accepted**), RFC
0099/0083 (`TriggerEvent` + the trigger-bridge ingest seam).

**Extends / amends:** ADR 0266 (new `openwop-host` destination kind + destination-sync's
first real egress send). ADR 0268 §5 — **phase-complete note**: the cross-host purpose
re-emit deferred there now has a *real OpenWOP-envelope egress* to ride (this ADR); the
label-carry is no longer seam-only.

## Context

RFC 0128 (Accepted) says a host that advertises `purposePropagation` **MUST re-emit** a
received `permittedPurposes` label on any onward hop of the same data **that uses an
OpenWOP envelope**. The tier-1 witness rode the destination-sync `[]`-fail-closed drop +
the hop-B forward seam. But an audit for W1.1 found openwop-app had **no real
OpenWOP-envelope onward egress** to anchor the re-emit MUST:

- the `ctx.a2a` **client** exists but **no node forwards subject data** through it (the
  only real A2A wiring is the inbound *server*, `routes/agents.ts`);
- **destination-sync emits arbitrary field-mapped ESP JSON** (`applyFieldMap`), a
  *non-OpenWOP* sink — the SHOULD/untestable leg (RFC 0128 §3(a)), not an OpenWOP
  envelope;
- `prepareSyncBatch` is **pure** — destination-sync's *actual* egress send was explicitly
  a "deeper phase" and was never built.

So wiring the re-emit into a2aSurface (the original W1.1 sketch) would have built a
**vacuous carrier** with no real consumer — the exact anti-pattern this program's arc
guards against (MyndHyve declined the symmetric trap for its A2A). The honest way to
close the sharpened RFC 0128 G4 ("the first host with a real onward OpenWOP-envelope
egress that invokes the label algebra") is to build a **genuine** such egress.

## Decision

Add an **`openwop-host` destination kind** to the destination-sync hub (ADR 0266's single
non-ad egress owner) — destination-sync's **first real onward send**. For this kind, each
eligible record is delivered to a **peer OpenWOP host's trigger-bridge ingest** as an
**OpenWOP envelope carrying the re-emitted `permittedPurposes` label**:

1. **Eligibility** — reuse the existing `[]`-fail-closed drop (`dropNoOnwardUse`): a
   record labelled `[]` ("no onward use") is dropped before egress. Unlabelled or
   non-empty-labelled records pass.
2. **Re-emit (the algebra, on a real hop)** — the onward label is
   `reEmitLabel(record.permittedPurposes, sync.narrowTo?)`: `⊆` the received label,
   guaranteed non-widening; a sync MAY narrow via an optional `narrowTo`. This is the
   RFC 0128 §3 MUST, now invoked on a real OpenWOP-envelope egress.
3. **Envelope** — the payload is a webhook-source ingress carrying the field-mapped
   record as the body **plus a top-level `permittedPurposes`** (RFC 0128 §1 trigger/sync
   carrier). The peer ingests it via the existing trigger-bridge ingest seam; the label
   rides top-level per 0128.
4. **Transport — via the sanctioned node, NOT a bespoke egress (ADR 0262 ruling #3).** The
   `prepareOnward` surface verb (`ctx.features['destination-sync'].prepareOnward`) is
   **pure** — it returns the labelled envelopes + the `peerIngestUrl` + `connectionId`. The
   **workflow egresses each envelope through `core.openwop.http.fetch`** (auth resolved from
   the Connection by the node's own credential resolver), then calls `advance`. This mirrors
   the existing `prepare` → http-node → `advance` shape; there is **no service-level fetch**
   and no second HTTP client — the SSRF guard + BYOK stay owned by the http node.
5. **Honest-off** — `prepareOnward` is gated behind `purposePropagationEnabled()`
   (`OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED`): flag-off returns
   `{ error: 'purpose_propagation_disabled', envelopes: [] }`, so the onward promise is not
   exercised until the flag flips — which happens only after the conformance witness.

### Boundaries (single-owner, no parallel architecture)

- **Egress owner** = destination-sync (`destinationSyncService.ts` + its surface) — the
  `openwop-host` prep extends it; it does **not** stand up a second egress path or touch
  campaign-connectors (the ad specialist).
- **Label algebra** = `features/cdp/purposeLabels.ts` (already imported here) — reused,
  not reimplemented. A shared `selectEligible` helper owns the CDC-select + `[]`-drop for
  both `prepareSyncBatch` (ESP leg) and `buildOnwardEnvelopes` (OpenWOP-host leg) so the two
  egress shapes cannot drift.
- **Transport** = the existing `core.openwop.http.fetch` node (ADR 0262 ruling #3) — no
  bespoke service fetch; **Credentials** = Connections (ADR 0024), resolved by that node,
  BYOK host-side, never in the payload.

### Reference consumer (W1.1 vehicle) — phase-complete

The egress mechanism (`buildOnwardEnvelopes` + the `prepareOnward` surface verb) had no
operator vehicle. That vehicle now ships and **closes RFC 0128 G4's sender arm**:

- **Node** `feature.destination-sync.nodes.prepare-onward`
  (`packs/feature.destination-sync.nodes/`) — a thin wrapper (mirrors the ADR 0266
  `prepare` node) that calls `ctx.features['destination-sync'].prepareOnward({syncId,
  records})`, then flattens `envelopes[0]` onto `onwardBody`. Flag-gated in the surface:
  purpose-propagation-off returns `purpose_propagation_disabled`, which the node surfaces
  as a failed outcome (honest-off).
- **Built-in workflow** `openwop-app.cdp.sync-to-openwop-host`
  (`features/destination-sync/onwardSyncWorkflow.ts`, registered via the feature's
  `builtinWorkflows`) — `prepare-onward → core.openwop.http.fetch (POST)`. Egress rides
  the http node (ruling #3), not a bespoke send. Data-flow: the http node's request
  `body` binds from the `prepare-onward` `onwardBody` output over a graph edge; its
  `config.url` binds from the run variable `peerIngestUrl` (config reads the per-run
  variable bag, not an upstream port — so the peer ingest URL is a run input, echoed by
  the node's `peerIngestUrl` output for parity). Fire a leg with
  `inputs = { syncId, records, peerIngestUrl }`.

## RFC gate

**No new RFC.** This composes **Accepted** wire only: the `TriggerEvent` envelope + the
trigger-bridge ingest contract (RFC 0099/0083) and the top-level `permittedPurposes`
label (RFC 0128). Emitting an accepted-shape envelope to a peer's accepted ingest surface
is host work, not a wire extension. The `/v1/host/.../trigger-bridge/ingest` seam is a
non-normative host-extension route.

## Alternatives considered

- **Wire re-emit into `ctx.a2a` (the original sketch)** — rejected: no node forwards
  subject data over the A2A client, so it would be a vacuous carrier.
- **Carry the label into the ESP field-map (the SHOULD leg)** — kept as a separate, real
  but *untestable* behavior; it does not close G4 (non-OpenWOP sink). Worth doing, but not
  the G4 closer.
- **Leave 0128 G4 named (openwop-app = MyndHyve's position)** — rejected by the maintainer:
  the cross-host CDP-sync use case is real (federated CDP / MyndHyve cutover), so building
  the genuine egress is preferred over a perpetual named gap.

## Witness / acceptance

The re-emitted-label egress is observable on the wire: the POST body a mock/real peer
receives carries `permittedPurposes = reEmitLabel(received)`. This is the non-vacuous
tier-1 witness for RFC 0128 G4 (a real onward OpenWOP-envelope egress invoking the
algebra). Steward curl-verifies against the deployed host; the flag flips on only after
the witness.

## Open questions

- **Receiver-side honoring** (a peer's ingest reading `permittedPurposes` onto its own
  `TriggerEvent` + enforcing it) — openwop-app is also a receiver; wiring the ingest to
  carry the label onto the in-run `TriggerEvent` is a **noted follow-on** (W1.1b), not
  required for the sender-side G4 witness.
- **`narrowTo` per-sync config surface** — ships as an optional service field; the
  operator UI affordance is a follow-on.
```
