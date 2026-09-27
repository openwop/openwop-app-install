# ADR 0724 — Safe mode's egress-class gate guards an EMPTY population; imply it anyway, and witness it against the real tool ids

Status: implemented

**Feature:** AI chat permission mode (safe / bypass) (`FEATURES.md` ordinal 218) · ADR 0135/0150/0610 · feature-loop 2026-09 it.50
**Corrects the closure record of:** `PMC-1` (ADR 0610 D5, #3515) — closed by a witness that fed a name the runtime never presents

## Context

`PMC-1` filed that safe mode gated a 4-name allowlist (`SENSITIVE_APPROVAL_TOOLS`) rather than the egress CLASS. ADR 0610 D5 (#3515) added a class gate keyed on the raw capability descriptor (`resolveToolCapability(name)?.egress === 'host-mediated'`) behind an opt-in flag, `gateHostMediatedEgress`, and witnessed it in `test/permission-mode-firewall.test.ts` §PMC-1.

### What this ADR was first drafted to say — and why that was wrong

The first draft (commit `1c2d6aa6c`) said: *two of the four production callers of `buildFirewallHook` never pass the flag, so the same allowlisted egress sender asks in chat and runs unasked over voice and direct dispatch — latent, but one tenant config away.* The four-caller table was right. The rest was not, and it is recorded here because a citation is a claim, not evidence:

| caller | name gate | `gateHostMediatedEgress` |
|---|---|---|
| `host/conversationToolLoop.ts:485` (chat) | ✅ | ✅ |
| `host/agentRunnerNode.ts:152` (workflow agent-runner) | ✅ | ✅ |
| `features/voice/realtime/toolBridge.ts:141` | ✅ | ✗ |
| `routes/agents.ts:407` — `POST …/agents/:agentId/dispatch` | ✅ | ✗ |

(The A2A server, `workforceEval` and the kicktodo check use the SYNCHRONOUS `runAgentDispatch` — a deterministic turn with no model call and no tool execution, `agentDispatch.ts:232` — and `routes/agents.ts:836` is the RFC 0090 verifier harness. None is a tool-executing lane.)

**MEASURED at `dc11f1088`, after a full `createApp` boot:** `builtinAgentToolIds()` returns **201** ids. **All 201 are `openwop:`-prefixed. `resolveToolCapability` classifies 2 of them** (`openwop:knowledge.search`, `openwop:ai.research.web`) **and 0 as `egress:'host-mediated'`.** The classifier's egress keys (`toolCapabilityResolver.ts:25-34`) are NODE type ids — `core.openwop.integration.email-send`, `core.openwop.a2a`, `core.openwop.mcp` … — and no agent tool is ever named that way: node-projected tools are `openwop:${typeId}` (`agentToolProvider.ts:149`) and only pure compute nodes are projectable (`PROJECTABLE_COMPUTE_NODE_TYPE_IDS`). MCP client tools are not agent tools at all.

So:

1. **The class gate cannot fire on any name the runtime presents — in ANY lane, including the two that pass the flag.** The two "ungated" lanes are not behind the two "gated" ones; all four are equal, and the gate is decorative in all four.
2. **The ADR 0610 D5 witness is vacuous.** `EMAIL_SEND = 'core.openwop.integration.email-send'` is a node type id, not a registered tool id. The test proves the hook's contract on a synthetic name; it proves nothing about production. This is the fifth "the test measures the wrong artifact" instance of this loop (0714 fixture, 0715 ratchet, 0718 guard, 0719 leg, and now a witness).
3. **"One config away" was false.** An allowlisted `core.openwop.integration.email-send` cannot resolve (`BUILTINS.get(name)` → `undefined`, `agentToolProvider.ts:673`); dispatch reports the tool unavailable. Nothing runs unasked.
4. **What actually gates off-host egress in safe mode today is the NAME set:** `openwop:core.openwop.http.fetch` — the one real off-host egress agent tool — is in `SENSITIVE_APPROVAL_TOOLS` (`firewallHook.ts:75`) and therefore ASKS in all four lanes. The name set is the working half; the class gate is the decorative half. `PMC-1`'s premise ("a name set is the wrong instrument") was reasonable; its closure was not real.

### The adjacent defect this ADR does NOT fix, with its blast radius

The same prefix mismatch means `openwop:core.openwop.http.fetch` is **unclassified** (the `core.openwop.http` → `safe-fetch` row never matches the `openwop:`-prefixed name), so under the default `unknownToolPolicy:'treat-as-risky'` it evaluates against tenant RULES as `RISKY_FALLBACK` (`egress:'host-mediated'`). Normalizing the prefix in the resolver would reclassify it to `safe-fetch` — a **relaxation** of any tenant rule keyed on the host-mediated class (the it.41 shape: a fix that weakens a gate). That is the capability-firewall feature's decision, filed there with this measurement; it is deliberately not made here.

## Decision

### D0 — Correct the record, and witness the gate against the REAL population

`PMC-1` is re-opened as **closed-vacuously** and re-closed by this ADR with a witness that runs against `builtinAgentToolIds()` after a real boot: it PINS that the egress-classified registered set is `[]`, that every registered id is `openwop:`-prefixed, that the ADR 0610 witness name is not a registered id, and that the one real off-host egress tool is covered by the name set. The pin is a ratchet in both directions: the day a registered tool classifies as host-mediated egress, the test forces the decision "does safe mode ask?" to be made on purpose — and if the resolver is ever normalized, it forces this ADR to be revisited.

### D1 — Safe posture IMPLIES the class gate, inside `buildFirewallHook`

`gateHostMediatedEgress` defaults to **true whenever `requireApprovalTools` is supplied** (`opts.gateHostMediatedEgress ?? (opts.requireApprovalTools !== undefined)`); an explicit `false` remains a legible opt-out. Kept from the first draft as hygiene, stated honestly: it makes the four lanes equal BY CONSTRUCTION so that when D0's pin goes red the gate is live everywhere at once, rather than in whichever lanes remembered a flag. It changes no verdict today (measured: no registered tool is class-gated). No caller supplies an empty set; "supplied" is the signal, not truthiness.

### D2 — The voice bridge's parity claim gets a witness, and its docblock stops overstating

`toolBridge.ts:5-6` promises a voice action is gated "exactly like a typed one". A parity leg drives the voice/dispatch hook shape and the chat hook shape over the same names and asserts identical verdicts. The docblock cites it.

### D3 — The dead fail-open shape at `firewallHook.ts:222` is left as-is, noted

`catch { egressGated = false }` reads fail-open, but `resolveToolCapability` is a pure loop over a const table and cannot throw; the branch is unreachable. Noted, not changed — a change there would be a no-op dressed as a fix.

## Alternatives weighed
- **Normalize the `openwop:` prefix in the resolver so node-projected names classify.** Rejected HERE (see blast radius above): it reclassifies `http.fetch` and can relax a tenant rule. Filed for the capability-firewall feature with the measurement.
- **Pass the flag at the two sites.** Closes an instance of a gate that guards nothing; the class-vs-list mistake `PMC-1` was about, repeated.
- **Delete the class gate as dead code.** Rejected: the population is empty today, not impossible (a projected egress node would populate it), and D0's pin makes the emptiness visible rather than silent.

## RFC verdict

Host-only. `buildFirewallHook` is a host composition seam behind the ADR 0135 firewall; nothing on the OpenWOP wire changes. No RFC.

## Implementation record

| Phase | Change | Witness |
|---|---|---|
| D0 | `PMC-1` row corrected in `CODEBASE-ASSESSMENT.md` | `test/safe-mode-egress-gate-implied.test.ts` §D0 (boot-backed pins) |
| D1 | `firewallHook.ts` — `gateEgress` derived once; both reads use it | §D1 leg 1 born-red on the pre-ADR hook (the literal option shape of the two lanes) |
| D2 | `toolBridge.ts` docblock corrected | §D2 parity leg |

## Open questions
- [ ] Capability-firewall feature: normalize the resolver's namespace (with the `http.fetch` reclassification consequence measured above) — or re-key the egress rows on the names the runtime actually presents.
