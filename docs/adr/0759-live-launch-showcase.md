# ADR 0759 — A live launch-kit showcase over the workflow engine

Status: Implemented (local preview; not deployed)

## Outcome and architecture contract (Track A)

A visitor supplies a product brief and watches a real workflow produce a useful launch kit: strategy, landing-page copy, three emails and social campaign copy. An editorial review feeds a revision step; the existing approval interrupt stops the run before handoff. No email, advertising spend or publication occurs.

Existing seams: RFC 0013 workflow-chain pack → existing from-chain expansion and owned workflow registry → v2 run client → run events/SSE → existing interrupt renderer. The showcase owns presentation only: no new execution engine, durable collection, credential store, provider dispatcher or backend endpoint. The existing backend enforces tenant access and run/approval authorization. No normative wire change and no new RFC are needed. A frontend feature route composes these always-on facilities without a new product toggle.

The pack uses core.ai.structuredOutput with schema validation and one error-fed repair per step. Provider and model are frozen at instantiation, using a valid BYOK binding; managed-chat and mock bindings are not advertised as runnable. The credential NAME travels only through configurable.ai, never through chain parameters. Briefs are user-input objects, not system-prompt interpolation. Six model steps incur provider charges. Core-node schema repair is bounded to one; the existing host adapter has its own bounded envelope/transport retry policy, so twelve calls is not an end-to-end ceiling. Output budgets include MiniMax reasoning overhead; draft length is separately constrained in instructions. Structured AI calls emit step events, not partial JSON tokens; the UI must not imply token streaming.

The graph is derived from the persisted definition, with the shared GraphSurface viewport. A readOnly GraphSurface prop disables geometry mutations (selection/zoom remain). Event projection deduplicates and orders sequence numbers, never advances a node on a timer, and restores from the existing run/event endpoints. Connection loss is distinct from workflow failure. No global content cache; identity change clears the view. Instantiation/run failures preserve the workflow link; the run-create idempotency key survives same-page retries. Ambiguous instantiation is not automatically retried.

## Design plan and critique

Palette: existing paper, paper-2, ink, rule, clay and functional status tokens; no new brand palette. Geist/sans headings, mono run metadata. One large live workflow, beside the tangible campaign output. Hierarchy: outcome → editable brief → execution → artifacts → human decision. Progressive disclosure keeps protocol details in the existing run inspector and builder.

The risk is replacing a trivial demo with a wall of AI prose. Countermeasure: render actual landing-page copy as a designed preview, email drafts as correspondence and social copy by channel; keep raw payload inspection on the existing run page. Do not fabricate images, performance metrics, research or published status. Mobile stacks the graph and deliverables, with a keyboard-accessible step list. Existing motion only while events report running; respect reduced motion.

## Provider admission correction (Track B)

The first live smoke exposed drift: MiniMax was supported by the real dispatcher and Keys connection, but omitted from both discovery's BYOK advertisement and the run-credential admission list. `advertisedProviderAuthModes()` now owns that list for both surfaces, including MiniMax's existing API-key mode. This changes an implementation capability advertisement, not the wire contract (RFC 0067 / RFC 0121 / ADR 0712). Tenant-scoped secret resolution and provider-name checks remain intact. The ADR 0712 HTTP tests pin discovery/admission parity and MiniMax acceptance; the live showcase exercises actual dispatch. No credential value enters a workflow, URL, or frontend.

> **CORRECTED 2026-10-26 (ADR 0990 D6, David's decision): MiniMax is no longer a
> user BYOK provider on any deploy.** It backs the free tier and is hidden from users,
> so run admission refuses a tenant's MiniMax key and its auth modes carry no `apiKey`.
> It stays in discovery's `providers[]`, which names the providers the host dispatches
> to. The showcase now needs an Anthropic, OpenAI or Google key.

## Alternatives considered

- A timed marketing animation would be easy but cannot demonstrate real execution or recovery: rejected.
- A new endpoint that prompts a model and stages artificial steps would duplicate the executor and misrepresent parallel work: rejected.
- Publishing a real campaign would require connected accounts and irreversible side effects before a visitor sees value: use draft-only deliverables.

## Verification / delivery

Browser verification found that API-key-only preview users can read their run log while the separate artifact-library RBAC denies its preview. The showcase now uses the existing approval renderer's inline-evidence lane, deriving Markdown from the completed output on the persisted gate's direct `artifact` input edge. It does not fetch foreign content, guess a node by label, bypass artifact authorization or change the approval payload submitted to the server. Tests require that exact dependency and completed output. The original brief is supplied to every AI step so review can compare proposals with the actual source, not just an upstream model's interpretation. The shared approval preview scroll region is keyboard-focusable.

- [x] Chain expansion and real executor test, including parallel outputs, review inputs, approval and rejection; structural-error repair loop tested.
- [x] Event projection tests: duplicates, out-of-order arrival, suspended/failed/terminal states. Hook tests cover failed-first-read recovery, foreign workflow rejection, terminal restore and late-response disposal.
- [x] Canonical frontend build and backend typecheck; 51 focused UI/graph/approval tests and 17 backend showcase/credential tests.
- [x] Browser check: 320/390/760/920/1080/1440 widths, no horizontal page overflow; dark mode, reduced motion, approval keyboard containment, refresh recovery. Axe scan of the showcase reports zero violations, including at the approval gate.
- [x] Real MiniMax-M3 run through approval and Markdown download; subsequent grounded run left waiting for the user's decision. Fixtures are test-only, never a production fallback.

Local preview first. No deployment is part of this decision.

### Release follow-ups / limits

- Showcase-authored copy is English-only in this preview; localize before a multilingual public launch.
- The shipped zero-dependency AI node validates required keys and types, not the entire JSON Schema vocabulary. The three-item array bounds are supplied to the model, not a server-side cardinality guarantee. Human review remains required; the live run produced three of each. Full semantic schema enforcement belongs at the shared host/node validation seam, not in a second showcase executor.
- Local preview data and the MiniMax binding are ephemeral. No provider key is saved in the source tree or browser. Production deployment and authenticated tenant smoke are separate release steps.
