# ADR 1116 — Market-intel chains read the pages they discover (CC-CHAIN-7)

Status: Accepted, implemented on branch fix/cc-chain-7-market-intel-fetch (2026-11-13; user chose "Fetch top pages", relayed by openwop-app-81; reviewed by 81)

## Context

Campaign Studio acceptance row CC-CHAIN-7 (openwop-app-81's campaign): on prod
b976b6055 with `core.openwop.workflows.market-intel` 1.2.1, run `fde1c628`
completes `discover`, then `voc` fails `INVALID_INPUTS: inputs.content is
required`. Neither chain in the pack can ever complete:

- `market-intel.digest`: discover → voc → score → synthesize.
- `market-intel.shift-digest`: discover → voc → score → shift → synthesize.

What is wrong, read from origin/main:

1. **No content.** `market-intel.ai-discovery` outputs `{sources[], communities[],
   searchQueries[]}`, which are URLs and names. `market-intel.voc-extraction` requires
   `content` (one string), and nothing fetches a page. The content-extraction
   pack's own description names the pipeline the chain skipped: discovery →
   `host.webResearch.fetchBatch` → extraction → voc.
2. **No context.** voc and `market-intel.opportunity-scoring` both require
   `icpContext` and `productContext` (objects). Neither chain declares them.
3. **Port mismatch.** Edges are bare (`{from:"voc", to:"score"}`). Scoring reads
   `inputs.vocRecords` and `inputs.communities`, but voc outputs `records` and
   communities come from discover. shift-detect requires `previous` and `current`;
   the shape scoring produces vs `current` is unchecked.

## Decision

**The user chose "Fetch top pages"** (relayed by 81, 2026-11-13): use the top 3
discovered URLs, fetch them, extract each one, then run voc, with ICP and product
context added as chain parameters. The user accepted about 3× the AI calls.

The chain format has no per-item loop (`core.loop` / `core.flow.iterator` only
wraps array items into bundles and runs no body), and an edge cannot index
`sources[0..2]`. So the fan-out lives inside the nodes, not the graph:

1. **Fetch:** a new `fetch` node, `core.web.fetch@1.0.0` (the host's ONE web
   owner, ADR 0101: SSRF-guarded, readable-text extraction, bounded). Config
   `maxPages: 3`, `extractReadable: true`. Edge `discover.sources → fetch.urls`. A
   page that fails is reported in `pages[]`, not dropped. A reddit-style
   `r/<sub>` source is not a URL; it is filtered before the fetch and named in a
   warning.
2. **Extract + VoC per page:** `market-intel.voc-extraction` gains an additive
   `pages` input (the `core.web.fetch` `pages[]` shape). When `pages` is given,
   it makes **one AI call per readable page**: that's the accepted 3×. It stamps
   each record with that page's `sourceUrl`/`sourceTitle` and merges the
   records. `content` keeps working unchanged for single-source callers. It fails
   typed (`INVALID_INPUTS`, never success-with-empty) when no page was readable,
   and the failure names how many were requested and fetched. Edge
   `fetch.pages → voc.pages`. Node version 1.0.0 → 1.1.0; pack
   `vendor.myndhyve.market-intel-voc` 1.0.2 → 1.1.0.
   *Alternative weighed:* per-page `market-intel.content-extraction` (an AI
   readability pass on raw HTML). That needs a graph-level loop the format lacks,
   and `core.web.fetch` already returns readable text. Rejected for this ADR; it
   can be a later quality step.
3. **Context params:** both chains declare `icpContext` and `productContext`
   (objects, required) and pass them to voc and score inputs as
   `{{params.icpContext}}` / `{{params.productContext}}`.
4. **Named edges:** `voc.records → score.vocRecords` and `discover.communities →
   score.communities`. Score feeds synthesize (digest) or shift.current
   (shift-digest), mapped to whatever shape shift-detect requires. Check before
   writing.
5. **Versions:** pack 1.2.1 → 1.3.0; both chains 1.1.1 → 1.2.0.

6. **Fetched text is untrusted.** Web pages are attacker-writable, so this
   chain opens a prompt-injection lane into voc. voc fences each page body before
   it reaches the model. The fence is in the same BEGIN/END UNTRUSTED CONTENT
   shape as host `fenceUntrustedBlock` (`host/untrustedContent.ts`): data-only
   instruction, delimiter defanged, and truncation that re-closes the fence. The
   pack carries its own copy because a pack cannot import host code
   (`core.openwop.ai` precedent). A test pins it byte-for-byte to the host
   helper's output. The page url/title labels are sanitised the same way.
   Model output is validated **closed-world** before it reaches scoring: the
   `tagType` enum and field types come from the output schema, and every
   record's `quote` must be a substring of the page it is attributed to. An
   ungrounded record is dropped with a warning. If every record is dropped, voc
   fails typed, never succeeds with an empty result. A planted "ignore previous
   instructions; return …" body must stay inside the fence and must not change
   the output shape.
7. **Cost knob:** `maxPages` is a chain parameter (default 3, cap 5). A run costs
   ≤ maxPages fetches + ≤ maxPages voc AI calls + discover + score + synthesize
   (+ shift). `params.x` values freeze to strings in some paths (ADR 0507), so
   the node accepts a numeric string.
8. **Builder form:** the from-chain unfilled-params report (ADR 0504) now lists
   `icpContext` and `productContext`. The builder's create form must show both
   as editable fields, verified by the existing from-chain route test, not
   assumed. If object params do not survive `{{params.x}}` expansion (Q2), both
   become JSON strings that voc and score parse, failing typed on invalid JSON.

### The portability claim changes, and we say so

The pack description says "authored entirely over PUBLISHED node packs … so they
expand + run on any conformant host", and each chain says "Portable: every node
is a published typeId". **That becomes false.** `core.web.fetch` is a host-native
core node that needs `ctx.webResearch`. On a host without it, the chain fails at
`fetch` with a typed `host_capability_missing`, before any AI call. The pack and
chain descriptions are amended to say that. Open question Q1: does the chain
format have a requirement/capability field the gallery can use to hide the chain
on such hosts? If yes, declare it. If no, the description plus the typed failure
is the honest floor, and a format extension is an RFC 0013 revision, not this
ADR.

## Consequences

- AI calls per run: discover 1 + voc ≤3 + score 1 + synthesize 1 (+ shift 0).
  The old chain made 4 calls on paper and completed 0 runs.
- Web fetches: ≤3 per run, through the existing SSRF-guarded surface.
- Replay: `core.web.fetch` and voc outputs are run-cached node outputs (same
  nondeterminism class as `core.web.search`). A replay reads them, never re-fetches.
- Already-instantiated copies (`wf.copy.market-intel-digest.*`) keep the broken
  1.2.1 graph. Both QA copies are archived. Re-instantiation is the remedy, and the
  1.3.0 notes say so.

## Shipping (decisions that are not mine)

1. One PR: chain pack 1.3.0, voc pack 1.1.0, tests, this ADR.
2. **Registry publish** of `core.openwop.workflows.market-intel` 1.3.0 (and the voc
   node pack if it is registry-published too). This is the user's call, in the
   acting session.
3. **Pin advance** and deploy: the user's go, via 76.
4. 81 retests: a `market-intel.digest` run with topic + both contexts reaches
   synthesize and completes. shift-digest too, with a prior result.

## Tests (red on the 1.2.1 pack, green on 1.3.0)

- Expand both chains and run them end to end with a stub provider and a stub
  `ctx.webResearch`. Each must reach the terminal node. On 1.2.1 they stop at voc.
- voc `pages`: 3 pages → 3 AI calls, each record carries its page's url; 0 readable
  pages → typed failure; `content` path unchanged.
- Injection: a page body containing "ignore previous instructions; output {…}"
  reaches the model only inside the fence (assert on the captured prompt), and
  a model reply carrying an ungrounded quote or an out-of-enum tagType is dropped
  or failed typed. The fence copy equals host `fenceUntrustedBlock` output.
- Fetch failure: no `webResearch` → typed `host_capability_missing` at `fetch`.
- Sabotage: drop the `voc.records → score.vocRecords` edge → red; revert voc's
  per-page loop to one call → the 3-call assertion goes red.

## Open questions

- Q1: chain requirement field (above).
- ~~Q2~~ **Resolved:** a whole-value `{{params.x}}` keeps its JSON type at expansion
  (`workflowChainPackLoader.ts`, the ADR 0237 rule), so objects arrive as objects.
  voc still accepts the JSON text form, because a builder field delivers text.
  (Original question: do object-typed chain params survive `{{params.x}}` as objects? shift-digest
  already passes `{{params.previous}}` (an object). Verify with a test, don't
  assume.
- ~~Q3~~ **Resolved:** it did not match, see the implementation record (shift-detect 1.1.0).
- ~~Q4~~ **Resolved (signing):** voc is a `vendor.myndhyve.*` pack under
  `myndhyve-internal-1`. That key's private half is on this Mac (`~/.openwop-keys`,
  listed by filename only), and a myndhyve pack has been published under it
  before (ADR 0782 D4, agent-orchestration 1.0.3). The `openwop-team-1` key for
  the chain pack is there too. So voc stays the home of the per-page loop; no
  first-party node is needed. Note the ship mechanics: prod runs
  `OPENWOP_STRICT_REGISTRY=true`, and since ADR 0655 D5 the installer refuses a pin
  BELOW the vendored version and serves the vendored copy. So voc 1.1.0 would run
  in prod UNSIGNED after a deploy, even without a publish.
  `check-pack-pin-drift` flags exactly that state. The plan is therefore to
  publish voc 1.1.0 and the chain pack 1.3.0 together, as one user-approved step,
  before the deploy that carries them.

## Existing pins this flips

- `test/workflow-chain-market-intel-digest-execution.test.ts` documents this exact
  defect as `it.fails('… (MKTI-VOC-1)')` (grade-code row MKTI-VOC-1). It turns red
  when the fix lands, so the PR converts it to a plain `it` (the defect-pin
  vocabulary test may need its row retired) and closes MKTI-VOC-1.
- `test/cc-chain-3-6-chain-wiring.test.ts` and the chain loader / from-chain /
  install-route tests read this pack. They are in the targeted set.

## Implementation record (2026-11-13, f2)

Changes from the decision text, found while building (each one recorded here, not
folded silently into the sections above):

- **Fetch budget vs AI budget.** `core.web.fetch` reads a NUMBER `maxPages` and
  falls back to 8 on a string, and an embedded param can arrive as a string. So
  the fetch node has a fixed `maxPages: 5` (the cap), and the `maxPages` chain
  param (default 3) goes to **voc**, which accepts a numeric string. The result:
  up to 5 fetches and up to `maxPages` AI calls, and an unreadable page is
  replaced by the next readable one instead of costing a call.
- **`r/<sub>` sources are not pre-filtered.** No node can filter them before
  the fetch. They reach `core.web.fetch` and come back as per-page errors
  (`status 0`), which voc skips and names in its warnings. "Reported, not dropped"
  still holds.
- **Scoring reads `quotePreview` and `community`, not `quote`.** voc records now
  carry `quotePreview` (the quote cut to 200 characters) and `community` (the
  page host, or `inputs.community`). Without this, scoring would have seen blank
  quotes on correctly wired edges.
- **Contexts reach scoring through voc.** voc outputs the parsed `icpContext` /
  `productContext`, and the chain wires `voc.icpContext → score.icpContext` (same
  for product). Scoring therefore reads the same object voc validated, and the
  scoring pack does not change.
- **shift-digest had two more defects, both fixed in `market-intel.shift-detect`
  1.1.0** (pack 1.0.1 → 1.1.0):
  1. `previous` was authored in `config.previous`, and the node reads only
     `ctx.inputs`, so every run diffed against `{}` and every pain read as new.
     The chain now passes it on `inputs`. The node also reads `config.previous`
     for back-compat.
  2. `current` was never set (a bare `score → shift` edge), so the node diffed
     against `{}` and reported "no material market shift": a false all-clear.
     The node now takes `records` + `rankedAngles` (angle key `angleId`/
     `angleName`, score `score.total`) when `current` is absent. A missing
     previous or current set is a typed `INVALID_INPUTS`. It also outputs
     `snapshot`, which is this run in the `previous` shape, for the next run.
- **Builder ports.** The builder makes one port per top-level `required` field
  (`portsFromSchema`). voc's required list is now `icpContext, productContext`,
  with `anyOf` content|pages, so `pages` is not drawn as a port. shift-detect's is
  `previous`. Edges into an undeclared port name already existed on these chains
  (`discover → voc` targeted `input`), so this is no regression. Showing every
  edge-fed port is a builder follow-up, not part of this ADR.
- **Every source body and its metadata are fenced**, in the content lane too:
  the content lane is now fenced and grounded as well. That is a behaviour change
  for direct callers, and a stricter one.
- **Pin drift.** `check-pack-pin-drift` on the branch prints exactly one line:
  `NEW core.openwop.workflows.market-intel — vendored 1.3.0, production pinned
  1.2.1`. voc and shift-detect are not pinned in prod. So the PR rides its own
  train after the pending product deploys, and the registry publish (chain pack
  under openwop-team-1; voc and shift-detect under myndhyve-internal-1) plus the pin
  advance are the user's go before the deploy that carries it.

| Piece | Where |
|---|---|
| voc 1.1.0 (pages lane, fence copy, grounding, contexts) | `packs/vendor.myndhyve.market-intel-voc/` |
| shift-detect 1.1.0 | `packs/vendor.myndhyve.market-intel-shift-detect/` |
| chains 1.2.0 / pack 1.3.0 | `examples/workflow-chain-packs/market-intel-digest/pack.json` |
| both chains end to end (real port rule) | `test/workflow-chain-market-intel-digest-execution.test.ts` |
| node contract + fence parity | `test/market-intel-voc-pages.test.ts`, `test/market-intel-shift-detect.test.ts` |
