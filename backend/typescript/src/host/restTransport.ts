/**
 * RFC 0115 — Run Transport Economy (conditional GET + Content-Encoding).
 *
 * Host-internal helpers for `GET /v1/runs/{runId}`:
 *  - a STRONG `ETag` derived from the run's latest persisted event-log
 *    sequence number (`storage.getMaxSequence`), so it changes on every
 *    observable transition and is stable while none occurs (RFC 0115
 *    §Proposal; architect pin 2026-06-26 — NOT a wall-clock / cached
 *    projection that could leave a `304` stale);
 *  - `If-None-Match` evaluation → `304 Not Modified`;
 *  - `Accept-Encoding` negotiation with a body that decodes byte-identically
 *    to the identity response.
 *
 * The encoding set is RUNTIME-DETECTED (gzip is always present; brotli on any
 * modern Node; zstd only on Node ≥ 22.15/23). `SUPPORTED_RUN_ENCODINGS` is the
 * single source of truth: the discovery advert (`restTransport.contentEncodings`)
 * imports the SAME constant so an advertised encoding is always one the host can
 * actually serve (honest-witness rule). The set is bounded by RFC 0115's
 * capability enum `["gzip","br","zstd"]` (gzip is the SHOULD baseline; br/zstd
 * are OPTIONAL — Unresolved Q2 resolved by the steward 2026-06-26).
 */
import zlib from 'node:zlib';
import type { Request, Response } from 'express';

/** Encodings RFC 0115 allows in `restTransport.contentEncodings`. */
type RunEncoding = 'gzip' | 'br' | 'zstd';

/** Compress the JSON string for a given encoding, or `null` if unavailable. */
const ENCODERS: Record<RunEncoding, ((s: string) => Buffer) | null> = {
  gzip: typeof zlib.gzipSync === 'function' ? (s) => zlib.gzipSync(s) : null,
  br: typeof zlib.brotliCompressSync === 'function' ? (s) => zlib.brotliCompressSync(s) : null,
  // zstd landed in node:zlib after the 22.13 LTS line; gate on presence so we
  // never advertise what this runtime cannot encode.
  zstd:
    typeof (zlib as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync === 'function'
      ? (s) => (zlib as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync(Buffer.from(s, 'utf8'))
      : null,
};

/**
 * Encodings this host will actually negotiate, in server preference order
 * (zstd > br > gzip when present — better ratio first). Honest: an entry
 * appears only if the runtime can encode it. On Node 22.13 this is
 * `["br","gzip"]`.
 */
export const SUPPORTED_RUN_ENCODINGS: readonly RunEncoding[] = (['zstd', 'br', 'gzip'] as const).filter(
  (e) => ENCODERS[e] !== null,
);

/** Strong ETag for a run snapshot, keyed to its event-log head sequence. */
export function runEtag(runId: string, maxSequence: number): string {
  // Strong validator (no `W/` prefix). The run id keeps it unambiguous across
  // resources; the sequence makes it advance on every observable transition.
  return `"${runId}.${maxSequence}"`;
}

/**
 * True when an `If-None-Match` request header matches the current ETag and the
 * server MUST answer `304`. Honors a comma-separated list and `*`. Strong
 * comparison (we only emit strong tags); a `W/`-weakened candidate still
 * matches its strong form per RFC 7232 §2.3.2 weak/strong list membership for
 * `If-None-Match`.
 */
export function ifNoneMatchSatisfied(req: Request, etag: string): boolean {
  const header = req.header('if-none-match');
  if (!header) return false;
  const candidates = header.split(',').map((t) => t.trim());
  if (candidates.includes('*')) return true;
  return candidates.some((c) => c === etag || c.replace(/^W\//, '') === etag);
}

/** Pick the best mutually-supported encoding from `Accept-Encoding`, or null. */
function negotiateEncoding(req: Request): RunEncoding | null {
  const header = req.header('accept-encoding');
  if (!header) return null;
  // Parse `gzip;q=0.5, zstd` → set of acceptable (q>0) tokens.
  const acceptable = new Set<string>();
  for (const part of header.split(',')) {
    const [tokenRaw, ...params] = part.trim().split(';');
    const token = (tokenRaw ?? '').trim().toLowerCase();
    if (!token) continue;
    const q = params
      .map((p) => p.trim().match(/^q=(.*)$/i))
      .find(Boolean);
    const qv = q ? Number(q[1]) : 1;
    if (Number.isFinite(qv) && qv > 0) acceptable.add(token);
  }
  // Server preference order; `*` means "any", so fall to our top choice.
  for (const enc of SUPPORTED_RUN_ENCODINGS) {
    if (acceptable.has(enc) || acceptable.has('*')) return enc;
  }
  return null;
}

/**
 * Send `body` as JSON on a `200`, negotiating `Content-Encoding` per RFC 0115.
 * Always sets `Vary: Accept-Encoding`. The compressed bytes decode to exactly
 * the identity JSON string, so the decoded body is byte-identical regardless of
 * the chosen encoding.
 */
export function sendNegotiatedRunJson(req: Request, res: Response, body: unknown): void {
  const json = JSON.stringify(body);
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const enc = negotiateEncoding(req);
  const encode = enc ? ENCODERS[enc] : null;
  // Skip if an upstream middleware already negotiated an encoding for us.
  if (enc && encode && !res.getHeader('Content-Encoding')) {
    res.setHeader('Content-Encoding', enc);
    res.send(encode(json));
    return;
  }
  res.send(json);
}
