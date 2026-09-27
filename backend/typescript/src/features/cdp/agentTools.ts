/**
 * CDP agent tool (XCH-HOLE-6, LLM-EXCHANGE-AUDIT round 3) — the ADR 0308 seam.
 * `openwop:cdp.identity.resolve` — "who is this customer?" for the model,
 * riding the SAME shared resolve+access helper the HTTP route calls
 * (`resolveIdentityWithAccess`) so route and tool cannot drift.
 *
 * PII posture (architect-ratified): the agent is ALWAYS a scope-limited
 * caller — `hasPiiGrant` is pinned false, so the golden record arrives
 * MASKED (deterministic pseudonymizer) and every resolve is
 * governance-logged, exactly like a programmatic API-key caller.
 * Toggle-gated fail-closed in `run` (cdp is off by default); by-value GET ⇒
 * structured denies (the documents.get posture), never silent-empty.
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { resolveIdentityWithAccess } from './identityService.js';

export const CDP_IDENTITY_RESOLVE_TOOL_ID = 'openwop:cdp.identity.resolve';

function toolError(error: string, message: string): { content: string; isError: true } {
  return { content: JSON.stringify({ error, message }), isError: true };
}

export function registerCdpAgentTools(): void {
  registerFeatureAgentTool({
    contentTrust: 'untrusted',
    def: {
      name: CDP_IDENTITY_RESOLVE_TOOL_ID,
      description:
        'Resolve a customer identifier (email, phone, loyalty id, device id, cookie…) to the CDP golden record: '
        + 'contact, known identifiers, and lifecycle stage. PII fields arrive MASKED (privacy policy). Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: "The identifier type, e.g. 'email' | 'phone' | 'loyalty' | 'device' | 'cookie'." },
          value: { type: 'string', description: 'The identifier value to resolve.' },
        },
        required: ['type', 'value'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      // Toggle honesty (ADR 0308 D2): per-call, fail-closed FIRST (a disabled
      // feature has no surface) — SAME subject shape as the route's subjectOf
      // (tenant + user when present), so a user-bucketed rollout can't
      // disagree between route and tool (grade-pass, 2026-07-15).
      const assignment = await resolveOne('cdp', { tenantId: scope.tenantId, ...(scope.actingUserId ? { userId: scope.actingUserId } : {}) }).catch(() => null);
      if (!assignment?.enabled) {
        return toolError('feature_disabled', 'The CDP feature is not enabled for this workspace.');
      }
      if (!scope.actingUserId) {
        return toolError('acting_user_required', 'Customer lookups run on behalf of a signed-in user.');
      }
      const type = typeof input.type === 'string' ? input.type.trim() : '';
      const value = typeof input.value === 'string' ? input.value.trim() : '';
      if (!type || !value) return toolError('validation_error', '`type` and `value` are required.');
      // hasPiiGrant pinned FALSE: the agent never sees the unmasked record.
      const resolved = await resolveIdentityWithAccess(scope.tenantId, type, value, false);
      if (!resolved) return toolError('not_found', 'No customer resolves to that identifier.');
      return { content: JSON.stringify({ masked: resolved.masked, record: resolved.record }) };
    },
  });
}
