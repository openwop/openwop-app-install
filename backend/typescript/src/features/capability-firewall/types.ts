/**
 * ADR 0135 — Capability Firewall types.
 *
 * The firewall reasons over capability CLASSES (RFC 0078 ToolDescriptor dimensions:
 * `safetyTier`, `egress`, `auth.scopes`) rather than tool ids, so a rule covers every
 * tool in a class and survives new tools. `ToolCapabilityDescriptor` is the minimal
 * STRUCTURAL projection of a tool's descriptor the evaluator needs — kept structural so
 * the pure evaluator imports no catalog/core code (the P2 loop boundary maps a tool name
 * → this).
 *
 * @see docs/adr/0135-capability-firewall.md
 */

/** The capability dimensions of a single tool (projected from RFC 0078). `kind` is a
 *  host-derived class shape (not an RFC 0078 dimension) reserved for composition-VOLUME
 *  concerns — `fan-out` marks a workflow-as-tool/sub-run dispatch (ADR 0135 Phase 5). */
export interface ToolCapabilityDescriptor {
  safetyTier: 'pure' | 'read' | 'write' | 'exec';
  egress?: 'none' | 'safe-fetch' | 'host-mediated' | 'host-owned';
  scopes?: string[];
  kind?: 'fan-out';
}

/** One capability class — the unit a rule matches on. `{ kind: 'fan-out' }` is the
 *  reserved composition-VOLUME class (ADR 0135 Phase 5). */
export type CapabilityClass =
  | { safetyTier: 'pure' | 'read' | 'write' | 'exec' }
  | { egress: 'none' | 'safe-fetch' | 'host-mediated' | 'host-owned' }
  | { scope: string }
  | { kind: 'fan-out' };

/** A count-based predicate (ADR 0135 Phase 5): fires when the number of tool calls in a
 *  class this turn (prior + the call about to run) reaches `threshold`. `window` is
 *  `'turn'` only for v1 (the seen list is per-turn). */
export interface CountAtLeast {
  class: CapabilityClass;
  threshold: number;
  window: 'turn';
}

/** A composition rule. Exactly ONE predicate kind per rule:
 *  - presence: fires when the run has exercised an `anyOf` class (across the run OR the
 *    current call) AND the tool about to run is in a `with` class (an empty/absent
 *    `anyOf`/`with` is a wildcard for that side);
 *  - `countAtLeast`: a composition-VOLUME predicate (ADR 0135 Phase 5);
 *  - `expression`: a bounded boolean-expression predicate (ADR 0135 Phase 6). */
export interface CapabilityRule {
  id: string;
  description: string;
  when: {
    anyOf?: CapabilityClass[];
    with?: CapabilityClass[];
    countAtLeast?: CountAtLeast;
    expression?: string;
  };
  /** ADR 0397 — `'allow'` is an explicit allow-list rule: meaningful only under the
   *  `shadow`/`enforce` deny modes (it short-circuits first-match to allow, carving an
   *  exception out of default-deny); a harmless no-op under `default-allow`. */
  verdict: 'deny' | 'require-approval' | 'allow';
  reason: string;
}

/** ADR 0397 — the firewall's per-tenant enforcement posture.
 *  - `default-allow`: today's behavior (unmatched ⇒ allow).
 *  - `shadow`: evaluate as default-deny, LOG the would-be block, but APPLY allow (the
 *    migration path — review the would-deny stream, build the allow-list, then flip).
 *  - `enforce`: apply default-deny (unmatched ⇒ `defaultDenyVerdict`). */
export type FirewallMode = 'default-allow' | 'shadow' | 'enforce';

export interface CapabilityVerdict {
  decision: 'allow' | 'deny' | 'require-approval';
  ruleId?: string;
  reason?: string;
}
