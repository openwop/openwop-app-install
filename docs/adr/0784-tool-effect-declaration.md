# ADR 0784 — Agent tools declare their effect: the receipt says what a turn read and what it changed

Status: implemented (P1–P3); P4 optional, not started

## Context

The Chat Studio design (ADR 0768; canvas "Moments 01", "Studio" feed) has every
turn's receipt say what it READ and what it WROTE: "Read brief.md · ran
/launch-plan · 4 tools". Today the receipt (`chat/TurnReceipt.tsx`) can only
count tool calls and failures. Nothing declares whether a tool reads or changes
anything:

- `BuiltinTool` (`host/agentToolProvider.ts`) has no effect field. MEASURED at
  `origin/main` 2026-09-29: **187** `registerFeatureAgentTool(` call sites, plus
  the generated compute-node tools (`openwop:<typeId>`, "pure, deterministic").
- MCP tools can carry `annotations.readOnlyHint`; this host consumes none.
- Tool calls reach the browser as `agent.toolCalled` / `agent.toolReturned`,
  which are SPEC run events. An `effect` field on them is a wire change.

A receipt that guessed from tool NAMES ("get-*" reads) would be a false
statement the first time a name lies, and this repo has a record of names lying
(the Proposals/ADR 0473 lesson).

## Decision

1. **`BuiltinTool.effect: 'read' | 'write'` — REQUIRED**, exactly as
   `contentTrust` became required (RFC 0137 §F1: 166 of 168 had defaulted to a
   fail-open value). The compiler is the ratchet: no tool registers without a
   decision. A factory that builds tools takes `effect` as a parameter and
   never hardcodes it (the `features/commerce/agentTools.ts` `readTool` rule).

   THE RULE, in order:
   - `'write'` if a call can change anything durable in this host (rows, cards,
     artifacts, canvases, settings, memory) OR cause an effect outside it
     (email/SMS/push, a webhook, a payment, a post, a connector write).
   - `'read'` otherwise, including external READS (web search, http GET
     fetches) and pure computation.
   - A tool whose effect depends on an argument (`mode: "preview" | "apply"`)
     is `'write'`. The receipt must never under-report a change.

   > **Correction (2026-09-29, during P1 classification).** Three tools
   > forced a boundary the rule above did not draw. A search that refreshes a
   > stale embedding index (`discovery.search`), a read that lazily creates an
   > empty container on first use (`job-search.applications.read`), and a read
   > that writes a one-time security binding (`builder-pair` read-canvas) all
   > persist SOMETHING, but a receipt saying they "changed 1 thing" would be
   > false to the user. So `'write'` means a change the USER would recognize as
   > content or state: **derived caches and indexes, lazy bootstrap of an empty
   > container, internal bindings, and audit/telemetry rows do not count.** Each
   > such tool carries an inline `// ADR 0784:` note saying why it is a read.

2. **Display only, never authorization.** `effect` feeds the receipt. It is
   NOT an input to HITL gating, capability checks or permission modes, which
   keep their own owners. A mislabeled tool therefore misstates a receipt; it
   cannot bypass a gate.

3. **No wire change.** A host-extension catalog,
   `GET /v1/host/openwop-app/chat/tool-effects` → `{ [toolName]: 'read' | 'write' }`
   for the caller's tenant (the pack allowlists already decide what is
   visible), cached client-side. The receipt joins it by the tool name already
   on `agent.toolCalled`. An unknown name (an MCP tool, a tool added after the
   cache) renders as neither, never as a guess.

4. **Receipt copy:** "2 reads · 1 change" in the one-line receipt; the expanded
   receipt tags each tool row. Naming the OBJECT ("brief.md") is a follow-up:
   it needs a per-tool, closed-world label source, not free text from args.

## P1 record

| Item | Where | Test |
| --- | --- | --- |
| `effect` required on `BuiltinTool`; 196 compile errors resolved: every literal registration plus two factories (`computeNodeTool`, `knowledgeRetrieverTool`, commerce `readTool`) now take it as a parameter | `host/agentToolProvider.ts`, 70 feature files | tsc |
| Values pinned: every tool is read or write, both kinds are well represented, and a fixed sample of known readers and writers holds | — | `tool-effect-declaration.test.ts` (flipping `kanban.add-todo` to read turns it red) |

Classification was done by reading each tool's `run` body, with evidence per
tool, never by name. It surfaced two authorization defects, fixed separately
because they are live (see §Found while classifying).

### P2 / P3 record

- **P2 — ask-by-name, not a catalog.** `GET /v1/host/openwop-app/chat/tool-effects?names=a,b`
  (`host/toolEffects.ts`) answers ONLY for names the client already holds
  from its own turns, so the host's tool list is never disclosed. Exact id
  first, then the provider-sanitized spelling (`openwop_kanban_add-todo`) in
  case a surface recorded the name the model used. Unknown names (MCP, late
  registrations) are OMITTED. Capped at 50 names. The join key is
  `agent.toolCalled.toolName`, which the dispatch loop reverse-maps to the
  original id. v1-reliance ratchet 746 → 747 (one stated path).
- **P3 — the receipt.** `chat/lib/toolEffects.ts` caches per name for the
  session; an unknown name is asked once, and a FAILED read caches nothing
  (the neutral copy stays; a later render may retry). `TurnReceipt` says
  "2 reads · 1 change"; any tool without a known effect stays a neutral
  "N tools", so the line with nothing known is exactly the old one. Each tool
  row in the expanded receipt carries a reads/changes tag.

| Item | Test |
| --- | --- |
| Route: read + write, sanitized spelling, unknown omitted, cap | `tool-effects-route.test.ts` (4); dropping the sanitized fallback, or guessing unknown as read, each turns one red |
| Receipt copy + row tags + neutral fallback | `turnReceiptEffects.test.tsx` (4); counting unknown as read turns 3 red |
| Cache: unknown asked once; failure cached as nothing | `lib/__tests__/toolEffects.test.ts` (2); caching a failure turns one red |

### Found while classifying

- **JOBS-SCOPE-1**, `job-search.applications.read`, and **BI-SCOPE-1**,
  `bi.run-metric`, passed the model-supplied `orgId` straight through where
  their HTTP routes gate with `authorizeOrgScope(…, 'workspace:read')`, breaking
  the CLAUDE.md rule that a tool SHARES its route's predicate. BI was worse: an
  omitted `orgId` disabled the org filter. Both now use `resolveReadOrgScope`;
  `agent-tool-org-scope-jobs-bi.test.ts` fails 3 of 5 on the old code.
- Two tool DESCRIPTIONS contradict their code: `ucp-buyer` track-order says
  "Read-only" but persists status; the accessibility alt-text module comment
  says WRITE but only returns a proposal. Follow-up; no behaviour change here.

## Alternatives rejected

- **Infer from the tool name.** Unfalsifiable and wrong on first contact.
- **`effect` on `agent.toolCalled`.** Correct long-term, but it is the OpenWOP
  wire: an RFC first. Recorded as the follow-up in §RFC gate. The catalog is
  forward-compatible, since the event field would simply supersede the join.
- **Optional field with a `'read'` default.** The exact fail-open shape
  `contentTrust` was made required to escape. A default of `'write'` would
  make every receipt claim changes that did not happen, which is equally false.

## Phases

| Phase | Scope | Gate |
| --- | --- | --- |
| P1 | Add the required field; classify all registrations in ONE PR (the compiler lists every site); factories take a parameter; a test pins that every `openwop:<typeId>` compute tool is `'read'` | tsc + a count test (registrations == classified) |
| P2 | `tool-effects` ask-by-name route + client cache (see §P2/P3 record — NOT a catalog) | route test incl. an unknown tool |
| P3 | Receipt copy + per-row tags | `TurnReceipt` tests; sabotage: a write shown as read turns red |
| P4 | (optional) MCP `readOnlyHint` → `'read'` for external tools, labeled as SERVER-DECLARED (untrusted) | — |

## Open questions

- [ ] Is a `'read'` of attacker-writable content worth distinguishing in the
      receipt? `contentTrust` already knows. Proposed: no. Keep one axis.
- [ ] Does any tool need `'write'` only for some tenants (feature-toggle
      dependent)? Classify by what the call CAN do, so `'write'`.

## RFC gate

None for P1–P4: `BuiltinTool` is host-internal and the catalog lives under
`/v1/host/openwop-app/*`. Putting `effect` on `agent.toolCalled` so OTHER
clients can render it is an RFC in `../openwop` (RFC 0064 lineage), and is not
required by this ADR.
