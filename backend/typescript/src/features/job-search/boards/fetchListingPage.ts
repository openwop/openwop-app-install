/**
 * ADR 0542 D3/D5 — the ONE outbound fetch for board content.
 *
 * The architecture review's finding, and the reason this module exists rather
 * than an inline `await fetch(url)`: a career-page URL is **attacker-supplied**,
 * which makes it the highest-risk fetch in this vertical. Calling `fetch()`
 * directly would bypass every one of the host's existing egress controls —
 *
 *   - the denied-range SSRF predicate (`isDeniedWebhookHost`);
 *   - **pinned resolution**, which closes the DNS-rebinding TOCTOU window by
 *     validating inside the connection's own lookup, so the approved address is
 *     the dialled address;
 *   - the `redirect: 'error'` policy, which is deliberately NOT env-bypassable
 *     and stops a public URL bouncing to `169.254.169.254`;
 *   - the https-only requirement.
 *
 * All of that already exists in `host/webhookEgressGuard.ts`. Reusing it is the
 * whole point: a second egress path is a second thing to get right, and the
 * guard's own header says its two call sites share one predicate precisely so
 * they cannot drift. This becomes the third.
 *
 * What the guard does NOT do is bound the RESPONSE, so that is added here.
 */
import { guardedEgressFetch } from '../../../host/webhookEgressGuard.js';
import { MAX_HTML_BYTES } from './jsonLd.js';
import { createLogger } from '../../../observability/logger.js';

const log = createLogger('job-search.boards.fetch');

/** Wall-clock bound. A career page that never finishes sending must not hold a
 *  campaign slot open indefinitely. */
const FETCH_TIMEOUT_MS = 10_000;

export type FetchOutcome =
  | { ok: true; html: string; truncated: boolean }
  | { ok: false; reason: 'egress-denied' | 'http-error' | 'too-large' | 'timeout' | 'network'; detail: string };

/**
 * Fetch a career page for Tier-2 extraction.
 *
 * Returns a typed outcome instead of throwing. Per D3 the failure posture is "a
 * skipped listing with a recorded reason, never a stopped campaign", and a
 * thrown error at this layer would propagate into exactly the campaign halt the
 * ADR rules out.
 */
export async function fetchListingPage(url: string): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await guardedEgressFetch(url, {
      // A plain, honest UA. Deliberately not disguised as a browser: Tier 2 reads
      // data published to be read, and pretending otherwise would be the posture
      // D5 excluded Tier 4 to avoid.
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'openwop-app job-search (+https://openwop.dev)' },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: 'http-error', detail: `status ${res.status}` };

    // Stream with a hard byte cap rather than `res.text()`. `text()` buffers
    // whatever arrives, so a hostile or merely enormous page would be read in
    // full before any length check could reject it — the check has to happen
    // DURING the read to bound memory at all.
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, reason: 'network', detail: 'no response body' };
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_HTML_BYTES) {
        truncated = true;
        // Cancel rather than drain: continuing to read a page we have already
        // decided to bound would defeat the bound.
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    return { ok: true, html, truncated };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (controller.signal.aborted) return { ok: false, reason: 'timeout', detail: `>${FETCH_TIMEOUT_MS}ms` };
    // An egress denial is a SECURITY outcome and is logged as such; the caller
    // still just skips the listing.
    if (/egress|denied|https/i.test(msg)) {
      log.warn('board_fetch_egress_denied', { detail: msg });
      return { ok: false, reason: 'egress-denied', detail: msg };
    }
    return { ok: false, reason: 'network', detail: msg };
  } finally {
    clearTimeout(timer);
  }
}
