# ADR 1009 — an approval in a run that read untrusted content is decided in the app

Status: implemented (2026-10-30), P1. P2 is open.

## Context

RFC 0256 §C says trust restricts who may approve. `SECURITY/threat-model-prompt-injection.md` §2a makes a turn's trust the meet of its inputs.

On this host the error code `untrusted_content_blocks_approval` has no production thrower: its one caller returns early unless a test seam is on (`a2uiSurfaceAdmission.ts:194`).

**Severity, corrected.** The review called this High. That overstated it. Model and tool content cannot resolve a gate, because every resolution comes through an authenticated lane. The real gap is narrower: the capability-token lane proves possession of a link, not who holds it (ISWF-23), and an approval that untrusted content may have shaped could be decided by anyone holding that link. Medium.

## Decision

1. A run carries a sticky bit, `metadata['openwop-app.untrustedContext']`, written with `mergeRunMetadata(..., { ifAbsentKey })`: atomic and write-once.
2. `resolveAndResume` refuses a capability-token resolution of an `approval` when the bit is set, when `metadata.trustBoundary === 'untrusted'`, or when the run row is missing. The refusal is `403 forbidden`, reason `approval_requires_session`.
3. Session lanes are not refused. Blocking approval outright would disable it after any read, the case `read-then-egress` sends to a person.
4. Nodes reach the bit through one narrow method, `ctx.markUntrustedContext()`. The agent runner calls it before each tool runs and when a turn's first message carries untrusted content.

The check is one row read on a path that already reads the run. ADR 0755 removed a whole-log read here for cost, which rules out deriving the bit from events.

## Alternatives

- **Stamp each interrupt, as ADR 1001 does.** Rejected. Other nodes mint approvals after the agent turn has ended, and the run-lane held-tool path ends the turn without minting one.
- **Derive it from the event log at resolve.** Rejected, per ADR 0755.
- **A shadow period, or an exception for the send-approval flow (ADR 0862).** Rejected by the user on 2026-10-30, who was shown this consequence and chose "Ship it enforced". RFC 0256 R1 is the risk this accepts.

## Consequences

- An emailed approval link for a run where an agent used any tool stops working: it answers 403 and tells the person to decide in the app. In-app approval still works. This is the user's decision of 2026-10-30, enforced from deploy with no shadow period, and it includes the send-approval flow.
- **Correction 2026-10-30, found by the gate (train 298).** The token lane has more users than the email link, and Decision 2 reaches all of them:
  - **MCP.** The `requestState` retry resolves as a capability token and every run on the mount has `trustBoundary: 'untrusted'` (`mcpSemantics.ts`), so no approval on an MCP-started run can be decided over MCP. It answers `isError` with the app text and the gate stays open. This is kept, not excepted: `requestState` carries no approver identity (ADR 0778 D5), and RFC 0256 §C requires the acting person bound to the interrupt. Non-approval interrupts on the mount still resolve.
  - **Triggers.** A trigger-started run is `trustBoundary: 'untrusted'`, so its emailed link is refused even if no agent used a tool.
  - **Bearer callers.** `deriveReviewer` treats a `bearer:` principal as the token lane, so an API key cannot decide an approval on a marked run.
- Forks copy metadata, so a fork of a marked run stays marked, which is the safe direction.
- This enforces the lane, not named-person binding. A workspace member with a session may still decide, subject to existing approver rules.

A new solution for email approvals is noted for future consideration in `ROADMAP.md` § "Future: email approvals".

## Not covered (P2)

These can consume untrusted content in a run and do not mark it yet:

- `core.openwop.mcp` and `core.openwop.a2a` nodes
- the bootstrap LLM-tools loop (`bootstrap/nodes.ts:2245`)
- pack calls to `ctx.callAIWithTools` (2 files)

## Implementation record

| Phase | Result | Witness |
| --- | --- | --- |
| P1 | `host/approvalTrust.ts`, `routes/interrupts.ts`, `executor/executor.ts`, `host/agentRunnerNode.ts`, `host/agentDispatch.ts` | `test/adr1009-approval-trust.test.ts`, sabotage-witnessed |
| P1 correction | `host/mcpSemantics.ts`, `host/hostCapabilityGates.ts` | `test/adr0962-p0-campaign-gates.test.ts`, `test/executor-capability-gate-ratchet.test.ts`, sabotage-witnessed |
| P1 production smoke | Passed on 2026-10-31, run by the user in the browser on `app.openwop.dev`: control token 200; token on a trigger-started run 403 `approval_requires_session`; in-app decision 200; trigger deleted 204 | The live responses |
