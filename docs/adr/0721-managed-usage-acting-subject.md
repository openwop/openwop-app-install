# ADR 0721 — a per-subject meter that nobody passes a subject to is a pooled meter

Status: **Accepted — implemented** 2026-09-17
Date: 2026-09-17
Scope: `openwop-app` backend — managed-tier dispatch + usage metering
Decision type: defect correction with a class ratchet

## Context

ADR 0693 split the managed free-tier allowance per subject so that one shared
workspace could not have a single 50 000-token day drained by whoever chatted first.
`managedUsageBucket(tenantId, subject)` hashes `(tenant, subject)` into a bucket, and
`test/managed-usage-per-subject.test.ts` proves that split works — two subjects differ,
one subject is stable, the subject is not recoverable from the bucket.

Every one of those assertions is about the **composer**. None is about whether any
caller passes a subject.

**MEASURED 2026-09-17 on `ac592900d`: of the seven `dispatchManagedChat` sites, ZERO did.**
`managedUsageScope.ts:49` reads `if (!subject) return tenantId;` — the pooled bucket — so
every one of them charged the whole workspace to a single row. The sibling entry point
`dispatchManagedToolsRound` was already correct at two of its three sites
(`aiProviders/aiProvidersHost.ts:1021`, `host/conversationToolLoop.ts:344`), which is what
makes the shape of this defect specific rather than total.

**So the affected lane is narrower than "all managed chat", and naming it precisely
matters.** `conversationToolLoop.ts:322` is `if (tools.length === 0) return null;`, so an
agent carrying the ADR 0315 default-on tool baseline took the tools round and metered
per-subject correctly. What fell through to the pooled bucket was the **TOOL-LESS reply
branch** — `dispatchReply` in `host/exchange/dispatchTurn.ts`. Real, and the busiest
remaining path, but not every conversation in the product.

> **CORRECTION, same PR.** The first draft of this ADR and of its commit message said
> "exactly one call site in the entire backend passed `actingSubject`", and described the
> blast radius as "EmbeddedChatPanel, /guide, and every group room". Both were wrong, and
> wrong the same way: I enumerated `dispatchManagedChat` and never enumerated its sibling
> `dispatchManagedToolsRound`, which meters through the same composer. Caught in code
> review. That is the identical error this ADR is *about* — checking one half of a
> population and reporting the result as if it covered the whole — committed while writing
> up the fix for it. The ratchet below now walks BOTH entry points, which is the only
> version of this lesson that survives me.

**It was an omission, not a decision.** `dispatchManagedChat` accepts `actingSubject`
(`providers/managedProvider.ts:402`) and uses it at `:445` and `:522`; the managed tools
round at `aiProvidersHost.ts:1024` already passes it. In `dispatchTurn.ts` the value is in
scope **78 lines below the managed branch**, where the same function reads
`run.metadata.actingUserId` to key the BYOK budget. The managed branch simply never
threaded it.

**How it was found.** Not by this lane. An `/architect` pass on ADR 0711 option B was
asked to verify that ADR's claim that "the ADR 0693 per-subject cap is enough to ship" —
its stated reason for deferring a per-workspace ceiling. The claim is false, and the
deferral rested on it.

## Decision

Thread the acting subject into every managed dispatch made **for a person**, and ratchet
the class so the next call site cannot quietly omit it.

| site | subject | why it was available all along |
|---|---|---|
| `host/exchange/dispatchTurn.ts` | `run.metadata.actingUserId` | the BYOK budget in the same function already reads it |
| `bootstrap/nodes.ts` (chat-responder) | `ctx.actingUserId` | `executor/types.ts:644` — "the DURABLE human the run was created for" |
| `aiProviders/aiProvidersHost.ts` (`callAIManaged`) | `scope.actingUserId` | the managed TOOLS round 50 lines below already does exactly this |
| `features/memory-auto-extract/memoryExtractor.ts` | threaded from the caller | `persistExchange.ts:161` holds `userId` in the same expression |

**Absent stays absent.** No placeholder subject is invented. A fix that substituted one
would mint per-caller rows for the anonymous widget and a DSAR surface for a person who
does not exist. Leg 2 of the witness pins this.

### Not fixed here, with the reason measured rather than asserted

| site | why |
|---|---|
| `features/chat-widget/publicGateway.ts` | anonymous **by design** (ADR 0693 OQ1). No subject exists; the pooled tenant bucket is the correct meter — the operator pays for visitors they cannot identify |
| `host/headlessAi.ts` | system work. All four callers (`workflowEvalJudge`, `kbService`, `cms/translate`, `mediaService`) pass only a tenantId; the host acts for the workspace, not a person |
| `features/chat-autotitle/titleGenerator.ts` | reachable only through the injected `generate?` seam (`binding.ts:70`) that tests stub, so threading changes a test seam. **A cost decision, not a claim that no subject exists** — the spend is real but bounded to one short title per conversation. A small self-contained follow-up |

## Why a ratchet and not just four edits

The instance fix rots the moment a seventh call site appears, and this defect is
*precisely* what an instance fix leaves behind: ADR 0693 fixed the composer and shipped a
test that could not observe its callers. `test/adr0721-managed-acting-subject.test.ts`
classifies every `dispatchManagedChat(` site in `src/**` — pass the subject, or earn an
`EXEMPT` row with a reason. The EXEMPT set is shrink-only and has an anti-rot arm: a row
whose file starts passing the subject must be deleted, never left as a permanent excuse.

Leg 2 is a source spelling and the file says so. **Leg 1 is the oracle** — it drives a real
call site and asserts what actually reaches `dispatchManagedChat`, which a grep cannot.

## Consequences

- A shared workspace's participants now draw **separate** free-tier allowances on the chat
  lane, which is what ADR 0693 decided and did not achieve.
- ADR 0711's answer to its OQ2 becomes true, so its deferral of a per-workspace ceiling
  becomes defensible. **It was not before**, and 0711 carries a correction saying so.
- No wire surface. Non-normative host behaviour; no RFC.

## The cap gets LOOSER at deploy, in one step, and that is not migrated

Splitting a pooled bucket into N per-subject buckets means a multi-principal workspace's
effective ceiling goes from **1 × cap/day to N × cap/day** the moment this ships, and every
member starts from zero consumption regardless of what the workspace had already burned
that day.

Measured, so the size of it is known rather than guessed: the old pooled row is NOT
orphaned — `managedUsageScope.ts:47-48` short-circuits single-principal tenants, so only
`ws:` / `host-*` workspaces change, the pooled row stays live as the anonymous/system
bucket, and teardown still reaches both through `usageBucketMatchersForTenant`. DSAR is
unaffected. So there is nothing to migrate; there is a **step change to accept**.

The only backstop is `OPENWOP_MANAGED_GLOBAL_DAILY_TOKEN_CAP`, and it is **unset by
default** (`frontend/react/WHITE-LABEL.md:233`) — set on kicktodo (ADR 0693 §199), absent
on a stock white-label deploy. **An operator who relied on the pooled cap as a spend
ceiling loses it here.** That is the correct trade (the pooled cap was never a budget, it
was a bug that happened to bound spend), but it is a real operational change and it is
recorded rather than discovered.

## Retention — these rows now grow N times faster and nothing ages them out

Raised by `/grade-data`, absent from the first version of this ADR, and the finding I would
most want the next reader to see.

`managed_provider_usage` and `media_provider_usage` are `(tenant_id, date, …)` tables with
**no `registerRetentionPurger`, no TTL and no prune** — the only deletes are tenant teardown
and subject erasure. Before this change the row count grew as `tenants × days`. It now grows
as `tenants × (1 + members) × days`, forever, on a `db-f1-micro`.

The omission pre-dates this work; **this change materially worsens it**, which is why it
belongs here rather than in a backlog. A `date < cutoff` purger needs no backfill and is
small. Recorded rather than fixed because it is a storage-lifecycle decision with its own
blast radius, not a line in this one.

Also from the same pass, pre-existing and worth a reader's attention: `routes/governance.ts`
reads media usage at the RAW tenant while TTS now writes the per-subject bucket, so the
superadmin panel reports `ttsChars: 0` for shared workspaces — and STT still lands pooled, so
one row is half one scoping and half the other.

## What this does NOT close

`providers/managedProvider.ts:450` reads `prepaid <= 0 && usage >= cap`, so **any non-zero
prepaid balance disables the daily cap entirely** for the whole workspace (ADR 0176 Phase 2,
deliberate: purchased credit should not be blocked by a free-tier cap). Per-subject metering
does not bound spend on a workspace that has bought credit. That is pre-existing and is not
made worse here — managed dispatch is already reachable by any member who can create a run —
but it is the strongest argument that a per-workspace ceiling is a real open question rather
than a formality, and it is recorded here because ADR 0711 does not mention it at all.

## Implementation record

| part | where | proof |
|---|---|---|
| four sites threaded | the table above | `test/adr0721-managed-acting-subject.test.ts` legs 1, 3 |
| absent stays absent | no placeholder anywhere | leg 2 |
| class ratchet + EXEMPT | same file | legs 3, 4, 5 |

### One non-human subject does reach the composer, by design

`host/schedulingService.ts:543` rewrites `metadata.actingUserId` to an `'[erased]'`
sentinel after a DSAR. A resumed job then meters to `hash(tenant, '[erased]')` — one shared
bucket for every erased subject, permanently unreachable by `eraseSubjectManagedUsage`.
Harmless (the person is already erased and the row is pseudonymous) and better than the
alternatives, but it is a real case of a non-human value reaching `managedUsageBucket` and
is written down so nobody re-derives it as a defect.

### Sabotage record
Each fix reverted **independently** — disjoint reds, never "the change":

| reverted | reds |
|---|---|
| `dispatchTurn.ts` | POPULATION only |
| `bootstrap/nodes.ts` | POPULATION only |
| `aiProvidersHost.ts` | POPULATION only |
| `memoryExtractor.ts` | BEHAVIOURAL + POPULATION (it is the site leg 1 drives) |

Also verified: the walker finds both passing and omitting sites, so `EXEMPT` is falsifiable
rather than vacuously satisfied.
