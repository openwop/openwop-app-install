# ADR 0962 — Campaign Studio open agent interface (MCP, A2A later)

Status: Proposed

Date: 2026-10-19

Program: Campaign Studio (ADRs 0941–0962), Tier 5. Net-new plan, not a MyndHyve
port. Depends on ADR 0921 (client = org), 0941 (canonical campaign + client
stamp), 0942 (autonomy policy + the one gate primitive), 0943 (agent team), 0944
(client memory). Composes the shipped MCP server (ADRs 0087, 0553, 0601, 0788).

## Context

Agencies already work inside Claude, ChatGPT and Copilot. The ask: let those
external agents drive Campaign Studio under the same RBAC and the same human
gates as the app's own agents, with external content treated as untrusted and
every action scoped to one client and audited.

Competitive context (2026-10-19 scan): VWO, Braze, Klaviyo and HubSpot ship MCP
servers, and TikTok is reported to (unverified). Each is a **data door into a
closed orchestrator**: an external model reads reports or flips settings
directly, and the vendor's own automation decides the rest. None exposes a
governed, replayable workflow run with role-routed human gates. Ours can,
because an OpenWOP MCP tool **is** a workflow run.

## Boundaries audit (state on `origin/main` at `74d5f18bc`)

Paths under `backend/typescript/src/` unless noted.

**The MCP server exists and is the only door:**

- Mount `POST /v1/host/openwop-app/mcp`, env-gated
  (`routes/mcp.ts:64`, `OPENWOP_MCP_SERVER_ENABLED`); run-starting methods
  `tools/call`, `resources/read`, `prompts/get` (`:47-51`). Two codecs:
  `mcp-2025-06-18-legacy` (`host/mcpServerRouter.ts:1-25`) and `mcp-2026-07-28`
  (`host/mcpCurrentCodec.ts`); shared meaning in `host/mcpSemantics.ts`.
- **A tool is a workflow.** The registry scans workflows for
  `core.openwop.mcp.expose-tool` nodes (`host/mcpServerRegistry.ts:1-12`, `:106`).
  Sources are `host` (chain-backed projections, reviewed gate metadata) and
  `workspace` (the caller tenant's own workflows, launch-gated) — never the
  global registry (ADR 0788 D1, `:14-35`).
- **Gates on a tool:** `mcpRequiresAuth`, `mcpFeatureToggle`, `mcpSafetyTier`
  → `workspace:read|write` (`:207-210`); authority from credential provenance,
  an `owk_` key = its issuer narrowed by declared scopes (`:213-271`);
  `isToolAllowedWith` (`:297-336`). Per-workspace disable list
  (`host/mcpExposure.ts:1-45`).
- **Untrusted by construction.** MCP runs start with
  `metadata: { source: 'mcp-server-mount', trustBoundary: 'untrusted',
  actingUserId: principal }` (`mcpSemantics.ts:404`); args validate against the
  tool's `inputSchema` before start (`mcpServerRouter.ts:26-34`).
- **Audit.** `mcp.decided` rows on the per-tenant hash chain with a closed key
  set — never arguments, content or tokens (`host/mcpAudit.ts:1-45`).
- **Reference consumer.** Notebook tools: `expose-tool → backing node`, writes as
  `expose → core.hitl.approval-request → gated write` (ADR 0087 status block).

**Findings that decide the design:**

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| X1 | **The MCP caller can approve its own run's gate** unless the gate names approvers | MRTR retry resolves the interrupt as a capability-token approver (`mcpSemantics.ts:282-298`); refused only when `needsNamedApprover` (`:321-323`; `routes/interrupts.ts:1266-1269`: quorum > 1 or a declared ACL, `host/approverResolution.ts:322-329`). ADR 0087's own correction says the approval is "the CALLER's confirmation, not a second person's". | A 0942 `approve(role)` gate without a declared role ACL would let Claude approve its own budget change. The hard requirement fails by default. |
| X2 | **MCP authority is tenant-wide** | "RESIDUAL … resolved TENANT-wide — the UNION across the caller's org memberships … does NOT close 'write in org A writes in org B'" (`mcpServerRegistry.ts:279-290`) | per-client checks must live in the backing node (as the notebooks do), never in the tool gate |
| X3 | A2A exists but is the wrong door today | Server env-gated (`routes/agents.ts:837`, `OPENWOP_A2A_SERVER_ENABLED`). The 1.0 card advertises **one host-global** invocable workflow (`host/a2aCard.ts:79-81`, `:178-188`); the 0.3 card lists one skill per installed pack agent (`:91-97`) dispatched straight to `runAgentDispatch` (`host/a2aServer.ts:226-231`), not a run | no tenant- or client-scoped campaign skills; and the 0.3 lane would list the 0943 team as directly dispatchable agents |
| X4 | Client-claimed identity | MCP `clientInfo` is self-asserted (`host/mcpProfile.ts:171`) | "via Claude" is a label, never an authority |
| X5 | Token-lane voter binding is weak | memory note ISWF-23: `POST /interrupts/{token}` admits an unsigned body voter on single-approver gates | another reason every campaign gate must declare an ACL (X1) |

## Decision

### D1 — The door is the existing MCP server; tools are chain packs

Campaign operations ship as a chain pack `campaign-studio.mcp` (RFC 0013 /
ADR 0163), host-sourced, each chain headed by `core.openwop.mcp.expose-tool` with
workflow metadata `{ mcpRequiresAuth: true, mcpFeatureToggle:
'campaign-orchestration', mcpSafetyTier, mcpApproval }`. No new endpoint, route,
codec or tool loop. The `/v1/tools` RFC 0078 catalog projects them automatically.

### D2 — The v1 tool set: reads, and requests that start governed runs

| Tool | Tier | What the run does |
|---|---|---|
| `campaign_list` / `campaign_get` | read | client-filtered campaign reads (0941) |
| `campaign_performance` | read | campaign-intel summary for one campaign |
| `campaign_pending_gates` | read | open gates for one client (titles, role, SLA; no payload content) |
| `campaign_run_status` / `campaign_explain` | read | run state; a link to the 0960 replay view of a decision |
| `campaign_request_change` | write | starts the 0923 change-request chain (interpret → propose → **gate**) |
| `campaign_draft_creative` | write | starts a 0946 variant-set chain; outputs are drafts |
| `campaign_propose_budget_change` | write | starts the 0952 apply-gated reallocation chain |
| `campaign_propose_experiment` | write | starts a 0949 pre-registration chain (locks at a gate) |
| `campaign_brief_to_launch` | write | starts the 0961 autopilot at the client's 0942 level, clamped (D4) |

**There is no tool that publishes, launches, sends, spends or promotes.** Those
are nodes inside the chains above, reachable only after their 0942 gate. A
write tool returns `awaiting-input` with the gate's inbox link, never "done".

### D3 — Per-client scoping lives in the backing node (closes X2)

Every campaign tool's `inputSchema` requires `clientId` (= `orgId`). The first
backing node calls `bindRunToClient(scope, orgId)`
(`features/campaign-ops/surface.ts:33-45`), which needs an acting person, checks
`workspace:read` on that org and stamps the run (ADR 0921's client stamp; a
chain that then acts on a campaign also carries the ADR 0941 run tag, and the two
must name the same org); write chains then require
`workspace:write` on the org in their own nodes. A run stamped A that later names
B fails `wrong_client`. `campaign_list` returns only clients the caller has a row
on (0921 D5); an unknown or foreign `clientId` gets the same not-found.

### D4 — An external agent can never satisfy a human gate (closes X1/X5)

1. **Every gate on a campaign chain declares an approver ACL.** The 0942 gate
   primitive always emits `approverRoleRefs` (role-routed) and, where the policy
   says, `requiredApprovals ≥ 1` plus the client's approvers. Then
   `gateAclOf(...).declared === true`, `needsNamedApprover` holds, and an MRTR
   retry is refused with "decide it in the inbox". A ratchet test walks every
   `campaign-*` chain pack and fails on any `core.approvalGate` /
   `core.hitl.approval-request` node without an ACL.
2. **Self-approval refusal** (ADR 0942 D10.2). The 0942 gate refuses a vote from the run's
   `actingUserId` when the run's `trustBoundary` is `untrusted` (the person whose
   key the agent holds cannot approve what their agent requested; ADR 0905's
   self-approval rule, applied by the gate, not by MCP).
3. **Policy clamp** (ADR 0942 D10.3). For runs with `source: 'mcp-server-mount'`, the 0942 resolver
   clamps `auto` to `approve` for external-effect classes (spend, send, publish,
   post, promote, contact a lead) unless the client policy sets
   `externalAgents: 'auto-within-caps'` (Q1). The clamp is frozen at run start.
4. Behaviour test: an MCP client starts `campaign_propose_budget_change`, then
   retries with `inputResponses` answering the gate ⇒ refused; a human in the
   role approves in the inbox ⇒ run proceeds; the audit chain shows both.

### D5 — Inbound content is untrusted all the way down

- `trustBoundary: 'untrusted'` is already stamped (`mcpSemantics.ts:404`);
  campaign agent nodes read it and fence every argument-derived string
  (`host/untrustedContent.ts`, ADR 0038 §C) — a brief or change description is
  data, never instruction.
- Memory written by such runs is tagged untrusted (ADR 0944 D4); an approval
  surface built from untrusted content goes through
  `assertApprovalSurfaceTrusted` (`mcpSemantics.ts:311`).
- Outputs returned to the external agent are drafts, ids and summaries — never
  secrets, connection details, other clients' names or raw lead PII
  (`campaign_get` returns aggregates; lead-level reads are not exposed in v1).

### D6 — Attribution and audit

- Each run carries host metadata `openwop-app.externalAgent = { protocol: 'mcp',
  codec, clientName (claimed), keyId? }` — advisory and labelled "claimed" in the
  UI (X4). Authority comes only from the principal.
- Audit = the existing three: `mcp.decided` rows, the run event log, and gate
  decisions on the approval audit. No second audit store.
- The 0960 command center shows "requested via Claude (claimed) by Dana, key
  owk_…3f" on the run and its gates.

### D7 — Who can turn it on

Three narrowing switches, all existing or additive: the deployment switch
(`OPENWOP_MCP_SERVER_ENABLED`), the per-workspace exposure list (`mcpExposure.ts`
— an admin can disable any campaign tool), and a new per-client field on
`ClientAccount`: `externalAgents: 'off' | 'read' | 'request'` (default `off`;
`auto-within-caps` only by Q1). A client stakeholder (ADR 0958 collaborator) sees the field in the ADR 0957 portal.

### D8 — A2A: not in v1, and close the side door now

- **No campaign A2A skills in this ADR** (X3): the 1.0 card is host-global and
  public, so tenant/client skills would leak client workflow names; a per-tenant
  authenticated card (`GetExtendedAgentCard`, `extendedAgentCard: false` today) is
  the prerequisite.
- **P0 hardening:** campaign team agents (0943) are excluded from the 0.3 legacy
  skill list and refused by `message/send`, via a manifest flag the card builder
  and router both read (one list, per the card's own invariant). Verify first
  whether `runAgentDispatch` there can reach live tools (Q3).

## Feature evaluation matrix

| # | Dimension | Decision |
|---|---|---|
| 1 | Feature package | No new package: chain pack + backing nodes in `feature.campaign-ops.nodes`; `externalAgents` on `ClientAccount`; the clamp in 0942's resolver. |
| 2 | Toggle | Rides `campaign-orchestration` via `mcpFeatureToggle`; deployment switch + per-client field narrow it. |
| 3 | Workflow surface | None new; backing nodes call existing `ctx.features.campaignOps.*`. |
| 4 | Node pack | `feature.campaign-ops.nodes.mcp-*` backing nodes (read projections, request starters). |
| 5 | Envelopes | None. External intent enters as validated tool args, never an RFC 0021 envelope. |
| 6 | Agent pack | None new; team agents gain an `a2aExposed: false` flag (D8). |
| 7 | Public surface | None; MCP is authenticated (`mcpRequiresAuth`). |
| 8 | RBAC | Tool gate = tenant scope (X2); per-client read/write in the backing node; gates role-routed with declared ACL; self-approval refused. |
| 9 | Replay / fork | MCP runs are ordinary runs: replayable, forkable; the clamp and client stamp are frozen at start. |
| 10 | Frontend | "External agents" card in the client page (switch, recent MCP runs, connect instructions reusing the ADR 0788 "connect an AI client" surface). |

## Why this is our advantage

- **Primitives:** MCP server composition (RFC 0020/0153), tools-as-workflows,
  durable runs with replay/fork, role-routed gates with declared ACLs, client
  stamps, the audit hash chain.
- **Gap closed:** every incumbent MCP server is a data door that lets an
  external model act directly or not at all. Ours lets Claude *request* any
  campaign operation and guarantees a named human in the right role signs off,
  scoped to one client, with a replayable record.

## Phased plan

| Phase | Scope | Exit criteria |
|---|---|---|
| P0 | D4.1 ACL ratchet + D4.2 self-approval refusal in the 0942 gate; D8 A2A exclusion | MRTR self-approval test red before, green after; A2A 0.3 card lists no team agent |
| P1 | Read tools + `campaign-studio.mcp` chain pack + `externalAgents` field | Route test via the MCP mount: client B invisible to an A-only operator; `/v1/tools` lists them only with the toggle on |
| P2 | Request tools (change, creative draft, budget, experiment) + D4.3 clamp | End-to-end: Claude-style client requests a budget change, gate lands in the inbox, MCP retry refused, human approval proceeds |
| P3 | `campaign_brief_to_launch` (after 0961) + UI card + attribution | Command center shows claimed client + principal |
| P4 | A2A study: authenticated extended card, tenant-scoped skills | Decision recorded; RFC filed if the card shape changes |

## Alternatives

- **A bespoke REST "agent API"** — rejected: a second door with its own auth and
  audit; MCP already has both.
- **Direct-action tools (publish, set budget)** — rejected: the data-door model
  this ADR exists to beat; it bypasses 0942.
- **Trust MRTR approval as the human's confirmation** (ADR 0087's posture) —
  rejected for campaigns: spend and publication need a second person in role.
- **Expose campaign agents over A2A now** — rejected (X3).

## RFC verdict

**MCP phases (P0–P3): host work riding Accepted RFC 0020 (host MCP server),
RFC 0078 (tool catalog) and RFC 0153 (served by ADR 0553) — no new RFC.**
Gate ACLs, the clamp and the client field are host behaviour.
**⚠ P4 (A2A) may need an OpenWOP RFC:** tenant-scoped skills on an authenticated
extended card change what `a2a-integration.md` §C ties a card's `skills[]` to.
Do not build P4 without `/prd` first.

## Open questions

1. **(David)** May a client ever let an external agent act without a human gate
   (`externalAgents: 'auto-within-caps'`, inside 0952 spend caps)? Recommended:
   not in v1.
2. **(David)** Is the MCP mount on in production for the agency demo? (ADR 0788
   turned it off on 2026-09-30 pending its fixes; re-measure before P1.)
3. Can the A2A 0.3 `runAgentDispatch` lane reach live tools? If not, D8's
   exclusion is defence in depth; if so, it is a P0 Blocker.
4. Should `campaign_pending_gates` be callable at all by an external agent, given
   it reveals which roles are bottlenecks? Recommended: yes, titles only.
5. Should a run started by an `owk_` key whose issuer later loses the client role
   be cancelled at its next gate? Recommended: yes — re-check the issuer per use
   (the "grants checked once" lesson).

## Planning rows

- **ROADMAP** (Campaign Studio program, Tier 5, after 0961; P0 hardening may land
  with 0942): `| 22 | **Open agent interface (MCP)** (ADR 0962) |
  `campaign-orchestration` (+ per-client `externalAgents`) | 0921, 0941, 0942,
  0943, 0944, 0087, 0553, 0601, 0788 | chain pack `campaign-studio.mcp`,
  `feature.campaign-ops.nodes.mcp-*` | Host extension (MCP); A2A phase may need an
  RFC | 🔵 Proposed |`
- **FEATURES Future features:** "**Campaign Studio open agent interface (ADR
  0962, Proposed)** — Claude, ChatGPT and Copilot drive Campaign Studio through
  the existing MCP server: read tools plus request tools that each start a
  governed chain run, scoped to one client, untrusted-fenced, audited. No tool
  publishes, sends or spends; every campaign gate declares a role ACL so an
  external agent can never approve its own request. Per-client `externalAgents`
  switch (default off). A2A deferred. No RFC for the MCP phases."
