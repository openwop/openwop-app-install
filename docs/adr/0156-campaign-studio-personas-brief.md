# ADR 0156 — Campaign Studio: Personas & Campaign Brief

| Field | Value |
|---|---|
| **Status** | implemented (Phases 1–4, 2026-06-27) |
| **Date** | 2026-06-27 |
| **Feature id / toggle** | `campaign-brief` (OFF, bucket `tenant`, category `Marketing`) |
| **Packs** | `feature.campaign-brief.nodes`, `feature.campaign-brief.agents` |
| **Depends on** | ADR 0155 (brand — voice resolver), 0011 (kb/RAG — grounding), 0008 (crm — audiences are real people), 0007 (media) |
| **PRD** | [`docs/campaign-studio-prd.md`](../campaign-studio-prd.md) — second of the 0155–0160 cluster |
| **RFC gate** | None — host work riding Accepted RFCs (RFC 0049, 0011 KB/RAG, RFC 0014 surface). **No new RFC.** |

> **CORRECTION 2026-11-06 — showcase retrofit uses protected semantics.**
> Restoring a missing grounding policy or competitor list is a protected context
> edit even for a demo-created brief: it advances the content revision, leaves
> the brief draft and retains its existing kernel as stale. The fill-if-absent
> retrofit does not regenerate, reapprove or finalize seeded content. Initial
> seeding still sets all authored context before its kernel and confirmation.
> Customized policy/competitors survive reseeding, and a no-op retrofit leaves
> the revision/kernel unchanged. The earlier showcase test expectation that a
> retrofit stays confirmed/fresh was obsolete; no actor exemption or new
> service precondition is introduced. Focused/full-gate verification pending.

## Context

With Brand & Guardrails (ADR 0155) defining *how* a workspace sounds, the next layer defines *who* it speaks to and *what* a campaign says: a marketing **`Persona`** (buyer stage, pain points, objections), the **campaign brief** that gathers product + persona + brand + channels into one workspace, and the **messaging kernel** — the single strategic foundation every channel echoes (headline, supporting statement, proof points, CTAs, tone) grounded in the knowledge base with `[src_N]` citations.

In MyndHyve this was `BriefContextAssemblyService` (parallel-fetches KB + brand voice + persona into one prompt context), `brief.validate`, and `brief.kernel.generate`. openwop-app has KB/RAG (ADR 0011) and brand voice (ADR 0155) already — this ADR adds the persona + brief entities and composes the two into a grounded kernel. It forks neither KB nor brand.

## Decision

Ship a `campaign-brief` feature package with:

1. **`Persona` entity + service** — a *content-targeting* abstraction (buyer stage, pain points, objections, goals), **distinct from a CRM contact** (a real person). Tenant+org scoped, `DurableCollection`, RBAC via `accessControl`. An optional `brandId` associates a persona with a brand.
2. **`CampaignBrief` entity + service** — the campaign workspace: objective, `brandId`, `personaIds[]`, optional `kbCollectionId`, product info, `channels[]` (each `{type, enabled, config}`), messaging params, `status` (`draft`/`validated`/`confirmed`), and the generated `kernel`. `validate` computes `enabledChannels` from the enabled channel set.
3. **Brief context assembler** — a pure-ish service that composes brand voice (`resolveVoice`, ADR 0155) + persona (buyer-stage/objection text) + product/audience sections into one grounded prompt block; the **KB retrieval leg runs in the node** (where the run-scoped retrieval surface lives), so the assembler stays composable.
4. **Messaging kernel generator** — a `feature.campaign-brief.nodes` node (`brief.kernel.generate`) that assembles the context (KB grounding via the run surface + brand + persona), calls `ctx.callAI` for the kernel, and returns the `campaign-brief.kernel` artifact. A `brief.validate` node sets `enabledChannels`. The **Campaign Brief Strategist** agent drives them through the one chat (ADR 0058).

### Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Persona vs CRM contact | A NEW `Persona` entity, NOT a CRM record | A persona is a content-targeting archetype (buyer stage, objections), not a real person; the audience-of-real-people path composes `crm` segments where that's needed (PRD §8.2). No fork of CRM. |
| Brief persistence | `DurableCollection` (`campaign-brief:persona`, `campaign-brief:brief`) | No migration; tenant-prefixed keys + IDOR — the 0155 precedent. |
| KB grounding seam | KB retrieval runs IN the kernel node (run-scoped), assembler composes brand+persona text | The node has the run's retrieval surface + records output for replay; the assembler stays pure/testable. Mirrors the ADR 0155 deterministic-in-service / AI-in-node split. |
| Kernel = artifact | `campaign-brief.kernel` recorded as the node output | Replay reads the recorded kernel; downstream channels (ADR 0157) consume it verbatim. |
| Citations | The kernel carries `sourceDocIds[]`; generators echo `[src_N]` | Grounding lives in artifact shape (host concern), not the wire — no new RFC. |
| Gates deferred to 0158 | The asset-decision / setup / brief-creation HITL **gate nodes** live with the orchestration (ADR 0158), not here | They are orchestration glue (pause/resume interrupts wired into the parent workflow); 0156 owns the entities + context + kernel they operate on. Honest scope refinement vs the PRD's pack note. |

### Non-goals

- The asset-decision / setup / brief-creation **gate nodes** (→ ADR 0158, where the parent workflow wires them).
- The channel generators + quality check (→ ADR 0157).
- Multi-persona A/B kernel variants (a follow-on).

## Phased plan

| Phase | Scope | Gate |
|---|---|---|
| **1 — Persona** | `Persona` types · service (CRUD, IDOR) · routes (`/campaign-brief/personas/*`, toggle + `accessControl`) · `feature.ts` + register · toggle default · route tests | backend tsc + tests |
| **2 — Campaign Brief** | `CampaignBrief` types · service (CRUD, `validate` → `enabledChannels`, kernel setter) · routes (`/campaign-brief/briefs/*`) · brief↔persona/brand reference reads · tests | backend tsc + tests |
| **3 — Context assembler + kernel** | `briefContext.ts` (compose brand voice + persona + product → prompt block, pure) · `ctx.features['campaign-brief']` surface (getBrief/listPersonas/assembleContext/validate) · `feature.campaign-brief.nodes` (`brief.validate`, `brief.kernel.generate` — KB-ground + `ctx.callAI`) · `feature.campaign-brief.agents` (Brief Strategist) · tests | backend tsc + tests; boot installs packs |
| **4 — Frontend** | `src/features/campaign-brief/` — Personas list+editor + a Brief wizard (identity → product → audience(personas) → channels → review → kernel) · client · nav · en/es/fr/pt-BR i18n | `npm run build` green |

Each phase: **`/architect` before** · implement · **`/code-review` + `/ux-review` after, apply fixes**. HITL avoided.

### Correction — selectable brief knowledge source (2026-11-05)

Live Campaign Studio acceptance testing found CORE-4: the editor allowed strict
grounding but displayed only a read-only knowledge status; no UI action could
bind a collection. The brief now offers collections from its own client through
the existing subject-scoped KB client. Save persists the selected
`kbCollectionId` through the existing brief update; empty selection explicitly
clears it. Loading, failed reads, genuinely empty lists and a saved collection
that is no longer accessible are distinct states. Failed or missing reads never
auto-clear the binding or select another collection. A source-management link
opens the existing KB page scoped to the same client. No route, protocol or
backend authorization contract changes. Save-and-Validate includes binding
edits; missing strict source coverage still fails closed at generation.

## Alternatives considered

1. **Reuse a CRM contact as the persona.** Rejected — conflates a real person (CRM) with a content archetype; the buyer-stage/objection fields don't belong on a contact, and it would couple campaign content to PII. Compose CRM segments only where a campaign targets real people.
2. **Run KB retrieval in the assembler service (headless).** Rejected for the same reason as ADR 0155 Alternative 2 — the node owns run-scoped retrieval + recorded output; a headless path duplicates resolution and loses replay fidelity.
3. **Fold persona into the brand entity.** Rejected — a brand has many personas; they have independent lifecycles and RBAC.

## Open questions

1. **Buyer-stage vocabulary.** `unaware | problem_aware | solution_aware | product_aware` (MyndHyve parity). Decided: keep these four.
2. **Channel config shape.** Per-channel `config` is open `Record<string,unknown>` v1 (e.g. ad platforms, email sequence type); typed per channel in ADR 0157.
3. **Kernel regeneration on brief edit.** Editing a confirmed brief marks the kernel stale (a `kernelStale` flag); regen is explicit. Decided: flag + explicit regen.

## Consequences

- Unblocks ADR 0157 (channel generators consume the kernel + `resolveVoice`) and 0158 (the orchestration wires gates around brief + kernel).
- Adds one toggle, one feature package, two packs, one FE area. No core edits beyond registry appends.

## Implementation log

| Phase | Status | Evidence |
|---|---|---|
| 1 | ✅ Done | `Persona` entity + `personaService` (CRUD, IDOR) + routes; `campaign-brief-persona.test.ts` 5/5. `/architect` (no existing marketing-Persona; agent "persona" is unrelated) + `/code-review` (0) passed. |
| 2 | ✅ Done | `CampaignBrief` entity + `briefService` (CRUD, `validateBrief`→enabledChannels, kernelStale-on-edit, setKernel) + brief routes + `/validate`; `campaign-brief-brief.test.ts` 4/4. `/architect` + `/code-review` (0) passed. |
| 3 | ✅ Done | `briefContext.ts` (pure assembler, buyer-stage guidance) + `ctx.features['campaign-brief']` surface (assembleContext/validate/setKernel) + `feature.campaign-brief.{nodes,agents}` (`generate-kernel` composes brand voice + `kb.rag` grounding + `ctx.callAI`, citations→sourceDocIds; Brief Strategist) + surface+packs wired. `campaign-brief-kernel.test.ts` 7/7; boot installs packs. `/architect` (3-surface composition, run-scoped provider, recorded kernel) + `/code-review` (0) passed. |
| 4 | ✅ Done | `frontend/react/src/features/campaign-brief/` — `/campaign-brief` page (Briefs + Personas tabs; brief detail = wizard sections + Validate + read-only Kernel panel + Brief Strategist chat deep-link per ADR 0058) on the shared `ui/` layer; `campaignBriefClient` + `Marketing` nav + en/es/fr/pt-BR. **`npm run build` green**. `/code-review` (0) + `/ux-review` (system row/tabs/checkboxes, semantic chips, no inline styles) passed. |

**Verification (all phases):** 16/16 backend tests (`campaign-brief-{persona,brief,kernel}.test.ts`); tsc clean beyond baseline; frontend `npm run build` green. No new RFC.


### Correction — per-channel allocation display (2026-11-05)

Campaign Studio acceptance testing reproduced CB-MONEY-2: the brief editor
converted the total budget to currency units but displayed channel allocations
as raw minor integers, so USD 150000 appeared as 150000 rather than $1,500.
The allocation line now uses the shared ISO-aware currency renderer; without a
currency it uses the budget editor's existing two-decimal fallback without
inventing a currency symbol. The four locale labels no longer describe these
readable amounts as minor units. Stored allocations and save semantics are
unchanged. The former expected-failure assertion is a normal regression, with
JPY, KWD and absent-currency cases alongside USD. Full gate and deployed
verification belong to the acceptance-test release record.


### Correction — 2026-11-08: host read-tool monetary grounding (source only)

The campaign brief is also read through ADR0308’s registered chat-tool seam. A normal QA Creative Director read reported “30,000 USD” from a stored budget of `totalMinor:30000,currency:USD`, while the native editor and freshly reloaded canonical brief showed300USD/version5. This is a reproducible symptom, not proof of the vendor’s internal reasoning, and differs from CB-MONEY-2’s frontend per-channel rendering.

Keep the durable/raw budget, completeness validation and toggle/actor/org-read authority unchanged. Add sibling `budgetPresentation` to the existing successful get-brief tool result and explain it in the registered tool description. The existing host strict ISO exponent table owns precision; do not use literal÷100 or runtime-dependent Intl display precision. Canonical major decimal strings are formed from safe integer digits (USD30000→300.00, JPY→30000, KWD→30.000). Zero remains zero, absent totals remain unavailable, missing/unsupported currencies are not guessed, and unsafe legacy integer amounts are explicitly unavailable. Present only existing allocations. No agent-pack, signed-registry, pin, provider, model, normative wire, auth or storage change is involved.

Source-authored regression cases exercise the actual registered tool, raw budget/validation preservation, currency exponents, zero, absent/unsupported values, allocation independence, safe integer precision and denied reads. All new and existing checks are **NOT RUN** at this checkpoint: no local dependency install, test, compiler, lint or build was launched. A separately reviewed isolated diagnostic and the normal exact-tree merge gate remain owed. Tool-output checks cannot guarantee LLM compliance; a separately authorized deployed same-prompt read/reload comparison remains required.
