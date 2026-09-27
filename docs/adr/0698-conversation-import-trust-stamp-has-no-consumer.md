# ADR 0698 — A trust stamp with no consumer, and three comments that cite it

Status: **implemented** (verified 2026-09-17, #3863)

Feature loop 2026-09, iteration 36 — Conversation export/import (`FEATURES.md`
ordinal 204, ADR 0119). Graded at `origin/main` `71c4e24a9`. Ids continue the
2026-08-27 passes (`CXC-`/`CXWF-`).

## Context

Prior grades: workflows **B+**, UX **B+**, code **C+**. The code grade carried the
work. Measuring the filed rows moved two of them — one *down* in severity, one
sideways into a different (and sharper) finding.

## D1 (Improvement, `CXC-2`) — the stamp is inert, and the comments cite it as protection

`importService.ts:54` stamps every imported message
`meta: {contentTrust:'untrusted', source:'import'}`. **Nothing reads it.** Verified
by enumerating every `contentTrust` consumer in the tree: they are all in the
RFC 0021 envelope/run-event path (`envelopeAcceptor`, `envelopeProjection`,
`promptInjectionGuard`, `promptCompose`) or the KB-chunk path
(`agentKnowledgeComposition`). Imported content lives in the **chat-message store**,
which none of them read.

Three comments assert a protection this stamp does not provide:

| site | claim |
|---|---|
| `features/chat-export/routes.ts:41-44` | "imported bodies are stamped … so a hostile import is fenced, never silently trusted" |
| `features/chat-export/importService.ts:6-9` | "fenced as untrusted on recall/render, never silently trusted" |
| `features/chat-export/importService.ts:53` | "SECURITY: imported content is UNTRUSTED — fenced on recall/render." |

### The measurement that changed the finding

I expected a live prompt-injection hole and did not find one. **The one model-facing
path over these rows is genuinely fenced — by a different mechanism.**
`conversation-search/agentTools.ts:22` declares `contentTrust:'untrusted'` **on the
tool**, and `host/toModelToolResult.ts:101` fences the result of any builtin that
declares it. So imported content reaching a model through conversation search is
wrapped, regardless of what any row says.

**The effect is right; the stated cause is wrong.** That is still worth fixing:
an inert field that looks like a protection is its own hazard, because the next
author extending this feature will reasonably rely on it. The prior row already
offered the correct disposition — *"make a real consumer honor the stamp, or correct
the comments to state the actual (architectural) reason"* — and the measurement says
the second is the honest one.

### Decision

- **D1a** — rewrite the three comments to state the real mechanism: these rows are
  not read by any trust-aware consumer; the protection on the model-facing path is
  the **tool-level** `contentTrust` declaration, cited by file and line.
- **D1b** — **keep** `source:'import'`. It is genuine provenance and is what a
  future consumer would key off. **Do not keep a claim that it fences anything.**
- **D1c** — a witness that fails if a comment re-asserts row-level fencing without a
  consumer existing, so the claim cannot silently return.

## D2 (Improvement, `CXC-5`) — the fence break-out is how imported content controls SHAPE

`transcriptRenderer.ts:60-75` interpolates `session.title`, `m.content` and
`m.createdAt` unescaped:

- `` lines.push('```json'); lines.push(m.content); lines.push('```') `` — content
  containing a literal ``` closes the fence and everything after it renders as
  document structure.
- `# ${session.title || 'Conversation'}` — a title containing a newline injects
  headings.

The prior row rated this *"low risk for a text format"*. That undersells it once
D3 is in view: **this is the mechanism by which imported (attacker-supplied)
content controls the STRUCTURE of the exported artifact**, not merely its text. An
import → export-as-document round trip turns a fence break-out into structure inside
a user-attributed Document.

### Decision

- **D2a** — normalize fences in structured content (neutralize any ``` run) before
  wrapping, and strip newlines/`#` from the title before interpolating.
- **D2b** — a witness driving the full round trip: a crafted title and a
  fence-bearing body must not produce extra headings or escape the fence.

## D3 (filed, NOT fixed — and the reason is the point)

`asDocumentService.ts:32-44` exports **any** conversation — including an imported
one — to a Document stamped
`provenance: { producedBy: { kind: 'user', id: actor } }`. The `Provenance` type
(`documents/documentsService.ts:74-80`) has **no trust field**, so the untrusted
origin is dropped at the document boundary and the artifact is attributed to the
exporting user. Meanwhile `agentKnowledgeComposition.ts:108` treats **absence** of
`contentTrust` as **trusted** (`chunks.filter((c) => c.contentTrust !== 'untrusted')`).

That is the "fail-open default is a SHAPE" family: absence becomes a grant.

**Why it is filed rather than fixed:**

1. **It is a forward risk, not a live hole.** I found **no automatic
   Document→KB pipeline**; ingestion is a deliberate act, and `kbService.ts:185`
   makes `contentTrust` a `PRIVILEGED_DOCUMENT_FIELD` on the source. Claiming a live
   injection path would overstate what I measured.
2. **The obvious fix would repeat the defect this ADR closes.** Adding an optional
   `contentTrust` to `Provenance` (21 construction sites, 45 readers — additive and
   safe) and setting it here would produce **another stamp with no consumer** —
   exactly `CXC-2`, one layer up. A trust field earns its place only when written
   *and* honored end to end.
3. Wiring it end to end spans chat-export, documents, and KB — three features, and
   this loop grades one per iteration.

**The right sequencing** is to close it when the KB ingestion path is the feature
under grade, so the consumer and the producer land together.

## Re-verified and dispositioned (do not re-spend)

- **`CXC-7`** ("owner-slot type confusion") — **correctly filed as Nice-to-have.**
  Two prior iterations found understated rows, which made it tempting to assume this
  one too. It is not: the read route (`routes.ts:24`) uses the **same**
  `req.userId ?? req.principal?.principalId` expression as the write (`:48`), so
  read-back is self-consistent. The one consumer that would double-prefix it,
  `chatMessageBus.ts:64` (`` `user:${meta.ownerUserId}` ``), early-returns unless
  `meta.type` is `channel`/`group` (`:57`), and imports create `type:'agent'`
  (`importService.ts:42`) — **unreachable**. Same family as the `PLC-7` closed in
  it.34 and as ADR 0684, but genuinely inert here.
- **`CXC-1`** — already closed by the ADR 0119 grade pass; the `!userId` refusal is
  live at `routes.ts:57`.

## RFC verdict

**No RFC.** Host-ext throughout: comment corrections, a renderer hardening, and a
filed row. No wire shape, no capability advertisement, no conformance claim.

## Open questions

1. D3's sequencing — whether the trust field belongs on `Provenance` or on the KB
   source at ingestion. Deciding that is the KB iteration's call, not this one's.
2. Whether `CXC-3` (import amplification, no per-caller quota) should ride the
   shared rate-limit tiers (ADR 0640) rather than a bespoke cap. Left open; it is a
   capacity question, not a correctness one.

## Status correction (2026-09-17)

This record read `Status: Proposed` while its decision was already merged in **#3863**. It was on the steward staleness baseline (`backend/typescript/test/steward/adr-status-not-stale.test.ts`) as *flagged but unverified*; the status above was established by reading the code, not the commit message.

**Evidence.** D1a corrections at `features/chat-export/importService.ts:8-21` and `features/chat-export/routes.ts:48-55`, citing the real tool-level mechanism (`conversation-search/agentTools.ts:22` → `host/toModelToolResult.ts:101`); D1b the stamp is KEPT as provenance at `importService.ts:73`; D2a `features/chat-export/transcriptRenderer.ts:62 safeHeadingText` (used `:84`) and `:75 fenceFor` (applied `:92-95`).

D3 is filed-not-fixed BY this ADR, so it is not a gap against it.
