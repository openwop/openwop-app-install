# ADR 0557 — Public docs as MCP tools on the RFC 0020 inbound mount

Status: Proposed
Date: 2026-08-13
Origin: UX_UPGRADE-docs round 3 (/feature-refinement over the 2026-08-07
competitive refresh) — "Docs MCP servers are standard (Mintlify `<site>/mcp`,
Stripe `mcp.stripe.com`, GitBook MCP + one-click connectors)"; agent traffic
exceeded human traffic on Mintlify-hosted docs in July 2026.

## Decision (proposed)

Expose the PUBLIC product docs as MCP tools on the host's EXISTING RFC 0020
inbound MCP server mount, as an **extension of the `docs` feature** (toggle id
`docs` unchanged; a `docs.mcp` SUB-toggle gates the new surface, the ADR 0424
`app-builder.deploy` sub-toggle precedent). Two read-only tools, following the
ADR 0087 notebooks-as-MCP-tools shape verbatim (expose-tool 2-node workflows;
`docs.mcp.` workflowId prefix):

- `docs-list` — the ordered nav projection (slug, title, group, updatedAt) the
  sidebar renders; backed by the same `docsService` nav read.
- `docs-get-markdown` — one doc as markdown; backed by **publishing's
  `pageMarkdown`** (`sectionMarkdown.ts`, behind `publishing/routes.ts:92`) —
  the single owner of the markdown projection. COMPOSED, never forked; its
  full-SECTION_TYPES coverage gate keeps protecting this consumer for free.

## The tenant question IS the design

Docs are public, so the tempting default — resolve the tenant from the CALLER —
is the wrong subject (the invitations R2 lesson: gating an unauthenticated
surface on the caller's tenant resolves 'default' and serves the wrong data).
**The tenant comes from the RESOURCE**: the public-site org
(`OPENWOP_PUBLIC_SITE_ORG_ID`), exactly as the root `llms.txt` door resolves it
(docs R2 / ADR 0392 correction). The tools serve PUBLISHED docs of that one org,
for any caller the gate admits — never the caller's tenant's drafts.

## Anonymous access — the open question, framed

`isToolAllowed` (`mcpServerRegistry.ts:171`) already supports ungated tools:
absent `mcpRequiresAuth`/`mcpFeatureToggle` metadata ⇒ allowed for anyone. So
anonymity is a POLICY choice, not new machinery. The cases:

- **For anon-allowed**: the same content is already anonymous over HTTP
  (`/docs`, the `.md` door, `llms.txt`) — an authed-only MCP door protects
  nothing and breaks the Mintlify/Stripe parity the market row cites (both are
  unauthenticated).
- **Against**: the MCP mount creates RUNS (`insertRunWithStartContext`), and
  every leader's public MCP is backed by purpose-built serving, not a workflow
  engine. Anonymous callers minting runs is an abuse surface HTTP GET is not
  (run-creation rate limits are tighter than read limits, but per-IP anon runs
  need a cap review before this ships).

**Proposed resolution** (open until an operator decision): ship Phase 1
authed-only (metadata `mcpRequiresAuth` + `mcpFeatureToggle: 'docs.mcp'`,
byte-identical to the notebooks gate), and open anonymity in a Phase 2 ONLY
with a per-IP anon-run budget measured and enforced on the MCP mount. The
market-parity claim stays UNADVERTISED until Phase 2 (capability honesty —
never advertise what the gate refuses).

## Boundaries audit (Step 3, verified)

- RFC 0020 mount EXISTS (`host/mcpServerRouter.ts` — tools/resources/prompts
  dispatch, untrusted-boundary propagation, schema validation before run
  start). This rides an **Accepted RFC → NO new RFC** (Step 5 verdict).
- ADR 0087 precedent EXISTS end-to-end (`notebooks/mcpToolsWorkflows.ts`:
  expose-tool manifests, prefix gating in router + `/v1/tools`).
- Markdown projection: single owner is publishing (`sectionMarkdown.ts` +
  `pageMarkdown`); the R2 coverage gate (full SECTION_TYPES) transfers.
- Nav projection: single owner is `docsService` (feature.docs).
- No route collision (no new HTTP routes; the mount is existing).
- Capability honesty: nothing advertised until the phase that honors it.

## Evaluation matrix (rows that bind)

1 Feature-package: extension of `docs` (new `docs/mcpToolsWorkflows.ts`), no
core edits. 2 Toggle: `docs` unchanged + `docs.mcp` sub-toggle default OFF.
3 ctx surface: none new (the tools ride workflows, not `ctx.docs`). 4 Node
pack: NONE new — the backing nodes are the 2-node expose workflows per ADR 0087
(registered from the feature, not a builtin pack; chains-or-stacks doctrine
untouched). 5 Envelopes: none. 6 Agent pack: none (this is an EXTERNAL-agent
surface; internal agents already read docs via chat tools). 7 Public surface:
no new HTTP paths; tenant from the RESOURCE (public-site org). 8 RBAC:
read-only tools; Phase-1 gate = authed + `docs.mcp`. 9 Replay: runs are
read-only and replay-safe (ADR 0087 property, inherited). 10 Frontend: none in
Phase 1; a Phase-2 "Connect your agent" affordance on `/docs` is deferred.

## Alternatives weighed

- **A raw HTTP `<site>/mcp` serving endpoint** (what Mintlify does) — rejected:
  a second MCP implementation beside the RFC 0020 mount duplicates dispatch,
  trust-boundary, and schema-validation machinery the host already owns.
- **Docs as MCP RESOURCES (`resources/read`) instead of tools** — viable and
  cheaper for agents; deferred to Phase 2 alongside anonymity (resources
  enumerate the whole nav per list call; the tool shape matches ADR 0087 and
  ships with proven gating today).
- **Do nothing** — rejected by the market row, but honestly restated: this is
  parity infrastructure for agent consumers, not a human-UX gap; it should not
  jump the queue ahead of human-facing defects.

## Phased plan

| Phase | Scope | Verify |
|---|---|---|
| P1 | `docs/mcpToolsWorkflows.ts` (2 tools, authed + `docs.mcp` gate); registered from `feature.ts`; tests mirroring `notebooks-as-mcp` (gate on/off, anon refused, content = the HTTP projections byte-for-byte) | vitest + the ADR 0087 gate tests as template |
| P2 | Anonymity decision (operator) + per-IP anon-run budget on the mount + resources/read shape + `/docs` connect affordance + THEN advertise | budget measured before enforced (ADR 0504 lesson) |

## Open questions

- [ ] Phase-2 anonymity: operator decision + the anon-run budget number.
- [ ] Should `docs-get-markdown` accept a locale (the RFC 0103 negotiation the
      HTTP door performs)? Phase 1 serves base-locale only; stated in the tool
      description so a model does not assume localization.
- [ ] MCP mount rate limits for authed callers — present but not docs-tuned.

## PRD-vs-architecture corrections

The market row implies "an MCP server" as a standalone endpoint; expressed here
as workflows on the EXISTING mount (composition over a parallel server). The
row's implicit anonymity is split into a phase behind an explicit budget rather
than assumed.
