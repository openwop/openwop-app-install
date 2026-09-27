# ADR 0674 — ten vendor event types were invalid; this fixes the writer

Status: Accepted (implemented; see § Implementation record)

## Context

`events.md` §Types caps a vendor event type at **three segments** and allows
kebab-case only:

```
^(?!openwop\.)[a-z][a-z0-9]*(-[a-z0-9]+)*\.[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)?$
```

MEASURED 2026-09-13 against this host's own emitted set: of 85 distinct dotted
types, 43 are named by the codemap (protocol types the vendor rule never
touches) and 42 take the vendor branch. **Eleven of those 42 do not satisfy the
grammar at all** — seven exceed the segment cap, four carry an underscore.

They pass here only because `isVendorType` (`storage/eventEra.ts`) accepts any
dotted lowercase name. **So the loose predicate is not merely failing to refuse
other hosts' malformed types — it has been concealing this host's own.** That
reframes the work: these are not a future migration, they are a bug the host
has been shipping.

The corpus registered `openwop-app` as a vendor org on 2026-09-11 (RFC 0180
§A.5; effective from `@openwop/spec-artifacts` 2.0.12, which this host has), so
there is now a legal org to put them under. The steward's ruling on the READ
side — whether an era-2 reader may refuse types written before the rule — is
going through an RFC 0180 amendment and is explicitly **held**. The writer side
was cleared to proceed, and this is that.

## Decision

Ten renames, each validated against the grammar **before** any file was touched:

| was | now |
| --- | --- |
| `host.crm.contact.triaged` | `openwop-app.crm.contact-triaged` |
| `host.entities.entity.written` | `openwop-app.entities.entity-written` |
| `host.kanban.card.moved` | `openwop-app.kanban.card-moved` |
| `host.servicedesk.ticket.reply-approved` | `openwop-app.servicedesk.ticket-reply-approved` |
| `host.servicedesk.ticket.sla-breached` | `openwop-app.servicedesk.ticket-sla-breached` |
| `host.whatsapp.health.degraded` | `openwop-app.whatsapp.health-degraded` |
| `openwop-app.conversation.context_degraded` | `openwop-app.conversation.context-degraded` |
| `openwop-app.conversation.recall_used` | `openwop-app.conversation.recall-used` |
| `workflow.approval_needed` | `openwop-app.workflow.approval-needed` |
| `workflow.budget_alert` | `openwop-app.workflow.budget-alert` |

"Prefix the org and keep the tail" does not work — it produces four segments.
The tail has to **collapse into kebab-case inside a segment**, which makes each
one a naming decision rather than a scripted prefix.

**Validated before editing, not after.** The steward's own registration note
gave `openwop-app.conversation.recall_used` as the intended shape, and I quoted
it back twice; it fails the grammar on the underscore. Two readers passed a
malformed example between them because neither ran it against the regex **that
was sitting in this repo at `storage/eventEra.ts:152`**.

## The eleventh is deferred, and the reason is the record

`host.forms.submission.created` is **not** renamed here. Its chain pack binds it
as a trigger `eventName`, and renaming it end-to-end leaves
`forms-intake-chain-execution` failing four ways: the chain still fires and the
run still completes, but files nothing. MEASURED: 9/9 on pristine main, 4 red
with the rename, and a pack version bump does not fix it — so it is the
installed-registry coupling this repo already documents ("a chain-pack fix needs
a registry republish"), not a source problem. Republishing is blocked on the
same key `openwop-registry#54` waits for.

Shipping ten and stating the eleventh beats shipping eleven and leaving a chain
silently not filing.

## What the bulk edit broke, and what caught it

The version-bump step round-tripped three `pack.json` files through
`json.dump`, which **reformatted them entirely and escaped every em-dash to
`—`** — 150 changed lines for a five-occurrence rename. The diff pass
caught it, but only because it was re-run *after* the bump; the first pass ran
before. **A diff pass is not a step you do once at the end of the edits — it is
a step you do after each mechanical transformation**, because each one has its
own failure mode.

The version bumps were also unwarranted: both node packs changed only a comment.

## Consequences

Emitted types invalid under the vendor grammar: **11 → 1**, the one being the
deferred forms type. The shrink-only host-event catalog baseline shrank by four
entries, because four renamed types are now catalogued rather than exempted.

Nothing here tightens `isVendorType`. That is the read side, it is held pending
the RFC 0180 amendment, and tightening it today would refuse this host's own
durable era-2 rows written under the old names.

## Implementation record

| phase | what |
| --- | --- |
| 1 | ten renames across src, tests, SPA, packs and docs — 98 occurrences, 50 files |
| 2 | forms type reverted and documented as registry-coupled |
| 3 | host-event catalog baseline shrunk 4 entries |
| 4 | `tsc --noEmit` clean; 5 touched test files / 49 tests green |
