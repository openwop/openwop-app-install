/**
 * Suppression-list client (ADR 0655 D10 / EM-UX-5 / EM-UX-23).
 *
 * A SEPARATE module from `emailClient.ts` on purpose: these routes are the
 * TENANT-scoped CRM overlay (`/crm/suppressions`, ADR 0217 C3), not the
 * org-scoped `email/orgs/:orgId` base every other email call rides — the
 * suppression list is the do-not-contact set every marketing egress in the
 * tenant subtracts, so it has no org in its path. (It also keeps the hub page's
 * existing test mocks, which enumerate `emailClient`'s exports, intact.)
 *
 * Shapes mirror `backend/typescript/src/features/crm/suppressionService.ts`.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type SuppressionReason = 'unsubscribed' | 'bounced' | 'complaint' | 'manual';

export interface Suppression {
  /** `${tenantId}::${emailLower}` — the natural key (one row per address). */
  key: string;
  tenantId: string;
  /** Lower-cased, trimmed address, as stored. */
  email: string;
  reason: SuppressionReason;
  /** Free-form context (e.g. the campaignId the unsubscribe came from). */
  note?: string;
  actor: string;
  at: string;
}

const root = `${config.baseUrl}/host/openwop-app/crm/suppressions`;

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

/** The tenant's suppression list, newest-first (the server orders it). */
export async function listSuppressions(): Promise<Suppression[]> {
  const res = await fetch(root, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ suppressions: Suppression[] }>(res, 'listSuppressions')).suppressions;
}

/**
 * Release ONE address. Resolves `true` when a row was removed, `false` when
 * there was none to remove. NOTE the server refuses (400) to lift a
 * non-`manual` suppression from this route — an unsubscribe, bounce or
 * complaint is lifted only by the subject re-opting in (ADR 0655 D3) — so the
 * panel offers Release on `manual` rows only and surfaces the server's message
 * verbatim if the rule ever changes underneath it.
 */
export async function removeSuppression(email: string, opts: { force?: boolean } = {}): Promise<boolean> {
  // ADR 0655 D10 — `force` is the operator's attested release of a bounce /
  // complaint / unsubscribe row (the D3 preference page refuses the recipient's
  // own re-grant while suppressed and tells them to ask the sender).
  const res = await fetch(`${root}/${encodeURIComponent(email)}${opts.force ? '?force=true' : ''}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  return (await asJson<{ removed: boolean }>(res, 'removeSuppression')).removed;
}
