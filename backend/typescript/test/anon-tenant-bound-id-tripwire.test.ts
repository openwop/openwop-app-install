import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateRepoSchemasDir } from '../src/host/_repoPath.js';
import { V2_TENANT_ID, toWireRunId } from '../src/host/v2Ids.js';

/**
 * ADR 0704 — this host's `V2_TENANT_ID` guard must be EXACTLY as wide as the
 * tenant segment of the corpus's bound-id grammar; no wider, no narrower.
 *
 * **Why this test exists.** `openwop-1` warned (crosstalk `dd19`) that a host
 * minting `anon:`-prefixed tenants had been emitting schema-invalid runIds,
 * because `ids.schema.json#tenantId` admits `anon:` while all five bound-id
 * kinds spelled their tenant segment without it.
 *
 * MEASURED here: the warning does not apply, for a reason worth keeping. This
 * host DOES mint `anon:` tenants (`middleware/cookieSession.ts:158`), but
 * `V2_TENANT_ID` is `^[A-Za-z0-9._~-]{1,128}$` — narrower than `tenantId` — so
 * `toWireRunId` silently DECLINES to bind them and returns a bare id. We never
 * emitted the invalid form because we never emitted the bound form at all.
 *
 * That is a conformance gap, not an isolation hole: `host/runAccess.ts` enforces
 * `run.tenantId !== req.tenantId` independently of the id's spelling.
 *
 * **The tripwire fired at suite 2.2.0**, when RFC 0184 widened the five bound-id
 * patterns to admit `anon:`. The steward's decision (ADR 0704 § "The tripwire
 * fired") is to keep anonymous runs UNBOUND for now: binding them is a product
 * change, not a pattern fix. The middle leg therefore pins the residue — corpus
 * admits `anon:`, this host deliberately does not — instead of the old equality.
 */
function tenantSegmentOf(boundPattern: string): string {
  // `^<tenant>/<opaque>$` — take everything between the anchor and the slash.
  const m = /^\^(.*?)\/(?:.*)\$$/.exec(boundPattern);
  if (m === null) throw new Error(`bound-id pattern is not <tenant>/<opaque>: ${boundPattern}`);
  return m[1] as string;
}

const ids = JSON.parse(
  readFileSync(
    join(locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'run-event.schema.json'), 'v2', 'ids.schema.json'),
    'utf8',
  ),
) as { $defs: Record<string, { pattern?: string }> };

describe('anon-tenant bound ids (crosstalk dd19)', () => {
  it('this host mints anon: tenants, so the question is live', () => {
    // Non-vacuity: if this host stopped minting them the rest of the test would
    // be guarding nothing, and would keep passing while guarding nothing.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'middleware', 'cookieSession.ts'),
      'utf8',
    );
    expect(src.includes('anon:'), 'cookieSession mints an anon: tenant').toBe(true);
  });

  it('the corpus admits anon: tenants, and the guard is deliberately the grammar WITHOUT them', () => {
    // Fired as designed at suite 2.2.0 (RFC 0184 widened the five bound-id
    // patterns to `^(anon:)?…`). ADR 0704 § "The tripwire fired" records the
    // decision taken then: anon runs stay UNBOUND for now, because binding them
    // changes the ids every anonymous visitor's links carry, and that is a
    // product decision (ADR 0469/0470), not a regex fix. So the invariant is
    // restated rather than deleted: the guard equals the corpus tenant segment
    // with exactly the `(anon:)?` prefix removed. It reds if the corpus grammar
    // moves again, or if the guard is widened without revisiting ADR 0704.
    const seg = tenantSegmentOf(ids.$defs.runId?.pattern ?? '');
    expect(seg.startsWith('(anon:)?'), `ids.schema.json#runId tenant segment admits anon: (got ${seg})`).toBe(true);
    expect(
      V2_TENANT_ID.source,
      'V2_TENANT_ID must be the corpus tenant segment minus `(anon:)?`. Widening it binds '
        + 'anonymous runs; revisit ADR 0704 first.',
    ).toBe(`^${seg.slice('(anon:)?'.length)}$`);
  });

  it('and today that means an anon tenant produces a BARE id, not an invalid one', () => {
    // The measured consequence, pinned so it cannot change silently. The day
    // this flips, `toWireRunId` starts binding anon runs — which is the
    // behaviour RFC 0184 permits, and ADR 0704 must be revisited first.
    const opaque = '7f3a9c1e-2b4d-4a6f-8e10-9c2d5b7a1f04';
    expect(toWireRunId(opaque, 'acme')).toBe(`acme/${opaque}`);
    expect(toWireRunId(opaque, 'anon:s7Kq2mVx9Lp4')).toBe(opaque);
  });
});
