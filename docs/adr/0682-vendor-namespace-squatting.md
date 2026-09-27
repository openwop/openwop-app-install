# ADR 0682 — five host events were squatting in protocol namespaces

Status: Accepted (implemented; see § Implementation record)

## Context

ADR 0674 renamed eleven event types that violated `events.md` §Types outright.
The census that followed (`scripts/era2-vendor-type-census.mjs`) found a second,
quieter population: **22 (tenant, type) pairs over 1273 rows** that are perfectly
well-formed and still wrong, because their first segment is an org this host does
not own.

`openwop-1`'s ruling (crosstalk `dd4b`) is what makes this actionable, and the
argument is theirs rather than mine. I produced the 1273 as evidence for relaxing
`persistence.md` §The reader rule and never asked *whose namespace the rows were
in*:

| prefix | protocol rows in the codemap |
| --- | --- |
| `node.` | **10** — `node.started`, `node.completed`, `node.failed`, … |
| `conversation.` | **3** — `conversation.opened`, `.exchanged`, `.closed` |
| `ai.` | 0 — genuinely free |

So `node.message` and `conversation.titled` are **host-invented events sitting
inside namespaces the protocol owns**. Under a shape-only pass-through,
`node.startd` — a one-character typo of `node.started` — is indistinguishable
from `node.message`: two kebab segments, no `openwop.` prefix, both opaque. A
protocol event silently demoted to "carry it, don't act on it" is worse than a
`500` that says so, and refusing unregistered orgs is the only thing separating
the two cases.

## Decision

> **CORRECTED 2026-09-15 by ADR 0688 — two of these five were the WRONG EXIT,
> and the half of this ADR that is right is what got the wrong half merged.**
>
> "Stop squatting" has two exits, and this ADR took the one that was uniform
> across all five rather than asking, per type, whether the protocol already had
> a name for the thing. Three of the five genuinely had none and are correctly
> vendor-namespaced. **Two did:**
>
> | this ADR wrote | the codemap already had | rows |
> | --- | --- | --- |
> | `openwop-app.ai.message-chunk` | **`output.chunk`** (`payloadDef: outputChunk`) | 967 |
> | `openwop-app.node.interrupt-resolved` | **`interrupt.resolved`** (`payloadDef: interruptResolved`) | 17 |
>
> `output.chunk` is what the conformance-REQUIRED `stream-text` provider emits
> (`spec/v1/run-options.md`), and RFC 0094 §D single-sources the
> `ai.message.chunk` payload to it — one persisted type, one SSE frame name, one
> shared payload. This host was persisting the **frame name** where the type
> belongs, and this ADR made that permanent by giving it an org.
>
> The interrupt case is worse: `routes/interrupts.ts` was **already emitting the
> codemap `interrupt.resolved` thirty lines away in the same function**, on the
> reject path. So one fact was spelled two ways BY OUTCOME — a rejection legible
> to any v2 reader, an acceptance opaque.
>
> And this ADR's writer-only rename **orphaned the 17 rows from every SPA
> matcher** on the day it merged: five call sites matched the old spelling by
> hand, none was updated, so the run detail page, the analytics count and the
> builder's node-status derivation silently lost them. (The 967 were unaffected —
> the chunk matcher drops anything replayed, so it never read old rows anyway.)
>
> **ADR 0687 made this sharper rather than milder.** Under the registration gate
> those two names are now *legitimately* registered vendor types, so they pass
> through **uninterpreted by design** — the gate working correctly is what would
> have made the misclassification permanent.
>
> The prohibition this ADR states still stands, and Finding 1 was right: `ai.*`
> and `node.*` are protocol-owned namespaces this host had no business in. Only
> the destination for two of the five was wrong.

Move all five under the registered `openwop-app` org:

| was | now | rows in production |
| --- | --- | --- |
| `ai.message.chunk` | `openwop-app.ai.message-chunk` | 967 |
| `node.message` | `openwop-app.node.message` | 275 |
| `node.interrupt.resolved` | `openwop-app.node.interrupt-resolved` | 17 |
| `ai.message.error` | `openwop-app.ai.message-error` | 12 |
| `conversation.titled` | `openwop-app.conversation.titled` | 2 |

Each validated against the vendor grammar **before** any file was touched — the
habit ADR 0674 bought, after a malformed example passed between two readers
because neither ran it against the regex.

This is the **writer** half only. It does not tighten `isVendorType`; that is a
separate change, and doing it first would refuse rows this host is still
producing.

## The check that nearly stopped this, and why it did not

`schemas/v2/run-event-payloads.schema.json` mentions `ai.message.chunk` in a
payload `description`, which reads as "the corpus knows this type, do not touch
it." It is not a declaration: the payload key is `outputChunk`, and the file's
own **normative** `_typeIndex` (RFC 0171 §A.4, generated from the codemap)
carries none of the five. The mention is stale corpus prose.

Worth recording because the failure would have been silent in the expensive
direction: had the corpus genuinely declared it, this rename would have stopped
the host emitting an event the spec describes, and nothing here would have
caught it.

## The bulk edit, and the two things that went wrong again

171 occurrences across 43 files, then a diff pass — which found the edit had
reached `schemas/`, the **vendored corpus tree**. Reverted; it is not this
repo's to change. Second time in two days that a repo-wide substitution has
walked into the vendored tree, so the rule is now explicit: **a substitution
scoped to "the repo" includes vendored copies of other people's files.**

And the worktree was provisioned by symlinking `node_modules` — the shortcut
CLAUDE.md forbids — which pointed at an install carrying conformance
`1.136.3`, so `check-vendored-schemas` failed against a `CORPUS_TAG` of
`v2.1.5`. The error was real, its cause was the shortcut, and the real
`npm ci` cleared it. Also the second time today.

## Consequences

New rows are conformant. The **1273 existing rows are not**, and this ADR does
not repair them — `persistence.md` §The reader rule refuses them at contract 2.
Their blast radius is bounded: `toContractVocabulary` gates the refusal inside
`if (contract === 2)`, and this host's header-less default is major 1, so every
current client still reads them.

That bound is what makes the follow-up safe to sequence: tighten the reader only
after this has been deployed long enough that the count has stopped growing.

## Implementation record

| phase | what |
| --- | --- |
| 1 | five names validated against the vendor grammar before editing |
| 2 | 171 occurrences / 43 files — backend, SPA, packs, docs |
| 3 | `schemas/` reverted; the corpus tree is not ours |
| 4 | backend 6 files / 47 tests · frontend build green · 757 files / 5333 tests |
