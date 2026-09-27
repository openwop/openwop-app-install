# ADR 0315 — Default-on agent tool baseline (the six grounding tools)

Status: implemented (2026-07-07)

## Context

The ADR 0308/0309/0311 grounding loop (promise → todo → proposal → deliverable)
shipped and deployed, but every one of its tools is **default-deny**: an agent
only sees a tool if its (signed) pack manifest lists it in `toolAllowlist`, or a
super-admin sets an ADR 0104 per-(tenant, agent) override. In practice nothing
grants them — the loop is live but inert, and "grant six tools to every agent on
every tenant, forever, by hand" is operationally dishonest (new agents would
arrive ungranted).

Maintainer decision (2026-07-07): these six are **platform capabilities, not
per-agent privileges** — on by default for every agent:

| Tool id | Ships with |
|---|---|
| `openwop:kanban.add-todo` | core (ADR 0311 D1) |
| `openwop:documents.draft` | documents feature (ADR 0308 D2 seam) |
| `openwop:email.draft` | documents feature (ADR 0308 P2) |
| `openwop:notifications.notify-me` | notifications feature (ADR 0308 P3) |
| `openwop:tasks.schedule-followup` | scheduled-agent-chats (ADR 0309) |
| `openwop:ai.research.web` | core builtin |

This is consistent with David's law (capabilities live at the core-agent level,
never on a named agent — ADR 0048): the baseline is anonymous and universal.

## Decision

A host-level **`DEFAULT_ON_AGENT_TOOL_IDS`** baseline, owned by
`agentToolAllowlistService.ts` (the module that already owns offering policy),
with ONE resolver used by every model-offering surface:

```
effectiveToolAllowlist(manifest, override) =
  override               — when an ADR 0104 override exists (FULL-REPLACE, unchanged)
  ∪(manifest, baseline)  — otherwise
```

- **The ADR 0104 override stays authoritative and full-replace.** It is the
  operator's revoke path: an override that omits a baseline tool removes it for
  that (tenant, agent). No new mechanism, no second policy store.
- **Applied at every model-offering chokepoint** (the same three surfaces ADR
  0104 enumerates, plus voice which never applied the override and still
  doesn't — it gains only the baseline):
  1. the chat tool loop (`conversationToolLoop.ts`) — including its
     `conversationToolTurnEligible` gate, which previously bailed on an empty
     manifest allowlist; with a non-empty baseline no agent is "pure persona"
     anymore, so eligibility reduces to provider tool-calling support;
  2. `runAgentDispatchLive` (`agentDispatch.ts`) — heartbeat picks, scheduled
     turns, deep investigations;
  3. the realtime voice tool declarations + wire-name mapping
     (`voice/realtime/toolBridge.ts`).
  The deterministic seam (`runAgentDispatch`) keeps offering nothing — it makes
  no model call (the existing ADR 0104 carve-out, unchanged).
- **Enforcement is untouched.** Offering ≠ entitlement: the Capability Firewall,
  the ADR 0102 execution gate (baseline namespaces are already auto-permitted
  via `builtinToolNamespaces()`), per-tool acting-user fail-closed checks, org
  RBAC, and toggle honesty inside each tool's `run` all still apply. A baseline
  tool whose feature is disabled for the tenant refuses at execution exactly as
  before.
- **Baseline ids that don't resolve are inert.** The offering set is always
  intersected with the registered builtins (`filterTools` ∩
  `builtinAgentToolIds()`), so on a host where a feature never registered its
  tool, the baseline id simply resolves to nothing — no dangling advert reaches
  a model.

## Boundaries audit

- `agentToolAllowlistService.ts` already owns offering policy (ADR 0104); the
  baseline is a second input to the SAME resolver, not a parallel policy system.
- No wire change: `toolAllowlist` on the manifest is unchanged; the baseline is
  host-local dispatch policy exactly like the ADR 0104 override (same honesty
  argument — the advertised manifest never mutates). **No RFC.**
- Replay: recorded runs replay recorded output (the ADR 0104 precedent);
  offering is resolved live only for live turns.

## Alternatives weighed

1. **Seed ADR 0104 overrides for every (tenant, agent)** — rejected: overrides
   are full-replace snapshots; seeding freezes each agent's manifest at seed
   time and silently strips any manifest tool added later. Also leaves new
   agents/tenants ungranted (the operational dishonesty this ADR removes).
2. **Add the six ids to every agent pack manifest** — rejected: dozens of
   signed packs to re-publish, and third-party packs never get them; the
   capability is the host's, not the pack author's.
3. **A feature toggle for the baseline** — rejected: the toggle system gates
   product surfaces; each tool already carries per-tenant toggle honesty inside
   `run`. A second gate would double-gate and drift.

## Falsifier

If a default-on tool proves abusable in a way the execution-layer gates don't
catch (e.g. proposal/notification spam beyond the existing budgets), the fix is
tightening THAT tool's execution gate or removing it from the baseline — not
reverting the baseline mechanism.

## Phased plan

| Phase | Scope | Verify |
|---|---|---|
| P1 | Baseline constant + `effectiveToolAllowlist` resolver + the three chokepoints + tests (union, override-revoke wins, voice decl minting, eligibility flip) | backend vitest |

### Phase record (2026-07-07)

Landed as one commit on `feat/adr0315-default-on-agent-tools`. Full backend
suite green modulo the two known pre-existing reds (`rfc0121`,
`connector-vendor-grouping`). Test repins: the inline-path regression tests
(injected context, multi-party council, deep-investigation inline arm) now pin
`byok:` + a non-tool-calling provider, since the managed default takes the tool
loop; the pure-persona eligibility pins flipped to the baseline semantics.

**Follow-up (P2, 2026-07-07) — the ADR 0104 admin panel.** The first cut updated
the dispatch chokepoints but not the super-admin allowlist editor, whose read
model (`GET …/agents/:id` `effective` + the FE checklist) still reflected only
the manifest — so the panel (a) misrepresented an un-overridden agent's real
tool set and (b) was a silent-revoke trap: any full-replace save dropped the six
baseline tools because they were never pre-checked. Fixed by routing the admin
`effective` through the SAME `effectiveToolAllowlist` resolver and returning a
`baseline` array; the editor now pre-checks + tags the default-on tools and warns
that saving an override PINS the agent (full-replace won't auto-receive future
default-on additions until Reset). The revoke path is unchanged — unchecking a
default-on tool and saving still removes it for that agent.

**Follow-up (P3, grade-code 2026-07-07) — the revoke path was NOT honored on
voice.** `voice/realtime/toolBridge.ts` resolved the agent's tools via
`effectiveToolAllowlist(manifest, undefined)` — hard-wiring the ADR 0104 override
to `undefined` on BOTH the decl (offering) and the execute (entitlement) sides,
and it never read `resolveAgentToolAllowlistOverride`. Because ADR 0315 forces the
six baseline tools onto every agent's voice surface, an operator's documented
revoke (uncheck + save) was silently ignored over voice — a revoked tool stayed
declarable to the realtime model AND executable. Per-tool acting-user/RBAC/toggle
guards still bound (no escalation beyond each tool's own entitlement), but the
config-vs-enforcement divergence was real. **Fix:** both `resolveAgentToolDecls`
and `executeRealtimeToolCall` now resolve the override and thread it into
`effectiveToolAllowlist`, so a revoked tool is neither declared nor executed over
voice. Covered by a new `voice-realtime.test.ts` case (override omitting a
baseline tool → not in the decls). Also: the admin panel's `baseline`/`effective`
now intersect with the host-registered tool catalog, so a feature-registered tool
whose feature is off no longer reads as "default-on" offered (display honesty).
