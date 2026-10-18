/**
 * ADR 0895 — the chain-lane email policy (`EM2-WF-1`, ADR 0848 residue).
 *
 * `core.openwop.integration.email-send` is the widest email exit and was bound by
 * none of the email feature's own controls: `from` came verbatim from node config,
 * `purpose: "transactional"` was the author's to declare (it skips the consent leg
 * of the egress guard), and nothing counted the sends. This module is consulted by
 * `makeEmailAdapter` for the chain lane ONLY (`lane: 'chain'`, set by the executor's
 * `ctx.email`); campaigns, invites, receipts and approval notices carry their own
 * sender and purpose and are unchanged.
 *
 * D1 sender — the verified senders are what the email feature's settings hold for
 *    the tenant (`email:settings`, every org). The feature registers the lookup at
 *    boot (host ← features import direction, the `recipientEgressGuard` shape).
 *    With one or more configured, `from` must be one of them (case-insensitive) and
 *    a blank `from` takes the workspace-root org's sender. With none configured the
 *    send passes as before: the connection is the acting user's own provider
 *    account, and SendGrid/Postmark verify senders provider-side (stated residue).
 * D2 purpose — `transactional` is honoured only when the run has an acting user who
 *    holds `host:members:manage` on the workspace root (the scope that sets the
 *    sender). Anyone else, and an actorless run, is DEMOTED to `marketing`, never
 *    refused: demotion only adds the consent leg.
 * D3 meter — a per-tenant recipient budget per clock hour
 *    (`OPENWOP_EMAIL_CHAIN_RECIPIENTS_PER_HOUR`, default 300, `0` = off). Spent after
 *    the ledger short-circuit and the egress guard, so a replay or a refused send
 *    costs nothing. Per-instance fixed window (the ADR 0848 D5 test-send precedent):
 *    with N instances the effective cap is N×, accepted for an abuse brake.
 */
import { assertRunOrgScope } from './accessControlService.js';
import { createLogger } from '../observability/logger.js';
import type { EgressPurpose } from './recipientEgressGuard.js';

const log = createLogger('host.chainEmailPolicy');

export interface VerifiedSenders {
  /** Every configured sender in the tenant, lower-cased. */
  all: readonly string[];
  /** The workspace-root org's sender (as configured), if set. */
  root?: string;
}

type SenderLookup = (tenantId: string) => Promise<VerifiedSenders>;
let senderLookup: SenderLookup | null = null;

/** Called once from the email feature's boot path. Last registration wins. */
export function registerChainEmailSenderLookup(fn: SenderLookup): void {
  senderLookup = fn;
}

export type ChainSenderVerdict =
  | { ok: true; from: string }
  | { ok: false; code: 'email_sender_not_verified' | 'email_sender_unreadable' };

export async function bindChainSender(tenantId: string, from: string | undefined): Promise<ChainSenderVerdict> {
  const given = (from ?? '').trim();
  if (!senderLookup) return { ok: true, from: given };
  let senders: VerifiedSenders;
  try { senders = await senderLookup(tenantId); }
  catch (err) {
    // An unreadable settings store is not permission to send as anyone.
    log.warn('chain email sender lookup failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, code: 'email_sender_unreadable' };
  }
  if (senders.all.length === 0) return { ok: true, from: given };
  if (given === '') {
    const fallback = senders.root ?? (senders.all.length === 1 ? senders.all[0] : undefined);
    return fallback ? { ok: true, from: fallback } : { ok: false, code: 'email_sender_not_verified' };
  }
  return senders.all.includes(given.toLowerCase()) ? { ok: true, from: given } : { ok: false, code: 'email_sender_not_verified' };
}

export async function resolveChainPurpose(tenantId: string, actingUserId: string | undefined, declared: EgressPurpose | undefined): Promise<EgressPurpose> {
  if (declared !== 'transactional') return 'marketing';
  if (!actingUserId) {
    log.info('chain email transactional demoted', { tenantId, cause: 'no_acting_user' });
    return 'marketing';
  }
  try {
    await assertRunOrgScope(tenantId, actingUserId, tenantId, 'host:members:manage');
    return 'transactional';
  } catch {
    log.info('chain email transactional demoted', { tenantId, cause: 'not_workspace_admin' });
    return 'marketing';
  }
}

const windows = new Map<string, number>();
function recipientsPerHour(): number {
  const env = (process.env.OPENWOP_EMAIL_CHAIN_RECIPIENTS_PER_HOUR ?? '').trim();
  const raw = env === '' ? NaN : Number(env); // '' is UNSET (default), never 0 = off
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 300;
}

/** Spend `recipients` from the tenant's hourly budget. False (nothing spent) when it would overrun. */
export function takeChainSendBudget(tenantId: string, recipients: number, now = Date.now()): boolean {
  const limit = recipientsPerHour();
  if (limit === 0) return true;
  const hour = Math.floor(now / 3_600_000);
  const key = `${tenantId}\u0000${hour}`;
  if (windows.size > 5000) { for (const k of windows.keys()) if (!k.endsWith(`\u0000${hour}`)) windows.delete(k); }
  const used = windows.get(key) ?? 0;
  if (used + recipients > limit) return false;
  windows.set(key, used + recipients);
  return true;
}

/** Test seam. */
export function __resetChainEmailPolicyForTest(): void {
  windows.clear();
  senderLookup = null;
}
