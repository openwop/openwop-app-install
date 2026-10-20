/**
 * ADR 0938 D6 — who may read proposals. ONE predicate, called by the routes and by
 * the `openwop:proposals.list` agent tool, so the two lanes cannot disagree (the
 * CLAUDE.md rule for app-state read tools). It is `assertTenantScope`, the
 * feature-free tenant gate `requireTenantScope` wraps (ADR 0617 D2): the wildcard
 * operator and a person's own personal workspace pass; everyone else needs
 * `workspace:read` from a membership. No subject → refused.
 */
import { assertTenantScope } from '../../host/accessControlService.js';

export async function assertCanReadProposals(
  tenant: string,
  subject: string | undefined,
  ctx: { personalTenant?: string | undefined; wildcardOperator?: boolean } = {},
): Promise<void> {
  await assertTenantScope(tenant, subject, 'workspace:read', {
    ...(ctx.personalTenant ? { personalTenant: ctx.personalTenant } : {}),
    ...(ctx.wildcardOperator ? { wildcardOperator: true } : {}),
  });
}
