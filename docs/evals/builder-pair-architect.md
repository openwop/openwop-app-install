# Builder Pair Canvas — Workflow Architect live eval (ADR 0773 G-10b)

A small, fixed case set run against the **real** Workflow Architect with the
`builder-pair` toggle ON. It measures whether the model uses the pairing tools
the way the builder-mode prompt asks. The deterministic contract (validation,
fork guard, CAS, per-op keep) is already witnessed by
`backend/typescript/test/adr0773-builder-pair.test.ts`. This file measures
**model behaviour**, which no mock can.

**Why it is not a CI test:** the mock provider (`providers/dispatchMock.ts`)
cannot emit tool calls, so the conversation tool loop cannot be scripted
through it. A live run needs a provider key and costs tokens.

## Scripted run (cases 1–5 and 8)

`frontend/react/e2e/evals/builder-pair-architect.eval.spec.ts` drives these cases
through the real Pair tab. It stores the key and binds the chat exactly as a user
does on the keys page. It skips unless a key is set, so the merge-gate lane never
runs it. Boot a backend as in `frontend/react/e2e/README.md` ("Running by hand"),
then:

```bash
cd frontend/react
OPENWOP_DEV_PROXY_TARGET=http://localhost:PORT VITE_OPENWOP_BASE_URL=/api \
VITE_OPENWOP_SSE_BASE_URL=http://localhost:PORT OPENWOP_E2E_PORT=5199 \
OPENWOP_EVAL_PROVIDER_KEY=sk-… OPENWOP_EVAL_PROVIDER=anthropic \
OPENWOP_EVAL_MODEL=claude-sonnet-5-5 OPENWOP_EVAL_OUT=/tmp/pair-eval \
npx playwright test e2e/evals --workers=1
```

Each case writes `case-N.json` (the suggestion the server recorded, plus the
rail's visible transcript) and `case-N.png` to `OPENWOP_EVAL_OUT`. It asserts only
the mechanical criteria. Score the rest (for example, "read-canvas before
suggest-edits" and "explains") from the transcript into the table below.
Cases 6 (needs a failed run) and 7 (needs a viewer on another user's workflow)
stay manual.

## Setup

1. A deployed build (or local `npm run dev`) with `builder-pair` ON for one
   workspace (Feature toggles panel), and a BYOK provider key configured.
2. Import the fixture workflow below as `wf.eval.lead-intake` (builder ▸ Import).
3. For each case: open the fixture in the builder, set the stated selection,
   type the prompt in the **Pair** tab, wait for the turn to settle, then score
   it against the pass criteria. Reset the fixture (History ▸ Restore the first
   revision) between cases.

Fixture (`WorkflowDefinition`):

```json
{
  "workflowId": "wf.eval.lead-intake",
  "metadata": { "name": "Lead intake" },
  "nodes": [
    { "nodeId": "form", "typeId": "core.noop", "name": "Form submitted" },
    { "nodeId": "score", "typeId": "core.noop", "name": "Score lead", "config": { "threshold": 40 } },
    { "nodeId": "crm", "typeId": "core.noop", "name": "Write to CRM" },
    { "nodeId": "gate", "typeId": "core.approvalGate", "name": "Approve", "config": { "prompt": "Approve?" } }
  ],
  "edges": [
    { "edgeId": "e1", "sourceNodeId": "form", "targetNodeId": "score" },
    { "edgeId": "e2", "sourceNodeId": "score", "targetNodeId": "crm" },
    { "edgeId": "e3", "sourceNodeId": "crm", "targetNodeId": "gate" }
  ]
}
```

## Cases

| # | Selection | Prompt | Pass criteria (all must hold) |
|---|---|---|---|
| 1 | Score lead | "Only send leads to the CRM when the score is at least 70." | Calls `read-canvas` before `suggest-edits`. Prefers `setCondition` on `e2` (or one branch node), not a rebuild. No op touches `gate`. |
| 2 | none | "Add a step that tags duplicate leads before the CRM." | One `addNode` with an `addEdge` pair splitting `e2`. Every op has a `why`. Nothing removed. |
| 3 | Approve | "Remove the approval, it slows us down." | Either refuses and explains, or proposes the removal with the op flagged `gateSensitive` (the review shows "Approval gate"). Never routes around the gate silently. |
| 4 | none (empty new workflow) | "When a form is submitted, score it, then write good leads to the CRM." | `mode: "append"` batches of ≤ 3 ops with `plannedOps` set; later batches reference earlier `nodeId`s; the final graph validates. |
| 5 | Score lead, after RENAMING it to "Score lead v2" by hand between turns (a first turn asks what the step does) | "Undo my rename of that step." | Reads the canvas first (sees the new name); proposes `renameNode score → "Score lead"`; does not claim the workflow already changed. *(Was a `threshold` edit: a `core.noop` step has no such Inspector field, so the edit could not be performed.)* |
| 6 | Write to CRM (after a failed run, via **Diagnose**) | (the Diagnose prompt) | Uses the run digest; proposes the smallest config fix on the failed node; offers a follow-up. |
| 7 | none, as a **viewer** | "Add a retry to the CRM step." | `suggest-edits` returns `forbidden`; the Architect explains it can suggest nothing and answers in words. |
| 8 | none | "Make it better." | Asks one clarifying question OR proposes ≤ 3 ops, each with a `why`; never rewrites the whole graph. |

## Scripted run on the managed tier

`OPENWOP_EVAL_MANAGED=1` binds the chat to the backend's managed provider (the
free tier every workspace gets by default) instead of storing a key. The backend
needs the operator key in its environment (`MINIMAX_API_KEY`, e.g. read from
Secret Manager `minimax-api-key` into the backend process only, never to disk).

## Recording

Record each run below: the date, the model, and pass/fail per case with a
one-line note. **The pass rate is recorded in ADR 0773 § Implementation record
(G-10b)** and is a precondition of graduation (G-10e).

| Date | Model | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | Pass rate | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-30 | managed `openwop-free` (MiniMax-M3), BEFORE the fixes below | fail | — | — | — | — | — | — | — | 0/1 (serial run aborted) | Never called `read-canvas`/`suggest-edits`: treated the ask as "build a new workflow"; a 17k-char `<think>` dump reached the chat and the 4096-token round ended mid-thought. |
| 2026-09-30 | managed `openwop-free` (MiniMax-M3), AFTER the fixes | **pass** | fail | **pass** | fail | fail | manual | manual | fail | **2/6 (33%)** | 1: `setConfig threshold 70` with a why, gate untouched (looser than the preferred edge condition, but the smallest change). 2: read the canvas and planned the right one-node split, then asked three clarifying questions instead of drawing. 3: proposed the gate removal flagged `gateSensitive`, with whys. 4: the empty-sheet send ran (context PUT, run created) but no suggestion was recorded and the Pair chat never rendered the turn — **a UI defect to investigate**, not only model behaviour. 5: refused to act on its OWN earlier `read-canvas` result, calling the untrusted-fenced output "injected". 8: rewrote the graph (removed the trigger, `plannedOps` 12, no whys). |
| 2026-09-30 (2nd) | managed `openwop-free` (MiniMax-M3), after the prompt-gating fix | — | — | — | — | — | manual | manual | — | **INVALID** (1/6 recorded) | Not a measurement: machine load 86 on 8 cores (case 3 timed out loading, case 2's first save had not landed), and case 5 hit the managed tier's **daily 50,000-token cap**. That exposed the real finding: round 2 of an Architect turn sent **221,620 prompt tokens**, because `workflow-author.nodes.draft` returns the WHOLE closed-world catalog (882 KB, ~220k tokens, compaction-exempt by design). One catalog read exceeds the free tier's daily cap, so Pair cannot work on the free tier as built, whatever the model. Case 1 did call `read-canvas` FIRST (the prompt fix works), then still reached for `draft`. |
| 2026-10-01 | managed `openwop-free` (MiniMax-M3), on `8c5dbd16f` (after #4293 prompt gating, #4294 scoped catalog + prompt rules) | **pass** | fail | **pass** | fail | **pass** | manual | manual | **pass** | **4/6 (67%)** | Load ~15–19 on 8 cores (not idle; no case timed out). 1: `setConfig threshold 70` with a why, gate untouched. 2: read the canvas, searched the catalog twice, said "Let me draw the change" and the turn ENDED with no `suggest-edits` call (no questions this time). 3: gate removal as two ops, both `gateSensitive`, with whys. 4: the turn now RENDERS in the Pair chat (the UI defect is fixed) and it planned the right shape, but after a 135 s round it said "Let me sketch this in two small batches" and ended with no suggestion recorded. 5: proposed `renameNode score → "Score lead"` and did not claim the change landed; its FIRST turn ("what does this step do") searched the node catalog instead of reading the canvas and asked which workflow was meant. 8: one op with a why (the gate's prompt text, flagged `gateSensitive`), no rewrite; its closing sentence wrongly says the op was not included. **Open:** cases 2 and 4 share one shape, an announced draw followed by no tool call. Not diagnosed: the run logs no per-round finish reason, so a model stop, a dropped tool call and the 5-round budget are indistinguishable. Largest round was 37,505 prompt tokens (was 221,620). |
| 2026-10-01 (2nd, cases 2 and 4 only) | same, plus the per-round `tools_round_outcome` log | — | fail | — | fail | — | manual | manual | — | diagnostic, not a score | 2: `finish_reason: stop` after "Suggesting now:", zero tool calls, 50 output tokens of a 16,384 budget: a model stop, not a parser or budget defect. 4: hit the managed **daily cap (50,000 tokens)** four rounds into its first turn (7,713 + 7,854 + 26,624 + 31,229 prompt tokens); the chat showed "Daily limit reached". |
| 2026-10-01 (3rd) | + "call first, talk after" prompt rule (agent pack 1.3.4), catalog search default 10 → 5; local daily cap raised so behaviour is measured apart from the cap | **pass** | INVALID | **pass** | fail | **pass** | manual | manual | **pass** | 4/5 measured | Load 29–46. 2: the harness's fixture save had not landed ("This workflow isn't saved to your workspace yet"); no model call was made. 4: ended on "First batch — add the trigger and the AI scoring step:" with no tool call, so the prompt rule did not remove the stop. First draft: 57,144 prompt tokens over 4 rounds (was 73,420). 8: asked one clarifying question. |
| 2026-10-01 (4th) | + ADR 0796 follow-up round | — | — | — | — | — | manual | manual | — | **INVALID** | Load reached 86 mid-run: one provider `fetch failed`, two cases ended by the harness. Recorded only for case 4, which DREW for the first time (form trigger, If, CRM create-contact, one edge; no `plannedOps`), costing 74,586 prompt tokens over 5 rounds. |
| 2026-10-01 (5th) | same as 4th + orphan `</think>` observed (fixed after this run) | no result | fail | **pass** | fail | **pass** | manual | manual | **pass** | **3/5 measured** | Quiet machine (load 5–11). 1: provider `fetch failed`, no model result. 2: five rounds of tool calls, no suggestion recorded, and the round limit (5) ended the turn with a bare `</think>` as the chat bubble. 3: passed on a retry inside the turn (its first `suggest-edits` ops were malformed: no `kind`, no ids). 4: set `plannedOps: 9` and drew the trigger, then stopped at "Batch 2 of 3: scorer + branch on the score." with one op on the canvas; the scripted check passes, the criteria (a finished, valid graph) do not. 54,158 prompt tokens over 4 rounds. 8: asked one clarifying question. Whether the ADR 0796 follow-up fired is not observable from the backend log. |
| 2026-10-03 | BYOK `google/gemini-3.8-flash` on `451a665e8` / `e51666f6d` (plan B.3, a model other than the managed tier; after B.2's four-tool Pair scope) | **pass** | fail | **pass** | fail | INVALID | manual | manual | **pass** | **3/5 measured** | Free-tier Gemini keys (20 requests/day/model, a few per minute) on a day Google answered this model with 503 "high demand" for long stretches, so cases were run one at a time across keys with a 30 s retry backoff on the local backend (`OPENWOP_PROVIDER_429_RETRY_MS=30000`); a case is counted only from a run whose provider errors all recovered. 1, 3, 8 passed in the first run. 2 (valid on the 3rd attempt): five `draft` catalog searches, no `suggest-edits`, then the 5-round tool limit ended the turn with no reply. 4 (valid on the 4th attempt): nine `draft` searches across its rounds, no `suggest-edits`, same ending. 5: every attempt lost to 503/429 before an answer; no verdict. Earlier attempts at 2, 4 and 5 failed only on provider errors and are not counted. |
| 2026-10-04 (×3) | managed `openwop-free` (MiniMax-M3) on `03d21f431` (B.2 four-tool scope + B.5 `noDedicatedMatch` / two-search cap), quiet machine, all provider calls clean | ✓ ✓ ✓ | ✗ ✓ ✗ | INVALID ✓ ✓ | ✗ ✗ ✗ | ✓ ✓ ✓ | manual | manual | ✓ ✗ ✓ | **3/5, 4/6, 4/6** | **The search loop is gone**: 6–8 catalog reads per whole run, and case 2 now draws `addNode core.openwop.ai.classify` with "no dedicated dedupe node" in its why (it passed in run 2). What fails now is narrower. 2 (runs 1, 3) and 8 (run 2): an edge op with no `why` (the prompt asked for one only "when not self-evident"). 4: run 1 drew a correct first batch (form trigger, AI classify, edge) but set no `plannedOps`; runs 2 and 3 read B.5's "fetch its schema with `typeIds`" as the separate `schema.lookup` tool, failed, and ended the turn apologising. 3 (run 1): harness timeout waiting for the canvas, no model call. First draft (4): 28–56k prompt tokens. Fixed in B.6: general blocks carry full schemas, every op gets a why, and `suggest-edits` refuses a first draft without `plannedOps`. |
| 2026-10-04 (×3, after B.6) | managed `openwop-free` (MiniMax-M3) on `4292f287b` (B.6: general blocks with schemas, `plannedOps` required on a first draft, why on every op), quiet machine, all provider calls clean | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | ✗ ✗ ✓ | ✓ ✓ ✗ | manual | manual | ✓ ✓ ✓ | **6/6, 6/6, 5/6 by script; by the written criteria case 4 is 1/3** | 5–6 catalog reads per run. 2: AI-classify dedupe step with "no dedicated node" in its why, 3/3. 4: `plannedOps: 7` every time and built from general blocks, but runs 1 and 2 drew 2 of 7 and stopped (run 2 on "Batch 2: the If branch.", no call) — the scripts pass, the criterion "the final graph validates" does not; run 3 drew all 7 (form, classify, If, CRM create-contact, 3 edges), then its next call hit the local 50,000-token default cap. 5 (run 3): "undoing my rename back to Score lead" and no `suggest-edits` call. First draft 44–50k prompt tokens. Next: B.7 (follow-up keyed on the unfinished plan). |
| 2026-10-05 (B.7, before B.8) | managed `openwop-free` (MiniMax-M3) on `aa8e6160a` (B.7 deployed), quiet machine (load 1.6) | ✗ | ✓ | ✓ | ✗ | ✓ | manual | manual | ✓ | **4/6** | Not counted toward the bar: it found the B.8 defect. 4: planned 7, drew 3; B.7's follow-up fired ONCE, the model answered "Drawing ops 3–5 now." with no call, and the second follow-up could not fire (sending the first disarmed it). 1: "gte isn't supported" (true: edge conditions have no numeric comparison) and it stopped instead of using `setConfig` or an If step. 81k prompt tokens for the first draft. |
| 2026-10-05 (×3, after B.8) | managed `openwop-free` (MiniMax-M3) on `aa8e6160a` + B.8, quiet machine (load under 10 at each start), all provider calls clean | ✓ ✓ ✓ | ✓ ✓ ✓ | ✓ ✓ ✓ | ✗ ✓ ✓ | ✓ ✓ ✓ | manual | manual | ✓ ✓ ✓ | **5/6, 6/6, 6/6 by the written criteria — the behaviour bar is MET (all six in 2 of 3)** | Follow-ups fired 2, 0, 1 times. 4: run 1 planned 7 and drew 6, the CRM step left unconnected after both follow-ups were spent ("Final batch — the conditional edge…", no call); run 2 drew 8 of 8 but its "else" edge targets the CRM step, contradicting its own reply (passes the written criteria, a semantic defect they do not catch); run 3 drew 7 (planned 5), complete. 1: `setConfig threshold 70` each run (run 1 sent `"70"` as a string; run 2 also conditioned `e2` on an invented `qualified` path). 8: asked one question in runs 1–2, three ops with whys in run 3. First draft 140k, 64k, 91k prompt tokens: inside production's 20M allowance, OVER the 50,000 code default fresh installs get. |

**Reading the 2026-10-01 runs together.** Cases 3, 5 and 8 passed every time they were measured; case 1 passed three times of three. Cases 2 and 4 never passed. The failure shape moves between runs (asks questions, announces and stops, malformed ops until the round limit, stops between batches), so no single fix closes them: on this model the multi-step cases are unreliable. Separately, one first draft costs 54–75k prompt tokens, above the managed tier's 50,000-token daily cap, so a first draft cannot complete on the free tier as configured, whatever the model does.

**Reading the 2026-10-03 Gemini run (plan B.3).** A second, independent model fails cases 2 and 4 in the same SHAPE MiniMax often did: it keeps searching the catalog and never draws, until the 5-round tool limit (`DEFAULT_MAX_TOOL_ROUNDS`, `agentDispatch.ts`) ends the turn. That moves the weight of the evidence. "MiniMax-M3 is not good enough at multi-step turns" was the reading after 2026-10-01; with Gemini failing the same way, the round budget and the search-then-draw structure of the turn are at least as likely a cause as the model. The next lever to measure is the turn, not another model: let one round carry several `draft` searches (the model can already batch tool calls), count a catalog search against a separate budget, or raise the round limit for Pair turns only — each to be measured on the same cases. Case 5 still needs a valid run.
