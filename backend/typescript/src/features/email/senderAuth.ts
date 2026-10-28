/**
 * ADR 0955 D7 — the sender-domain authentication precondition for MARKETING email.
 *
 * Before a broadcast, the sending address's domain must publish SPF (a `v=spf1` TXT record) and
 * DMARC (a `v=DMARC1` TXT record at `_dmarc.<domain>`). Mailbox providers (Gmail, Yahoo bulk
 * sender rules) reject or junk mail that fails them, which burns the client's domain.
 *
 * - Enforced only when the `email.sender-auth` sub-toggle is ON. It is a RESTRICTION (on refuses
 *   more), so it is read with `resolveToggle`, and an unreadable toggle enforces (ADR 0819 §1).
 * - DNS answers are cached for 24 h per domain. "No such record" is a refusal
 *   (`sender_unauthenticated`); a DNS outage is its own refusal (`sender_auth_unverifiable`),
 *   never read as either a pass or a person's misconfiguration.
 * - **DKIM is NOT checked.** Its status lives in the email provider's domain-authentication API,
 *   which needs the provider credentials (ADR 0955 Q4 / the live-provider row: OPEN for David).
 *   Nothing here claims DKIM passed.
 */
import { promises as dns } from 'node:dns';
import { resolveToggle } from '../../host/featureToggles/service.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('email.sender-auth');

export const SENDER_AUTH_TOGGLE = 'email.sender-auth';
const TTL_MS = 24 * 3_600_000;

type TxtResolver = (name: string) => Promise<string[][]>;
let resolveTxt: TxtResolver = (name) => dns.resolveTxt(name);

interface Verdict { ok: boolean; missing: Array<'spf' | 'dmarc'>; unverifiable?: boolean; at: number }
const cache = new Map<string, Verdict>();

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'ENOENT']);

async function hasRecord(name: string, prefix: RegExp): Promise<boolean | 'unverifiable'> {
  try {
    const rows = await resolveTxt(name);
    return rows.some((chunks) => prefix.test(chunks.join('')));
  } catch (err) {
    if (NOT_FOUND.has((err as { code?: string }).code ?? '')) return false;
    log.warn('sender_auth_dns_failed', { name, code: (err as { code?: string }).code ?? 'unknown' });
    return 'unverifiable';
  }
}

/** SPF + DMARC for a domain, cached 24 h. */
export async function checkSenderDomain(domain: string, now: number = Date.now()): Promise<Verdict> {
  const d = domain.trim().toLowerCase();
  const hit = cache.get(d);
  if (hit && now - hit.at < TTL_MS) return hit;
  const [spf, dmarc] = await Promise.all([hasRecord(d, /^v=spf1(\s|$)/i), hasRecord(`_dmarc.${d}`, /^v=DMARC1(;|\s|$)/i)]);
  const unverifiable = spf === 'unverifiable' || dmarc === 'unverifiable';
  const missing: Array<'spf' | 'dmarc'> = [];
  if (spf === false) missing.push('spf');
  if (dmarc === false) missing.push('dmarc');
  const verdict: Verdict = { ok: !unverifiable && missing.length === 0, missing, ...(unverifiable ? { unverifiable: true } : {}), at: now };
  if (!unverifiable) cache.set(d, verdict); // an outage is never cached
  return verdict;
}

/** Throws a typed refusal when the toggle is on and the sending domain is not authenticated. */
export async function assertSenderAuthenticated(tenantId: string, fromAddress: string): Promise<void> {
  let on: boolean;
  try { on = (await resolveToggle(SENDER_AUTH_TOGGLE, { tenantId }))?.enabled === true; }
  catch { on = true; } // a restriction fails closed
  if (!on) return;
  const domain = fromAddress.includes('@') ? fromAddress.slice(fromAddress.lastIndexOf('@') + 1) : '';
  if (!domain) throw new OpenwopError('validation_error', 'The sender address has no domain to authenticate.', 400, { reason: 'sender_unauthenticated' });
  const v = await checkSenderDomain(domain);
  if (v.unverifiable) {
    throw new OpenwopError('service_unavailable', `Could not look up ${domain}'s DNS records just now; nothing was sent. Try again shortly.`, 503, { reason: 'sender_auth_unverifiable', domain });
  }
  if (!v.ok) {
    throw new OpenwopError('validation_error', `${domain} does not publish ${v.missing.map((m) => m.toUpperCase()).join(' and ')}, so mailbox providers would reject or junk this campaign. Add the record${v.missing.length > 1 ? 's' : ''} at your DNS host, then send again.`, 400, { reason: 'sender_unauthenticated', domain, missing: v.missing });
  }
}

/** Test seam: a fake DNS resolver, and a cleared cache. */
export function __setSenderAuthResolverForTests(fn: TxtResolver | null): void {
  resolveTxt = fn ?? ((name) => dns.resolveTxt(name));
  cache.clear();
}
