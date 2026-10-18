/**
 * ADR 0894 addendum (G-C) — resolve a browser-allowlist name and refuse it when
 * any address is private. The shared egress predicate (`isDeniedWebhookHost`)
 * judges each RESOLVED address, so there is still one list.
 *
 * The browser is hosted by the provider, which does its own connecting, so the
 * connect-time pin the host's own egress uses cannot apply. What the host CAN do
 * is resolve every allowlisted name itself: at start, and again on every advance
 * (a name that starts resolving private mid-session — DNS rebinding — ends the
 * session). A name the host cannot resolve proves nothing either way (the
 * provider may see different DNS), so a lookup failure is not a refusal; an
 * address in a denied range always is. Rebinding between this check and the
 * provider's own connection stays the provider's (residue CU2-R1, narrowed).
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isDeniedWebhookHost } from '../../host/webhookEgressGuard.js';

const LOOKUP_TIMEOUT_MS = 1_500;

/** The first denied address `hostname` resolves to, or null. IP literals are
 *  judged by name already (`isRefusedBrowserHost`), so they are not looked up. */
export async function privateResolutionOf(hostname: string): Promise<string | null> {
  if (isIP(hostname.replace(/^\[|\]$/g, ''))) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    const addrs = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('dns_timeout')), LOOKUP_TIMEOUT_MS); }),
    ]);
    for (const a of addrs) if (isDeniedWebhookHost(a.address)) return a.address;
    return null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The first allowlisted origin whose name resolves private, or null. */
export async function privateOriginOf(origins: readonly string[]): Promise<string | null> {
  for (const origin of origins) {
    let host: string;
    try { host = new URL(origin).hostname; } catch { continue; }
    if (await privateResolutionOf(host)) return origin;
  }
  return null;
}
