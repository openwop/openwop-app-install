/**
 * ADR 0897 D2 / RFC 0247 — the ONE source of `limits.maxStreamAgeSec`, and of
 * whether this host may end an opted-in (`resumable=true`) WIRE stream early.
 *
 * RFC 0247 makes the two inseparable: a host MUST NOT end an opted-in stream
 * early unless it advertises the facet, and MUST end it by the advertised age.
 * The facet is advertised ONLY when the VENDORED v2 schemas carry it — the
 * closed v2 `limits` record rejects an unknown member, so advertising ahead of
 * the schema sync would red this host's own certified cut (the RFC 0244
 * precedent, `host/evals/evalCapability.ts`). Until the pin moves, wire streams
 * are never bounded: exactly the pre-RFC behaviour.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoSchemasDir } from './_repoPath.js';

/** RFC 0247 — a host MAY end an opted-in stream only once it has been open this long. */
export const RFC0247_MIN_AGE_MS = 15_000;

let cached: boolean | undefined;
let floorMs = RFC0247_MIN_AGE_MS;

/** True iff the vendored v2 capabilities schema defines `limits.maxStreamAgeSec`. */
export function rfc0247WireAvailable(): boolean {
  if (cached !== undefined) return cached;
  try {
    const dir = locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json');
    const caps = JSON.parse(readFileSync(join(dir, 'v2', 'capabilities.schema.json'), 'utf8')) as {
      properties?: { limits?: { properties?: Record<string, unknown> } };
    };
    cached = caps.properties?.limits?.properties?.maxStreamAgeSec !== undefined;
  } catch {
    cached = false;
  }
  return cached;
}

/** Test seam: re-read the vendored schema (or force a value), and lower the
 *  15 s floor so a route test does not wait 15 s per case. */
export function resetRfc0247WireCache(force?: boolean, floorForTestsMs: number = RFC0247_MIN_AGE_MS): void {
  cached = force;
  floorMs = floorForTestsMs;
}

/** The longest an opted-in wire stream is held, in ms; 0 = never bounded.
 *  `defaultMs` is the channel default (`OPENWOP_SSE_MAX_AGE_MS`). */
export function wireStreamMaxAgeMs(defaultMs: number): number {
  if (!rfc0247WireAvailable() || defaultMs <= 0) return 0;
  return Math.max(defaultMs, floorMs);
}

/** The floor every opted-in bound respects (15 s outside tests). */
export function wireStreamFloorMs(): number {
  return floorMs;
}

/** `limits.maxStreamAgeSec`, or `undefined` when this host does not bound. */
export function maxStreamAgeSec(defaultMs: number): number | undefined {
  const ms = wireStreamMaxAgeMs(defaultMs);
  return ms > 0 ? Math.ceil(ms / 1000) : undefined;
}
