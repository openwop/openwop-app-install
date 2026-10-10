/**
 * ADR 0761 — the origin this host's event streams should be read from, when
 * the public front door cannot carry them.
 *
 * MEASURED 2026-09-27: through `https://app.openwop.dev/api` (the Firebase
 * Hosting rewrite in front of Cloud Run) a server-sent-events response
 * delivered ZERO bytes in 25 s — not even headers — while the Cloud Run origin
 * answered headers in 291 ms. Hosting buffers rewritten responses, and that is
 * not configurable. The SPA already bypasses the rewrite for streams
 * (`VITE_OPENWOP_SSE_BASE_URL`); this advertises the same origin to every
 * other client under the host's own extension record
 * (`extensions["openwop-app.host"].streamBase`, versioning.md §5 — a
 * host-proprietary value, not a protocol field: `runs.md` requires `eventsUrl`
 * to stay on the request's origin, so the protocol itself cannot redirect).
 *
 * OPTIONAL and FAIL-QUIET: unset means nothing is advertised; an invalid value
 * is dropped (warned once) rather than failing the boot, because a missing hint
 * only costs streaming latency, while a bad one would hand every client an
 * origin to send its bearer to. Only an `https:` URL with no credentials,
 * query or fragment is advertised.
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('stream-base');
let warned = false;

/** The validated stream origin (no trailing slash), or undefined when unset/invalid. */
export function streamBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = (env.OPENWOP_STREAM_BASE_URL ?? '').trim();
  if (raw === '') return undefined;
  const reason = invalidReason(raw);
  if (reason !== undefined) {
    if (!warned) {
      warned = true;
      log.warn('stream_base_ignored', { reason });
    }
    return undefined;
  }
  return raw.replace(/\/+$/, '');
}

function invalidReason(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return 'OPENWOP_STREAM_BASE_URL is not a URL'; }
  if (url.protocol !== 'https:') return 'OPENWOP_STREAM_BASE_URL must be https';
  if (url.username !== '' || url.password !== '') return 'OPENWOP_STREAM_BASE_URL must not carry credentials';
  if (url.search !== '' || url.hash !== '') return 'OPENWOP_STREAM_BASE_URL must not carry a query or fragment';
  return undefined;
}

/** The discovery fragment: `{ streamBase }` when configured and valid, else `{}`. */
export function streamBaseRecord(env: NodeJS.ProcessEnv = process.env): { streamBase?: string } {
  const base = streamBaseUrl(env);
  return base ? { streamBase: base } : {};
}

/** Test seam: forget the one-time warning. */
export function resetStreamBaseWarningForTests(): void {
  warned = false;
}
