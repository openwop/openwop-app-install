# ADR 1039 — Creative briefs: the write floor, a reel that can run, and a chat read

Status: implemented (2026-11-10: P1 = D1–D5 #5532, P2 = D6–D7 #5533, P3 = D8 #5535, all merged in train 241. /architect pass folded in before code; PR split approved by the row lead.)

Feature-loop row 82 (`docs/steward/FEATURE-LOOP-2026-10.md`). Grade record:
`docs/steward/workflows-assessment/2026-11-03-creative-briefs-row82.md` (IDs `CB82WF-*`,
`CB82XC-*`). Builds on ADR 0353 (briefs), ADR 0399 (renders), ADR 0411 (reel), ADR 0945
(product-grounded creative), ADR 0832 (the surface org floor) and ADR 0308 (feature agent tools).

## Context

Creative briefs is open beta for every tenant and has **never been used in prod** (read-only
sizing 2026-11-03: 0 briefs, renders, verdicts, reel runs, share links). So every defect below
is latent, and no data needs repairing. The grade found:

1. **Viewer writes through a run (`CB82WF-1`, Blocker).** The surface's `methodScopes` names only
   the four ADR 0945 methods. `create`, `render`, `renderVariants`, `reelPrompt` and `storeReel`
   inherit the `workspace:read` floor, while their HTTP doors ask `workspace:write`. A Viewer can
   run the reel chain from `/` and spend a paid video.
2. **The page's "Generate reel" cannot succeed (`CB82WF-2`, Blocker).** The client never sends a
   `credentialRef`; `callVideoGenerator` requires one. The route creates and charges a run that
   must fail, and the user sees a generic error. Every witness used `provider:'mock'`.
3. **Spend before the cap (`CB82WF-3`).** The per-brief render cap is checked after the paid call.
4. **The aspect ratio is dropped (`CB82WF-4`).** `aspectRatio` is not a `VideoGenerationRequest`
   field; the host derives the ratio from `width`/`height` (default portrait). The render record
   then claims the requested ratio.
5. **`createdBy` is caller-supplied on the surface (`CB82WF-5`).**
6. **Render and comment-thread cascades live on the DELETE route (`CB82WF-6`)**, so
   `deleteBrief`'s other caller (the demo clear) orphans both.
7. **No subject eraser (`CB82WF-7`).** Two stores sit on the actor-attribution debt ledger.
8. **The Creative Director cannot read a brief (`CB82XC-1`)**, and nothing on the page opens the
   one chat scoped to it (`CB82XC-2`).

## Decision

### D1 — Every surface write method names `workspace:write` (CB82WF-1)

`CREATIVE_BRIEFS_SURFACE_POLICY.methodScopes` gains `create`, `render`, `renderVariants`,
`reelPrompt` and `storeReel` at `workspace:write`, matching the HTTP doors. `reelPrompt` is a read
in shape, but it is the reel node's first call and the last host call before the paid video, so
it is where a Viewer must be refused. `list`, `get` and `listRenderTemplates` stay at the floor.

A ratchet test pins the policy: every method `buildCreativeBriefsSurface` returns is either in an
explicit read allowlist (`list`, `get`, `listRenderTemplates`) or in `methodScopes` at
`workspace:write`. A new method that is in neither fails the test (GEN-CB82-2).

Who the floor checks (corrected by the `/architect` pass, A1): the run's `actingUserId`, else its
`orgScopeSubject` (`host/featureSurfaces.ts:198`). The approver of a gate is never consulted. So:

- a campaign-channels run whose STARTER lacks `workspace:write` on the org now fails `create`. The
  `create-creative-briefs` node (`feature.campaign-channels.nodes/index.mjs:438`) passes a
  `forbidden_scope` refusal through as a typed failure instead of counting it into
  `briefCreateErrors` and saying "try approving again" (a false instruction for a scope refusal).
  Pack `feature.campaign-channels.nodes` gets a patch bump;
- triggers (`orgScopeSubject: binding.createdBy`), schedules and kanban cards carry a causing
  member, so they go through the cause-lane floor at `workspace:write` too. That is the intended
  behaviour; only a run with neither field stays tenant-trusted.

The exploit the RED witness uses is an Editor of org A who is a Viewer of org B (a built-in
Viewer has no `runs:create` at all, `accessControlService.ts:286`), plus a custom role.

### D2 — A reel needs a video key before a run exists (CB82WF-2)

- **Route.** `POST …/briefs/:briefId/reel` checks the video credential BEFORE `buildRunRecord`.
  It needs `credentialRef` (a non-managed ref) for `provider` `replicate` (the only wired video
  provider; `mock` only while the mock seam is enabled), and the ref must be one of the
  workspace's stored ref NAMES (`listSecretRefs(scope)`, the `campaign-ops/agentBindingService.ts:142`
  precedent) and not a ref named for another provider. Otherwise `credential_required` (an
  existing `OpenwopErrorCode`, 422) with no run created and no quota charged. Names only: the
  route never resolves cleartext; resolution and policy stay in `callVideoGenerator` (one BYOK
  door, row 7). Refs are tenant-scoped (`secretResolver.ts:415-434`), so no member can name
  another member's personal key here; per-member ref policy is `BYOKWF-11`.
- **Page.** The reel control lists the workspace's stored refs for `replicate`
  (`listStoredRefs`, the `JudgeCheckPanel` precedent) and sends `{provider:'replicate',
  credentialRef}`. With no Replicate key it shows a Notice linking to the keys page and the button
  is disabled. A failed reel shows the run's error message, not the generic string.

  > **CORRECTED in implementation (P1, 2026-11-03).** There is no picker. The route already runs
  > the dispatch's own ladder (`pickCredentialRef`: explicit, exact `replicate`, then a
  > `replicate-`/`replicate:` prefix) over the stored ref names, so it PICKS the key rather than
  > only checking one the page names, and registers the pick on the run
  > (`configurable: byokRunConfigurable(ref)`). **The first cut passed it only as an input, which
  > the independent grade-code pass caught as a Blocker:** a run's secret set holds only declared
  > refs (`host/runCredentials.ts`), so every keyed workspace's reel would have died
  > `byok_required_but_unresolved` after admission. The keyed-launch witness now runs end to end
  > against a stubbed provider call. The node also fails `credential_required` before any host
  > call when a `/` or gallery launch carries no key. That reuses the
  > existing resolver (the row lead's constraint: no new key-entry UI pattern), and the BYOK
  > keys page does not list Replicate as a provider anyway, so a picker fed by `listStoredRefs`
  > for "replicate" would have shown keys stored only through the Secrets Vault. The page sends
  > its old body; on `credential_required` it shows a persistent Notice ("nothing was started or
  > charged") linking to the Secrets Vault (`/access?tab=connections`), and a failed run toasts
  > the run's own error message.
- **Witness.** A route test sends the page's exact body and asserts it is refused before a run
  exists; a second sends a ref and asserts the run reaches the video call.

### D3 — Refuse at cap before the paid call; recheck after (CB82WF-3, CB82WF-8)

`reelPrompt` takes the node's deterministic `renderId`. If that render already exists it returns
it and the node short-circuits with NO video call (today a retried node pays for a second video
before `storeReel` hands back the existing row). Otherwise, when the brief already holds
`renderCap` renders, it refuses with the existing cap error (`validation_error`, the
`renderService.ts:345` message). Both run before `callVideoGenerator`, so a full brief makes no
video call and a retry never pays twice. `storeReelRender` keeps its own check and gains the post-write convergent recheck image
renders already have (`renderService.ts:514-522`), because two reels can pass the pre-check
together. A reel pruned by the recheck after its video was paid is reported as a typed failure;
its video stays a library asset (media owns it), exactly like an image render pruned the same way.

### D4 — The aspect ratio reaches the provider and the record tells the truth (CB82WF-4)

The `generate-reel` node maps `aspectRatio` to `width`/`height` (`9:16` → 1080×1920, `16:9` →
1920×1080, `1:1` → 1080×1080) and refuses any other value with `validation_error` before the
paid call. An absent or empty `aspectRatio` (an unset `{{params.aspectRatio}}`) keeps the 9:16
default. The render record derives `aspectRatio` from `video.width`/`video.height`, which today are
the requested, clamped values (the host does not demux the mp4, `aiProvidersHost.ts:1912-1917`):
the record states what was requested of the provider, and the request now carries the ratio.
Narrowing the accepted values on an unchanged `generate-reel@1.0.0` is a contract change for any
tenant workflow pinned to it; acceptable at 0 prod runs and stated here. Node pack `feature.creative-briefs.nodes` 1.4.0 → 1.5.0; the node version
`generate-reel@1.0.0` is unchanged (same inputs and outputs, a bug fix), so the chain's exact pin
holds. Replay serves the recorded result of the side-effect node; no fork re-runs it.

### D5 — The surface stamps the run's person (CB82WF-5)

`create` stamps `createdBy`/`updatedBy` with the surface's one attribution rule,
`scope.actingUserId ?? scope.runId ?? 'workflow'` (already used by `render`, `renderVariants`,
`storeReel` and `composeProductShot`). `args.actor` is ignored. `orgScopeSubject` is NOT used: it
only narrows a floor, it is not the run's actor, and erasure rewrites it to a sentinel
(`/architect` A3). The demo seed writes through the
service, not the surface, so its `CAMPAIGN_SHOWCASE_SEED_ACTOR` filter is unaffected.

### D6 — `deleteBrief` owns every cascade (CB82WF-6)

`deleteBrief` deletes render records (`deleteRendersForBrief`) and prunes comment threads
(`pruneThreadsForResourceAndComposites`), alongside the versions, usage refs and share links it
already handles. Both are dynamic imports where a static edge would cycle (the share-link
precedent in the same function). The route keeps no cascade of its own.

### D7 — A subject eraser that re-attributes (CB82WF-7)

`eraseCreativeBriefsSubject` tombstones the erased person in `creative-briefs:brief`
(`createdBy`, `updatedBy`), `creative-briefs:version` (`capturedBy`), `creative-briefs:render`
(`createdBy`) and `creative-briefs:grounding-settings` (`updatedBy`). Rows are org creative
records and are kept. Matching uses `subjectKeyForms` and writes `ERASED_SUBJECT` through a
compare-and-swap (the `scheduledChatService.ts:411-423` precedent), never through `mutateBrief`,
which would bump the version and snapshot. Run ids and `'workflow'` in `createdBy` never match a
subject and are left alone. The actor-debt ceiling drops by two in the same change. The manifest gains one id; the debt ledger loses `creative-briefs:brief` and
`creative-briefs:render`.

### D8 — The Creative Director reads a brief; the page opens the one chat (CB82XC-1, -2)

- `openwop:creative-briefs.get` (`effect:'read'`, `contentTrust:'untrusted'`) returns one brief's
  production fields and its validation issues. It decides access through `assertOrgScope`, the
  predicate the HTTP GET reaches (`featureRoute.ts:267`); `agentToolKit.resolveReadOrgScope`
  calls `resolveEffectiveAccess` directly, so the tool calls `assertOrgScope` itself and maps the
  throw to the tool's result shape (the `list` tool moves onto it too). Fails closed when the
  toggle is off and fails EMPTY with a note without an acting user. It is classified in
  `test/schema-read-exemption-completeness.test.ts` (it carries the `directions[]` indices a
  `directionIndex` cites, so it is schema-carrying and exempt from compaction), gets a
  `LLM-EXCHANGE-AUDIT.md` row, and the campaign-studio agent pack is bumped with its
  `evals/creative-director.json` expectations checked.
- The tool joins the Creative Director's allowlist (not the ADR 0315 default baseline). Its
  prompt says to read the brief before directing work on it; `agent-prompt-tool-ids` and the
  feature's prompt parity test pin the id.
- A brief's page gets "Ask the Creative Director", a deep link to the main chat scoped to that
  agent (`navigate('/?agent=vendor.openwop-app.campaign-studio.agents.creative-director')`, the
  canonical id at `campaign-studio.agents/pack.json:47`, pinned by a test because of the ADR 0763
  two spellings). Shown only when the caller's agent list contains that id (the pack is gated by
  campaign-studio, not creative-briefs, and `ChatSidebar` silently ignores an unknown id). No new
  chat surface.

## Alternatives weighed

- **Resolve a workspace default video key server-side (D2).** Rejected: there is no managed video
  key and no "default video provider" setting; inventing one is a BYOK decision for row 7. An
  explicit picker matches the judge-check precedent on the same page.
- **Gate `reelPrompt` at read and add a separate pre-spend check.** Rejected: it adds a second
  door for one decision. The floor on the first host call is the check.
- **A model-authoring `draft` tool for briefs.** Deferred (open question Q1): model-written briefs
  already reach durable state through campaign-channels behind an approval. A chat-time draft
  tool needs its own validation + gate design.

## Phased plan (PRs, each off `origin/main`, none stacked)

| PR | Covers | Size (est.) |
|---|---|---|
| P1 | D1, D2, D3, D4, D5 + ratchet + RED witnesses; pack 1.5.0; campaign-channels pack patch; steward manifest + `pack-surface-arg-parity` fixture regenerated | ~1,000 lines |
| P2 | D6, D7 | ~400 lines |
| P3 | D8 (tool, allowlist, prompt, deep link, 4 locales) | ~400 lines |

## `/architect` pass (independent, 2026-11-03)

No Blockers in the decision text. Four premises were wrong and are corrected above: A1 who the
floor checks and which lanes stay tenant-trusted (D1); A2 the cap pre-check would have broken the
deterministic-id retry and still paid twice (D3); A3 the `orgScopeSubject` fallback (D5); A4 a
presence-only ref check would still start doomed runs (D2). Mediums folded in: existing error
codes instead of new ones; D4's "returned" dimensions are the request echoed; the read predicate
is `assertOrgScope`, not the tool kit's helper (D8); the canonical agent id and availability
check (D8); D7's CAS + ceiling; P1's manifest/fixture fallout.

## Open questions

- [x] Q1 — Should the Creative Director be able to DRAFT a brief from chat (a write tool creating
  a `draft`-status brief through the closed-world cleaners, approval still privileged)? **Decided
  2026-11-03 by the row lead: deferred.** Reason: model-written briefs already reach durable state
  through campaign-channels behind an approval (ADR 1020 D14); a chat-time draft tool needs its own
  closed-world validation and gate design, and no Blocker depends on it. Filed as `CB82XC-3`.

## Implementation record

| Phase | Commit | Witness |
|---|---|---|
| P1 | #5532, merged `540b22b09` (2026-11-10): RED witnesses on unmodified main, D1–D5 backend + packs, the page (user-visible), grade-code fixes (B1: key registered on the run; node fail-fast), grade-ux fixes (announced needs-key state, coded failure reasons), pre-emptive agent-catalog mock for P3 | `adr1039-creative-briefs-write-floor`, `adr1039-reel-key`, `adr1039-reel-spend-and-aspect`, `adr1039-channel-brief-create-refusal`; FE `reelNeedsKey`, `clientErrorCode`. Each sabotage-witnessed (floor, cap, retry short-circuit, aspect, channel refusal, key on the run, reel race, needs-key state, envelope code) |
| P2 | #5533, merged `48220b05a` (2026-11-10): D6 children-first `deleteBrief` (a failed child cascade keeps the brief, retryable), D7 `eraseCreativeBriefsSubject` (CAS tombstones; a lost CAS fails the eraser); actor-debt ceiling 13 from the test's own count | `adr1039-p2-brief-cascade-and-erasure` (5 cases, every guard sabotage-witnessed, two through a storage proxy) |
| P3 | #5535, merged `2bb07a962` (2026-11-10): D8 `openwop:creative-briefs.get` + shared `assertOrgScope` gate with typed refusals, Creative Director allowlist/prompt/eval, "Ask the Creative Director" (save-first, canonical id), readable version diffs (`CB82UX-4`) | `adr1039-p3-creative-briefs-get-tool`; FE `askCreativeDirector`, `versionDiffValue`; schema-read exemption, safe-mode census and team-suite rows |
