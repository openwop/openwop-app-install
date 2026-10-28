# ADR 0982 — Chat memory extraction: the person's own words in, closed-world facts out, written only where the person can see them

Status: implemented (2026-10-26; merged as #5250 `88db7bfec`, deployed in rev `01050-vkb`; Accepted earlier the same day after the adversarial `/architect` pass: 1 Blocker, 5 High, 4 Medium, 2 Low, all folded into D1–D8; findings table at the end)

Feature loop round 2, row 57 (Chat memory auto-extraction, `memory-auto-extract`). Amends ADR 0120
(chat memory auto-extraction), ADR 0666 D1 (the grant key) and ADR 0587 §1 (trust provenance). It is
host-only: no wire change, no new RFC, nothing advertised changes.

## Context

Round 1 graded the workflows side A− and never graded UX or code as a unit. That pass checked the
consent gate and that the recall fence fires. It did not check what the lane decides to write, about
whom, or where.

Re-measured on `origin/main` `70ecf4ff1`, 11 of 11 probes are red (`test/row57-baseline-probe.test.ts`):

| Probe | Defect | Where |
|---|---|---|
| P1 | Agent turns reach the extractor. They echo tool results, MCP content, fetched pages and mock output, so an injected page can author a fact about the person. | `host/exchange/persistExchange.ts` `maybeExtractMemoryOnClose` |
| P2 | The person's own text reaches the model unfenced. | same |
| P3 | Free prose is split into lines and each line is written. A mock reply ("Mock response to: …") becomes facts. | `memoryExtractor.ts` `parseFactLines` |
| P4 | A fact with no support in anything the person said is written. | same |
| P5 | The same fact is re-added at every close. | `extractionBinding.ts` (no idempotency key, no dedupe) |
| P6 | Auto-extraction can fill the 200-note cap, after which the person's own "add a memory" is refused. | same |
| P7 | A chat in a shared workspace writes `(ws:…, user:<id>)`. The Personal Memory tab reads the HOME tenant, so nobody can see or delete it. | `extractionBinding.ts` + `features/profile-memory/routes.ts` |
| P8 | A client-bound run (ADR 0944 stamp) is extracted into the agency person's personal memory. | `maybeExtractMemoryOnClose` |
| P9 | The lane keys on `actingUserId` (the caller's subject). The review UI and DSAR key on the canonical `User.userId`. An unbound `oidc:` session writes `user:oidc:<sub>`, which no list shows. | `extractionBinding.ts` |
| P10 | A provider error returns `[]`, the same value as a model that found no facts. | `memoryExtractor.ts` `llmExtractFacts` |
| P11 | An anonymous caller can opt in, but Personal Memory refuses anonymous callers, so they could never open what it writes. | `routes.ts` |

**Prod (read-only, 2026-10-26T02:21Z):**
- 0 grants have ever been filed.
- 0 notes have `source:'auto-extract'`, and 0 legacy `[auto-extracted]` rows exist.
- 0 managed spend is attributed to `memory-auto-extract`.
- 339 conversation closes happened in the last 30 days, all in non-personal tenants.

The feature has never written anything. Every defect is latent, no cleanup is due, and changing the
grant key strands nothing.

**Also measured:**
- **Who reads what this lane writes.** Only `per-user` agents (KickBot today) recall a `user:` scope
  through `resolveAgentMemory`, and they recall it fenced. The digital twin (`features/twin/borrowedRecall.ts`)
  and Personal Knowledge read the person's HOME-tenant scope.
- **When it runs.** The SPA closes a conversation only on "New chat" (`useSessionPersistence` reset)
  and from Arena. The consent copy says facts are learned "during chats".
- **CS-BE-1 residue.** A run with no conversation meta stays tenant-visible, so in a shared workspace
  another member could append user turns to it and close it.

## Decision

### D1 — Extraction runs only in the person's own personal workspace, on their own persisted chat, with no client

`maybeExtractMemoryOnClose` resolves a **lane** before it does anything else. Any failed check is a
typed skip; nothing is read, dispatched or written.

1. `run.tenantId` is a personal `user:` tenant (`isPersonalTenantId`, minus `anon:`).
   Otherwise the outcome is `skipped: 'not-personal'`.
   - This closes P7 and the CS-BE-1 residue: a personal tenant has exactly one human.
   - It also closes P11's write half: `anon:` sandboxes never extract.
2. The run has no ADR 0944 client stamp (`runClientStamp(run.metadata) === undefined`).
   Otherwise the outcome is `skipped: 'client-bound'` (P8).
3. The run is a persisted chat: it carries a `chatSessionId` AND a server-side conversation record
   exists for it (`getConversationMeta(run.tenantId, chatSessionId)`). Otherwise the outcome is
   `skipped: 'not-a-chat'`.
   - *Corrected by the architect pass (A3):* the first draft required only the `chatSessionId` stamp
     and claimed that excluded ephemeral panels and API runs. It does not. The SPA stamps it on every
     conversation open, the ephemeral `EmbeddedConversation` included (`useTurnTransport.ts:275`),
     and the stamp is client-supplied. The server-side record is what a persisted chat has and those
     runs do not. Forging the stamp only matters inside the person's own tenant, so this is about
     honesty, not security.
4. The tenant's canonical person resolves read-only (`resolveCanonicalUserReadOnly(run.tenantId, actingUserId)`),
   and the run's `actingUserId` is one of that person's spellings (`user.userId` or `user.principalId`).
   Otherwise the outcome is `skipped: 'no-person'`.
   - It never creates a user. An erased person (dangling pointer) is `no-person`.
   - The spelling check refuses a wildcard operator bearer acting inside someone's personal tenant.
   - *Corrected (A7):* a person with legacy split rows can act as a row other than the canonical one
     (the fold adopts the oldest `oidc` row, the bind mints `userIdFor(home, oidc:<sub>)`). So
     `actingUserId` also matches when it names a user row in `run.tenantId` whose `principalId`
     equals the canonical row's `principalId`.

5. The conversation is the person's alone: its record names the person as owner (any of their
   spellings), and no other human is a participant. Otherwise the outcome is `skipped: 'not-a-chat'`.
   - *Added after the closing `/grade-code` (MAE2CD-8):* D1.1's "a personal tenant has exactly one
     human" is false. Personal workspaces can have members (`AWG2CD-1`), and a user turn carries no
     author (`from:'user'`). A conversation with another human participant could have put that
     member's words into the owner's memory.

**Order is fixed:** checks 1–2 are pure and run first, so a non-personal close pays no reads.

**Every later step keys on the canonical `User.userId`:** the grant, the note scope and the dedupe.
This closes P9: facts land exactly where the Personal Memory route lists them, which is
`(user.tenantId, user:<userId>)`, and where the DSAR eraser looks.

**Alternative weighed: write workspace chats into the home tenant.** Rejected. That would move a shared
workspace's content (possibly a client's) into personal memory across a tenant boundary, which is the
ADR 0944 failure in a new place. A person who wants facts from workspace chats can add them by hand.

### D2 — The consent door is the person, not the request subject

The grant routes resolve the caller through `resolveCallerUser`, the same door Personal Memory uses.
- An anonymous caller is refused 401 `sign_in_required` (P11).
- The grant is stored at `(user.tenantId, user.userId)`: the home tenant and the canonical id, from
  whichever workspace the person is in.
- GET adds `available: boolean`. It is `true` only when the home tenant is a personal `user:` tenant,
  since only those can ever extract (a SAML deployment's shared `personalTenant` cannot).
- PUT while unavailable is refused 409 `memory_extraction_unavailable`, rather than filing a grant
  that can never act.
- A signed-in person whose home tenant is `anon:` (a bound password user) gets `available:false`, not 401.
- `resolveCallerUser` is not read-only: it can create the canonical row and fold an IdP email
  (`usersService.ts:690-699`). Personal Memory already pays that on the same page, so it is accepted (A9).

> ADR 0666 D1 kept the write side on `callerSubject` "because real grant rows exist". Measured
> 2026-10-26: 0 rows exist in prod, so moving both sides to the canonical id strands nothing. The
> DSAR eraser (`eraseExtractionGrants`) already matches every key form, so it is unchanged.

### D3 — Only the person's own words reach the extractor, inside the untrusted fence

The extractor's input is the **user-role turns only**. Each is run through `neutralizeUntrusted`,
then all are wrapped in `fenceUntrustedItems`, newest kept when the 8,000-character cap bites.
- Agent turns are never sent (P1). They carry tool, web, MCP and mock output, and a fact "about the
  user" that only the assistant asserted is not the person's.
  - **Trade-off, stated (A11):** a reply like "yes, that one" can no longer be resolved, so some real
    facts are lost. If this is ever relaxed, agent turns may be added as fenced context only and must
    never count as evidence.
- The fence (P2) covers text the person pasted from elsewhere.
- The system prompt states that the fenced block is data and that facts must come from it.

### D4 — Closed-world output: a typed JSON envelope, each fact quoting the person

The model must return exactly:

```json
{ "facts": [ { "fact": "Keeps bees", "category": "other", "evidence": "I keep bees" } ] }
```

- `facts` holds at most 10 items.
- `fact` is 4–280 characters.
- `category` is one of `preference | role | location | goal | ownership | relationship | other`.
- `evidence` is 1–280 characters and MUST be a verbatim quote from the fenced user text.

**Validation is closed-world:**
- **The whole response is `invalid-output`** when it is not exactly that object: unparseable, unknown
  keys at either level, wrong types, a bad category, or a length out of range.
  - A fenced ```json block is unwrapped first. Nothing else is tolerated, so line-per-fact prose no
    longer parses (P3).
- **An individual fact is `rejected`** unless ALL of these hold (P4):
  - its `evidence` is at least 8 characters and two words;
    - *Corrected during implementation:* the architect pass proposed 12. The first witness showed 12
      rejects ordinary self-statements ("I keep bees" is 11, "I'm vegan" is 9). The anchor is the
      shared content word below, and the floor only has to stop `"I"` and `"the"`.
  - the evidence is a substring (case-insensitive, whitespace-collapsed) of ONE neutralized user turn
    that was actually sent, never of the fence wrapper and never across two turns;
  - content words of `fact` (lowercased, 3+ letters, not a stopword) appear in the evidence: two of
    them when the fact has two or more, and a suffix-variant match only when both words are 4+ letters;
  - neither the evidence nor the sentence of the turn that contains it carries a negator (`not`,
    `n't`, `never`, `anymore`, `no longer`, `used to`, …).
  - *Tightened after the closing `/grade-code` (MAE2CD-1):* the one-shared-word rule passed "I don't
    live in Paris anymore" for "Lives in Paris" (the model can quote just "live in Paris"), "be careful
    with this" for "Owns a car" (`car` ⊂ `careful`) and "my trip to Denver" for "Is a nurse in
    Denver". The negator rule is conservative: "I don't drink coffee but I love tea" yields nothing.
    A relational quote ("my sister is a nurse in Denver") still passes and is stated residue.
  - *Corrected by the architect pass (A1, the Blocker):* the first draft checked only that the
    evidence was a substring of the joined text. `"I"` or `"the"` passed for any invented fact, and a
    quote could match the fence boilerplate or span two turns.
  - The evidence check is what makes this closed-world rather than a format check. The only facts that
    reach memory are anchored to something the person actually typed in this conversation.

**ONE bounded repair** (the CLAUDE.md authoring-path rule): on `invalid-output`, the request is resent
once with the fenced user text and the validator's error. The model's previous reply is never sent
back as trusted text. A second invalid reply is the typed failure. Evidence rejections are not repaired.

**One deadline governs the whole lane (A2).** The close's budget becomes an `AbortSignal` passed into
the extractor and the binding:
- the signal aborts the provider call;
- it is checked before the repair call and before every write;
- after the deadline the outcome is `abandoned` and nothing more is written.

*Corrected:* the old race (`persistExchange.ts:160-173`) never cancelled anything. Since ADR 0741
gives the service CPU always, an "abandoned" extraction still finished and wrote after the warning was
logged.

The prompt forbids credentials, health details and government or financial identifiers.
`addSubjectNote` already scrubs secret-shaped text. ADR 0077 classification is OQ-2, not claimed.

### D5 — Typed outcomes, never success-with-empty

`llmExtractFacts` returns a discriminated result, and the binding returns one too:
- `{ status: 'written', written, duplicates, rejected, suppressed, budgetFull }`
- `{ status: 'no-facts' }`: valid JSON with an empty `facts`
- `{ status: 'rejected', rejected }`: every fact failed evidence
- `{ status: 'skipped', reason }`, where `reason` is `no-consent | empty | not-personal | client-bound | not-a-chat | no-person`
- `{ status: 'failed', reason }`, where `reason` is `provider-error | invalid-output | no-provider`
- `{ status: 'abandoned' }`: the deadline passed (D4)
- *Added at code review:* `{ status: 'nothing-new', duplicates, suppressed, budgetFull }` when every
  fact was already known, forgotten or over budget (so a write of zero is not reported as `written`),
  and `failed: 'write-error' | 'lane-error'` (a per-fact write failure vs. a thrown lane read).

A provider error is `failed: provider-error`, never `[]` (P10). The close logs one
`memory_extraction_outcome` line per close: status, counts and reason, never content. `failed` and
`abandoned` are WARN.

### D6 — Writes are idempotent and deduplicated, have their own budget, and respect "forget"

- **Idempotent.** Each fact is written with `idempotencyKey = memextract:<sha256(tenant, scope, normalized fact)>`.
  Two concurrent closes that learn the same fact converge on one row through the existing CAS.
  - *Corrected (A4):* `addSubjectNote` throws 409 when an idempotency hit's stored content differs
    byte for byte (`subjectMemory.ts:428-437`). "Keeps bees" and "keeps bees." share a key. A
    `conflict` is therefore caught per fact and counted as a duplicate. One fact's failure never
    aborts the others.
- **Deduplicated.** A fact whose normalized text equals ANY existing note in the scope (typed or
  learned) is counted as `duplicates` and not written (P5). Normalized means lowercased,
  whitespace-collapsed and without a trailing period.
- **Its own budget.** Extraction stops when the scope holds `AUTO_EXTRACT_CAP` (50) learned notes, or
  when the total would leave fewer than `HUMAN_HEADROOM` (10) slots under `NOTE_CAP`.
  - The outcome reports `budgetFull: true`. Auto-extraction never takes the person's last slots (P6).
  - The check is read-then-write, so concurrent closes can overshoot by up to one batch. Writes are
    counted inside the loop, and the 10-slot headroom absorbs the race (A10).
- **"Forget" sticks.** When the person deletes a learned note on the Personal Memory route, the route
  reads the row first. If it is `source:'auto-extract'` on the `user` subject, it records a tombstone
  in `subject-memory:forgotten`. The lane will not re-learn that fact and counts it as `suppressed`.
  - Without this, a fact the person deleted comes back the next time they happen to restate it, and
    the person has no way to say "stop learning this".
  - A tombstone never blocks a fact the person TYPES; it only gates the extraction lane.
  - The tombstone holds the sha256 of the normalized fact. A short fact's hash can be guessed, so the
    tombstone is treated as personal data. `eraseSubjectMemory` deletes it with the scope's notes for
    every key form, and the collection declares its tenant so teardown reaches it.
  - *Corrected (A5):* the first draft put the tombstone in `removeSubjectNote`, which deletes by id
    without reading the row and is shared by the org, project and agent lanes. It also claimed
    re-learning happens "by the next New chat". It does not: the lane reads only the closed run's turns.

### D7 — Honest copy

The consent hint states:
- when it runs: when you start a new chat, the chat you leave is reviewed;
- what it reads: only your own messages, only in your personal workspace;
- where facts go: below, marked Auto-learned;
- how they are treated: assistants treat them as unverified.

When the GET says `available: false`, the toggle is replaced with a one-line explanation. FEATURES.md
is corrected the same way.

### D8 — What this does not change

- Recall stays as it is: learned facts are `contentTrust:'untrusted'` and fenced on every read
  (ADR 0587).
- No per-write audit row and no `{runId}` provenance. ADR 0120 promised both, and both stay
  unimplemented and unclaimed (OQ-3).
- The lane stays a post-close host operation outside any recorded run, so there is no replay surface.

## Consequences

- The lane now writes only to the one place the person can review it, and only from what the person
  typed.
- Shared-workspace and client chats never extract. That is a capability reduction, and it is honest:
  before, those writes could not be seen, reviewed or deleted.
- **On measured prod traffic the lane would have run on 0 of 339 closes.** Every close in the last 30
  days was in a non-personal tenant, which D1 skips. The copy (D7) therefore says "only chats in your
  personal workspace" even when the toggle is available (A6).
- An un-opted-in close in a personal tenant pays three point-gets: the canonical pointer, the user row
  and the grant. A non-personal close pays nothing because the tenant check runs first. An opted-in
  close adds one `listSubjectNotes` and one tombstone list (A8).

## Open questions

- **OQ-1** — Learn from workspace chats into the workspace's own `user:` scope, with a review surface
  per workspace? Deferred; needs a UX for per-workspace memory.
- **OQ-2** — ADR 0077 PII classification of candidate facts (ADR 0120 OQ-5). Not implemented.
- **OQ-3** — The per-write audit row and `{runId}` provenance (ADR 0120 §Data model). Not implemented.
- **OQ-4** — A "Memory updated" notice in chat, like the market leaders. It needs a turn-time event;
  filed for UX.

## Implementation record

| Phase | What | Commit / test |
|---|---|---|
| — | Baseline probes, 11/11 red on `70ecf4ff1` | `test/row57-baseline-probe.test.ts` |
| — | Adversarial `/architect` pass on the decision text (before code) | findings below |
| D1–D8 | The rebuilt lane, consent door, extractor, op, tombstones and copy | `a44042633` |
| D1.5, D4 tightening, MAE2CD-2/5, MAE2UX-3/4/6 | Closing `/grade-ux` + `/grade-code` findings in the fix itself | `ddedc44fe` |
| code-review #1–#4, #6 | `lane-error`, `nothing-new`, scrub-before-normalize, opt-out when unavailable, typed spy | `e3368d576` |
| Train-98 fix | `memoryExtractor.ts` classified `PRODUCES` in the fenced-truncation call-site ratchet | `e249249a2` |
| Merge | #5250 | `88db7bfec` |
| Witness | 48 sabotage witnesses, all red (`row57-sabotage.py`); baseline probes 11/11 red → green | `test/row57-baseline-probe.test.ts` + the lane tests |

## Architect findings (2026-10-26, before code)

| # | Severity | Hit | Finding | Resolution |
|---|---|---|---|---|
| A1 | Blocker | D4 | The evidence check passed `"I"` for any invented fact, and quotes could span turns or match the fence | Minimum length plus two words, one turn, and a content word of the fact in the evidence |
| A2 | High | D4/D5 | The timeout never cancelled extraction, so an "abandoned" run still wrote | One `AbortSignal` deadline, checked before repair and each write; `abandoned` outcome |
| A3 | High | D1.3 | A `chatSessionId` stamp alone does not exclude ephemeral panels or API runs | Require the server-side conversation record |
| A4 | High | D6 | A per-fact 409 on a normalized-key collision aborted the batch | Catch `conflict` per fact and count it as a duplicate |
| A5 | High | D6 | The tombstone in `removeSubjectNote` cannot know the source; the re-learn rationale was wrong | Tombstone in the profile-memory route; personal data; erased and torn down |
| A6 | High | Consequences/D7 | Never said the lane would run on 0 of 339 measured closes | Stated; the copy always names the personal workspace |
| A7 | Medium | D1.4 | Legacy split rows fail the spelling check | Also accept a row in the tenant with the canonical `principalId` |
| A8 | Medium | Consequences | The cost was understated | Three point-gets, with fixed check order |
| A9 | Medium | D2 | `resolveCallerUser` can write | Accepted and stated; an `anon:` home gets `available:false` |
| A10 | Low | D6 | The budget race | Counted in the loop; the headroom absorbs it |
| A11 | Low | D3 | Agent turns dropped cost facts | Stated as a trade-off |
| A12 | Low | D4 | The repair contents were unspecified | Specified; evidence rejections are not repaired |

## Residue (filed at close, 2026-10-26)

- `MAE2WF-7` / OQ-3 — no per-write audit row and no `{runId}` provenance on a learned note.
- `MAE2UX-5` — no in-chat "memory saved" signal; needs the OQ-4 turn-time event.
- `MAE2UX-7` — no bulk delete of learned facts.
- `MAE2UX-8` — no sign-in link beside the sign-in reason.
- `MAE2UX-9` — no "nothing learned yet" line after opting in.
- `MAE2CD-6` — a concurrent exact duplicate is counted `written`, not `duplicate`. This affects counts only.
- `MAE2CD-9b` — the two-word evidence rule rejects every CJK or Thai fact, and there is no NFC normalization.
- Relational quotes — "my sister is a nurse in Denver" still supports "Is a nurse in Denver" (D4). Learned notes stay untrusted and reviewable.
- Prod, read-only, at 2026-10-26T15:30Z: 0 grants and 0 eligible closes. The lane has not yet run in production.
