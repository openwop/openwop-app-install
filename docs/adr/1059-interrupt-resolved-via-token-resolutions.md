# ADR 1059 — A token resolution records its instrument (`resolvedVia`), never an unauthenticated `resolvedBy`

Status: Accepted (P1 implemented behind a default-off flag; P2 seam served, RFC 0259 is `Active` and suite 2.46.44 vendored; D7 corrected 2026-11-12: production keeps the flag off and RFC 0259 waits for a seams-serving public host)

## Context

A resolve through a bare resume token proves possession, not identity. So
`interrupt.resolved` records no `resolvedBy` on the token surfaces (ADR 0932 D2,
D6 of the decision in open PR #5538, steward notes `RESBY-CAP-1` and `RESBY-VOTER-1`). A consumer cannot
tell "resolved through an approval link" from "resolver unknown". Book AI
(`requireBookApprover`) therefore cannot accept an approval made through this
host's own emailed link: it accepts only a mapped person, and it falls back to a
receipt that only its own route writes.

The user authorized the protocol change on 2026-11-04 ("Work with the /architect
and bookai to solve this now without hitl"). It is filed upstream as **RFC 0259**,
openwop/openwop#2082, as a `Draft`. RFC 0147 §A.6 gives an identity RFC its full
comment window, so the window is not waived. The schema diff waits on branch
`rfc/0259-resolved-via-impl` for `Active`.

The RFC's shape replaces the one first floated (a `kind: "capability"` Subject in
`resolvedBy`). An independent architect review chose the sibling property:

- `subject.schema.json` is shared by owner, `run.started` and the `actor` chain.
- `capability` is not an auth lane.
- Any value in `resolvedBy` would turn Book AI's working receipt fallback into a
  refusal.
- A nested `interruptId` would diverge on fork.

## Decision

- **D1 — record the instrument.** `interrupt.resolved` gains
  `resolvedVia { scheme: "interrupt-token", boundTo?, mintedAt?, expiresAt? }` on
  every resolution that PRESENTED the token. Those are `POST /interrupts/{token}`
  and the decide-by-email form (`tokenPresented: true` on the reviewer). All three
  `interrupt.resolved` emitters in `resolveAndResume` carry it.
  - The other `capabilityToken` lanes present no token and record nothing: the
    MCP `requestState` resume and inbound webhooks.
  - The authenticated `bearer:` run-scoped lane also presents no token and records
    nothing. It is an api-key caller, and PR #5538 (its D6) gives it a workload
    `resolvedBy`.
- **D2 — `resolvedBy` unchanged on the token lane: absent.** RFC 0259 §A.1 makes
  this a MUST NOT on every host. A body `voter`, even a signed one, is never copied
  into `resolvedBy`.
- **D3 — `boundTo` from this host's own binding only.** It is set when the resume
  value's `voter` + `voterSig` verify as this host's MAC over `(token, voter)`
  (`verifyVoterBinding`). Only the approval email signs that pair, so a link is
  bound only when this host issued it to that person. The Subject is
  `sessionSubjectV2(voter, runTenant)`: the session-lane branch of
  `ownerStampFromRequest`, so it equals what `requestSubjectV2` stamps for that user
  signed in (the test pins the equality). `mintedAt` (`interrupt.createdAt`) and
  `expiresAt` ride with it.
- **D4 — no `tokenRef`.** This host issues one token per interrupt, so a reference
  to the token identifies nothing that `interruptId` does not. Deriving one would
  make the log an oracle.
- **D5 — eligibility.** With the flag on, a token resolution of an interrupt whose
  data declares an approver ACL (`gateAclOf(...).declared`) and carries no
  `boundTo` is refused `403 forbidden` (`reason: resolved_via_unbound`) before
  anything is claimed.
  - ACL'd approval gates already require the signed voter
    (`assertTokenQuorumVote`), so they are unchanged.
  - The change bites on ACL'd NON-approval interrupts, which today accept an
    unsigned body voter on the token lane. That is the open half ADR 0932 left
    under "Not changed".
- **D6 — flag, default off: `OPENWOP_INTERRUPT_RESOLVED_VIA=true`.** The wire-advert
  rule applies, because the RFC is a Draft whose shape can still move.
  - With the flag off, nothing is recorded, nothing is refused, and nothing is
    advertised.
  - With the flag on, `interrupt.resolvedVia: true` is advertised in v2 discovery.
  - Until the schema is vendored, the major-2 read boxes `resolvedVia` under
    `vendor.openwop-app` (`storage/vendorKeyCarry.ts`), so even a flag-on host makes
    no wire claim.
  - Turning the flag on in production is a decision for after P2.

- **D7 — the flag decision (P2, proposed).** Keep the env flag, and keep the code
  default off. Once 2.46.44 is vendored (`scripts/sync-schemas.sh`) the boxing
  under `vendor.openwop-app` stops, and `resolvedVia` is a real wire member. The
  order is then:
  1. Turn it on in the conformance cut's environment.
  2. Read the bundle: legs 2, 3 and 5 should be `executed-pass`, and leg 6 too for
     a session-lane caller. Production advertises no seams, so those rows come from
     the colocated companion bundle (prod image by digest).
  3. Only then set `OPENWOP_INTERRUPT_RESOLVED_VIA=true` in production with
     `scripts/update-env.sh`, never a bare `services update`.

  > **CORRECTED 2026-11-12 — step 2's evidence source is wrong.** A colocated
  > companion bundle counts toward acceptance only when it pairs with the served
  > production bundle (RFC 0216 §C, `../openwop/scripts/lib/companion-pairing.mjs`),
  > and pairing requires equal discovery documents (condition (d),
  > `equivalent-discovery`). A companion running with this flag on advertises
  > `interrupt.resolvedVia: true`. Production, with the flag off, does not, so the
  > two never pair, and none of the companion's `0259.*` rows count. The
  > companion run stays as a pre-check before the production flip, not as
  > evidence.
  >
  > The user's decision of 2026-11-12: RFC 0259 stays `Active` until a public
  > host that serves seams passes legs 2, 3 and 5, for example the v2 reference
  > host. This host keeps the flag off in production. RFC 0258 takes the other
  > route: `OPENWOP_BOUNDED_LOOPBACK=true` in production, then a certified
  > production cut, because its rows need no seams.
  >
  > The D5 measure ran the same day (read-only, counts only). Of 1656 production
  > interrupts, 0 declare an approver ACL under `gateAclOf`. 52 approvals carry
  > `approversList: []`, which is an open gate. So turning the flag on would
  > have refused no past resolution, and no pending interrupt is exposed.

  Turning it on also starts the D5 refusal for ACL'd non-approval interrupts on the
  token lane, so measure first. The measurement is a read-only count of token-lane
  resolutions of such interrupts that carry no signed voter. The release manager
  owns the flip.

## Alternatives

- **Wait for the RFC before writing host code.** Rejected: the behaviour is
  host-internal until vendored, and the flag keeps it inert.
- **Record `boundTo` for any body `voter`.** Rejected: it is an asserted identity
  (ISWF-23).

## Phases

| Phase | What | State |
| --- | --- | --- |
| P1 | D1–D6 behind the flag (RFC 0259 landed as `Draft` in openwop 2.46.43, #2082/#2083); `host/interruptResolvedVia.ts`, `routes/interrupts.ts`, `routes/discovery.ts`, `host/runOwner.ts` `sessionSubjectV2`; tests | this PR |
| P2 | `readInterruptToken` seam (`routes/interruptTokenSeam.ts`, `test/adr1059-interrupt-token-seam.test.ts`) and its `conformanceSeams.ts` row: prepared locally on `feat/rfccap-p2-seam`. After 2.46.44 is published: `scripts/sync-schemas.sh`, then the D7 order | in progress |
| P3 | Book AI reads `resolvedVia.boundTo` when `resolvedBy` is absent (Book AI's repo) | open |

## Tests

`backend/typescript/test/adr1059-interrupt-resolved-via.test.ts`:

- flag off: nothing is recorded or advertised;
- flag on, unbound;
- a signed voter equals the session owner mapping;
- a forged signature binds no one;
- a `capabilityToken` lane with no token presented records nothing;
- the eligibility refusal, and its two non-refusals.
- a token REJECT records `resolvedVia` too (the single-approver reject emitter).

Sabotage record (each red, then restored from the commit): dropping
`resolvedVia` from the accept emitter (3 red); trusting a body voter without its
MAC (2 red); keying on `capabilityToken` instead of `tokenPresented` (1 red);
removing the eligibility refusal (1 red); removing the flag gate (2 red);
dropping it from the single-approver reject emitter (1 red). The quorum-reject
emitter carries the same spread and has no dedicated case.

## Checklist

- [x] P1 code and tests
- [ ] P2 after RFC 0259 `Active`
- [ ] Tell Book AI the PR number
