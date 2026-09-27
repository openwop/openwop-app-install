# ADR 0601 — Research Notebooks: the trust boundary, the MCP scope claim, and the delete that destroyed first

Status: implemented

Supersedes nothing. Corrects two decisions taken in **ADR 0084** (the `facet:'notebook'`
discriminator, after that ADR's own correction removed it from the read path) and one in
**ADR 0087** (§3's claim that the MCP write descriptors "carry the `workspace:write`
scope").

## Context

Feature 28 (Research Notebooks) was graded `C+ / D+ / B` with four Blockers on the
codebase axis and six on the UX axis. This ADR records **PR-A: the security half** —
a laundered trust boundary, an authorization bypass, a destructive delete that
reported doing nothing, and the three UX defects that destroy or misattribute the
user's own work. PR-B takes the remaining UX and type-contract rows.

Two properties of this feature made all three security defects possible, and both
are worth naming because they are the reusable lesson, not the individual bugs:

1. **A correction that moved a definition but not its uses.** ADR 0084's correction
   redefined a notebook as *any project with a bound KB collection* and dropped the
   `facet:'notebook'` check from `getNotebook`. Two delete doors kept it. The result
   is not "a stale comment" — it is two doors giving different answers to the same
   question, one of which destroys data.
2. **A boundary drawn in one place and dropped in the adjacent one.** Notebook
   SOURCES are ingested `contentTrust:'untrusted'`, deliberately, with the reason
   written in the code. Notebook NOTES — the same corpus, one click away — were
   written with no provenance at all.

---

## Decisions

### D1 — A note's CONTENT ORIGIN is a required argument, and the rule is one table

`notebooksService.addNote` takes a **required** `origin: NoteContentOrigin`
(`'authored' | 'third-party'`) with **no default**, and maps it through a single
exhaustive table:

```ts
const ORIGIN_TRUST: Record<NoteContentOrigin, 'trusted' | 'untrusted'> = {
  authored: 'trusted',
  'third-party': 'untrusted',
};
```

`Record<NoteContentOrigin, …>` means a new origin cannot be added without the
compiler demanding its trust. A required parameter means the *omission* that shipped
this defect is now a compile error, for the two callers that exist and every future
one.

`AddSubjectNoteOptions` gains `contentTrust`, an axis **orthogonal** to `source`:
`source` answers *who performed the write*, `contentTrust` answers *whether the TEXT
may carry instructions*. They coincide for `'auto-extract'` and diverge for exactly
the case that shipped the bug — a human clicks "save to notes" beside a retrieved
passage, so the ACT is the user's while the WORDS are third-party. Same vocabulary as
`kbService.ingestDocument(..., { contentTrust })`, which the source lane already uses.

**Alternatives weighed.**

- *Tag every note untrusted at the choke* (the assessment's prescription). **Rejected.**
  Untrusted notes are fenced on recall, so a legitimately hand-composed instruction
  ("always answer these in bullet points") stops being an instruction the user wants
  honoured and becomes quoted data. The control test pins this half: an `'authored'`
  note must NOT carry the tag, so "tag everything" cannot pass the suite.
- *Add a third `SubjectNoteSource` member (`'excerpt'`).* **Rejected.** `SubjectNote.source`
  is persisted and projected to the frontend, where `MemoryBrowser.tsx:53` narrows it
  to `'user' | 'auto-extract'`. A third value would reach a UI that silently renders
  no provenance for it — the same absence-is-invisible shape, moved. `contentTrust` is
  already a first-class field on the row.
- *Derive trust server-side by matching the note text against the notebook's source
  documents.* Attractive (trust as a property of the CONTENT, not of the request) but
  rejected as brittle and expensive: exact substring matching over every document on
  every note write, with false negatives on any UI trimming and false positives on a
  user hand-typing a quotation.

### D2 — The HTTP note lane fails CLOSED; the MCP lane has no knob at all

The route maps **only** the exact literal `'authored'` to a trusted note. Absent,
unknown, or hostile ⇒ `'third-party'` ⇒ fenced.

Absent MUST be the untrusted side. A caller that says nothing about provenance is
precisely the caller that shipped this Blocker, and `?? 'authored'` would re-open it
for every client that never learns the field exists.

Accepting the client's word for `'authored'` grants no new capability: the caller
already holds `workspace:write` on that notebook and could type the same bytes into
the composer. The threat closed here is third-party CONTENT reaching the agent
unfenced — not a `workspace:write` holder lying about authorship.

The MCP surface **hard-codes** `'third-party'` and does not read it from `args`. ADR
0087 §73 declares inbound `params.arguments` untrusted, there is no human authorship
anywhere on that lane, and the HITL card approves the ACT without ever showing the
approver the content. Letting the caller name its own trust would hand the attacker
the boundary.

### D3 — One function is BOTH the advertised MCP scope and the enforced one

`requiredScopeForTool(manifest)` in `mcpServerRegistry.ts` is called by
`toolCatalog.toDescriptor` (the claim) **and** by `isToolAllowed` (the enforcement).

The two used to derive their answers independently, which is exactly how they
drifted: the catalog emitted `auth.scopes:['workspace:write']` while the gate checked
non-anonymous + feature toggle and no scope at all. Sharing the function makes drift
structurally impossible rather than merely tested-against.

Ungated tools (the conformance samples: no `mcpRequiresAuth`, no `mcpFeatureToggle`)
return `null` and now advertise `scopes: []` — **no claim** rather than a false one.
`scopes: []` is valid under `schemas/tool-descriptor.schema.json` (no `minItems`), so
this is not a wire-shape change.

Identity resolution deliberately MATCHES the HTTP lane:
`resolveEffectiveAccess(tenantId, { subject: principalId })`. One question, asked the
same way on both doors.

### D4 — Scope enforcement is HOST-level and covers BOTH tiers

`isToolAllowed` is the single choke for `tools/call` (`mcpSemantics`), `tools/list`
(`listToolsForPrincipal`) and `GET /v1/tools/:id` (`toolCatalog`), so one edit covers
all three lanes and all three features that ship MCP tools.

Both tiers are enforced, not just `write`. A scope advertised and unenforced is a
false claim whichever tier it names; the alternative offered by the brief — *stop
advertising it* — would have meant deleting a true statement about the write lane in
order to avoid making a false one about the read lane.

### D5 — The delete doors agree, and the row delete runs FIRST

`deleteNotebook` drops the `p.facet !== 'notebook'` half of its guard.
`projects/routes.ts` keeps its branch but changes its **discriminator** to
`getNotebook(...) !== null` — the same question the notebooks door asks.

Both doors now run the row delete **before** the conversation cascade, and cascade
only if it succeeded.

**Alternative weighed: 404 in the notebooks route instead of dropping the guard.**
Rejected — it moves the disagreement rather than removing it, leaving
`GET /notebooks/:id` → 200 beside `DELETE /notebooks/:id` → 404. Authority is
unchanged either way: both doors already require `workspace:write` on the project,
exactly as `DELETE /projects/:id` does. What still narrows the blast radius is the R3
guard on the *collection*, which is about corpus ownership, not the facet, and is
untouched (control test pins it).

---

## Findings, as taken

| ID | Verdict | Note |
|---|---|---|
| `NBC-2` | **FIXED**, cure rejected | Finding correct. The prescribed "tag notebook notes untrusted" was rejected as over-broad (D1). |
| `NBC-3` | **FIXED**, finding CORRECTED | The escalation is real. Its stated blast radius was wrong — see below. |
| `NBC-1` | **FIXED**, and WIDENED | Reproduced exactly. A third site the report did not name; the report's own cure is a NO-OP for it. |
| `NBU-5` | **FIXED** | Finding correct as stated. |
| `NBU-4` | **FIXED** | Finding correct as stated. |
| `NBU-2` | **FIXED** | Finding correct as stated; fix also closes the `NBU-3` cohort row as a side effect. |

### Falsified: `NBC-3`'s blast radius

> *"notebooks is the **only** feature in the repo shipping `mcpSafetyTier: 'write'`
> (`grep -rn "mcpSafetyTier: 'write'"` → one hit) … so the blast radius is this
> feature's."*

**False.** That grep polices a **spelling**. Two features set the field from a
variable — `mcpSafetyTier: spec.safetyTier` — and are invisible to it. Counted from
the tool specs instead:

| Feature | Write tools |
|---|---|
| notebooks | `notebook-add-source`, `notebook-create-note` |
| commerce (UCP) | `ucp-place-order` |
| app-builder | `app-builder-create-project`, `app-builder-render-design`, `app-builder-resolve-paused-task` |

**Six write tools across three features** — 3× the reported radius. The read tier was
no better: 13 gated read tools advertised `workspace:read` with nothing enforcing it.
The gap was **universal**, not notebooks-specific, so a notebooks-local fix would have
left five write tools open while reporting the class closed.

### Widened: `NBC-1` had a third site, and the prescribed cure is a NO-OP for it

The report named `notebooksService.ts` and `notebooks/routes.ts`. Enumerating
`deleteNotebook`'s callers found a third: **`projects/routes.ts`**, whose `DELETE`
branched `if (project?.facet === 'notebook')` before delegating. For an
ensure-provisioned project that branch is FALSE, so plain `deleteProject` ran and the
exclusive KB collection was left with no owner, no surface and no eraser — the exact
R2 PRJ2-B2 orphaned-corpus defect that branch exists to prevent, still live on the
lane ADR 0084's correction created.

That site matters because the guard there lives **at the caller**. Removing the guard
inside `deleteNotebook` — the report's cure — changes nothing for it. Both had to move
together.

### Recorded, deliberately NOT changed

`projects/routes.ts` `POST /:id/memory` writes `addSubjectNote(..., projectSubject(id))`
— the **same memory scope** notebook notes live in — with no options. It is not part
of the NBC-2 laundering: its text is composed in a project-notes composer, so
`'authored'` is the correct answer and today's default already gives it. Noted because
the two doors share one store, so the notebooks list shows project notes too.

---

## Witnesses and their sabotage

Every assertion below was attacked. Files were restored from a backup copy and
verified by **diffing the file**, never by assuming.

| # | Sabotage | Result |
|---|---|---|
| A | drop the `contentTrust` option at `addNote` | 4 red, control GREEN |
| B | route origin mapping fails OPEN (`?? 'authored'`) | exactly the 2 fail-closed tests red |
| C | MCP surface honours a caller-declared origin | exactly the MCP test red |
| D | restore `p.facet !== 'notebook'` | 4 red (three distinct scenarios) |
| E | restore the original cascade-before-delete ORDER | **GREEN** — see R1 |
| F | remove the `isToolAllowed` scope check | 4 red, both controls green |
| G | write tools downgraded to `workspace:read` | 3 red + the served-descriptor test red |
| H | catalog re-derives its own scope (drift) | **GREEN first** — see below |
| I | delete `setAnswer(null)` | **GREEN first** — see below |
| J | shared note core clears the composer again | exactly the NBU-4 test red |
| K | sources catch stops flagging failure | 3 red |

### Two green sabotages, and what each taught

**H — the catalog-drift probe was measuring a neighbour.** Reverting `toDescriptor`
to its own independent derivation reddened *nothing*. For every **gated** tool the
shared rule and the old hand-rolled `safetyTier` derivation return the SAME answer;
they diverge only on **ungated** tools (`null` → `[]` versus `'workspace:read'`), and
no ungated tool existed in the registry during the test. Fixed by registering one, so
the `null` branch is exercised. H now reddens exactly the parity test. The reasoning
is recorded in both test files so the registration is not later "cleaned up".

**I — the stale-answer probe was catching a different guard.** Deleting
`setAnswer(null)` left the NBU-5 test green, because the `askFailed` StateCard
short-circuits the answer branch and hid the stale hits *for a different reason than
the test named*. The **in-flight window** is the only input that separates the two:
`askFailed` is still null, nothing short-circuits, and the previous question's hits
are on screen iff `answer` was not cleared. Added that case; I now reddens exactly it.

Both are the same shape — *non-vacuous is not the same as meaningful* — and neither
would have been found without attacking the assertion rather than the code.

---

## Residuals

Stated here because a residual that lives only in a report is a defect in the record.

**R1 — the delete ORDERING fix is defense-in-depth, and is NOT independently
witnessed.** Sabotage E (restoring cascade-before-delete) is **GREEN**, and the reason
is understood: once the stale facet guard is removed there is no longer a reachable
path where `deleteNotebook` returns `deleted:false` after `requireNotebook` has
passed, so the ordering defect cannot be reached through the HTTP door and cannot be
witnessed there. What carries the fix is **structure, not coverage** —
`result.deleted ? cascade : 0` makes *"`deleted:false` ⇒ `conversationsDeleted:0`"*
true by construction, so a future re-introduced validation inherits the safe order.
An unwitnessed assertion, stated as unwitnessed.

**R2 — the MCP scope gate is TENANT-wide, not per-org.** A `tools/list` call names no
org, so `resolveEffectiveAccess` is called without `orgId` and falls back to the
caller's first member row. This closes *"a `workspace:read` member writes over MCP"* —
the named escalation — and does **not** close *"a member with write in org A writes a
notebook in org B"*. Closing that needs a per-org gate at the surface, which is
subjectless by design (ADR 0084). The gate must not be read as more than it is; the
limit is written at the function.

**R3 — a principal with no member row now loses every gated MCP tool, read included.**
This is the intended fail-closed posture and it matches the HTTP lane exactly, but it
IS a behaviour change for any deployment whose MCP principal is not a member. The exit
is documented and ordinary: be a member holding the scope. Three existing tests pinned
the weaker behaviour with synthetic member-less principals and were given member rows
so they keep pinning what they intend.

**R4 — `AddSubjectNoteOptions.contentTrust` still defaults to `'trusted'`.** That
default is correct for a person typing their own fact, and is unchanged for the four
other `addSubjectNote` callers, so this PR does not widen their blast radius. It is
safe *only* because the notebooks choke takes a required argument and cannot fall
through to it. A future feature copying third-party text into subject memory must make
the same required-argument choice at its own choke.

**R5 — the note's trust is still invisible in the UI.** `NotebookNote.contentTrust` is
declared in `notebooksClient.ts` and has zero readers; notes render as bare text. The
backend now draws the distinction correctly and the UI still erases it, so a user
cannot see which notes are fenced. `NBC-12` / PR-B.

**R6 — deploy-order window.** Backend deploys before frontend. In that window the live
SPA posts `{text}` with no `origin`, so genuinely hand-authored notes are marked
untrusted until the frontend lands. That is the safe direction and it is temporary,
but it is a real (small) recall degradation and should not surprise anyone reading the
logs.

**R7 — not addressed in this PR** (PR-B / later): `NBC-4` + `NBC-8` (discarded
`runId`, four false empty states, the success-with-nothing-written nodes), `NBC-5`
(inert `topK`), `NBC-6` (MIME guard defeated by `.trim()` one call deeper), `NBC-7`
(deleted sources still grounding the model through stale summaries), `NBC-9`
(`summary`-level sources invisible to Ask), `NBC-11`–`NBC-19`, `NBU-1`, `NBU-6`–
`NBU-18`.

---

## Implementation record

| Decision | Commit | Tests |
|---|---|---|
| D1, D2 | `f6eb572` | `backend/typescript/test/notebooks-note-trust.test.ts` (5) |
| D3, D4 | `56a3dad` | `backend/typescript/test/mcp-tool-scope-enforcement.test.ts` (8) + `notebooks-mcp.test.ts` (+1) |
| D5 | `a931907` | `backend/typescript/test/notebooks-delete-honesty.test.ts` (6) |
| NBU-5/4/2 | `f1d2257` | `frontend/react/src/features/notebooks/__tests__/workspaceFailureStates.test.tsx` (8) |

`workspaceFailureStates.test.tsx` is the **first** test in `features/notebooks/`
(`NBU-15`): 581 lines of ingest, retrieval and note-taking shipped with no frontend
regression net, which is why each of these defects was a one-line change away from
returning with nothing going red.

### Gates

**Run:** backend `tsc --noEmit` (0); backend vitest across the notebooks, projects,
kanban, subject-memory, subject-erasure and MCP/tool-catalog suites; frontend
`npm run build` — the canonical gate, **EXIT=0 unpiped** — including all 26
token/CSS/a11y/i18n checks, `check-notice-announce` (191/191 after the baseline
lowering), `check-test-types` (172, ratchet holds), `design-system-inventory --check`,
and the post-build CSS/bundle/CSP checks; `scripts/__tests__/gates.test.ts` (41);
frontend vitest over notebooks/podcasts/projects/memory (90).

**NOT run, and not claimed:** `npm run ci` (owned by the caller), Playwright e2e, live
testcontainer adapters, the conformance suite, and any live-browser check.

### Not a wire change

Everything here is host-extension (`/v1/host/openwop-app/*`) or host-internal, except
`GET /v1/tools`, where the change is `auth.scopes: []` for ungated tools — permitted
by the existing `tool-descriptor.schema.json` (no `minItems`) and a *narrowing* of a
claim, never a new field. **No RFC required.** ADR 0087 §3's sentence about the write
descriptors carrying `workspace:write` becomes TRUE for the first time with this ADR.

---

## Corrections

Appended, never rewritten — the reasoning trail is the point, and four of these
corrections are about a claim made *above* that a later pass falsified.

An adversarial review of the PR that implemented this ADR returned 13 findings,
three of them HIGH and two of those **regressions this ADR introduced**. Each
finding's prescribed cure was falsified before being applied; three were wrong as
written and are recorded below with the mechanism.

### C1 — R2 rewritten: the gate is a tenant-wide UNION, and its `orgId` residual was only half the story

**R2 as written above documents only the PERMISSIVE direction** ("does not close
*a member with write in org A writes a notebook in org B*") and misses the other
two, which are worse because they bite honest callers:

- **RESTRICTIVE.** With no `orgId`, `resolveEffectiveAccess` returns the FIRST
  matching member row. A subject who is `viewer` in org-A and `editor` in org-B is
  DENIED writes whenever the store hands back org-A — not a widened gate, a wrong
  one.
- **NON-DETERMINISTIC.** Which row comes first is store iteration order, so the
  same principal can get different authority across a restart. An authz gate whose
  answer can flap is not a gate.

The repo already said this was the wrong tool: `resolveSubjectScopesUnion`'s
docblock names this exact shape ("the org-scoped, first-match
`resolveEffectiveAccess({ subject })` is the wrong tool") for exactly this kind of
non-org-scoped surface. R2 should have found that before writing its own residual.

**R2 now reads:** the gate resolves the caller's authority as the **tenant-wide
union** across their org memberships — deterministic, and granting a scope iff the
caller holds it in ANY org. The per-org check belongs **at the surface**, where
the resource names its org; `resolveProjectAccess` already does exactly that for
the notebook tools' backing routes, so the org-B case is closed there and never
was this gate's job.

### C2 — the prescribed union swap was FALSIFIED: it silently kills the demo lane

The review's cure — "`resolveSubjectScopesUnion` is the in-repo precedent, swap
it in" — is right about the shape and wrong as a patch. `resolveSubjectScopesUnion`
carries **no equivalent of the single-principal/demo exception** at
`accessControlService.ts:1271`, which is the branch that gives an unknown subject
OWNER scope in a single-principal tenant under demo mode.

**MEASURED** with demo mode ON, by applying the swap exactly as prescribed: the
anonymous-session lane goes **17 gated tools → 0** — i.e. every anonymous visitor
on `app.openwop.dev` loses every notebook, commerce and app-builder MCP tool.

Taken instead: union first, and fall back to `resolveEffectiveAccess` **only when
the union found no membership at all**. That cannot re-introduce first-match
ambiguity (there are zero rows to be ambiguous between) and it keeps the
"no member row" rules — tenant-owner, and the demo exception — in the ONE place
that owns them, instead of copying a security rule into a second file.

### C3 — R3 is wrong twice, and the transferable lesson is about LANES

R3 above says the new fail-closed posture's exit is "ordinary: be a member holding
the scope". **Both halves of that residual are false.**

**(a) That exit does not exist for the API-key lanes.** `middleware/auth.ts` mints
`bearer:<first 8 chars of the key>` (`:761`) and `apikey:<keyId>` (`:790`).
Neither is an RBAC subject; no member row is ever keyed on one; and the first
changes when the key rotates. Telling an operator to create a member row named
after eight characters of their secret is not an exit — it is an instruction that
cannot be followed and would break on the next rotation if it could.

**(b) The blanket sentence "a principal with no member row now loses every gated
MCP tool" is FALSE IN DEMO MODE.** `accessControlService.ts:1271` grants exactly
that principal OWNER when `demoMode() && isSinglePrincipalTenant(tenantId)`. So
the residual overstated the change on the demo deploy and understated it
everywhere else — and, more importantly, **any witness written without demo mode
explicitly OFF proves nothing at all.**

**The transferable lesson, which is why this correction is long.** R3 saw the same
symptom in THREE test files, diagnosed it as a fixture problem, and "gave them
member rows so they keep pinning what they intend". Three files failing the same
way is not three fixtures; it is a **LANE**. The right move was to ask which
population those fixtures represented — and the answer was "every caller whose
authority is not member-derived", which is four lanes of production traffic. The
tests were the messenger.

**MEASURED on the implementing branch, demo mode OFF, by reverting the scope
block:** 17 gated tools before, **0 after**, for the env-key lane, the `owk_` key
lane, the anonymous-session lane AND the conformance test seam. The review named
two of those four.

**Closed** by resolving authority from **provenance** (`Principal.auth`, stamped
at the boundary that verified the credential) rather than by pattern-matching the
id string — see C4.

### C4 — how a credential principal's authority is resolved, and the escalation the obvious answer creates

`Principal` gains an optional `auth` discriminant, stamped at the six mint sites
in `middleware/auth.ts` plus the `routes/mcp.ts` conformance seam. It records HOW
the caller authenticated, because `principalId` is an IDENTITY and authority is a
different question:

| `auth.kind` | Minted for | Authority |
|---|---|---|
| `subject` | cookie session bound to a user, OIDC bearer | tenant-wide member union |
| `anon` | anonymous cookie session | member union → the no-member rules (demo/tenant-owner) |
| `env-key` | `OPENWOP_API_KEYS` entry (ADR 0561) | the tenant's own principal, in the tenant the config pinned it to |
| `api-key` | ADR 0270 `owk_` key | its ISSUER's authority, narrowed by the key's declared scopes |
| `test-seam` | `OPENWOP_TEST_SEAM_ENABLED` | none |
| *(absent)* | minted outside the auth boundary | resolved as a subject — fail-closed |

**The `api-key` row is the load-bearing one, and the obvious alternative is a
privilege escalation.** "A protocol-authenticated principal carries its own
authority" reads naturally as *an API key acts as its tenant*. It must not:
`POST /developer-keys` is gated on `requirePrincipal` **alone**, so ANY
authenticated member — including a `viewer` — can mint a key for their tenant. Had
an unscoped key been granted the tenant's authority, that viewer would have
written over MCP through a key they issued themselves, **re-opening the exact
escalation `NBC-3` closed, through a side door**. A key is a DELEGATION, so its
authority is `ApiKeyRecord.createdBy`'s — a real subject, stable across rotation.

An empty `scopes[]` means *undeclared*, not *none*: every key issued before this
ADR carries `[]`, and the only other reader of that field is the entities
surface's own grammar (`features/entities/routes.ts`). A key that DOES declare
scopes is narrowed to them (ADR 0270: "a key can't exceed its scopes") — strictly
tighter than today, never looser.

**Not widened, deliberately:** a `*`-scoped env key is still denied every gated
tool by `isAnonymousPrincipal` (pre-existing ADR 0087 posture). That diverges from
`requireProtocolScope`, which treats a wildcard bearer as a trusted operator.
Recorded, not changed — widening a security population is not a fix.

### C5 — R1 is understated: the ordering fix is what makes the RACE safe, not defense-in-depth

R1 above says the ordering fix "is NOT independently witnessed" and is carried by
"structure, not coverage", on the reasoning that once the stale facet guard is
gone there is no reachable path where `deleteNotebook` returns `deleted:false`
after `requireNotebook` passed.

That holds **branch-wise and not otherwise.** Both doors **re-read the project
between the guard and the delete** (`requireNotebook` → `getNotebook`, then
`deleteNotebook` → `getProject`), so a CONCURRENT delete in that window still
yields `deleted:false` after the guard passed. The ordering fix is therefore not
optional hardening — it is what stops that race from destroying a conversation
under a project whose row is already gone and then reporting that nothing
happened. R1's "unwitnessed and unnecessary" framing should have been
"unwitnessed **through the ordinary door**, and load-bearing for the race".

It is now witnessed. `notebooks-delete-cascade-reachability.test.ts` makes the
race deterministic by letting a "peer" (`deleteProject`) win it, so the
`deleted:false` under test is produced by the shipped `deleteNotebook` against a
genuinely absent row rather than fabricated.

### C6 — MEDIUM-6: the `result.deleted ? cascade : 0` GATE was the defect the reorder created

D5 above says the doors "cascade only if it succeeded". **That gate is removed.**
`deleted:false` is exactly the race in C5, and gating on it made the conversation
cascade unreachable in the one branch that needs it — the `WF-PRJ-1` shape the
reorder was added to close, re-entering by the door the fix installed. It also
retired the stranded-meta self-heal documented at `conversationCascade.ts:34`
(which cleans a meta left by an EARLIER partial delete) by leaving it with no
caller at all.

The invariant was never "the number must be zero"; it is **"the body reports what
actually happened"**. `{deleted:false, conversationsDeleted:1}` after a peer
removed the row is a true statement — the original NBC-1 defect was the opposite,
a body claiming nothing was destroyed while a conversation had just been
irrecoverably destroyed.

**CHECKED, because the review did not:** removing the gate cannot cascade a
stranger's conversation — both routes 404 at their authorization guard before this
code runs, so the id was authorized and its conversation id is derived from it.
The pre-PR behaviour on both doors was already unconditional, so this restores it
rather than inventing a posture.

### C7 — HIGH-1: widening the delete widened the ERASER, and the guard that "narrows the blast radius" was a heuristic

D5's closing sentence above — *"what still narrows the blast radius is the R3
guard on the collection, which is about corpus ownership"* — is **false**, and the
same false claim was written into `notebooksService.ts` as a code comment.

Dropping `p.facet !== 'notebook'` widened the delete's population from "projects
created via `POST /notebooks`" to "every project with any bound KB collection".
That is correct for the DELETE. It also widened the **corpus eraser's** population
in the same stroke, to include Knowledge-tab bindings that ADR 0084 says may be
**SHARED** — and the last thing standing between a shared corpus and deletion was
`col.name.startsWith('Notebook: ' | 'Sources: ')`, a prefix test on a name the
USER chooses and can edit. `Sources: Q3 research` is not an unusual name for a
shared team corpus. **PROVED:** shared collection 200 → 404, and a second
project's knowledge list → `[]`.

The control test that was supposed to defend this picked the name
`Company handbook`, which **dodges the prefix** — so it proved the guard fired,
not that it discriminated.

**Taken:** the eraser deletes only what `notebookCollectionId` names — provenance,
stamped at the two sites that MINT a corpus exclusively for a project, the same
principle `NBC-2` used (a required `origin`, not a guess). **VERIFIED before
committing, because the trade depends on it:** both live provisioning lanes
(`createNotebook`, `ensureNotebookForProject`) stamp, so only rows predating the
stamp lose auto-cleanup. That trade is deliberate and asymmetric — an orphaned
collection is listed, readable and deletable by hand; a destroyed shared corpus is
none of those. **Irreversibility decides it.**

`projects-r3-residuals.test.ts` PINNED the removed fallback. It is rewritten, not
deleted: it now asserts an unstamped collection is never erased HOWEVER it is
named, with two cases differing only in a string — which is the whole argument.

### C8 — HIGH-2: the consent dialog asked a different question from the eraser

`ProjectDetailPage.tsx` branched the delete confirm on `facet === 'notebook'`.
`ensureNotebookForProject` — what opening the Sources tab calls — never stamps
`facet`, so **the entire ensure-provisioned population got no corpus warning** and
learned its sources were destroyed from the **success toast**
(`deleteReceiptCorpus`). Irreversible destruction disclosed after the fact: this
ADR's own defect family, relocated to the consent layer.

Both sides now read ONE exported predicate, `notebookCorpusToDelete`. The
projection serves `deletesCorpus` from it; the client reads that instead of
re-deriving. **The review's hot-path concern was falsified:** the predicate is a
FIELD on the row `getProject` already returned, so there is no computation and no
extra read — on the detail route or the list — and
`projects-list-scan-costs.test.ts` is untouched.

### C9 — a THIRD green sabotage, alongside the two already recorded

The "Two green sabotages" section above should read **three**.

**MEDIUM-7 — the "ADVERT ≡ ENFORCEMENT" test never touched the advert.** It
compared `requiredScopeForTool(t)` against `Boolean(t.mcpRequiresAuth || …)` —
i.e. it restated that function's own first line. Sabotage H (`toDescriptor`
re-derives its own scope, the exact drift the test's NAME promises to catch)
reddened the real witness in `notebooks-mcp.test.ts` and left this one **green
through 20 consecutive passes**. A decorative test carrying that name is worse
than no test: it will be cited as coverage that does not exist.

Rewritten to read the ADVERT (`toolCatalog.toDescriptor`, now exported for this)
and assert a BEHAVIOURAL consequence — whatever a descriptor claims the gate
honours, whatever it claims nothing for the gate lets through — never touching
`requiredScopeForTool` at all. Sabotage H now reddens it precisely, on the ungated
branch.

**And a fourth, found in this pass's OWN work.** The first draft of the
determinism witness (C1) seeded `viewer` in org-A and `editor` in org-B, which is
the finding's own wording. `editor`'s scopes are a strict SUPERSET of `viewer`'s,
so a first-match resolver landing on `editor` returns the union's answer by
accident — the witness was at the mercy of the iteration order it was testing, and
sabotaging the resolver back to first-match left the whole file green. Rewritten
with two DISJOINT custom roles (read-only in org-A, write-only in org-B) so no
single row can satisfy both assertions, whichever the store returns first.

### C10 — sabotage D is ONE instrument catching several CONSEQUENCES of one defect

The witness table above counts sabotage D as "4 red (three distinct scenarios)".
That over-counts. Both delete doors, the corpus outcome and the response body all
derive from **one** guard (`p.facet !== 'notebook'` and its caller-side twin), so
restoring it reddens four assertions about a single defect — not four independent
witnesses. Read the table's counts as *assertions reddened*, never as
*independent instruments*.

### C11 — the `mcpSafetyTier` blast-radius correction, restated as a method note

The "Falsified: `NBC-3`'s blast radius" section above is correct and its root
cause deserves naming plainly: the original "only feature" claim was a
**spelling-grep artifact**. `grep -rn "mcpSafetyTier: 'write'"` matches only
notebooks; app-builder and commerce set the field from a variable
(`mcpSafetyTier: spec.safetyTier`) and are invisible to it. Enumerate a class over
the DELIVERY FUNCTION'S INPUTS — here, the live registry — not over a literal.
`mcp-tool-scope-enforcement.test.ts`'s ratchet does exactly that.

### C12 — deferred to PR-B, recorded so it is not double-counted

- **LOW-13** — 5 orphan i18n keys × 4 locales = 20 dead strings, all
  **pre-existing**. PR-B already owns a dead-locale-string sweep; these overlap
  it. Left in place deliberately so PR-B's count is not inflated by keys this PR
  would otherwise have removed from under it.
- **LOW-11** — simultaneous panel failures announce only one. Informational;
  `StateCard` endorses last-wins, so there is no defect to close.

---

## Residuals, added by the corrections pass

**R8 — a cascade that THROWS still strands its conversation.** If
`deleteConversationCompletely` throws after the row delete, the request 500s and
there is no retry path: the row is gone, so the door 404s. **Removing the gate
(C6) does not fix this**, contrary to the finding's framing — the gate was about
REACHABILITY in the `deleted:false` branch, and this is about failure mid-cascade.
Closing it needs a durable dead-letter / retry for the cascade, not a reordering.
Not attempted here.

**R9 — legacy notebook corpora lose auto-cleanup.** Consequence of C7, stated as a
cost rather than buried: a notebook whose corpus predates the `notebookCollectionId`
stamp leaves an orphaned KB collection on delete. Both LIVE provisioning lanes
stamp (verified, and pinned by a test), so this is bounded to rows created before
this ADR. `collectionDeleted:false` reports it honestly.

**R10 — `Principal.auth` is OPTIONAL, so an unstamped principal fails closed.** A
principal minted outside `middleware/auth.ts` / `routes/mcp.ts` resolves as a bare
subject and, absent a member row, gets nothing. That is the safe direction, but it
means a NEW credential lane must remember to stamp itself or it will go dark. The
lane table in `mcp-tool-authority-lanes.test.ts` is the tripwire: it enumerates the
mint sites by call graph, so a new one added without a stamp shows up as a missing
row rather than as a production outage.

**R11 — the wildcard divergence stands.** `isAnonymousPrincipal` denies a
`*`-tenant principal every gated tool; `requireProtocolScope` treats the same
principal as a trusted full-access operator. Two host surfaces, two answers about
one credential. Pre-existing (ADR 0087), not touched here because closing it means
choosing which surface is wrong, and that is a decision, not a fix.

---

## Implementation record — corrections pass

| Correction | Commit | Witness |
|---|---|---|
| C1–C4, C9 (MEDIUM-7), C11 | `fix(mcp): the scope gate went dark …` | `test/mcp-tool-authority-lanes.test.ts` (8) + `mcp-tool-scope-enforcement.test.ts` (rewritten parity) |
| C7, C8 | `fix(notebooks): the corpus eraser guessed from a name …` | `notebooks-delete-honesty.test.ts` (+parity), `projects-r3-residuals.test.ts` (rewritten), `deleteReceipt.test.tsx` (+3) |
| C5, C6 | `fix(notebooks): the cascade gate made the conversation cleanup unreachable …` | `test/notebooks-delete-cascade-reachability.test.ts` (3) |
| LOW-12 | `test(notebooks): the one trust case without a non-vacuity floor …` | `notebooks-note-trust.test.ts` (floor added) |
| LOW-9, LOW-10 | `fix(notebooks): a failed Ask announced twice …` | `workspaceFailureStates.test.tsx` (+5) |

### Sabotage results, corrections pass

| # | Sabotage | Result |
|---|---|---|
| L1 | api-key authority resolved by `principalId` (the shipped defect) | 3 red |
| L2 | unscoped api-key granted TENANT authority (the escalation) | exactly the escalation guard red |
| L3 | a key's DECLARED scopes ignored | exactly the narrowing test red |
| L4 | union-only, no no-member fallback (the prescribed cure) | exactly the demo-lane witness red |
| L5 | first-match resolver (the MEDIUM-4 defect) | **GREEN first** — see C9; red after the disjoint-roles rewrite |
| L6 | per-tool authority resolution (MEDIUM-5) | exactly the fan-out test red |
| H′ | `toDescriptor` re-derives its own scope | exactly the rewritten parity test red (was GREEN before the rewrite) |
| D2 | restore the name-prefix eraser fallback | the rewritten shared-corpus control + the parity test red |
| M | the projection re-derives consent as `facet === 'notebook'` | parity test red on the ensure lane |
| N | the confirm dialog reverts to `facet === 'notebook'` | 3 frontend tests red |
| O | restore the `out.deleted` cascade gate | both race tests red, control green |
| P | recall rows stop being written | 5 red WITH the LOW-12 floor; 4 red + **1 GREEN** without it |
| Q | restore the Ask toast | exactly the single-channel test red, write-lane control green |
| R | retry buttons lose their busy state | 2 red |

Every restore was verified by **diffing the file against its backup**, not by
assuming.
