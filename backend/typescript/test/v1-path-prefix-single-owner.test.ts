import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { V1_PATH_PREFIX, v1 } from '../src/middleware/protocolVersion.js';

/**
 * ADR 0649 — the major-1 path prefix has ONE owner.
 *
 * Before this ADR, 346 of 347 route registrations spelled `/v1` themselves, so
 * retiring major 1 (ADR 0642 — atomic, EOS 2026-12-04) meant 46 protocol edits
 * across 14 files under a deadline. Now every protocol route registers through
 * `v1()`. This test is the ratchet that keeps it so: a new protocol route that
 * hard-codes `/v1/` is a second owner and reddens here with its file and line.
 *
 * Host-extension routes (`/v1/host/…`) and the conformance seams
 * (`/v1/packs-test/…`) are EXCLUDED on purpose: they are not retiring with the
 * protocol, and a shared prefix would flip them by accident.
 */
const ROUTE_LITERAL = /app\.(?:get|post|put|patch|delete|all)\(\s*['`](\/v1\/[^'`]*)['`]/g;
const EXEMPT = (p: string) => p.startsWith('/v1/host/') || p.startsWith('/v1/packs-test');

function* tsFiles(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* tsFiles(p);
    else if (e.isFile() && p.endsWith('.ts')) yield p;
  }
}

describe('ADR 0649 — one owner for the v1 path prefix', () => {
  it('spells the prefix once, and isV1Path derives from it', () => {
    expect(V1_PATH_PREFIX).toBe('/v1');
    expect(v1('/runs')).toBe('/v1/runs');
    expect(v1('/runs/:runId/events')).toBe('/v1/runs/:runId/events');
  });

  it('no protocol route registration hard-codes /v1/ (host-extension and seam routes exempt)', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const dir of ['src/routes', 'src/middleware', 'src/features']) {
      for (const f of tsFiles(dir)) {
        scanned += 1;
        const text = readFileSync(f, 'utf8');
        for (const m of text.matchAll(ROUTE_LITERAL)) {
          if (EXEMPT(m[1]!)) continue;
          const line = text.slice(0, m.index).split('\n').length;
          offenders.push(`${f}:${line} ${m[1]}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(50); // non-vacuous: the walk found the sources
    expect(offenders, `protocol routes still spelling /v1 themselves:\n${offenders.join('\n')}`).toEqual([]);
  });
});
