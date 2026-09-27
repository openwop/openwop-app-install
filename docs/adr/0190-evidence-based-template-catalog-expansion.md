# ADR 0190 — Evidence-Based Template Catalog Expansion (support + starters + the tiered gallery program)

**Status:** implemented — all 6 phases (2026-07-02; PRs #1119, #1122, #1123, #1125, #1129, + the Phase 6 decision record; architect-reviewed per phase, /code-review + /ux-review folded in per phase)
**Date:** 2026-07-02

## Context

ADR 0149 froze a 20-workflow real-work catalog and ADR 0152/0163 gave it the
RFC 0013 chain-pack home + builder gallery. A 2026-07-02 deep-research pass
over the top-100 most common workflow automations (verified against n8n's
10,387-template gallery, Zapier's template + Agents galleries, IFTTT's official
2025 popularity data, CrewAI's examples, and three surveys — LangChain
Nov–Dec 2025 n=1,340, PwC Apr 2025, G2 Aug 2025) was overlaid on this host's
shipped surface. Findings that drive this ADR:

- **Customer service/support is the #1 surveyed deployed-agent use case**
  (26.5% LangChain; 57% PwC using/planning) — and the gallery shipped **zero**
  support templates, while the substrate (feature.kb RAG, `core.ai.chatCompletion`,
  `core.chat.approvalGate`, `core.email.draft`, `core.openwop.connectors.ticket-create`,
  the integration pack) fully covers them.
- **Simple single-trigger→action pipes still carry the most volume at the
  consumer/prosumer end** (IFTTT's entire 2025 top-12 is single-shot pipes) —
  and the gallery had **no on-ramp tier**: every shipped template was a
  multi-step AI chain.
- **HITL-with-guardrails is the dominant deployment mode** (~60% keep human
  review; <10% full autonomy) — matching the gallery's existing gate
  convention, which this expansion keeps.

The full overlay (coverage scorecard + the 6-phase plan this ADR heads) lives in
the session research report; later phases get their own ADR sections/records as
they land (RSS trigger bridge and demo-backend webSearch each carry their own
ADR because they change host behavior, not just catalog data).

## Decision

Extend the shipped template catalog through the **existing** RFC 0013 chain-pack
seam (`examples/workflow-chain-packs/` → `workflowChainPackLoader` → the ADR
0163 gallery) — never a parallel catalog path (the ADR 0149 §Correction law).
Phase 1 adds two vendored packs:

1. **`core.openwop.workflows.support`** (keywords `["Support"]`) — 5 chains:
   `support.kb-answer`, `support.email-triage` (draft-only — `core.email.draft`
   never sends; the draft IS the human gate), `support.ticket-routing`,
   `support.sentiment-escalation`, `support.csat-followup`.
2. **`core.openwop.workflows.starters`** (keywords `["Starters"]`) — 6 chains:
   `starters.webhook-notify`, `starters.form-to-table`,
   `starters.scheduled-digest`, `starters.fetch-to-storage`,
   `starters.verified-webhook-router`, `starters.webhook-to-slack`.

### Conventions this expansion pins (architect-review R1–R8 fold-in)

- **No second gallery grouping.** The Day-1 UX P6 "Start here" section already
  derives a tier from `runsWithZeroConnections`; the starters chains qualify
  and populate it with **no frontend change**. An authored `tier` manifest field
  would be an RFC 0013 schema change — rejected as unnecessary.
- **Trigger-shaped chains use `core.trigger.*` pass-through entry nodes**
  (shape (i)): RFC 0099 ingestion delivers inbound payloads as
  `ctx.triggerData` with `inputs: null` (`triggerIngestionService.ts:418`), so
  a payload-as-param shape would never receive subscription deliveries. The
  binding step (`POST /v1/trigger-subscriptions` / Schedules) is named in each
  chain description; on a manual run the trigger payload is empty and the copy
  says so.
- **External sends (`email-send` / `slack-message` / `sms-send`) sit behind
  `core.chat.approvalGate`.** Draft-only (`core.email.draft`) and in-app
  (`notification-push`) sinks are exempt (the it-support precedent);
  `ticket-create` follows the it-support precedent (ungated, baseUrl-as-param
  so empty ⇒ no ticket).
- **A chain must not wait on an external future** (e.g. a CSAT survey
  response): the chain ends at the gated send; the response is a new run.
- **Secrets are never run parameters** (`webhook-verify` takes only
  `family`/`algorithm`; the secret resolves host-side).
- **Classification steps use `core.ai.chatCompletion` with a classify prompt**
  (the gallery-wide idiom), not `core.ai.classify`.
- **Resolvability is test-pinned** per pack
  (`test/workflow-chain-support-starters.test.ts`): every typeId in the shipped
  known set, zero `missingNodeTypeIds`, gates asserted on external-send chains,
  deterministic expansion.

### Alternatives weighed

- *Pinned backend module (`workflowTemplates.ts` style):* rejected — ADR 0149
  §Correction already reverted exactly that shape; chain packs are the home.
- *One combined pack:* rejected — the gallery category chip derives from the
  pack (`packCategory`), and Support vs Starters are different tiers/audiences.
- *New tier UI in `WorkflowsDashboard`:* rejected for Phase 1 — duplicates the
  existing derived "Start here" grouping (two disagreeing groupings drift).

## Phased program (the overlay's plan of record)

| Phase | Scope | Status |
|---|---|---|
| 1 | `support` + `starters` packs, ADR, resolvability tests, loader 0150→0152 comment fix | **implemented** (PR #1119) |
| 2 | `knowledge` + `inbox` packs; repo-wide vendored-pack convention tests | **implemented** (PR #1122) |
| 3 | `content` pack (feed/page watching as scheduled chains — re-scoped, see §Correction Phase 3) | **implemented** (PR #1123) |
| 4 | `devops` pack — 4 advisory chains (diff review, release notes, CI-failure explainer, stale-issue gardener); chain-local prompts, NOT the code-reviewer/git-author agents (chains and agents coexist as different surfaces); GitHub-authenticated writes deferred until an MCP-reach connection binding has a chain precedent | **implemented** (PR #1125) |
| 5 | `core.web.search` unified onto the `host.webResearch` surface (ADR 0101's workflow leg — live with a key, honest `demo` without, `stub` only in bare-ctx harnesses; removes the second fabricating search impl) + `research` pack (Cited Web Brief; Deep Research stays the agent path). Re-scoped from "own ADR": the decision is ADR 0101's, this is its node leg — no wire change (§host.webResearch already spec'd + bundled), no new RFC | **implemented** (PR #1129) |
| 6 | Fold-vs-expose for the hidden `tmpl.*` catalog — **resolved: neither** (see §Phase 6 decision) | **decided (this ADR)** |

### §Phase 6 decision (2026-07-02) — fold-vs-expose dissolved; the hidden catalogs keep their substrate roles

The overlay asked whether the 44 pinned `tmpl.*` templates
(`host/workflowTemplates.ts`, ADR 0032) and the 15 `exampleWorkflows.ts` role
demos should be exposed in the gallery (with a "simulated AI" badge) or folded
into chain packs. **Neither.** Architect options review:

- **Expose** would re-create the parallel-catalog-listing shape ADR 0149
  §Correction explicitly reverted (the gallery's single source of truth is the
  chain-pack loader), and would seat 44 mock-AI cards beside the real-AI
  chains — precisely the simulated-work dishonesty ADR 0101/0190 enforce
  against.
- **Fold** would duplicate the Phase 1–5 catalog: all 11 `tmpl.*` categories
  (meeting-ops, reporting, intake/triage, scheduling, approvals, knowledge,
  people, finance, commercial, IT, comms) now have real-chain equivalents.
- The question **dissolved**: Phases 1–5 met the discovery need with real
  workflows. `tmpl.*` deliberately remains the work-twins' deterministic
  no-BYOK substrate (its ADR 0032 job — an agent-binding concern, not a
  gallery concern); `exampleWorkflows.ts` remains the roster demo seed. The
  original "mock-vs-real is unlabeled" finding self-resolves — the gallery
  contains only real-AI chains, so there is nothing to badge.
- **Falsifiability:** if users ask for a `tmpl.*` shape with no real-chain
  equivalent, that specific gap becomes a Phase-2-style pack — not a bulk
  fold.

### §Correction (2026-07-02, Phase 2) — the "uneven HITL coverage" overlay claim dissolved

The pre-ADR overlay flagged `market-intel.digest`/`shift-digest` and
`exec-ops.daily-briefing` as "side-effectful without approval gates." On
inspection those chains have **no external-send sinks** (market-intel's side
effects are research I/O; daily-briefing/meeting-prep end in the exempt in-app
`notification-push`). The convention binds **sends, not side-effect markings**
— so no gates were added. Instead Phase 2 codified the rule repo-wide: a test
iterates every VENDORED chain (in-tree root only — never the registry-install
dir, whose third-party contents are machine-local and not ours to bind) and
asserts every `email-send`/`slack-message`/`sms-send` sits behind ≥1 approval
gate on a `side-effectful`-marked chain
(`test/workflow-chain-knowledge-inbox.test.ts`).

### §Correction (2026-07-02, Phase 3) — the "RSS poller trigger bridge" re-scoped to chains

The plan of record called for wiring a host RSS poller behind
`core.trigger.rss`. Architecture review found that an `rss` ingestion source
belongs on `POST /v1/trigger-subscriptions` — **RFC 0099 §F.2 normative wire**
(`routes/triggerBridge.ts:82`) — so a host-side poller source is **RFC-gated**:
it needs a new RFC in `../openwop/RFCS/` reaching Accepted before this host
implements it. Phase 3 therefore ships the user value with **zero host
changes**: `core.openwop.workflows.content` chains pair a `core.trigger.schedule`
entry with durable seen-state in host KV (`core.storage.kv-get/kv-set`,
deterministic per-source key, first run seeds the baseline) — the scheduler IS
the poller. `core.trigger.rss` remains an unwired pack node (honest: nothing
subscribes it). If feed-watching demand outgrows scheduled chains, author the
RFC first.

### Phase 2 decisions folded in (architect review)

- **`kb-builder` dropped**: `feature.kb.nodes` has no ingest node, and
  `core.rag.vector-upsert` writes a raw vector store the app-KB `rag` node
  does not read — a "build here, query there" pairing would be silently
  disconnected. KB population stays with the Knowledge feature +
  knowledge-sync (ADR 0107); the Q&A chains' copy points there.
- **No version bump of the published lighthouse pack**: sales-call analysis
  ships as `inbox.call-debrief` (productivity framing) instead of a
  `lighthouse@1.1.0` sixth chain — in-tree bumps of registry-published packs
  divorce in-tree from packs.openwop.dev until an operator republish, which
  is not a catalog-phase concern.
- **Shape-duplication rule**: two chains may share a DAG shape when the
  catalog evidence lists them as distinct templates (e.g. `support.kb-answer`
  vs `knowledge.policy-qa`) — but their copy MUST differentiate audience,
  defaults (escalation channels), and prompts. Templates are product, not
  code; dedup applies to engines, not cards.

## Consequences

- Gallery coverage of the evidence-backed top-100 shapes roughly doubles with
  zero engine changes; the #1 surveyed category goes from empty to five
  templates; the "Start here" tier gains genuinely zero-config pipes.
- Two packs ship with trigger entry nodes before any in-gallery subscription
  affordance exists — the descriptions carry the binding instruction; a
  preflight "bind a trigger" hint is a candidate Phase 3+ UX follow-on.
- The new packs are in-tree trusted source (same posture as the existing
  seven); registry publication (packs.openwop.dev signing) can follow the
  ADR 0163 Phase 7 pipeline at any time without code changes.
