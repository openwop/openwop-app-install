/**
 * ADR 0135 Phase 2 — classify a tool name → its capability descriptor.
 *
 * Builtin agent tools don't carry RFC 0078 `safetyTier`/`egress` on their `def` (only
 * MCP-exposed tools do), and the schema MANDATES the host assign `safetyTier` explicitly.
 * So the host classifies its builtin namespaces here. An UNKNOWN tool returns `null`; the
 * firewall then applies the tenant's `unknownToolPolicy`, which DEFAULTS to
 * `treat-as-risky` (CGOV-1, fail-CLOSED) — an un-classed tool is conservatively treated as
 * egress-capable so a coverage gap here can't silently bypass a configured rule. Keep this
 * table current to reduce false positives (a genuine read-only tool left un-classed would
 * over-fire as risky); the `capability-firewall-classification.test.ts` drift guard asserts
 * the known egress namespaces stay classified.
 *
 * @see docs/adr/0135-capability-firewall.md
 */
import type { ToolCapabilityDescriptor } from './types.js';

/** Ordered namespace → descriptor classification. First prefix match wins. */
const CLASSIFICATION: ReadonlyArray<readonly [string, ToolCapabilityDescriptor]> = [
  // Reads of external/connected data (web research, KB, HTTP fetch) — sourced data.
  ['openwop:ai.research', { safetyTier: 'read', egress: 'safe-fetch' }],
  ['openwop:knowledge', { safetyTier: 'read', egress: 'none' }],
  ['core.openwop.http', { safetyTier: 'read', egress: 'safe-fetch' }],
  // Off-host SENDS (the egress side of an exfil combination).
  ['core.openwop.integration.email-send', { safetyTier: 'write', egress: 'host-mediated', scopes: ['workspace:write'] }],
  ['core.openwop.integration.slack-message', { safetyTier: 'write', egress: 'host-mediated', scopes: ['workspace:write'] }],
  ['core.openwop.integration.sms-send', { safetyTier: 'write', egress: 'host-mediated', scopes: ['workspace:write'] }],
  ['core.openwop.integration.notification-push', { safetyTier: 'write', egress: 'host-mediated' }],
  ['core.openwop.integration', { safetyTier: 'write', egress: 'host-mediated' }],
  // Off-host messaging / agent-to-agent — sends that leave the host (egress side).
  ['core.openwop.messaging', { safetyTier: 'write', egress: 'host-mediated' }],
  ['core.openwop.a2a', { safetyTier: 'write', egress: 'host-mediated' }],
  // External tool servers — conservatively a write that may egress off-host.
  ['core.openwop.mcp', { safetyTier: 'write', egress: 'host-mediated' }],
];

/** Resolve a tool name to its capability descriptor, or null when unclassified. */
export function resolveToolCapability(toolName: string): ToolCapabilityDescriptor | null {
  for (const [prefix, d] of CLASSIFICATION) {
    if (toolName === prefix || toolName.startsWith(`${prefix}.`)) return d;
  }
  return null; // un-classed → firewall skips it (logged by the caller)
}
