# ADR 0720 — `enabled` says "any lever on" and means "master only", on a projection graded honest

Status: **implemented** (the fix ships in the same PR as this decision)

**Feature:** Context economy (`FEATURES.md` ordinal 217) · ADR 0148 · feature-loop 2026-09 it.49
**Closes:** `CEC-4` · **Narrows:** `CEC-1` · **Ticks as stale:** `CEC-2`, `CEC-3`

## Context — three of four filed rows did not survive measurement

This iteration's substance is as much what is NOT wrong as what is. Each row was re-checked
at HEAD rather than carried:

| row | verdict at HEAD |
|---|---|
| `CEC-4` | **REAL** — the one fixed here |
| `CEC-1` | **HALF WRONG** — pack/feature tools ARE covered; only MCP is not, defensibly |
| `CEC-2` | **STALE** — closed by a different mechanism than the row expected |
| `CEC-3` | **NOT REACHABLE** — the guarded branch is always taken |

### `CEC-4` — real, but NOT the defect it looks like (and not the one I first wrote)

```ts
export interface ContextEconomyConfig {
  /** Master switch — OR of "any lever on". */
  readonly enabled: boolean;
  …
}

export function contextEconomy(): ContextEconomyConfig {
  const master = envBool('OPENWOP_CONTEXT_ECONOMY') ?? false;
  const lever = (name: string): boolean => envBool(name) ?? master;
  return Object.freeze({
    enabled: master,                                  // ← NOT the OR
    transcriptBudget: lever('OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT'),
    …
```

Each lever *defaults* to the master but can be set **independently**, so
`OPENWOP_CONTEXT_ECONOMY_TRANSCRIPT=1` with no master yields
`{ enabled: false, transcriptBudget: true }`.

**My first draft of this ADR concluded the code was wrong and proposed changing
`enabled` to the OR. That was incorrect, and I am recording the reversal rather than
quietly shipping the second answer.**

The reasoning that looked convincing: `enabled` is what the operator projection reports,
the UX pass graded that projection *"live + honest + superadmin-gated (retired a lying
toggle)"*, and a lever-on/master-off deploy would then report "disabled" while truncating
history — the same dishonesty the feature is proud of having retired.

**The consumer's SHAPE settles it the other way.** `routes/featureToggles.ts` emits:

```ts
{ id: 'context-economy', envVar: 'OPENWOP_CONTEXT_ECONOMY', enabled: ce.enabled,
  levers: [ { id, envVar, enabled }, … ] }
```

`enabled` sits beside the env var it describes, and **every lever is reported separately
with its own `envVar` and `enabled`**. A reader of that payload sees "master off,
transcript on" accurately. Nothing is concealed, so there is no dishonesty to fix. (There
is also no frontend consumer at all today — the projection is API-only — so the
"operator-facing lie" framing was overstated twice over.)

**And an existing test already pinned the correct contract**, on adjacent lines that make
the intent unmistakable (`test/context-economy-caching.test.ts:53-57`):

```ts
process.env.OPENWOP_CONTEXT_ECONOMY = '0';
process.env.OPENWOP_CONTEXT_ECONOMY_TRANSPORT = 'yes';
expect(c2.enabled).toBe(false);
expect(c2.transport).toBe(true); // lever-on despite master-off
```

The author saw the combination and asserted it deliberately. **I was one step from
overriding a correct test because it disagreed with a comment** — and my witness would
have locked my misreading in.

**So the defect is the SENTENCE, not the behaviour.** `enabled` has never meant "any lever
on"; it means "is `OPENWOP_CONTEXT_ECONOMY` set". The docstring is corrected to say that,
and to state what the field is NOT an answer to.

### `CEC-1` — narrowed, because half the claim is false

The row says the exemption census *"covers only BUILTIN tools; a non-builtin (MCP/pack)
schema-carrying output … isn't guaranteed exempt."*

**The "pack" half is wrong.** `registerFeatureAgentTool` writes into the **same
`BUILTINS` map** `builtinAgentTool` reads (`agentToolProvider.ts:596-598, 592-594`), so a
feature/pack tool declaring `schemaCarrying: true` IS honoured — `intent-ledger`
(`agentTools.ts:43`) is a live example.

**The MCP half is true and is left alone deliberately.** MCP results do reach the
compaction seam (`agentDispatch.ts:1293`), but MCP content is `<UNTRUSTED>`-fenced by
design and is not the host's closed-world authoring catalog the exemption exists to
protect — the stated rationale is *"an elided enum lies to the model"* about the vocabulary
it must author against. Compacting an external tool's payload is not that.

**What IS worth fixing is the shape underneath it.** `isSchemaReadExempt` ends:

```ts
return builtinAgentTool(toolName)?.schemaCarrying === true;
```

which returns `false` both for *"I classified this tool and it does not carry a schema"*
and for *"I have never heard of this tool."* **That is the identical conflation ADR 0719
fixed one iteration ago** in `useFeatureVisible`, where an ABSENT toggle read as an OFF
toggle and silently removed two console tabs. Same shape, different subsystem, found
independently a week apart.

Today the unknown branch is only reachable for MCP, where the answer happens to be
acceptable. It is acceptable **by accident of what is registered**, not by decision — and
the next registrar that adds a schema-carrying tool outside `BUILTINS` inherits silence.

### `CEC-2` — stale; closed by a different mechanism

The row asks to wire `cachePrefixScope` *"so shared-key deployments aren't unprotected"*
and cites `aiProvidersHost.ts:890-905` as omitting it. Measured:

- `aiProvidersHost` now **does** pass it (`:924`, `:1918`);
- the **only** shared-key lane is the managed tier, and it is protected by a different,
  thorough mechanism — `MMXC-1`/ADR 0611's per-tenant cache-scope sentinel prepended in
  `prepareManagedDispatch`, which every managed dispatch traverses;
- every other lane uses a **per-tenant** key: BYOK by construction, and compat via
  `resolveCompatDispatch(tenantId, …)` → `getCompatEndpoint(tenantId, …)` with the
  credential resolved under `{ tenantId }`.

Only 1 of 10 `dispatchChat` call sites passes `cachePrefixScope`, which looks alarming and
is not: the others are either per-tenant-keyed or covered by the sentinel.

### `CEC-3` — not reachable

The row: *"the transcript elision marker is appended only when a system message exists; a
windowed transcript with no system message drops turns silently."* The guard is
`if (omittedCount > 0 && messages[0]?.role === 'system')`. But `turnsToMessages`
**unconditionally** begins `[{ role: 'system', content: scaffold }]`
(`dispatchTurn.ts:151`), so on this lane `messages[0].role` is always `'system'` and the
disclosure always fires.

## Decision

### D1 — correct the DOCSTRING; leave the behaviour alone

`enabled` is documented as what it is: the master switch's own state, paired with the
`envVar` the projection reports beside it. The docstring also states what it is **not** —
it is not the answer to "is context economy doing anything to my prompts?", for which a
caller must read the levers.

**No behaviour changes.** The alternative — making `enabled` the OR — was drafted, then
rejected on the consumer's shape and on an existing test that pins the current contract
deliberately.

A witness pins the MEANING (not just the values), because the failure mode here is a
future reader doing what I did: finding the old sentence quoted somewhere, concluding the
code is broken, and "fixing" it. Applying that fix reds **4 tests** — the new legs plus
the existing caching test.

### D2 — Make the unknown-tool branch explicit

`isSchemaReadExempt` distinguishes the two cases it currently collapses: a tool that is
registered and not schema-carrying, versus a tool this host cannot classify. The MCP
outcome is unchanged — an unclassifiable tool is still compacted — but it is now a
**stated** decision at the site, with the ADR 0719 precedent named, instead of a silent
fallthrough that the next schema-carrying registrar outside `BUILTINS` would inherit.

## Not in scope

- **Exempting MCP results from compaction.** That is a policy change about external tool
  payloads, with its own trust and cost trade-offs; D2 makes the current choice legible
  rather than changing it.
- **Making `enabled` the OR.** Drafted and rejected above. If a caller ever needs "is
  anything active", the honest shape is a separate derived field — not redefining a field
  the projection already pairs with a specific env var.
- **The `CE*` id-namespace collision.** Context economy (ordinal 217) and Code execution
  (ordinal 201) both use `CEC-`/`CEWF-`/`CEU-`, so a grep for `CEC-2` returns the wrong
  feature's row — it misdirected this very pass until line numbers disambiguated it.
  Recorded in the tracker; renaming one set is a documentation change best done in a
  single sweep rather than half-done here.
