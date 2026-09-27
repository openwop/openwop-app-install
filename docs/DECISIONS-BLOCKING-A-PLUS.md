# The nine decisions — DECIDED

*Delegated 2026-08-18: "make these decisions by asking /architect or doing in-depth web research on industry
best practices and on what will make our apps bulletproof." Each below is decided, with the evidence that
decided it. Where a decision is "don't", that is a decision — not a deferral.*

**Three were decided against my own earlier recommendation.** Those are marked ⚠ and are the ones worth
reading first, because a recommendation that survives its own research is weaker evidence than one that doesn't.

---

## ⚠ D9 — the 12-minute stale-worker stall → **ADD A HEARTBEAT** (ADR 0585, PR #3371)

I had recommended "accept and state the bound". **Wrong**, and one measurement shows it:

```
grep -rn 'setRunDispatchLease(' src/   ->   executor.ts:1355   (ONE site)
```

**The lease is set once at dispatch and never renewed**, so it is not a liveness signal — it answers *"could
this run still legitimately be running?"*, not *"is the worker alive?"*. That is why it must be ≥ the longest
legal run, and why crash detection takes as long as the maximum run duration.

Temporal separates the two for exactly this reason: *"using a long timeout would increase the delay before a
stuck or crashed worker would be identified."* **Heartbeat = liveness (seconds); the advertised ceiling =
duration (minutes).**

**And shortening the lease alone — the obvious fix — would have been dangerous.** Without a heartbeat it
declares *live* long-running runs dead and re-dispatches them, and this host has **no effect fencing**. It
would trade a 12-minute stall for duplicate refunds. *The long lease is currently standing in for fencing.*

Phased P0 heartbeat → P1 shorter threshold → P2 declare the bound. **P1 without P0 is the dangerous ordering**
and the ADR says so.

## ⚠ D5 — pack network denial → **RECORD "not on Node/Cloud Run"; keep the advert absent**

I had leaned this way; the research hardened it from preference to evidence. In-process JS sandboxes are not a
security boundary and keep failing catastrophically — **CVE-2026-22709** in vm2 (CVSS 9.8) and
**CVE-2026-34208** (CVSS 10.0, "completely defeats its security isolation purpose"), on top of vm2's 2023
deprecation.

**And this host's posture is already fail-closed**, which I verified rather than assumed:
`isolationAdapter.ts:54` — *"more than the adapter enforces is REFUSED, never downgraded."* A pack requiring
network denial is refused, not silently downgraded to a weaker adapter.

So this is **not a live vulnerability**; it is a capability correctly withheld. Deno/WASM/brokered-egress are
each a programme, and building one to close a phase row is the error this whole review has been removing.

## D1 — attestation predicate → **DSSE + in-toto Statement, `predicateType: https://slsa.dev/provenance/v1`**

The 2026 standard, confirmed: SLSA provenance v1.0 *is* an in-toto predicate, signed inside a **DSSE**
envelope, bound to the artifact by digest — and it is what npm and GitHub Actions already emit via OIDC. No
bespoke format. This unblocks wiring `sign-attestation.mjs` into `deploy.sh` (50-4).

## D3 — hosted CI → **record that local `ci.sh` IS the merge gate**

Re-enabling needs org billing, which is a spend decision, not an engineering one. Meanwhile "temporarily
disabled" and "this is our gate" call for different rigour — and it has been the arrangement for a month.
Recording it is the honest state **and** raises the bar on the local gate, which is where tonight's nine
main-reds were caught.

## D4 — governance numbers → **adopt RFC 0156 §A (2 unaffiliated maintainers); record `GOVERNANCE.md:97` as superseded**

Pick the more recent and more specific normative text and say which one lost. *Recruiting the people remains a
human act* — the decision here is only which standard the project is held to, so the gap stops being ambiguous.

## D6 — second region + OTLP collector → **DON'T**

Neither is claimed on the wire. `idempotency.crossRegion` stays `single-region` and the SLOs stay
declared-not-measured — both already honest. Building infrastructure to close a phase row is the same error as
writing "done" in the row.

## D7 — RFC 0100 durable push → **DON'T implement; it is above the RFC**

ADR 0552 P3 is not implementable as written until RFC 0100 gains a durable-push MUST. **A host must not
implement a durable push the protocol does not describe** — that is inventing wire behaviour peers cannot rely
on. Corpus decision; the host records it as blocked-on-spec.

## D8 — the proposed RFC slate → **author only 0162; fold the other six**

Agreed with the corpus session, which confirmed 0158–0164 are unreserved. 0158's remaining content is one
optional field on RFC 0151; 0159 is qualification levels belonging to 0162's ladder; 0160 is RFC 0154's UQ1/UQ3;
0161 is RFC 0155; 0163 is RFC 0156 §A; 0164 is `RFCS/README.md`. **The test: if a proposal's content is
"qualify what an existing RFC already says", that is a conformance scenario and an acceptance criterion, not a
document.**

## D2 — RFC 0147 §A.1 freeze → **DECIDED: it binds ONE of the three, and the test is textual**

I first declined this as "needs the steward", and so did the corpus session — on the reasonable ground that a
rule binding hosts should not be set by whoever is in the conversation. **Delegated back and now decided**,
because reading the clause shows it is a question of text rather than of authority.

The clause (`RFCS/0147:42`):

> *"The project **MUST** freeze new **non-essential optional wire capabilities** until Workstreams 1–3 are
> Accepted and every Critical risk in the companion register is Closed…"*

Three words carry it, and the corpus session's fact stands: the acceptance box is still unticked, so the freeze
IS in force. What it *reaches* is narrower than "all wire work":

- **"new … capabilities"** — advertised surface that did not exist. An annex clarifying an existing enum is not
  one; a qualification ladder describing behaviour that already exists is not one.
- **"optional"** — required corrections and safety-fixes are outside it (item 7 of the same list explicitly
  contemplates safety-fix child RFCs proceeding, with a migration package).
- **"non-essential"** — the operative test is whether the *safety outcome* depends on the capability, not
  whether it is useful.

Applying it:

| item | ruling | why |
|---|---|---|
| **`supportedTriggers`** (RFC 0151) | **FROZEN — record and wait** | It is new optional advertised surface, and it is non-essential because the safety hole is ALREADY closed by refusal: `compensation.md:165` requires a host to refuse at registration a policy naming a trigger it does not fire (`validation_error`, naming the offending trigger). The advert moves discovery from registration-time to authoring-time — ergonomics, not safety |
| **RFC 0150 §D annex** | **NOT reached by the freeze** | `capabilities.idempotency.crossRegion` is an EXISTING closed enum of three postures (`idempotency.md:362`). Clarifying it adds no capability |
| **RFC 0162 / SP-14** | **NOT reached — author it** | A qualification ladder is evidence about existing behaviour. It becomes frozen only if it mints a new advertised field, so it should be drafted not to |

**Consequence: the freeze blocks one optional field, not the programme.** RFC 0162 proceeds, the 0150 §D annex
proceeds, and `supportedTriggers` waits — which is exactly where the corpus session's instinct already pointed;
this supplies the reason it was missing.

**Falsifier:** if `compensation.md:165`'s registration refusal were ever relaxed, `supportedTriggers` would
become the only thing standing between an author and a silently-inert policy — and would then be **essential**,
clearing the carve-out. The ruling depends on that refusal existing, so it should be cited wherever the refusal
is edited.

---

## What needs you now

**Nothing.** All nine are decided, including D2, which was delegated back after both I and the corpus session
declined it. Reading the clause turned it from a question of authority into a question of text.

**Two things are worth your review rather than your decision**, because they are the ones where I overruled my
own first answer:

1. **D9** — the dispatch lease is set ONCE and never renewed, so it was never a liveness signal. Shortening it
   without a heartbeat would have traded a 12-minute stall for duplicate refunds. ADR 0585 / PR #3371.
2. **D2** — the freeze binds `supportedTriggers` only, and only because a registration refusal already closes
   the safety hole. If that refusal is ever relaxed, the ruling inverts.
