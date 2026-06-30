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

/** The capability dimensions of a single tool (projected from RFC 0078). */
export interface ToolCapabilityDescriptor {
  safetyTier: 'pure' | 'read' | 'write' | 'exec';
  egress?: 'none' | 'safe-fetch' | 'host-mediated' | 'host-owned';
  scopes?: string[];
}

/** One capability class — the unit a rule matches on. */
export type CapabilityClass =
  | { safetyTier: 'pure' | 'read' | 'write' | 'exec' }
  | { egress: 'none' | 'safe-fetch' | 'host-mediated' | 'host-owned' }
  | { scope: string };

/** A composition rule: fires when the run has exercised an `anyOf` class (across the
 *  run OR in the current call) AND the tool about to run is in a `with` class. An empty
 *  `anyOf`/`with` is a wildcard (always matches that side). */
export interface CapabilityRule {
  id: string;
  description: string;
  when: { anyOf?: CapabilityClass[]; with?: CapabilityClass[] };
  verdict: 'deny' | 'require-approval';
  reason: string;
}

export interface CapabilityRuleSet {
  tenantId: string;
  enabled: boolean;
  rules: CapabilityRule[];
  updatedBy?: string;
  updatedAt?: string;
}

export interface CapabilityVerdict {
  decision: 'allow' | 'deny' | 'require-approval';
  ruleId?: string;
  reason?: string;
}
