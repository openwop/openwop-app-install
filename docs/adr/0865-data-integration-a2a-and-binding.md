# ADR 0865 — data-integration: serve `data.source.a2a` and `data.binding.apply`

Status: implemented (2026-10-09; decision accepted on that date). The recommendations were taken, and decision 4 is brought into scope as B17–B20. Both phases are implemented: P1 (the run-lane canvas gate and `applyBinding`) and P2 (`fetchA2A`).

> **Decision recorded (2026-10-09):** the product owner said "Proceed with your
> recommendations and also address ctx.canvas.write issue". Open decisions 1–3
> are ACCEPTED as recommended. Open decision 4 is no longer a follow-up ADR: the
> `ctx.canvas` run-lane gap is closed HERE (B17–B20), because the binding needs
> the same gate, and one gate for both is the point.

Follows ADR 0783, whose D9 claim (phase 2c) lists both nodes as `unavailable`.
This ADR decides how to serve them, so that the `data-integration` family claim
can drop its `unavailable` list.

## Context (measured on `89d43aa2a`)

**No RFC is needed.** v2 makes `dataIntegration` a discovery-only reservation:
"v2 defines no portable operations or payload contract for it", and the record
is organization-defined (`openwop/spec/v2/ext/dataIntegration/README.md`). The
shapes below are this host's own, and they follow the pack. The v1 text
(`spec/v1/host-capabilities.md` §host.dataIntegration) gives `fetchA2A` a
`{sourceId, task}` shape that the pack never sent. v1 is retired here (ADR 0812),
so the pack is the contract.

**What the pack asks for** (`packs/vendor.myndhyve.data-integration/index.mjs`):

- **`data.source.a2a`** calls
  `ctx.dataIntegration.fetchA2A({ peerId, taskType, payload?, timeoutMs?, idempotencyKey })`.
  - The key is derived from run, node, peer, task type and payload, so a retried
    node sends the same key.
  - It expects `{ result?, taskState, error?, taskId? }`, where `taskState` is one
    of `completed | failed | cancelled | timeout`.
  - Config: `peerId` is "a registered A2A peer agent id"; `timeoutMs` ranges
    from 1 s to 600 s and defaults to 30 s.
- **`data.binding.apply`** calls
  `ctx.dataIntegration.applyBinding({ targetType, targetPath, value, transform?, fallback?, canvasId?, updateMode, preserveUndo })`.
  - It expects `{ applied, previousValue?, resolvedValue? }`.
  - Config: `updateMode` is `immediate` (the default) or `batched`;
    `preserveUndo` defaults to `true`.
- **Two pack defaults would fabricate success if the host omitted a field:**
  - `taskState: result?.taskState ?? 'completed'`;
  - `applied: result?.applied !== false`.
  So the host MUST always return both fields explicitly. That is the CLAUDE.md
  "typed failure, never success-with-empty" rule, applied from the host side.
- **Both nodes are on the side-effect floor and in `MANIFEST_FAST_PATH_SERVED`**
  (`executor/sideEffectFloor.generated.ts`). A replay therefore serves the
  recorded output and never re-executes. Only a retry within a run re-executes.

**What already exists, so that neither node needs a parallel system:**

| Need | Existing owner |
|---|---|
| An A2A client: discovery, version negotiation, `SendMessage`, `GetTask`, state normalization | `host/a2aSurface.ts` (`ctx.a2a`, ADR 0552) |
| What a peer's reply may become (text and data, never authority) | `host/a2aPeerIngest.ts` (invariant `a2a-peer-no-authority-escalation`) |
| A tenant's named, credentialed external endpoint | Connections plus the ADR 0783 D1 `dataSource.baseUrl` (validated against the provider's `apiHosts` at write time and at call time) |
| Credentialed, pinned, SSRF-guarded, firewall-checked egress | `brokeredFetch` via `connectors.invoke` |
| A once-only send ledger with no body | `egress:sent` (`host/egressSentLedger.ts`). Its `providerRef` field already carries an opaque provider reference (a Twilio `sid`). |
| A durable, versioned, tenant-scoped canvas with CAS writes | `host/canvasSurface.ts` (`updateCanvasForTenant`, `snapshotCanvas`, `restoreCanvasVersion`) |
| The canvas write veto and fan-out (a live collab room) | `fireBeforeCanvasStateWrite` / `fireAfterCanvasStateWrite` (ADR 0359 P6) |
| The canvas type gate (feature toggle and plan) | `resolveCanvasTypeAccess` (ADR 0820 G3) |

**Measured gaps:**

1. **`ctx.a2a` cannot be the transport as it stands.**
   - It takes a caller-supplied `baseUrl` and sends through `guardedEgressFetch`:
     SSRF-guarded, but with no credentials, no `apiHosts` pin and no tenant egress
     firewall.
   - There is no "registered peer" anywhere. `grep peerRegistry|a2aPeers` finds
     nothing.
   - The agent card's `url` chooses the RPC endpoint (`readPeerCard`), so a card
     can point the RPC at a different host than the one discovered.
2. **`ctx.canvas.write` (the run path) skips three things that the editor's
   write path (`updateCanvasForTenant`) does:**
   - the external-write veto;
   - the post-commit fan-out;
   - snapshots.
   It also checks only the tenant and the type gate, never the canvas's
   `ownerSubject` (`canvasReadAllowed`).

   Its own comment says runs "create canvases, they don't iterate them". A binding
   *iterates* one, so it must not inherit that path.
3. **There is no batching infrastructure.** Nothing in the host defers a canvas
   write to a "next flush".

## Forces

- **One owner per concept.** Peers are external, credentialed endpoints, which is
  exactly what a Connection is. Canvas state already has its owner. A new peer
  registry or a second canvas writer would be a parallel system (ARCHITECTURE.md
  contract).
- **Egress parity with ADR 0783.** A data-source A2A call must be at least as
  confined as a data-source REST call: `apiHosts` pin, SSRF guard, tenant
  firewall, credentials kept host-side.
- **A peer is untrusted.** Its result is data for the run, never a decision (ADR
  0552 P2).
- **Erasure.** `egress:sent` is exempt from subject erasure because it stores no
  body (ADR 0464; ADR 0783 D7 corrected).
- **Honest outputs.** Never let the pack's defaults speak for the host.

## Options

### `fetchA2A`: where a peer comes from

- **A. `peerId` is a Connection with a `dataSource.baseUrl` (D1), and the A2A
  codec runs over the broker.** This reuses the D1 write/call validation,
  credentials, `apiHosts` pin and firewall. It needs one seam in `a2aSurface`: an
  injectable RPC transport.
- **B. `peerId` is a raw URL handed to `ctx.a2a` unchanged.** No code, but there are
  no credentials, no pin and no firewall, and a pack config value chooses the
  egress host. This is weaker than the REST path, so it is rejected.
- **C. A new tenant peer registry.** This duplicates Connections (credentials, a
  host allowlist, a UI and authorization). It is rejected as a parallel system.

### `applyBinding`: what a target is

- **A. One target type, `canvas.state`.** `targetPath` is an RFC 6901 JSON Pointer
  into the canvas state, written through `updateCanvasForTenant` (veto, CAS,
  fan-out, snapshot).
- **B. Route through `ctx.canvas.write` with a deep-merge mutation.** This
  inherits gap 2 (no veto, no owner check, no undo), so it is rejected.
- **C. Open-ended target types (`element`, `property`, …) per canvas type.** No
  canvas type in this host declares bindable targets, so this would invent
  semantics nobody reads. It stays open as a future additive extension (see the
  open questions).

**Recommended: A for both.**

## Decisions

### `fetchA2A`

- **B1. A peer is a Connection.**
  - `peerId` names a Connection of the run's tenant. The Connection must be
    active and carry a `dataSource.baseUrl`.
  - Resolution is the same `resolveSource` path that `fetchRest` uses, so the D1
    call-time re-validation and the D2 single `source_unavailable` code (no
    probing) apply unchanged.
  - There is no new registry and no new UI. The Connections-row **Data source**
    dialog (ADR 0783 2b) is how a peer is registered.
- **B2. The A2A codec runs over the broker.**
  - `a2aSurface` gains an injectable transport, `rpcTransport(url, init)`, which
    defaults to today's `guardedEgressFetch`.
  - `fetchA2A` passes a transport that calls `connectors.invoke(provider, { url, method:'POST', body, connectionId, extraHeaders })`.
    Negotiation, the method names and the state normalization stay in
    `a2aSurface`, so there is still one A2A client.
  - Card discovery uses the same transport.
  > **Review correction 2026-10-09 (B2):** the injected transport must preserve
  > each caller's HTTP method, headers and body. Card discovery is GET; only
  > JSON-RPC calls are POST. The broker adapter must not turn discovery into a
  > POST merely because the example above describes an RPC.
- **B3. Every A2A URL stays inside the source base: the card, the card-chosen RPC
  endpoint, and every poll.**
  - Each is confined by `isWithinBase(url, base)` (the ADR 0783 D6 per-hop rule).
  - A card whose `url` leaves the base fails `validation_error` before any RPC.
  - The well-known card paths sit at the origin root, so a peer source whose base
    has a path probes `<base>/.well-known/agent-card.json` and then the origin
    root. The origin root is allowed only when the base IS the origin.
  - Tested by a witness.
- **B4. Once-only send through the ledger, keyed by the pack's `idempotencyKey`.**
  - Channel `'a2a'`: one new `EgressChannel` member, beside `'data'`.
  - It reserves before sending, the same insert-if-absent CAS as ADR 0783 D7.
  - On the peer's accept, it records the peer's **task id** in the existing
    `providerRef` field, plus the A2A message id. Both are opaque references and
    never a payload, so the erasure exemption still holds. The exemption reason in
    `subject-erasure-coverage.test.ts` gains the sentence saying so.
  - A transport failure, or a JSON-RPC error with no task, releases the key so a
    retry re-sends.
  - The A2A `messageId` is derived from the key, so a peer that de-dupes by
    message id sees the same id on a retry.
  > **Review correction 2026-10-09 (B4):** ledger deduplication prevents a second
  > send after a task id has been recorded; it cannot guarantee exactly-once
  > delivery after an ambiguous transport failure. A peer may have accepted a
  > task before its response was lost. Releasing and retrying is safe only when
  > the peer honors the stable message id as a deduplication key. Otherwise keep
  > the reservation and fail closed with a host-local typed uncertain-delivery
  > outcome. Never present a network timeout as proof that no task was sent.
  > This behavior must be settled and witnessed before P2 is accepted.
  > **Implementation correction 2026-10-09:** the integration keeps the
  > reservation on every ambiguous send failure and returns
  > `a2a_delivery_uncertain`. An empty prior task reference has the same
  > refusal; a recorded task remains re-readable. Only an expired deadline
  > before dispatch releases a newly reserved key. The real-broker witnesses
  > include acceptance followed by a destroyed response socket and a delayed
  > completed reply; neither retry sends a second task.
  > A malformed success reply is also uncertain: it cannot report completion
  > without a valid task or message, and it cannot release the reservation.
  >
  > **Settled (2026-10-09):** fail closed. See the implementation record's
  > Review row and witness 20.
- **B5. A duplicate RE-READS; it does not fail.**
  - Unlike a REST write (D7: `duplicate_result_unavailable`), an A2A task can be
    asked for again: `GetTask(taskId)` returns its current state and result from
    the peer.
  - So a retried node with a recorded task id polls that task instead of sending a
    second one.
  - This is the one place where "never re-send" and "return the result" are both
    possible, because the peer keeps the body.
- **B6. Waiting and states.**
  - `SendMessage` is non-streaming. If the task is not terminal, the node polls
    `GetTask` (backing off 1 s, 2 s, 4 s and so on, capped at 10 s) until
    `timeoutMs` (default 30 s; max 600 s, as the pack's schema sets).
  - The deadline is checked before and after every awaited RPC, the same shape as
    ADR 0783 2a's wall clock.
  > **Implementation correction 2026-10-09:** negotiation, credential lookup,
  > send and response parsing also consume the same deadline. The broker
  > combines the caller's abort signal with its own request timeout, and the
  > adapter bounds its wait. Expiry during an unconfirmed send is uncertain
  > delivery, never a successful late result or permission to resend.
  - `taskState` mapping:

    | A2A state | `taskState` | `error.code` |
    |---|---|---|
    | `COMPLETED` | `completed` | — |
    | `FAILED`, `REJECTED` | `failed` | `peer_failed` or `peer_rejected` |
    | `CANCELED` | `cancelled` | — |
    | the deadline passes | `timeout` (the `taskId` is always returned, so the run can correlate) | — |
    | `INPUT_REQUIRED`, `AUTH_REQUIRED` | `failed` | `peer_input_required` or `peer_auth_required` |

    A data-source node cannot answer a peer's question. A multi-turn exchange
    belongs to the `core.openwop.a2a` pack.
  - On a timeout the node does NOT cancel the peer task. The peer may finish; the
    `taskId` lets a later step read it.
- **B7. The result passes through the production ingestion and nothing else.**
  - `result` is the peer's last artifact or message, as data. It goes through
    `ingestPeerReply`'s rule: no branch acts on `metadata.openwop.*`, and
    `referenceTaskIds` are never dereferenced.
  - It is capped at the ADR 0783 5 MB byte cap (`payload_too_large`).
  - The node returns it as data. When a downstream LLM node reads it, the existing
    run-input trust rules fence it as `<UNTRUSTED>`. Nothing here changes those
    rules.
- **B8. Typed failures; never a defaulted success.**
  - The host always returns `taskState`.
  - Failures raised as errors (not data states):
    - an unknown, revoked or non-source peer: `source_unavailable`;
    - card discovery or negotiation failure: `a2a_peer_unavailable` (no peer
      response that can be read);
    - a read-only provider: `connector_read_only`. Sending a task is a write.
    - a missing key: `validation_error`.

### `applyBinding`

- **B9. One target type: `canvas.state`.**
  - `canvasId` is required. A run is not bound to a canvas in this host, so there
    is no implicit "current canvas".
  - `targetPath` is an RFC 6901 JSON Pointer (`/sections/0/title`).
  - A missing intermediate object is created; a missing array index past the end
    is refused.
  - Any other `targetType`, or a malformed pointer, fails `validation_error`, and
    the error names the one served type.
  > **Review correction 2026-10-09 (B9):** pointer traversal must use own
  > properties and reject decoded `__proto__`, `prototype` and `constructor`
  > segments before reading or writing. Define empty-pointer/root replacement,
  > array-index and escape behavior explicitly against the canvas's JSON shape;
  > do not mutate a prototype or silently turn an array into an object. These
  > are implementation acceptance gates, not additional portable semantics.
- **B10. Authorization: ONE run-lane canvas gate (`assertCanvasRunAccess`, B17),
  shared with `ctx.canvas`.**

  > **CORRECTED during acceptance (2026-10-09):** the text below said "the same
  > predicate as the editor's PATCH, via one shared helper". The editor's gate
  > takes an Express `Request` (`authorizeOrgScope` plus an optional per-type
  > `authorize(req)`), so a run cannot call it. What is shared instead is every
  > PART that is not request-shaped:
  > - the type gate;
  > - the owner predicate (`canvasReadAllowed`, already shared with the chat tools);
  > - the type's catalog validator;
  > - the "privileged type" flag.
  >
  > All four are read from the ONE registry that `registerCanvasEditorRoutes`
  > writes. The role check uses the request-free twin `assertTenantScope`, under
  > ADR 0837's floor convention (the run's person is the actor, else the causing
  > member). A run with NO person passes the role floor, as every feature surface
  > does, but can never write a subject-owned canvas (`subjectReadAllowed`
  > refuses a missing subject). The original text follows.

  - The write is allowed only if:
    - the canvas is in the run's tenant;
    - the type gate passes (`resolveCanvasTypeAccess`);
    - the run's acting user passes `canvasReadAllowed` (a subject-owned canvas);
    - the user also passes the canvas feature's org-scope write gate.
  - The editor route and the binding call ONE helper (a new
    `canvasWriteAllowed(tenantId, canvas, caller)` beside `canvasReadAllowed`),
    following the CLAUDE.md "share the route's access predicate" rule.
  - Missing and refused both answer `binding_target_not_found` (the spec's own
    code), so there is no existence leak.
  - A run with no acting user is refused; it never falls through as "owner".
- **B11. The write goes through `updateCanvasForTenant`, with `expectedVersion`
  equal to the version that was read.**
  - It reads the canvas, resolves `previousValue` at the pointer, computes the next
    state, and writes with `merge: 'replace'` and `expectedVersion`. This is one
    CAS: a lost race re-reads, at most 8 times, as the function already does.
  - The ADR 0359 veto applies, so a live `canvas.document` room refuses with its
    typed 409, mapped to `canvas_version_conflict`. The after-write fan-out
    applies too.
  > **Review correction 2026-10-09 (B11):** with `expectedVersion`, the existing
  > writer re-reads after a lost CAS and throws 409 because the caller's basis
  > is stale. Its internal eight-attempt loop does not recompute the pointer
  > mutation. A binding retry must re-read, re-authorize, recompute the prior
  > and next value, and capture that attempt's prior state before another CAS.
  > Bound the whole adapter to at most eight attempts; never retry a stale
  > replacement or count an exhausted/conflicted write as `applied: true`.
- **B12. Undo is version history.**
  - `preserveUndo: true` (the default) captures a snapshot of the PRIOR state
    (`snapshotCanvas`, `capturedBy: 'binding:<runId>'`) before the write. The
    canvas's existing version restore is then the undo.
  - This snapshot must not fail open: if it fails, the write does not happen
    (`binding_undo_unavailable`). A promise of undo that silently was not kept is
    the defect class this rules out.
  - `preserveUndo: false` writes with no snapshot.
  > **Review correction 2026-10-09 (B12):** `snapshotCanvas` silently skips
  > captures inside its 30-second throttle unless `{ force: true }` is passed.
  > The binding must force the prior-version capture, await durable completion,
  > and verify the captured version remains available before attempting its
  > CAS. The editor writer's post-save best-effort snapshot option does not
  > satisfy this promise. A throttle-window witness must restore the actual
  > prior state, and a failed forced capture must leave the canvas unchanged.
- **B13. `transform` and `fallback`.**
  - `transform` is a JSONata expression evaluated with the same engine and limits
    as `ctx.dataIntegration.transform`, with `value` as its input.
  - `fallback` applies when `value` (or the transform's result) is `undefined` or
    `null`. A transform that THROWS fails `transform_expression_invalid`; it never
    falls back silently.
  - `resolvedValue` is the value actually written.
- **B14. `updateMode: 'batched'` is refused with `unsupported_operation`.** There is
  no flush to defer to, and treating it as `immediate` would make the node's
  promise false. `immediate` is the pack default.
- **B15. Explicit `applied`.**
  - It is `true` only when the CAS commit landed.
  - An identical value (a deep-equal no-op) returns `applied: false` with no
    version bump and no snapshot. That is honest: nothing changed.
  - A retry within the run is therefore idempotent by value. A replay never
    re-executes (fast path).

### `ctx.canvas`: closing the run-lane gap (former open decision 4)

Measured: `ctx.canvas.read/write/create` checks only the tenant and the type
toggle. Against the editor's write path it misses five things:

1. the role (`workspace:write`);
2. the owner predicate for a subject-owned canvas;
3. the type's catalog validator (the editor's PATCH 422s a closed-world
   violation; a run could write it);
4. a privileged type's extra gate (the KickTodo challenge outline requires
   `host:kicktodo:manage` on every route, while a run of any member could write
   it);
5. the ADR 0359 live-room veto and the after-write fan-out.

- **B17. `assertCanvasRunAccess(scope, canvas, 'read' | 'write')` in
  `host/canvasSurface.ts`** is the run lane's one gate. It is used by
  `ctx.canvas.read` (read), `write` and `create` (write), and `applyBinding`
  (write). In order:
  1. **Tenant:** a missing canvas or another tenant's gives `canvas_not_found`.
  2. **Type gate:** unchanged, `host_capability_disabled`.
  3. **Privileged type** (one registered with an `authorize` predicate): refused
     with `host_capability_disabled`. The predicate needs a `Request`, so there
     is no honest run-lane answer and the gate fails closed.
  4. **Role floor:** the run's person must hold `workspace:read`/`workspace:write`
     in the tenant (`assertTenantScope`, with the personal-tenant short-circuit),
     else `forbidden_scope`. With no person, this step does not run (ADR 0837).
  5. **Subject-owned canvas:** `canvasReadAllowed` with the run's person, else the
     same `canvas_not_found` as step 1 (no existence leak).

  `applyBinding` maps every refusal to `binding_target_not_found`, except the role
  floor and the type gate, which keep their own codes (they say nothing about the
  canvas's existence).
- **B18. `ctx.canvas.write` goes through `updateCanvasForTenant`.**
  - It keeps its own merge default (`shallow`), `expectedVersion` and
    idempotency cache, and it gains the veto and the fan-out.
  - The veto now sees the RESULTING state rather than the raw mutation. The
    editor passes a full state with `replace`, so for it nothing changes.
  - The run path still takes no snapshot ("runs create canvases, they don't
    iterate them"). Only `applyBinding`'s `preserveUndo` snapshots.
- **B19. The type's validator runs on the resulting state** for `ctx.canvas.write`,
  `create` (on `initialState`) and `applyBinding`. `registerCanvasEditorRoutes`
  records `cfg.validate` beside the owning toggle, so the editor and the run lane
  run the SAME function. Errors give `validation_error`; warnings pass, as in the
  editor.
- **B20. Behavior change, stated.** A run that today writes an invalid canvas, a
  privileged-type canvas, or another member's private canvas now fails. That is
  the point. A run whose person lacks `workspace:write` (a Viewer's run) can no
  longer write canvases through `ctx.canvas`. The same person is already refused
  by the editor, so this closes a privilege the HTTP door never granted.

### The claim

- **B16. Each phase removes its own `unavailable` entry in the same commit as its
  end-to-end witness.** The phase-2c contract test already refuses a method that
  is both claimed and named unavailable. Once both phases have landed, the
  `unavailable` list is empty and is removed.

## Witnesses (each must go red when its mechanism is sabotaged)

**`fetchA2A`** (a loopback A2A 0.3 peer behind a test provider, the real broker
and the pack's own node):

1. It sends once with the derived `messageId`. The same key again sends nothing
   and re-reads the task (B4, B5).
2. The ledger row holds a task id and no payload byte (B4).
3. A card whose `url` leaves the base is refused before any RPC (B3).
4. A non-source, revoked or foreign-tenant peer gets one `source_unavailable` (B1).
5. The request carries the Connection's credential, and the pack never sees it
   (B2).
6. Deadline: a peer that stays `WORKING` gives `timeout` with a `taskId`, and the
   peer task is not cancelled (B6).
7. `INPUT_REQUIRED` gives `failed` / `peer_input_required` (B6).
8. A reply carrying `metadata.openwop.approval` and `referenceTaskIds` changes no
   run state and causes no outbound read of the referenced id (B7, reusing the
   §22 probe).
9. A read-only provider refuses the send (B8).

**`applyBinding`** (real storage, the pack's own node):

10. It writes at a pointer and returns `previousValue` and `resolvedValue`. A
    second identical apply returns `applied: false` with no version bump (B11,
    B15).
11. A subject-owned canvas belonging to another user, a foreign tenant and a
    missing canvas all answer the same `binding_target_not_found` (B10).
12. A toggle-off canvas type is refused (B10).
13. A live-room veto refuses the write (B11).
14. `preserveUndo` captures the prior state, and restore brings it back. A failing
    snapshot leaves the canvas unwritten (B12).
15. A throwing transform is `transform_expression_invalid`, never the fallback
    (B13).
16. `batched` is `unsupported_operation` (B14).
17. The editor PATCH and the binding share `canvasWriteAllowed`: sabotage the
    helper and both route-level and node-level tests go red (B10).

**`ctx.canvas` (B17–B20):**

> **Renumbered 2026-10-09:** these were 19–24 until the review acceptance
> witnesses below (merged first, on `main`) took 19–23; they are now 24–29.

24. A Viewer's run cannot `write`, while a member's can (role floor, B17.4).
25. A run cannot read or write another user's private canvas: the same
    `canvas_not_found` as for a missing id (B17.5).
26. A privileged-type canvas is refused on the run lane (B17.3).
27. A catalog-invalid `write` and `create` are `validation_error`, and the canvas
    is unchanged (B19).
28. A live-room veto refuses a `ctx.canvas.write` (B18).
29. A system run (no person) still writes an org-owned canvas (the ADR 0837
    floor, B17.4: the non-regression half).

**The claim:**

18. `adr0765-ext-family-records`: each node moves from `unavailable` to served in
    its phase's commit (B16).

**Review acceptance witnesses:**

25. Card discovery remains GET, RPC remains POST, and both requests pass through
    the real broker with the same connection pin and confinement (B2).
26. A peer accepts a task and loses its reply: retry either demonstrably
    deduplicates by stable message id or fails closed without a second send
    (B4). A non-deduplicating peer never receives a false exactly-once claim.
27. Escaped malicious pointer segments and array/root edge cases cannot mutate
    prototypes or change the canvas's JSON container shape (B9).
28. An intervening authorized write wins the first CAS; a bounded binding retry
    recomputes from the new state and preserves that state as undo (B10–B12).
29. Two writes inside the snapshot throttle window still persist the second
    binding's actual prior version; failed forced capture prevents its write
    (B12).

## Phasing (real gates only)

- **P1, the run-lane canvas gate and `applyBinding`:**
  - B17–B20 (`ctx.canvas`) and B9–B15 (binding);
  - witnesses 10–16, 21–23 and 24–29;
  - witness 17 now reads: the editor and the run lane call the same registered
    validator and owner predicate;
  - the claim drops `data.binding.apply`.

  One PR, because the binding's whole authorization IS the B17 gate.
- **P2, `fetchA2A`:**
  - the transport seam (B2): `ctx.a2a`'s own tests must stay green with the
    default transport;
  - B1 and B3–B8;
  - the `'a2a'` ledger channel and the erasure reason;
  - witnesses 1–9;
  - the claim drops `data.source.a2a` and the empty `unavailable` list.

The two phases touch disjoint files except `extFamilyRecords.ts` and the ADR, so
they are not stacked: branch each from `origin/main`.

## Open decisions (for the maintainer)

1. **Accept B1** (a peer is a Connection). A peer then needs a provider whose
   `apiHosts` covers its host, which in practice means a connection pack (RFC
   0120) per peer organization. **Recommended.** The operator's host allowlist
   is the control, and this is the same bar REST sources already meet.
   - Alternative: a generic built-in `a2a-peer` provider with a per-tenant host
     allowlist. That adds a second allowlist (a parallel system).
2. **Accept B5** (a duplicate re-reads the task). **Recommended**, because it is
   strictly more useful than D7's refusal and stores no body.
3. **Accept B14** (refuse `batched`) rather than accepting it as `immediate`.
   **Recommended.**
4. ~~**Pre-existing gap 2.**~~ **Resolved: brought into scope as B17–B20.** `ctx.canvas.write` (the `vendor.myndhyve.canvas` run
   path) has the same missing veto and owner check that B10 and B11 avoid. This
   ADR does not change it. **Recommended:** a follow-up ADR that routes it
   through the same helper. It is out of this ADR's scope because it changes an
   already-served node's behavior.

## Implementation record

| Phase | What landed | Evidence |
|---|---|---|
| P1 | **The run-lane canvas gate.** `assertCanvasRunAccess` (`host/canvasSurface.ts`) is used by `ctx.canvas` read, write and create, and by `applyBinding`. `ctx.canvas.write` now goes through `updateCanvasForTenant` (veto and fan-out) with `validate: true`, and `create` validates `initialState`. `registerCanvasEditorRoutes` records each type's `validate` and `privileged` flag in `host/canvasTypeOwnership.ts`, beside the owning toggle. **`applyBinding`** is in `host/dataBinding.ts`; the executor hands the adapter a `canvasScope` (tenant, run, person, personal tenant). The claim serves `applyBinding`, and `unavailable` names only `data.source.a2a`. | `test/adr0865-canvas-run-lane-and-binding.test.ts`: 15 tests on the booted app, including the pack's own `data.binding.apply` node. **Fourteen mechanisms are sabotage-red:** the role floor, the owner predicate, the privileged refusal, the write validator, the create validator, the veto on the write path, the no-op `applied:false`, the prior snapshot, the snapshot failing closed, transform-throw-never-falls-back, the `batched` refusal, the veto never being retried, and the editor registering both the privileged flag and the validator. 101 canvas, data-integration and claim test files are green (1297 tests). |
| P2 | **`fetchA2A`** (`host/dataA2a.ts`). A peer is a Connection data source (B1), resolved through the same `resolveSource` as REST, so D1 call-time re-validation and D2's single `source_unavailable` apply. The A2A client (`host/a2aSurface.ts`) gains an injectable `A2aTransport` (B2); the default is unchanged. `fetchA2A` passes a brokered transport that refuses any URL outside the base before `connectors.invoke` (B3). Sends use the `egress:sent` ledger on a new `'a2a'` channel; `providerRef` holds the peer's task id, and `messageId` is derived from the key (B4). A duplicate re-reads via `GetTask` (B5). Polling backs off 1 s→10 s until `timeoutMs` (B6). Only `data`/`text` part content is returned (B7). The claim serves all eight methods, and `unavailable` is gone (B16). | `test/adr0865-fetch-a2a.test.ts`: 14 tests, with a loopback A2A 1.0 peer behind the real broker and the pack's own `data.source.a2a` node (a retried node sends once). **Thirteen mechanisms are sabotage-red:** transport confinement, the origin-only base, the RPC path keeping the refusal's code, the ledger CAS, the recorded task id, the derived `messageId`, release on a peer error, duplicate re-read, the `INPUT_REQUIRED` mapping, the deadline, content-only results, the read-only refusal and the brokered credential. The A2A, claim, erasure and data-integration suites are green (32 files, 385 tests). |
| Review (B2, B4, B9, B11, B12) | The review corrections merged on `main` while P1+P2 were gating; each is now met. **B2:** discovery was already a GET through the transport, RPC a POST. **B4:** taken as the fail-closed branch, because A2A does not oblige a peer to de-dupe by message id. A send is released only when it provably did not land: the peer's JSON-RPC error, an HTTP 4xx other than 408, a confinement refusal, or a broker refusal before egress (no or unusable connection, host not allowed, insecure base, read-only). A timeout, dropped connection or 5xx keeps the reservation as `uncertain:<messageId>` and fails `a2a_delivery_uncertain`, a host-local code; a retry with the key gets the same answer and sends nothing. `rpc` now carries the broker's reason and the HTTP status so the two can be told apart. **B9:** already met (own-property reads, decoded segments refused, root pointer refused, an array index must exist, so no array becomes an object). **B11:** already met; every attempt re-reads, re-authorizes, recomputes and re-captures, bounded at eight. **B12:** the forced capture is now read back (`getCanvasVersionAt`) and compared with the state being replaced before the CAS. | Review witnesses 19–23 in the two ADR 0865 test files. **Nine mechanisms are sabotage-red:** release-only-on-provable-refusal, the uncertain duplicate, the HTTP status, the snapshot read-back, the forced capture, the CAS retry, the attempt bound, the forbidden segments and the array-index rule. |

**P2 corrections found while implementing:**

- **B3 — an A2A peer's base must be an origin.** The ADR said to probe
  `<base>/.well-known/agent-card.json` first. The one A2A client discovers cards
  at the ORIGIN root, and teaching it a second discovery rule for one caller would
  fork it. So the brokered transport confines every URL to the base, and a base
  with a path is refused up front (`validation_error`, naming why). The
  confinement rule is unchanged; only a base it could never satisfy is caught
  earlier.
- **B8 — two failure codes, named.** A JSON-RPC error from the peer is
  `a2a_peer_error`. Its message carries the §D.7 projected `reason`, never the
  peer's text. A broker refusal or transport failure is `a2a_peer_unavailable`.
  A version refusal keeps its own `interop_version_unsupported`.
- **B5 — a message-only reply.** A peer may answer with a Message and no task.
  That is a completed result, and its ledger row records `message:<messageId>`,
  so a duplicate is `duplicate_result_unavailable`: there is no task to re-read,
  and the message body is not kept.

**Corrections found while implementing** (the decisions above stand as written;
these name what the code does):

- **B17.4:** the role floor is ADR 0822's `hasWorkflowScope`, not bare
  `assertTenantScope`. A configured operator key's run (`bearer:<8>` actor) has no
  member row, so bare `assertTenantScope` refused the dev-token run that
  `canvas-surface.test.ts` drives. `hasWorkflowScope` is the in-run twin of the HTTP
  door, and it treats that key as the tenant's own principal.
- **B11:** the live-room veto keeps its OWN code, `canvas_room_live`, rather than
  being mapped to `canvas_version_conflict`. A binding retries only
  `canvas_version_conflict` (a lost race). A veto is a refusal, and witness 13 pins
  that it is tried once.
- **B13:** a throwing transform fails with the transform method's own codes
  (`expression_invalid`, `expression_failed`, `expression_budget_exceeded`), the
  ones `ctx.dataIntegration.transform` already uses. The ADR's
  `transform_expression_invalid` would have been a second spelling for one
  failure.
- **B17.5 / witnesses 11 and 25 — what "private" means.** A `user` owner has no
  subject-access resolver in this host, so the org gate decides it; the
  membership-scoped owner is a `project`. And ADR 0054 D5 holds that
  `workspace:write` IS write on every project, private or not. So privacy refuses a
  Viewer who is not a project member, and a run with no person. It does not refuse
  an editor. The witnesses test exactly those callers, which is the rule the editor
  and the chat tools already apply through the same `canvasReadAllowed`.

### Final integration record — 2026-10-09

| Phase | Commit | Validation |
|---|---|---|
| P1 / P2 and forced undo read-back | Captured #4635 `7653418f4`; integrated at `efb8d2847`, then main `d2b8ebcd2` through #4642 | Final clean canonical candidate `cce4a4f90` passed all backend/frontend/browser/CSP gates. Pinned Linux built the actual backend and isolation worker; related runtime tests passed under normal and one-year-advanced clocks. |
| Ambiguous-send correction | `efb8d2847`, retained in the final integration | Existing correction notes govern the final behavior: a dispatched HTTP/JSON-RPC failure is not proof that the peer did no work. Unconfirmed acceptance keeps the durable reservation and does not automatically resend. |

The recorded canonical backend result is 2,500 passing files, 20,202 passing
tests, one pre-existing expected failure and 132 skips. The targeted Linux run
passed 53 files and 501 tests under each clock, with its expected-failure/skip
classifications retained. This is an implementation record; production source,
traffic and signed post-deploy evidence are separately verified by the maintained
deployment workflow. Historical sabotage counts above remain their original
author's observations rather than a claim that this integration reran them all.

## Falsifiability

- If a canvas type in this host declares bindable element targets, B9's single
  type is too narrow, and option C becomes an additive extension.
- If a real peer needs streaming (it never answers `GetTask` before
  `SendMessage`'s HTTP response ends), B6's polling must move to
  `sendAndStream`. The transport seam is the same.
- If any witness passes with its mechanism removed, that decision is unproven.

> **Final integration correction 2026-10-09:** an HTTP 4xx or JSON-RPC error alone does not prove that a peer accepted no side effect. The integration retains the reservation after every dispatched send without a confirmed task/message, including these replies. Witness 20 covers HTTP 400 as well as lost/503 responses; the empty provider reference is the durable uncertain-delivery marker. Binding undo capture is additionally read back before its CAS.
