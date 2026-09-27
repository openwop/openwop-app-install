/**
 * RFC 0168 §C.1 — `/conformance/seams/…` is the v2 address of the seam surface,
 * and `conformance.seamsProfile` is a CLAIM that the space is served.
 *
 * Two things are pinned here, and the second is the point:
 *  1. Every operation `SEAM_OPERATIONS` marks `served: true` really answers at
 *     its v2 address — the manifest cannot claim a mount it does not have.
 *  2. The advert is DERIVED from that manifest, so it stays off while any floor
 *     operation is missing. The old gate was `OPENWOP_V2_SEAMS_MOUNTED`, an env
 *     var nothing checked: set it where the seams are absent and the host
 *     advertises a path space it does not serve.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SEAM_OPERATIONS,
  SEAMS_PREFIX, seamAliasTarget, seamsFloorServed, unservedSeamOperation } from '../src/routes/conformanceSeams.js';

let server: Server; let base = '';
const AUTH = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

/** A concrete request path for an operation's templated v2 path. */
function concrete(v2Path: string): string {
  return v2Path
    .replace('{taskId}', 'seam-mount-probe')
    .replace('{path}', 'seam-mount-probe.txt')
    .replace('{name}', 'vendor.acme.seam-mount-probe')
    .replace('{version}', '1.0.0');
}

describe('the seam alias serves every operation the manifest claims', () => {
  // A 404 is AMBIGUOUS — it means both "no route" and "no such resource" — so
  // "not 404" is not a mount probe. (Measured: the workspace GET and the
  // packs-test reads answer 404 for a resource that does not exist, at an
  // address that is mounted perfectly well.) The unambiguous question is
  // EQUIVALENCE: the v2 address must answer exactly as its v1 twin, because the
  // alias is a rewrite onto that very handler. Same status ⇒ same handler.
  //
  // HONEST LIMIT of this leg: for the reads whose resource does not exist, BOTH
  // addresses answer 404 with and without the alias, so those rows do not
  // discriminate on their own — removing the mount reddens 3 of the 9. The
  // liveness leg below is what makes the mount falsifiable; it is there because
  // an all-404 equivalence would otherwise read as a pass.
  it.each(SEAM_OPERATIONS.filter((op) => op.served).map((op) => [op.operationId, op] as const))(
    '%s answers identically at its v2 address and its v1 twin',
    async (_id, op) => {
      const v2Path = concrete(op.v2Path);
      const v1Path = seamAliasTarget(v2Path);
      expect(v1Path, `${op.operationId} is not covered by any alias prefix`).not.toBeNull();
      const send = (path: string) => fetch(`${base}${path}`, {
        method: op.method.toUpperCase(),
        headers: AUTH,
        body: op.method === 'put' || op.method === 'post' ? '{}' : undefined,
      });
      const [viaSeam, viaV1] = await Promise.all([send(v2Path), send(v1Path!)]);
      expect(viaSeam.status, `${op.operationId}: ${v2Path} answered ${viaSeam.status}, ${v1Path} answered ${viaV1.status} — the alias does not reach the same handler`).toBe(viaV1.status);
    },
  );

  it('an unmapped path is left alone, and each prefix maps to its v1 address', () => {
    expect(seamAliasTarget('/v1/runs/abc')).toBeNull();
    expect(seamAliasTarget('/conformance/seams/sample/a2a/tasks/t1')).toBe('/v1/host/sample/a2a/tasks/t1');
    expect(seamAliasTarget('/conformance/seams/workspace/files')).toBe('/v1/host/workspace/files');
    expect(seamAliasTarget('/conformance/seams/packs-test/x/-/1.0.0.tgz')).toBe('/v1/packs-test/x/-/1.0.0.tgz');
    // ADR 0749 — the v2 emit seam is its own handler, not the v1 `{surface}` one.
    expect(seamAliasTarget('/conformance/seams/sample/a2ui/emit-surface')).toBe('/v1/host/sample/a2ui/v2/emit-surface');
  });

  it('a served operation is genuinely routed — its v1 twin is not a blanket 404', async () => {
    // The equivalence check above would also pass if BOTH addresses 404'd because
    // neither is mounted. This leg falsifies that: the workspace list is a real
    // handler and answers 2xx for the caller's own tenant.
    const r = await fetch(`${base}/conformance/seams/workspace/files`, { headers: AUTH });
    expect([200, 204], `the workspace list seam answered ${r.status}`).toContain(r.status);
  });
});

describe('the seamsProfile advert is derived from the mount, not asserted', () => {
  /**
   * The BICONDITIONAL, not a frozen roster.
   *
   * This assertion originally pinned the four unserved seams by name, and it
   * went red the moment two of them landed — correctly, but for the wrong
   * reason: it was tracking a snapshot, so every seam that shipped broke it and
   * the fix each time was to retype the list. A list that must be retyped to stay
   * green teaches nothing when it is finally empty.
   *
   * What must hold forever is the LINK between the mount and the claim: off
   * while anything is missing, on when nothing is. Both directions are asserted,
   * so the day the last seam lands this test says the advert must flip rather
   * than needing to be told.
   */
  it('the advert tracks the mount in BOTH directions', async () => {
    const missing = SEAM_OPERATIONS.filter((op) => op.floor && !op.served).map((op) => op.operationId);
    // Non-vacuity: there IS a floor to be unserved, so neither branch is empty by construction.
    expect(SEAM_OPERATIONS.filter((op) => op.floor).length).toBeGreaterThan(0);

    if (missing.length > 0) {
      expect(seamsFloorServed(), `unserved floor seams (${missing.join(', ')}) must keep the advert off`).toBe(false);
      const doc = await (await fetch(`${base}/.well-known/openwop`, { headers: { ...AUTH, 'OpenWOP-Version': '2' } })).json() as Record<string, unknown>;
      expect(doc.conformance, 'advertising a profile whose floor seams 404 is a false claim about the path space').toBeUndefined();
    } else {
      expect(seamsFloorServed(), 'every floor seam is served — withholding the advert would now be an UNDER-claim').toBe(true);
      const doc = await (await fetch(`${base}/.well-known/openwop`, { headers: { ...AUTH, 'OpenWOP-Version': '2' } })).json() as Record<string, unknown>;
      expect((doc.conformance as Record<string, unknown> | undefined)?.seamsProfile).toBe('openwop-conformance-seams-v2');
    }
  });

  it('records which floor seams remain, so the count cannot drift unnoticed', () => {
    const floor = SEAM_OPERATIONS.filter((op) => op.floor);
    const missing = floor.filter((op) => !op.served).map((op) => op.operationId).sort();
    // A deliberate snapshot: shrinking it is the work, and it must be edited
    // knowingly rather than by a list that silently grows back. It is EMPTY as of
    // ADR 0639 — `forceEffectTransportRetry` was the last one.
    expect(missing).toEqual([]);
    // NON-VACUITY, which matters more now that the expectation is `[]` than it
    // ever did while the list had an entry: an empty `missing` is also what a
    // SEAM_OPERATIONS that lost its floor rows would produce, and that reads as
    // "all served" while measuring nothing. Pin the denominator.
    expect(floor.length, 'the floor ledger must not be empty — an empty one makes the assertion above vacuous').toBeGreaterThan(3);
  });

  it('an env var nobody checks cannot change the claim — in EITHER direction', async () => {
    // This asserted `doc.conformance` was UNDEFINED with `OPENWOP_V2_SEAMS_MOUNTED`
    // set. It passed for a reason that has now gone away: a floor seam was
    // unserved, so the profile was withheld no matter what any env var said. With
    // the floor complete the advert is legitimately ON, and the old assertion
    // would have to be deleted.
    //
    // Deleting it would lose the property, which is still worth binding: the
    // advert follows the MOUNT (`seamsFloorServed()` — the real gate plus every
    // floor operation served), never `OPENWOP_V2_SEAMS_MOUNTED`, which nothing
    // reads. So assert IRRELEVANCE instead of absence — strictly stronger, since
    // it now catches a change in both directions rather than only the one the
    // withheld state happened to make observable.
    const read = async () => (await (await fetch(`${base}/.well-known/openwop`, { headers: { ...AUTH, 'OpenWOP-Version': '2' } })).json() as Record<string, unknown>).conformance;
    const prev = process.env.OPENWOP_V2_SEAMS_MOUNTED;
    delete process.env.OPENWOP_V2_SEAMS_MOUNTED;
    const without = await read();
    process.env.OPENWOP_V2_SEAMS_MOUNTED = 'true';
    try {
      const withVar = await read();
      expect(withVar, 'the advert must follow the mount, not an env var nobody checks').toEqual(without);
      // And non-vacuously: if BOTH were undefined this would pass while proving
      // nothing about the var.
      expect(without, 'the floor is complete, so the profile must actually be advertised here').toBeDefined();
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_V2_SEAMS_MOUNTED; else process.env.OPENWOP_V2_SEAMS_MOUNTED = prev;
    }
  });

  // The hosting guard (`check-hosting-wire-rewrites.cjs`) pins ONE literal source,
  // `/conformance/**`, because the v2 path manifest is generated with "no seam or
  // test-mode operation" and so cannot supply these addresses. That single literal
  // is only sufficient while every seam actually lives under the prefix — this leg
  // is where that holds. Add a seam at some other root and this goes red, instead
  // of the guard passing while the new address answers the SPA shell as text/html.
  it('every seam address sits under the one prefix the hosting rewrite pins', () => {
    expect(SEAMS_PREFIX).toBe('/conformance/seams');
    const outside = SEAM_OPERATIONS.filter((op) => !op.v2Path.startsWith(`${SEAMS_PREFIX}/`));
    expect(outside.map((op) => op.operationId)).toEqual([]);
    expect(SEAM_OPERATIONS.length).toBeGreaterThanOrEqual(16);
  });
});

/**
 * WS0 (2026-09-24) — a declared-but-UNSERVED seam must answer 404, never
 * whatever v1 route happens to share its tail. `emitA2uiSurface`'s v2 address
 * used to rewrite onto the RFC 0114 v1 handler and answer 400 to the RFC 0209
 * body; the corpus reads any non-404/405 as "seam wired" and would have
 * recorded fails for a seam this host never built.
 */
describe('declared-but-unserved seams answer 404 (WS0)', () => {
  it('the manifest names EVERY operation the pinned seams-v2.yaml declares — no silent omission', () => {
    const require = createRequire(import.meta.url);
    const yaml = readFileSync(require.resolve('@openwop/spec-artifacts/api/seams-v2.yaml'), 'utf8');
    const declared = [...yaml.matchAll(/^\s+operationId:\s*(\S+)/gm)].map((m) => m[1]!).sort();
    expect(declared.length, 'no operationIds parsed — the yaml moved').toBeGreaterThanOrEqual(16);
    expect(SEAM_OPERATIONS.map((op) => op.operationId).sort()).toEqual(declared);
  });

  // ADR 0749 — the RFC 0209 seam now exists, so its v2 address reaches ITS OWN
  // handler (a run that does not exist is `404 not_found` with a RUN message,
  // and an empty body is a 400 from the v2 handler), never the v1 `{surface}` one.
  it('the v2 emitA2uiSurface address reaches the RFC 0209 handler while the v1 RFC 0114 route still answers', async () => {
    const v2 = await fetch(`${base}${SEAMS_PREFIX}/sample/a2ui/emit-surface`, {
      method: 'POST', headers: AUTH, body: JSON.stringify({ runId: 'ws0-probe', envelope: { type: 'ui.a2ui-surface' } }),
    });
    expect(v2.status).toBe(404);
    expect(((await v2.json()) as { message?: unknown }).message).toMatch(/^run /);
    const v2Empty = await fetch(`${base}${SEAMS_PREFIX}/sample/a2ui/emit-surface`, { method: 'POST', headers: AUTH, body: '{}' });
    expect(((await v2Empty.json()) as { message?: unknown }).message).toMatch(/runId and envelope/);
    // The v1 route is untouched: a body missing runId gets its own 400, not a 404.
    const v1 = await fetch(`${base}/v1/host/sample/a2ui/emit-surface`, { method: 'POST', headers: AUTH, body: '{}' });
    expect(v1.status).toBe(400);
  });

  it('every served:false operation is refused and no served one is', () => {
    for (const op of SEAM_OPERATIONS) {
      const hit = unservedSeamOperation(op.method, concrete(op.v2Path));
      expect(hit?.operationId ?? null, op.operationId).toBe(op.served ? null : op.operationId);
    }
  });
});
