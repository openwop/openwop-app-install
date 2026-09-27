# A10 — interactive-artifacts + code-exec (chat-first port review)

Scope: the Visualizer's interactive-artifact tools (CFP-1) and the code-exec
builtin agent tool (`openwop:feature.code-exec.nodes.run`), across the three
lanes an agent can execute a tool on: **chat**, **run** (workflow / scheduled /
heartbeat dispatch via `agentRunnerNode`), and **voice** (realtime bridge).

### Verdict table

| Capability | Today | Verdict | Port target |
|---|---|---|---|
| render interactive artifact | agent tool `interactive-artifacts.render` | PORTED (CFP-1) | real render node + `persistRunArtifact` |
| run code (chat) | `code-exec` builtin, gated by ADR 0150 firewall | PAGE-LEGIT | keep — already gated + now projects an artifact |
| run code (run lane) | dispatched via `agentRunnerNode`, **no firewall** | PARALLEL (ungated side-effect) | wire the same firewall hook; require-approval → escalated |
| run code (voice) | firewall built only when rules exist, no `requireApprovalTools` | PARALLEL (ungated side-effect) | always-build the hook in safe mode; typed refusal |
| code execution artifact | `code.execution-result` type registered but **never produced** | THEATER (advertised, dropped) | project the result via `persistRunArtifact` |

## Correction note — 2026-07-22

The original A10 audit claimed the **chat lane bypasses the code-exec approval
gate**. That claim was **wrong**. The chat lane already gates the SENSITIVE
tools (code-exec / file-write / off-host egress) behind the ADR 0150
permission-mode firewall: `conversationToolLoop.ts` builds the hook with
`requireApprovalTools: SENSITIVE_APPROVAL_TOOLS` in safe mode (see
`conversationToolLoop.ts:461-466`), so a chat-driven `code.execution` already
surfaces the "Run code?" `interrupt.approval` card. (Architect scouting caught
this before implementation.)

The REAL gaps — now fixed:

1. **Run lane had no firewall.** `agentRunnerNode.ts` called
   `runAgentDispatchLive` with no firewall option, so a workflow / scheduled /
   heartbeat agent could execute a SENSITIVE tool ungated. Fixed: the node now
   builds the same `buildFirewallHook` (tenant rules + posture, always safe
   mode — a headless run has no interactive user to pre-authorize, so
   `bypassApproval:false`) and threads it through `LiveDispatchDeps.firewall`
   into the shared tool loop. A `require-approval` verdict is collected as a
   pending approval and mapped by `runToolLoop` to an **escalated**
   `AgentDispatchResult` (carrying the held tool names + an honest message), so
   the SENSITIVE action never runs without either an approval or an escalation a
   human sees. `deny` still blocks outright.

2. **Voice lane built the hook without `requireApprovalTools`, and only when the
   tenant had rules.** So a rule-less tenant ran SENSITIVE tools ungated over
   voice, and even a ruled tenant never applied the safe-mode baseline. Fixed:
   `toolBridge.ts` now builds the hook ALWAYS with
   `requireApprovalTools: SENSITIVE_APPROVAL_TOOLS` + `bypassApproval:false`; a
   `require-approval` verdict returns a typed, honest refusal
   (`{ error: 'approval_required', message: … }`) the model relays — never a
   silent execution. The voice approval-CARD UX is deferred (A7 follow-on).

3. **The `code.execution-result` artifact was advertised but never produced.**
   The chat CODE_EXEC builtin returned stdout/stderr/exitCode as plain tool text
   and dropped the registered artifact type. Fixed: after a successful run it
   persists a typed `code.execution-result` artifact via `persistRunArtifact`
   (deterministic key `chat-code:<conversation|user>` + `run:<sha256(code)[:12]>`,
   role `deliverable`) so it lands in the same workbench/Library lane as a
   run-produced artifact, and returns `artifactId`/`artifactKey` in the tool
   result. Best-effort: a persist failure never fails the execution result.

### Deferred honestly

- **Voice approval-card UX** (A7 follow-on): the voice lane refuses SENSITIVE
  tools honestly but cannot yet render an in-voice approval card; the user must
  approve from chat. Not built here.
