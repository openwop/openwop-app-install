/**
 * ADR 0785 P4 — the claude-code-permission approval kind's policy, owned by this
 * feature and registered at its boot (the kicktodo-plan-proposal inversion: core
 * holds the registries, the owning feature fills them).
 */
import { registerApprovalEligibility, registerApprovalRedactor } from '../../host/approvalService.js';
import { OpenwopError } from '../../types.js';

let registered = false;

export function registerClaudeCodeApprovalPolicy(): void {
  if (registered) return;
  registered = true;
  // The card is about the owner's OWN machine: the summary is free text they
  // caused, and the card means nothing once they are erased.
  registerApprovalRedactor('claude-code-permission', { idFields: [], textFields: ['proposal', 'claudeCodePermission.summary'], onApproverMatch: 'delete' });
  // ADR 0785 D7 — only the device's human decides, and never a key. The
  // PendingApproval claim route checks no scope, so absent this a device key (or
  // any identified co-tenant) could approve Claude Code's own prompt.
  registerApprovalEligibility('claude-code-permission', async (_tenantId, decidedBy, approval) => {
    const owner = approval.policy?.approverRefs?.[0];
    if (!decidedBy || decidedBy.startsWith('apikey:') || !owner || decidedBy !== owner) {
      throw new OpenwopError('forbidden', 'Only the person who paired this Claude Code device can answer its permission prompts.', 403, {});
    }
  });
}
