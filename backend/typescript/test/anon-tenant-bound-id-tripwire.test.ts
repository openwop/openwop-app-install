import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { locateRepoSchemasDir } from '../src/host/_repoPath.js';
import { V2_TENANT_ID, fromWireRunId, toWireRunId } from '../src/host/v2Ids.js';

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
 * patterns to admit `anon:`. ADR 0704 first kept anonymous runs UNBOUND; ADR 0760
 * (issue #4169) binds them, because a bare id on the major-2 wire is exactly what
 * identity.md §5 forbids. The equality leg is restored.
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

  it('the guard is EXACTLY the corpus tenant segment, anon: prefix included (ADR 0760)', () => {
    // ADR 0704 kept anonymous runs unbound and pinned the guard to the corpus
    // segment MINUS `(anon:)?`. ADR 0760 revisits that: an unbound id on the
    // major-2 wire is what identity.md §5 forbids, and the corpus has admitted
    // `anon:` since suite 2.2.0. So the original invariant is back — equality,
    // derived from the vendored schema, red on drift in either direction.
    const seg = tenantSegmentOf(ids.$defs.runId?.pattern ?? '');
    expect(seg.startsWith('(anon:)?'), `ids.schema.json#runId tenant segment admits anon: (got ${seg})`).toBe(true);
    expect(V2_TENANT_ID.source, 'V2_TENANT_ID must equal the corpus runId tenant segment').toBe(`^${seg}$`);
  });

  it('an anon tenant BINDS its runs, and the bound id satisfies the vendored runId grammar', () => {
    const opaque = '7f3a9c1e-2b4d-4a6f-8e10-9c2d5b7a1f04';
    expect(toWireRunId(opaque, 'acme')).toBe(`acme/${opaque}`);
    const anon = toWireRunId(opaque, 'anon:s7Kq2mVx9Lp4');
    expect(anon).toBe(`anon:s7Kq2mVx9Lp4/${opaque}`);
    expect(new RegExp(ids.$defs.runId?.pattern ?? '^$').test(anon), 'bound anon id matches ids.schema.json#runId').toBe(true);
  });

  it('inbound: the bound anon id (raw or path-projected) resolves for its own tenant only, and a bare id is still accepted', () => {
    const opaque = '7f3a9c1e-2b4d-4a6f-8e10-9c2d5b7a1f04';
    const t = 'anon:s7Kq2mVx9Lp4';
    expect(fromWireRunId(`${t}/${opaque}`, t)).toEqual({ ok: true, runId: opaque });
    expect(fromWireRunId(`anon~3As7Kq2mVx9Lp4/${opaque}`, t)).toEqual({ ok: true, runId: opaque });
    expect(fromWireRunId(opaque, t), 'existing bare anonymous links keep resolving').toEqual({ ok: true, runId: opaque });
    expect(fromWireRunId(`${t}/${opaque}`, 'anon:someoneElse').ok, 'another anon tenant is refused').toBe(false);
  });
});
