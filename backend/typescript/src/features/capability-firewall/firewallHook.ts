/**
 * ADR 0135 Phase 2 — the firewall hook + default rules + the run.metadata stamp.
 *
 * `buildFirewallHook` returns the callback `runChatToolLoop` invokes per tool call
 * (agentDispatch stays feature-free — it only calls the injected `evaluate`). The hook
 * resolves tool names → capability classes (`toolCapabilityResolver`) and runs the pure
 * `evaluateComposition` (P1) over the within-turn seen set vs the next tool. An
 * already-approved tool (the conversation-tools approval ledger, passed in by the
 * host orchestrator — no feature→feature import) short-circuits to allow so a resolved
 * approval isn't re-deferred.
 *
 * ADR 0834: every production lane builds this through `host/laneFirewall.ts` (the census
 * test pins it as the only caller). Every `require-approval` carries an ORIGIN —
 * `baseline` (the user's own safe-mode ask) or `policy` (a tenant rule, the enforce
 * default, the platform floor) — and only a `baseline` ask yields to the user's bypass.
 *
 * @see docs/adr/0135-capability-firewall.md
 * @see docs/adr/0834-capability-firewall-exit-decision.md
 */
import { evaluateComposition, classesOf } from './compositionEvaluator.js';
import { resolveToolCapability } from './toolCapabilityResolver.js';
import type { ApprovalOrigin, CapabilityRule, CapabilityVerdict, FirewallMode, ToolCapabilityDescriptor } from './types.js';

const CAPABILITY_FIREWALL_KEY = 'capabilityFirewall';

export interface FirewallHook {
  evaluate(seenToolNames: readonly string[], nextToolName: string): CapabilityVerdict;
}

/** The shipped default rule set. EMPTY since the always-on graduation (2026-06-24,
 *  maintainer decision): the firewall is present for every tenant but a no-op until an
 *  admin adds rules — graduating the feature without imposing approval friction on all
 *  tenants. The loop skips building the hook when there are no rules. */
export function defaultCapabilityRules(): CapabilityRule[] {
  return [];
}

/** The recommended starter rule (the read-then-egress exfiltration combination ⇒
 *  require-approval) — offered as a one-click add in the rule manager + used by tests.
 *  NOT applied by default (see defaultCapabilityRules). */
export function recommendedExfilRule(): CapabilityRule {
  return {
    id: 'read-then-egress',
    description: 'Reading external data then sending it off-host is potential exfiltration.',
    when: { anyOf: [{ safetyTier: 'read' }], with: [{ egress: 'host-mediated' }, { egress: 'host-owned' }] },
    verdict: 'require-approval',
    reason: 'This run read external data and is about to send it off-host — approve to proceed.',
  };
}

/** ADR 0135 Phase 5 — the recommended composition-VOLUME rule: 3+ off-host sends in a
 *  single turn ⇒ require-approval (a real guardrail against a runaway blast). Offered as a
 *  one-click add in the rule manager; NOT applied by default (see defaultCapabilityRules). */
export function recommendedCountRule(): CapabilityRule {
  return {
    id: 'egress-volume',
    description: 'Sending data off-host many times in one turn is a burst worth reviewing.',
    when: { countAtLeast: { class: { egress: 'host-mediated' }, threshold: 3, window: 'turn' } },
    verdict: 'require-approval',
    reason: 'This turn is about to send data off-host several times — approve to proceed.',
  };
}

/** Build the per-run firewall callback. `approvedTools` are tools already approved for
 *  this conversation (the conversation-tools ledger) — passed by the host orchestrator
 *  so an approved combination isn't re-deferred. `onUnclassified` logs a coverage gap. */
/** Conservative fallback for an unclassified tool when `unknownToolPolicy` is
 *  `treat-as-risky`: a write that may leave the host — so it participates in composition
 *  (either the seen or the next side) rather than slipping through (fail-closed).
 *  Exported so the simulator (ADR 0397 Phase 2) resolves unclassified tools identically. */
export const RISKY_FALLBACK: ToolCapabilityDescriptor = { safetyTier: 'write', egress: 'host-mediated' };

/** ADR 0150 — high-blast-radius agent tools that need approval in `safe` mode (the default).
 *  These execute a consequential side-effect (run code / write a file / send data off-host), so
 *  the permission-mode gate defers them for a one-click approval (the existing `interrupt.approval`
 *  card) unless the user is in `bypass` mode (or already approved the tool this conversation). This
 *  restores the code-exec "Run code?" gate dropped on the builtin agent-tool path (#957). */
export const SENSITIVE_APPROVAL_TOOLS: ReadonlySet<string> = new Set([
  'openwop:feature.code-exec.nodes.run', // run code
  // ADR 0834 D4 — `openwop:core.files.write` was listed here and no agent tool ever
  // registered it (`core.files.write` is a NODE id); a dead entry made the set read
  // broader than it was. Removed; `safe-mode-baseline-census.test.ts` now requires every
  // member to be a registered tool. New asks are DECLARED on the tool
  // (`BuiltinTool.safeModeApproval`), not added here.
  'openwop:core.openwop.http.fetch',     // off-host egress
  // ADR 0442 Guide wave (Wave 2) — KickBot's one bounded write: logging the
  // participant's OWN check-in commits durable, NON-reversible domain state, so
  // it is deferred for the one-click approval card in `safe` mode. "You propose;
  // the user decides" — nothing is recorded until they approve.
  'openwop:kicktodo.log-checkin',        // complete today's action (own check-in)
]);

export function buildFirewallHook(opts: {
  rules: readonly CapabilityRule[];
  /** Tools a human with authority approved for this conversation (the conversation-tools
   *  ledger) for an ask of `policy` origin. Satisfies an ask of EITHER origin. */
  approvedTools?: ReadonlySet<string>;
  /** ADR 0834 D2 — approvals that only answered a `baseline` (safe-mode) ask: a ledger row
   *  raised by the baseline, or voice's one-shot in-session card. They satisfy a `baseline`
   *  ask only, never a tenant/platform/enforce `policy` ask. */
  approvedBaselineTools?: ReadonlySet<string>;
  unknownToolPolicy?: 'skip' | 'treat-as-risky';
  onUnclassified?: (toolName: string) => void;
  /** ADR 0150 — tools that need approval in `safe` mode regardless of the (opt-in) firewall
   *  rules. A `deny` from the rules still wins; otherwise these become `require-approval`. */
  requireApprovalTools?: ReadonlySet<string>;
  /** ADR 0834 D4 — the per-tool reason a `baseline` ask shows (a declared
   *  `safeModeApproval.reason`), e.g. pointing a held `compose-and-run` at the reviewed
   *  `workflows.propose` lane. Absent ⇒ the generic safe-mode reason. */
  baselineReasons?: ReadonlyMap<string, string>;
  /** ADR 0610 D5 / PMC-1 — in `safe` mode, gate the host-mediated egress CLASS, not just a
   *  hard-coded name set: any tool whose RFC 0078 capability descriptor is `egress:'host-mediated'`
   *  needs approval, even if it is not in `requireApprovalTools`. A `deny` still wins. */
  gateHostMediatedEgress?: boolean;
  /** ADR 0150 — `bypass` permission mode: the user pre-authorized this turn. ADR 0834 D2:
   *  it downgrades a `baseline` ask only. A `policy` ask and a `deny` are NEVER downgraded. */
  bypassApproval?: boolean;
  /** ADR 0397 — the enforcement posture. `default-allow` (default) is today's behavior;
   *  `shadow` logs would-blocks but applies allow; `enforce` denies an unmatched action. */
  mode?: FirewallMode;
  /** ADR 0397 — the posture for an UNMATCHED action under deny modes (default `deny`). */
  defaultDenyVerdict?: 'deny' | 'require-approval';
  /** ADR 0397 — shadow-mode sink: a would-block the firewall COMPUTED but did NOT apply
   *  (the call proceeds). Deduped by tool name in `shadowLogged` (OQ-1). */
  onShadowWouldBlock?: (toolName: string, wouldBe: 'deny' | 'require-approval') => void;
  /** ADR 0834 D1 — the dedupe set for shadow would-blocks. A lane that builds a hook per
   *  CALL (voice) passes one set per session so the decisions log is not flooded; absent ⇒
   *  one set per hook (per turn). */
  shadowLogged?: Set<string>;
  /** ADR 0834 D1 — every verdict that narrowed a call (deny / require-approval), for the
   *  governance decision log. Called by the hook itself, so every lane that evaluates logs. */
  onDecision?: (toolName: string, verdict: CapabilityVerdict) => void;
  /** ADR 0397 Phase 5 — the superadmin platform-baseline rules. Evaluated alongside the
   *  tenant rules; the MORE restrictive verdict wins, so a platform deny cannot be weakened
   *  by a tenant allow-rule. Absent/empty ⇒ no floor. */
  platformRules?: readonly CapabilityRule[];
}): FirewallHook {
  const fallback = opts.unknownToolPolicy === 'treat-as-risky' ? RISKY_FALLBACK : null;
  // ADR 0724 D1 — safe posture IMPLIES the egress-class gate. Deriving it from
  // `requireApprovalTools` makes every lane equal BY CONSTRUCTION; `false` stays a legible
  // opt-out; a hook with no safe posture (rules-only) is unchanged. MEASURED at ADR 0724 and
  // again at ADR 0834: NO registered agent tool classifies as host-mediated egress (all ids are
  // `openwop:`-prefixed; the classifier's egress rows are node type ids), so this changes no
  // agent-lane verdict today — the safe-mode baseline that actually covers off-host agent tools
  // is the declared `safeModeApproval` set (ADR 0834 D4, `safe-mode-baseline-census.test.ts`).
  const gateEgress = opts.gateHostMediatedEgress ?? (opts.requireApprovalTools !== undefined);
  const mode: FirewallMode = opts.mode ?? 'default-allow';
  const defaultDenyVerdict = opts.defaultDenyVerdict ?? 'deny';
  const loggedShadow = opts.shadowLogged ?? new Set<string>(); // dedup for shadow would-blocks (OQ-1)
  // Resolve a tool → descriptor. `forceRisky` (for the PLATFORM floor) applies the risky
  // fallback for an unclassified tool regardless of the tenant's `unknownToolPolicy`, so a
  // tenant's `skip` choice cannot drop the operator's global floor.
  const resolve = (name: string, forceRisky = false): ToolCapabilityDescriptor | null => {
    const d = resolveToolCapability(name);
    if (d) return d;
    if (!forceRisky) opts.onUnclassified?.(name);
    return forceRisky ? RISKY_FALLBACK : fallback; // null under 'skip'; the risky class otherwise
  };
  const buildSeen = (seenToolNames: readonly string[], forceRisky: boolean): { seenKeys: Set<string>; seenCounts: Map<string, number> } => {
    const seenKeys = new Set<string>();
    // Per-class-key counts of PRIOR calls this turn — feeds the `countAtLeast` / `count.*`
    // expression predicates (ADR 0135 Phases 5/6).
    const seenCounts = new Map<string, number>();
    for (const name of seenToolNames) {
      const d = resolve(name, forceRisky);
      if (d) for (const k of classesOf(d)) {
        seenKeys.add(k);
        seenCounts.set(k, (seenCounts.get(k) ?? 0) + 1);
      }
    }
    return { seenKeys, seenCounts };
  };
  // ADR 0150 / 0610 D5 — is this tool held by the user's own safe-mode baseline? The egress
  // CLASS is read on the RAW descriptor (resolveToolCapability), NOT `resolve()` — under
  // `treat-as-risky` resolve() folds RISKY_FALLBACK (egress:'host-mediated') into EVERY
  // unclassified tool, which would mass-defer benign reads ("read before you write").
  const baselineHolds = (name: string): boolean =>
    Boolean(opts.requireApprovalTools?.has(name)) || (gateEgress && resolveToolCapability(name)?.egress === 'host-mediated');
  const baselineAsk = (name: string): CapabilityVerdict => ({
    decision: 'require-approval', origin: 'baseline',
    reason: opts.baselineReasons?.get(name) ?? 'This action needs your approval (safe mode).',
  });
  // ADR 0834 D2 — who may satisfy an ask. A `policy` ask is satisfied ONLY by an approval a
  // human with authority gave for a policy ask (`approvedTools`); a `baseline` ask also by the
  // user's own bypass or a baseline-only approval. A `deny` is never touched by this.
  const satisfied = (name: string, origin: ApprovalOrigin | undefined): boolean => {
    if (opts.approvedTools?.has(name)) return true;
    if (origin === 'policy') return false;
    return Boolean(opts.bypassApproval || opts.approvedBaselineTools?.has(name));
  };
  const finish = (name: string, v: CapabilityVerdict): CapabilityVerdict => {
    if (v.decision !== 'allow') { try { opts.onDecision?.(name, v); } catch { /* observability never decides */ } }
    return v;
  };
  return {
    evaluate(seenToolNames, nextToolName) {
      // ADR 0397 Phase 5 — the PLATFORM FLOOR is a hard, mode-INDEPENDENT gate, evaluated
      // FIRST in its OWN fail-closed try/catch (a floor error denies regardless of tenant
      // mode) and robust to unclassified tools (risky fallback — a tenant's `skip` can't
      // drop it). A platform deny short-circuits: never bypassed, never shadowed.
      let platformFloor: CapabilityVerdict = { decision: 'allow' };
      if (opts.platformRules && opts.platformRules.length > 0) {
        try {
          const { seenKeys, seenCounts } = buildSeen(seenToolNames, true);
          const nextDescP = resolve(nextToolName, true) ?? RISKY_FALLBACK; // always classified for the floor
          platformFloor = asPolicy(evaluateComposition(seenKeys, classesOf(nextDescP), opts.platformRules, seenCounts));
        } catch {
          platformFloor = { decision: 'deny', reason: 'firewall evaluation error (platform baseline)' };
        }
        if (platformFloor.decision === 'deny') return finish(nextToolName, platformFloor); // hard floor
      }
      try {
        const nextDesc = resolve(nextToolName);
        const { seenKeys, seenCounts } = buildSeen(seenToolNames, false);
        const nextKeys = nextDesc ? classesOf(nextDesc) : null;
        // Tenant composition verdict + the deny-mode default posture — both `policy` origin.
        let verdict: CapabilityVerdict = nextKeys
          ? asPolicy(evaluateComposition(seenKeys, nextKeys, opts.rules, seenCounts))
          : { decision: 'allow' }; // unclassified + policy 'skip' (rules skipped; mode still applies)
        // ADR 0397 — deny-mode default posture. A composition that fell through (allow with
        // NO matched rule — nothing allow-listed this action) resolves to the mode's default.
        // An explicit `allow` rule (allow WITH a ruleId) carves an exception and is left
        // untouched. Shadow records the would-block ONLY IF the call ultimately proceeds.
        const fellThrough = verdict.decision === 'allow' && verdict.ruleId === undefined;
        let shadowWouldBlock: 'deny' | 'require-approval' | null = null;
        if (mode !== 'default-allow' && fellThrough) {
          if (mode === 'shadow') shadowWouldBlock = defaultDenyVerdict; // apply allow; maybe record later
          else verdict = asPolicy({ decision: defaultDenyVerdict, reason: 'No rule allow-listed this action (default-deny).' }); // enforce
        }
        // Platform baseline ANDs UNDER the tenant verdict (most-restrictive wins). A platform
        // deny already returned above; a platform require-approval combines here.
        verdict = mostRestrictive(platformFloor, verdict);
        // ADR 0150 — the safe-mode baseline RAISES an allow to a `baseline` ask. ADR 0834 D2:
        // it never REPLACES a policy verdict (the first draft of the overlay did, which made
        // a tool that was both sensitive and policy-held skippable by bypass).
        if (verdict.decision === 'allow' && baselineHolds(nextToolName)) verdict = baselineAsk(nextToolName);
        if (verdict.decision === 'require-approval' && satisfied(nextToolName, verdict.origin)) {
          verdict = { decision: 'allow' };
        }
        // Shadow would-block is recorded ONLY when the call actually proceeds (final allow),
        // so the decisions log never claims a call ran that a platform floor (or anything
        // else) blocked. Deduped by tool name (OQ-1).
        if (shadowWouldBlock && verdict.decision === 'allow' && !loggedShadow.has(nextToolName)) {
          loggedShadow.add(nextToolName);
          opts.onShadowWouldBlock?.(nextToolName, shadowWouldBlock);
        }
        return finish(nextToolName, verdict);
      } catch {
        // ADR 0397 Phase 5 — fail-closed ON THE FIREWALL ITSELF, keyed on mode: in `enforce`
        // an evaluation error MUST deny; in `default-allow`/`shadow` it preserves today's
        // non-blocking behavior — BUT never weaker than the platform floor already computed,
        // and never weaker than the ADR 0150 sensitive-tool baseline (CFP Phase-2 review
        // MEDIUM-1). ADR 0834 D2: the baseline part is `baseline` origin (bypass may skip
        // it); the already-computed floor keeps `policy` and is not downgraded on this path.
        let errVerdict: CapabilityVerdict = mode === 'enforce'
          ? { decision: 'deny', reason: 'firewall evaluation error' }
          : { decision: 'allow' };
        if (errVerdict.decision === 'allow') {
          let held = false;
          try { held = baselineHolds(nextToolName); } catch { held = Boolean(opts.requireApprovalTools?.has(nextToolName)); }
          if (held && !satisfied(nextToolName, 'baseline')) errVerdict = baselineAsk(nextToolName);
        }
        return finish(nextToolName, mostRestrictive(platformFloor, errVerdict));
      }
    },
  };
}

/** Tag a rule-derived `require-approval` as `policy` origin (ADR 0834 D2). */
function asPolicy(v: CapabilityVerdict): CapabilityVerdict {
  return v.decision === 'require-approval' ? { ...v, origin: 'policy' } : v;
}

/** Combine two verdicts most-restrictively (deny > require-approval > allow). Ties resolve
 *  to the first argument, so the caller passes the platform (floor) verdict first — its
 *  reason/ruleId shows when the floor is the deciding authority. */
function mostRestrictive(a: CapabilityVerdict, b: CapabilityVerdict): CapabilityVerdict {
  const rank = (v: CapabilityVerdict): number => (v.decision === 'deny' ? 2 : v.decision === 'require-approval' ? 1 : 0);
  return rank(a) >= rank(b) ? a : b;
}

/** Pure stamp of the resolved firewall POSTURE into run.metadata (replay-safe; mirrors
 *  computeCapabilityScopeStamp). Null when already stamped or when there is nothing that
 *  affects behavior to record.
 *
 *  ADR 0397 replay-safety: the posture is `{ rules, mode, defaultDenyVerdict }`. Because a
 *  deny MODE changes behavior even with an EMPTY allow-list, the stamp MUST be written
 *  whenever `mode !== 'default-allow'` — not only when `rules.length > 0` (the ADR 0135
 *  condition). Otherwise an `enforce` run with no allow-rules would carry no stamp and a
 *  `:fork` would silently reproduce `default-allow`. Stamped verbatim, read on fork. */
export function computeFirewallStamp(
  metadata: Record<string, unknown>,
  rules: readonly CapabilityRule[] | null,
  resolvedAt?: string,
  posture?: { mode?: FirewallMode; defaultDenyVerdict?: 'deny' | 'require-approval'; platformRules?: readonly CapabilityRule[] },
): Record<string, unknown> | null {
  if (metadata[CAPABILITY_FIREWALL_KEY]) return null;
  const mode: FirewallMode = posture?.mode ?? 'default-allow';
  const ruleList = rules ?? [];
  const platformRules = posture?.platformRules ?? [];
  // Nothing behavior-affecting to record: default-allow AND no tenant/platform rules ⇒ no-op.
  if (ruleList.length === 0 && platformRules.length === 0 && mode === 'default-allow') return null;
  return {
    ...metadata,
    [CAPABILITY_FIREWALL_KEY]: {
      rules: ruleList, // the tenant's OWN rules (safe to expose in tenant-readable provenance)
      mode,
      defaultDenyVerdict: posture?.defaultDenyVerdict ?? 'deny',
      // Record only that a platform floor applied + how many rules — NOT the superadmin rule
      // bodies (run.metadata is tenant-readable; the global policy content stays operator-only).
      ...(platformRules.length > 0 ? { platformRuleCount: platformRules.length } : {}),
      ...(resolvedAt ? { resolvedAt } : {}),
    },
  };
}
