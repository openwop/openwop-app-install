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
 * @see docs/adr/0135-capability-firewall.md
 */
import { evaluateComposition, classesOf } from './compositionEvaluator.js';
import { resolveToolCapability } from './toolCapabilityResolver.js';
import type { CapabilityRule, CapabilityVerdict, ToolCapabilityDescriptor } from './types.js';

export const CAPABILITY_FIREWALL_KEY = 'capabilityFirewall';

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

/** Build the per-run firewall callback. `approvedTools` are tools already approved for
 *  this conversation (the conversation-tools ledger) — passed by the host orchestrator
 *  so an approved combination isn't re-deferred. `onUnclassified` logs a coverage gap. */
/** Conservative fallback for an unclassified tool when `unknownToolPolicy` is
 *  `treat-as-risky`: a write that may leave the host — so it participates in composition
 *  (either the seen or the next side) rather than slipping through (fail-closed). */
const RISKY_FALLBACK: ToolCapabilityDescriptor = { safetyTier: 'write', egress: 'host-mediated' };

/** ADR 0150 — high-blast-radius agent tools that need approval in `safe` mode (the default).
 *  These execute a consequential side-effect (run code / write a file / send data off-host), so
 *  the permission-mode gate defers them for a one-click approval (the existing `interrupt.approval`
 *  card) unless the user is in `bypass` mode (or already approved the tool this conversation). This
 *  restores the code-exec "Run code?" gate dropped on the builtin agent-tool path (#957). */
export const SENSITIVE_APPROVAL_TOOLS: ReadonlySet<string> = new Set([
  'openwop:feature.code-exec.nodes.run', // run code
  'openwop:core.files.write',            // write a host file
  'openwop:core.openwop.http.fetch',     // off-host egress
]);

export function buildFirewallHook(opts: {
  rules: readonly CapabilityRule[];
  approvedTools?: ReadonlySet<string>;
  unknownToolPolicy?: 'skip' | 'treat-as-risky';
  onUnclassified?: (toolName: string) => void;
  /** ADR 0150 — tools that need approval in `safe` mode regardless of the (opt-in) firewall
   *  rules. A `deny` from the rules still wins; otherwise these become `require-approval`. */
  requireApprovalTools?: ReadonlySet<string>;
  /** ADR 0150 — `bypass` permission mode: the user pre-authorized this turn, so any
   *  `require-approval` is downgraded to `allow`. A hard `deny` is NEVER downgraded. */
  bypassApproval?: boolean;
}): FirewallHook {
  const fallback = opts.unknownToolPolicy === 'treat-as-risky' ? RISKY_FALLBACK : null;
  // Resolve a tool → descriptor, applying the unclassified policy + logging the gap.
  const resolve = (name: string): ToolCapabilityDescriptor | null => {
    const d = resolveToolCapability(name);
    if (d) return d;
    opts.onUnclassified?.(name);
    return fallback; // null under 'skip' (fail-open); the risky class under 'treat-as-risky'
  };
  return {
    evaluate(seenToolNames, nextToolName) {
      const nextDesc = resolve(nextToolName);
      const seenKeys = new Set<string>();
      for (const name of seenToolNames) {
        const d = resolve(name);
        if (d) for (const k of classesOf(d)) seenKeys.add(k);
      }
      // Composition verdict first — a hard `deny` ALWAYS wins (never downgraded below).
      let verdict = nextDesc
        ? evaluateComposition(seenKeys, classesOf(nextDesc), opts.rules)
        : { decision: 'allow' as const }; // unclassified + policy 'skip'
      // ADR 0150 — permission-mode baseline: a sensitive tool needs approval in `safe` mode,
      // even when the rules would allow it. `deny` still wins.
      if (verdict.decision !== 'deny' && opts.requireApprovalTools?.has(nextToolName)) {
        verdict = { decision: 'require-approval', reason: 'This action needs your approval (safe mode).' };
      }
      // CGOV-4 + ADR 0150 bypass: downgrade a `require-approval` to allow when the user is in
      // bypass mode OR already approved this tool — but MUST NOT bypass a hard `deny`.
      if (verdict.decision === 'require-approval' && (opts.bypassApproval || opts.approvedTools?.has(nextToolName))) {
        return { decision: 'allow' };
      }
      return verdict;
    },
  };
}

/** Pure stamp of the resolved rule set into run.metadata (replay-safe; mirrors
 *  computeCapabilityScopeStamp). Null when already stamped or no rules. */
export function computeFirewallStamp(
  metadata: Record<string, unknown>,
  rules: readonly CapabilityRule[] | null,
  resolvedAt?: string,
): Record<string, unknown> | null {
  if (metadata[CAPABILITY_FIREWALL_KEY]) return null;
  if (!rules || rules.length === 0) return null;
  return { ...metadata, [CAPABILITY_FIREWALL_KEY]: { rules, ...(resolvedAt ? { resolvedAt } : {}) } };
}
