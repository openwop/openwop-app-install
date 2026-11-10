# ADR 1034 — Sales ops: money and gate integrity (territories, sales-commissions, dealers, sales-maps)

Status: implemented (2026-11-03, feature loop row 75; user decisions D1–D3 via the row-75 lead; architect round 1 folded in)

Refines ADR 0272 (territories), ADR 0280 (sales commissions), ADR 0281 (dealers + PRM) and
ADR 0282 (sales maps). No new feature package, no new toggle, no wire change.

## Context

Feature loop round 2, row 75, graded the four packages as a unit
(`docs/steward/workflows-assessment/2026-11-03-sales-ops-row75.md`, baseline **C**).
Production holds only seeded rows from 2026-07-09 (2 tenants) and **0 runs** in 180 days,
so every defect below is latent. That also means a data shape can change now without a
production migration, except where this ADR says otherwise (the 8 partner tokens).

The defects that set the grade, each verified in code at `0a3da6141`:

1. **Two governed writes skip the review gate from a workflow.** The
   `dealers.approve-registration` and `territories.activate-model` nodes call the feature
   service directly (`dealers/surface.ts:46`, `territories/surface.ts:61`), recording
   `run:<runId>` as the decider. The HTTP routes for both only queue a review. The
   commissions surface already closed this exact hole (R2 COM2-M3,
   `sales-commissions/surface.ts:77`).
2. **`set-quota` erases rep splits.** The node contract describes a `repSplits` input that
   neither `index.mjs:94` nor `surface.ts:77` forwards, so `setQuota` rewrites `[]`.
3. ~~**Write nodes re-execute on `:fork`.**~~ Withdrawn: false premise (see D3).
4. **One deal can pay twice.** `YYYY-MM` and `YYYY-Qn` statements of one plan both include
   it (`statement.ts:67`, `:80`). ADR 0280 §8's "one active plan per assignment" is enforced
   nowhere (`plan.ts:149`).
5. **A rep can move their own accelerator.** Quotas and splits on the ACTIVE model are
   writable at `workspace:write` (`territories/routes.ts:268`, `quota.ts:58`). Attainment is
   read live at compute, and the approval card pins only `{total, currency}`
   (`statementApproval.ts:78`).
6. **Recompute can overwrite an approval.** `computeStatement` and `recordStatementSubmitter`
   use read-then-`put` (`statement.ts:283`, `:407`).
7. **Money is float math.** Lines are computed in major-unit floats and rounded with
   `quantizeMajor` (`Math.round(x*f)/f`, `host/currencyUnits.ts:80`), so a half-minor-unit
   case misrounds (`1.005 → 1.00`), and a capped rule's rounded lines can sum past the cap.
8. **Self-approval and self-pay compare raw ids** (`statementApproval.ts:96`,
   `statement.ts:341`). A deal `owner` stored under another spelling of the decider escapes
   both (the row-4/row-5 two-spellings trap).
9. **Erasure can overwrite a payout record.** Re-keying an erased rep's statement to
   `planId:<ERASED_USER_REF>:period` collides when two erased reps share a plan and period
   (`statement.ts:390`).
10. **Partner tokens are plaintext at rest, never expire, cannot be revoked, keep working for
    a suspended dealer, and are minted at `workspace:write`** (`registration.ts:66-88`,
    `dealers/routes.ts:126`, `:196`, `:213`).
11. **Any reader sees every rep's plan** (rates, caps, the assigned rep id;
    `sales-commissions/routes.ts:60`, agent tool `list-plans`), while statements are
    filtered to the rep.
12. **Two agent tools hand-roll the org read check** (`territories/agentTools.ts:70`,
    `sales-commissions/agentTools.ts:58`) instead of the shared `resolveReadOrgScope`
    (`host/agentToolKit.ts:115`) the dealers tools use. The CLAUDE.md rule is one helper.
13. **The geocode cache key is not length-prefixed** (`${tenantId}:${orgId}:${addr}`, and
    tenant ids contain `:`), and the manual write path does not check that an existing row
    belongs to the caller (`sales-maps/entities/geocode.ts:43`, `:69`).

## Boundaries audit

- **No new store, route prefix, toggle or pack.** Every change lands in an existing module.
  One new DurableCollection is added: `commissions:deal-claim` (D4). Its name was grepped
  across `backend/typescript/src` and is unused.
- **Approval kinds reused, not added.** `dealer-registration` and
  `territory-model-transition` already exist with decide handlers
  (`dealers/registrationApproval.ts`, `territories/modelTransitionApproval.ts`).
- **Shared seams are called, not changed.** `resolveReadOrgScope`, `subjectKeyForms`,
  `currencyExponent`, the approval queue and `DurableCollection.compareAndSwap` are used as
  they are. The ADR 0447 obligation ledger is **not touched** (see D10).
- **Wire:** none. All routes are host extensions under `/v1/host/openwop-app/*`. Node
  `role` is a pack-manifest field this host already honours, not a protocol change.
  **RFC verdict: host-ext, no RFC.**

## Decision

> **Architect round 1 (2026-11-03, independent agent) found 4 Blockers and 8 Highs in the
> first draft of this section. All are folded in below; the corrections are listed at the
> end of the ADR so the reasoning trail survives.**

### D1 — Workflow writes go through the human gate (SO75WF-1, -2)

Both surfaces copy the commissions precedent (`sales-commissions/surface.ts:77-115`) exactly:
a non-pending subject is a `409`; success returns
`{ success: true, submittedForReview: true, review: { approvalId, status } }`; the node turns
a missing `review.approvalId` into `invalid_response` (as
`feature.sales-commissions.nodes/index.mjs:73-76` does).

- **Dealers.** `approveRegistration` no longer decides. It finds the registration's
  `dealer-registration` card or creates it, **without reopening** a resolved card. A resolved
  card means a decision is in flight or done, so the surface returns that card's status. The
  reopen repair stays in the admin-list repair only (`registration.ts:143`), because reopening
  from a workflow can race a manager's decide between its CAS and its apply.
- **Territories.** `activateModel` no longer activates. It runs the route's checks (404/IDOR,
  archived refusal) and queues the `territory-model-transition` card. A pending card is reused
  only when its `transition === 'activate'`; a pending archive card for the same model is a
  `409`. The card id becomes deterministic, `appr:terrtx:${modelId}:${transition}`, created
  get-then-put like the dealers card (`approvalService.ts:2657-2671`), so concurrent retries
  cannot mint two cards. The HTTP route (`territories/routes.ts:133`) takes the same reuse rule.
- Node outputs, pack descriptions and surface docblocks drop the
  "author a `core.approvalGate` before the node" convention. `run:<id>` is never again
  written as a decider. Tests that change: `test/dealers-surface.test.ts:81`,
  `test/territories-surface-writes.test.ts:81`.

### D2 — `set-quota` forwards splits, and omission preserves them (SO75WF-3)

The node forwards `repSplits` when supplied, including `[]` (an explicit clear). When the
caller omits it, the surface carries the stored splits forward by a CAS read-modify-write
on the quota row. The HTTP route keeps its replace semantics. The node contract text says
"omit to keep the stored splits; pass [] to clear". `test/fixtures/pack-surface-arg-parity.json`
pins `index.mjs` by line and is regenerated.

### D3 — Replay role: no change needed (SO75WF-7 withdrawn)

The first draft claimed the write nodes re-execute on `:fork`. **False.** All five are in the
generated floor and the fast-path served set (`executor/sideEffectFloor.generated.ts:363,
405-6, 411-12` and `:712, 753-4, 759-60`; `docs/steward/SERVED-SET-BASELINE.json`), because
the generator takes `role:"side-effect"` **or** the `side-effectful` capability, which they
all declare. A `:fork` already serves their recorded outcome. Packs are still minor-bumped
for the D1/D2 contract changes; the floor and served set are regenerated and must not
change.

### D4 — A deal pays at most once per plan (SO75WF-4; user decision D1(b))

- **Deal claims.** A new collection `commissions:deal-claim`, keyed
  `` `dc1|${planId.length}|${planId}|${dealId}` `` *(corrected by grade-code B1: the first text
  said `${planId}\u0000${dealId}`, and Postgres TEXT cannot store a NUL byte, so every approval
  would have failed on Cloud SQL while the SQLite/in-memory test lanes passed)*, value `{ tenantId, orgId, planId, dealId, statementId }`,
  with a `tenantOf` indexer so tenant teardown and the tenant index cover it.
- **The one choke point is `approveStatement`.** It takes the row the caller checked
  (`expected`) and does, in order:
  1. **Legacy check.** Scan the plan's approved/paid statements (tenant-indexed list) for any
     line with one of `expected`'s deals. Seeded production rows predate claims, so this
     is what makes "at most once" true on day one.
  2. **Claim.** Insert-if-absent each deal claim (`compareAndSwap(null, claim)`). A claim
     already held by this statement is a no-op, so a retry is idempotent.
  3. **Flip.** `compareAndSwap(expected, approved)`.
  4. **On any failure** after step 2, release only the claims this attempt inserted, with
     `compareAndDelete(claim)`, and only after re-reading the statement and confirming it is
     not `approved`. Releasing someone else's claim is impossible because the CAS compares
     the whole claim row.
  The seeder (`host/demoSalesCommissionsSeed.ts:103`) reaches the same function, so it
  claims too; `clearDemoCommissions` deletes the plan's claims.
- **The decide handler approves exactly what was pin-checked.** It reads `live`, checks the
  pin, then runs a **pre-check** of steps 1–2's conflict condition (read-only) BEFORE the
  approval CAS. A conflict resolves the card as **rejected** ("Superseded: N deals were
  already paid on another statement of this plan; recompute") and returns `409
  deal_already_committed`. The card is never reopened on this error, so no dead-end card.
  After the approval CAS it calls `approveStatement(…, expected: live)`. A lost race there
  (a recompute, or a claim taken in the gap) takes the existing compensation path: reopen,
  and the next attempt's pre-check rejects it cleanly.
- **At compute,** deals that are claimed, or present on an approved/paid statement of the
  same plan, are left off the draft and listed in `excludedDeals` (`dealId` + period of the
  statement that paid it), so the draft a reviewer sees matches what can be approved.
- **Claims are permanent once taken.** There is no `approved → draft` path, and plan delete
  is refused while a non-draft statement exists (COMM-DATA-1).
- **Plan overlap.** `createPlan` refuses, and `updatePlan` refuses **when it changes the
  assignment or the window**, a plan whose `kind` + `ref` equal another plan's in the org and
  whose window overlaps (`409 plan_window_overlap`). An open `effectiveTo` overlaps everything
  after `effectiveFrom`. Plans with different assignments may stack.
- **Stacking on the card.** The proposal text names any OTHER plan with an approved/paid
  statement over one of this statement's deals, **by plan name and period only**. No other
  rep's id (statement ids embed the subject) reaches this card or the 409 details.

### D5 — Active-model writes that feed attainment are manager writes; the pin covers what drives the money (SO75WF-5; D2)

- On the org's **active** model, every write that feeds `repAttainmentPct`
  (`statement.ts:131-165`) requires `host:territories:manage`: quota set/delete (route +
  surface), territory create and re-parent (`territories/routes.ts:178`, `:188`), and rule
  create/delete (`:209`, `:220`). Planning models keep `workspace:write`.
- The commission pin grows from `{ total, currency }` to
  `{ total, currency, attainmentPct, lineDigest }`. `lineDigest` is sha256 over the canonical
  `(dealId, dealAmountMinor, rateMicros, commissionMinor)` lines. The re-pin rule exists twice
  today (`routes.ts:28-35` `repinOrKeep`, `surface.ts:102-106` inline); it becomes ONE exported
  helper that compares the whole pin. The decide handler compares the whole pin.
- An old-shape pin (no `lineDigest`) is stale: `409`, re-submit. Production has 0 pending
  commission cards. Every reader of `PendingApproval.commissionStatement` (the type in
  `approvalService.ts`, the review projection, the redactor and the frontend card) is
  updated to tolerate the added optional fields.
- The proposal text states the attainment and each distinct rate.

### D6 — Recompute and the submitter stamp are CAS (SO75WF-6)

`computeStatement` writes with `compareAndSwap(existing ?? null, next)`. A lost CAS is a `409`
("this statement changed while it was being recomputed"). The approved/paid refusal is checked
against the same `existing` the CAS compares, so an approval landing in between fails the CAS.
`submittedBy` is carried across a recompute. `recordStatementSubmitter` is a CAS that retries
once.

### D7 — Commission money is computed in integer minor units

- **No float multiplication anywhere on the path.** A major-unit number converts to a
  `BigInt` of minor units by parsing its **decimal string**: `String(n)`, or `n.toFixed(20)`
  when `String(n)` is in exponent form; `|n| ≥ 1e21` is a `validation_error`. Measured:
  `Math.round(1.005 * 100) === 100`, so the old conversion itself misrounds.
- Rates convert the same way to `rateMicros` (`rate × 10^6`, exact, from the string).
- A `percentage` line is `roundHalfAwayFromZero(dealMinor × rateMicros / 10^8)` in `BigInt`.
  A `fixed` line is the rate's minor value. A won deal with a NEGATIVE amount is refused
  with a typed `validation_error` naming the deals: a credit is a clawback, and clawback is
  deferred (ADR 0280 §8), so a negative line would be an unreviewed partial clawback.
  *(Corrected during implementation: the first text allowed negatives, which made the cap
  allocation's sign handling ambiguous.)*
- A cap is converted once. When a rule's positive total exceeds it, the cap is allocated by
  **largest remainder**, so the lines sum to the cap exactly.
- The row gains `totalMinor` and per-line `commissionMinor`/`dealAmountMinor` (JSON numbers;
  a value outside `Number.isSafeInteger` is refused). The major
  `total`/`commission`/`dealAmount` stay, derived by `minorToMajor`, so readers do not change.
  `quantizeMajor` leaves the commission path.
- Witnesses, red on the old code: a `1.005` deal amount; a half-minor-unit commission; a
  capped three-way split whose rounded lines exceeded the cap; a JPY (exponent 0) and a KWD
  (exponent 3) plan.

### D8 — Identity and erasure correctness

- Self-approval (`statementApproval.ts:96`), self-pay (`statement.ts:341`) and the
  non-manager statement filter use `subjectKeyForms(actor).forms.has(subjectId)`.
- Erasure re-keys an erased rep's statement to a UNIQUE id
  (`planId:<ERASED_USER_REF>~<random>:period`; no caller re-derives a statement id after
  erasure — `closePendingCommissionStatementApprovals` matches on the `planId:` prefix and
  still works). Order: put-if-absent the new row, then `compareAndDelete` the old one. Deal
  claims and every card's `commissionStatement.statementId` (pending and resolved) are
  re-pointed. The non-erased branch's blind `put` (`statement.ts:401`) becomes a CAS.

### D9 — Partner tokens (user decision D3)

- **Where the hash lives.** `PartnerToken.token` stores `ptokh:<sha256hex(raw)>`. The key
  function `(t) => t.token` is unchanged, so one collection handle serves both the new rows
  and the sweep. Mint returns `{ raw, row }`; the route builds the portal URL from `raw`, once.
  Lookup hashes the presented token. A legacy row is recognised by its `ptoken:` prefix.
- **Legacy rows (8 in production) are re-keyed eagerly** by an `APP_MIGRATIONS` entry
  (`host/appMigrations.ts`; its contract is idempotent and concurrency-safe, witnessed by
  `app-migration-idempotence.test.ts`). Per row: `putIfAbsent(hashed row)`, then
  `compareAndDelete(legacy row)`. Two instances converge: the loser's `putIfAbsent` is false
  and its `compareAndDelete` finds the row gone. Existing links keep working, because the
  link carries the raw token and lookup hashes it.
- **Expiry:** `expiresAt = mint time + 180 days`. Legacy rows take `createdAt + 180 days`
  when `createdAt` parses, otherwise the migration's run time + 180 days (the row validator
  does not require `createdAt`). Expired is the same uniform 404.
- **Revoke:** `DELETE …/dealers/:dealerId/portal-token` (`host:dealers:manage`). Minting moves
  from `workspace:write` to `host:dealers:manage`.
- **Suspended dealers:** both public partner routes return the uniform 404 when
  `dealer.status !== 'active'`.

### D10 — Filed, not built: commissions on the obligation ledger (ADR 0447)

`paid` stays a status flag with `paidBy` and `paidAt`; the host moves no money (ADR 0280 §8).
The ADR 0447 ledger has no sales-commission obligation kind, and its "paid only on attested
external evidence" rule needs an evidence field that only a payout rail can supply. Adding
either changes a shared seam, so it needs its own ADR and PR. Filed as `SO75CD-LEDGER`.

### D11 — Smaller corrections

- **Plan visibility:** without `host:commissions:manage`, a reader sees role and territory
  plans plus the rep plans assigned to them (`subjectKeyForms`). One helper serves the route
  and the `list-plans` agent tool.
- **Agent tools:** territories and commissions tools call `resolveReadOrgScope`.
- **Geocode:** the key function stays `(g) => g.cacheKey`; the key VALUE becomes
  length-prefixed. *(Corrected at implementation: the shipped form is
  `g1|<len>|<tenantId>|<len>|<orgId>|<address>`; the `g1|` prefix lets the migration tell new
  rows from legacy ones.)* The
  manual path refuses to overwrite a row whose `tenantId`/`orgId` differ. The 15 production
  rows are re-keyed by a second `APP_MIGRATIONS` entry, the D9 shape. The header comment that
  describes a provider call is corrected (a miss is a 503).
- **ADR 0280 §8** gets a correction note: compute never emits negative clawback lines.
- **Frontend honesty:** the commissions, dealers and territories pages hide the controls the
  server refuses (submit/approve paths for non-managers, mark-paid on your own statement,
  issue/revoke portal link, active-model quota/hierarchy/rule edits). Where a list route does
  not already return the caller's manage capability, it adds `canManage` (host-ext field).

## Alternatives weighed

- **D4 by scan instead of claims:** scan approved and paid statements of the plan for
  overlapping deals at approval. Rejected: two concurrent approvals both pass the scan. A
  per-(plan, deal) insert-if-absent is the CAS this decision needs.
- **D4(a), one payout per deal across all plans:** rejected by the user (it forbids base
  plus SPIFF stacking).
- **D9 lazy re-key on first use:** rejected by the user. Plaintext would stay at rest
  until a partner happened to use the link.
- **D5 freeze attainment only, keep the quota writable by reps:** rejected. The reviewer
  would see the manipulated figure without knowing it was manipulated.

## Phased plan (one PR)

| Phase | Scope |
|---|---|
| P1 | D1, D2 (surfaces, node packs, version bumps, steward manifest; D3 regenerates and must not change) |
| P2 | D6, D7, D8 (statement entity, decide handler) |
| P3 | D4, D5 (claims, plan overlap, pin, quota scope) |
| P4 | D9 (partner tokens, boot sweep, revoke route) — split into its own PR first if the total passes ~2,000 changed lines |
| P5 | D11 (plan visibility, agent tools, geocode, frontend gating, ADR 0280 note) |

Every new guard gets a sabotage-witnessed test (red with the guard removed).

## Evaluation matrix

| # | Dimension | Answer |
|---|---|---|
| 1 | Feature-package | unchanged packages; no core route or nav edits |
| 2 | Toggle | unchanged ids (`territories`, `sales-commissions`, `dealers`, `sales-maps`), all OFF by default |
| 3 | `ctx.<feature>` | D1, D2 change three surface methods' effect; replay role already served (D3) |
| 4 | Node packs | 2 packs minor-bumped (D1/D2 output and contract text) |
| 5 | AI chat | no envelope; agent tools read-only, unchanged allowlists |
| 6 | Agent packs | unchanged; `list-plans` output narrows per D11 |
| 7 | Public surface | partner routes harden (D9); no new public path |
| 8 | RBAC | D5 (active quota → manage), D9 (mint/revoke → manage), D8 (canonical self checks), D11 (plan visibility) |
| 9 | Replay | write nodes already served on `:fork`; D4 claims idempotent per statement; D6 CAS |
| 10 | Frontend | D11 control gating; 4-locale strings for new copy |

## Open questions

- [ ] Should `deal_already_committed` at compute be a refusal rather than an exclusion?
      Exclusion was chosen so a monthly draft still computes after the quarter is approved.
- [ ] D10 ledger ADR: owner and timing are the release manager's call.

## Corrections from the architect pass (round 1, 2026-11-03)

| # | First draft said | Why it was wrong | Now |
|---|---|---|---|
| B1 | write nodes re-execute on `:fork`; move them to `role:"side-effect"` | they are already served via `side-effectful` (`sideEffectFloor.generated.ts`) | D3 withdrawn |
| B2 | claim deals in the decide handler | the seeder reaches `approved` without it, and seeded paid rows have no claims | claim in `approveStatement` + legacy scan |
| B3 | (silent) | the handler pin-checked one row and `approveStatement` re-read another | `approveStatement(…, expected)` |
| B4 | refuse a claimed deal with 409 and reopen | a card that can never pass is the COM2-M5 dead end | pre-check before the approval CAS; resolve as rejected |
| H1 | non-pending returns status, no card | broke the commissions precedent and its node contract | 409 + the precedent's output shape |
| H2 | reuse `queueRegistrationApproval` | it reopens resolved cards, racing a decide | find-or-create without reopen |
| H3 | reuse any pending transition card | it matches on `modelId` only and could return an archive card; ids were random | match transition; deterministic id |
| H4 | only quotas go manager-only | territory hierarchy and rules also move attainment | every attainment-feeding write |
| H5 | `round(amount × 10^e)` | that is the `1.005` defect itself | decimal-string parse to `BigInt` |
| H6 | name other statements on the card | statement ids embed another rep's id; erasure left the card's id | plan name + period; erasure re-points cards |
| H7 | key on a hash (unspecified where) | a second key function needs a second handle | `token` field holds the hash |
| H8 | release claims on failure | a second card could approve with no claims | `compareAndDelete` after confirming not approved |

## Corrections from implementation and grading (2026-11-03)

- **D4 claim lifecycle, reworked after grade-code H1.** The first cut released the claims a
  failed approval had inserted, after re-reading the statement's status. That is
  check-then-act: a concurrent approval of the same statement could flip in the gap and be
  left approved with no claims. Shipped instead: a failed attempt's claims stay bound to its
  statement; claims are released only when that statement's review is REJECTED, when a
  recompute DROPS a deal, when a draft is deleted, and, after a successful approval, for any
  deal not on the approved lines. And **`markStatementPaid` re-claims** every deal, refusing
  `deal_already_committed` when another statement holds one, so two statements of one plan
  can never both be paid for one deal, whatever happened to the claims in between.
- **D4 conflict note.** The closed card's note is the constant `DEAL_CONFLICT_NOTE`, and it
  says "already on an approved statement", not "paid": claims are taken at approval.
- **The statements list carries each row's latest review state** (`review: { status,
  superseded }`, pending and rejected cards only), ignoring a card older than the statement's
  `computedAt`. Without it the console could not say "In review" or "Recompute", and with it
  computed naively a superseded card pinned the row forever (both closing graders' Blocker).
- **The approved-recompute refusal** no longer says "Revoke the approval first": there is no
  revoke, and ADR 1034 does not add one. An approved statement and its claims are final.

## Implementation record

| Phase | Commit | Witnesses |
|---|---|---|
| D1, D2, D4–D9, D11 backend + packs | `b461e04bd` | `test/adr1034-commissions-integrity.test.ts`, `test/adr1034-territories-dealers-integrity.test.ts`, updated surface tests |
| Witnesses (19 guards, each sabotaged red) | `311343c97` | — |
| Frontend: manager-only controls, partner link revoke + expiry | `a8f576f56` | `partnerLinkControls.test.tsx`, `statements.test.tsx` |
| grade-code B1/B2/H1–H3 | `7b053ddd7` | 6 more guards sabotaged red |
| grade-ux H1–H7 | `4e5aa4ae8` | 5 more guards sabotaged red |
| Closing-pass findings | `51af0f1ab` | supersede → recompute clears the review state (sabotaged red) |
| APP_MIGRATIONS numbering guard | `662180b70` | duplicate version sabotaged red |

D3 needed no code (the write nodes were already served on `:fork`). D10 is filed, not built.

## Residue (filed in `docs/steward/workflows-assessment/2026-11-03-sales-ops-row75.md`)

- Commissions on the ADR 0447 obligation ledger (`SO75CD-LEDGER`, a shared-seam change).
- CRM deal `owner`/`amount`/`status`/`closeDate` edits stay `workspace:write` and move
  commission more directly than the quotas D5 locks; the pin catches changes after submit,
  and the reviewer still does not see the deal list on the card.
- Splits staged on a PLANNING model at `workspace:write` go live when a manager approves the
  activation, and the card does not list them.
- A failed approval's partial claims HOLD those deals (they are not lost) for the statement
  that wanted them: other statements of the plan leave them off until that statement is
  either recomputed and approved (the deals pay there) or its review is rejected (the claims
  are released and the next recompute of another statement picks the deals up). Not a
  double-pay path.
- Closing re-grade fixes (2026-11-03): `repointClaims` retries a lost CAS and 409s when
  exhausted (a claim left behind made the re-keyed statement unpayable); the claim release
  after a successful approval is best-effort and logged, never reopening the card of an
  approved statement; a resubmit closes the stale card, and a stale card's decide is a 409.
