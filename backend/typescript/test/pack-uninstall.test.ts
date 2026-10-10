/**
 * Two-tier pack uninstall (ADR 0194 Phase 4) — route harness over a TEMP pack
 * dir (OPENWOP_PACK_DIR), so the shared ~/.openwop-packs is never touched.
 *
 * Drives: tombstone (listing flagged + node-catalog hidden host-wide + install
 * refused), the protected classes (feature-pinned 409 via requiredBy — the
 * wired Phase-1 guard; core.openwop.* 409), the purge gates (tombstone-first
 * 409; definition-reference 409 with workflowIds; success deletes the dir and
 * KEEPS the tombstone row), restore, and the boot-loader skip (mountLocalPacks
 * never re-mounts a tombstoned pack).
 *
 * Sabotage witnesses (wave 10): core / requiredBy refusals removed → protected-
 * classes red; catalog tombstone filter, listing flag, restore, or the install
 * lane's tombstone check removed → tombstone red; tombstone-first or reference
 * gate removed → purge red; either rubble shape read as "no nodes" → its WF-MKT-1
 * case red; absent-dir or no-nodes over-refusal → their discriminators red; the
 * mount pass's tombstone skip removed → re-mount red; `requireSuperadmin` removed
 * → superadmin red (a scoped NON-superadmin key, not an anonymous call — anonymous
 * is refused upstream, which made the old case vacuous); path-safety check
 * removed → traversal red; `isSafePackName` dot-segment rule removed → unit red.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PACK_DIR = mkdtempSync(join(tmpdir(), 'owp-uninstall-'));
const PREV_PACK_DIR = process.env.OPENWOP_PACK_DIR;
process.env.OPENWOP_PACK_DIR = PACK_DIR; // BEFORE createApp import side effects

import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { getListing } from '../src/features/marketplace/listingService.js';
import { __clearPackTombstones, isTombstoned, tombstonePack, restorePack } from '../src/host/packTombstones.js';
import { ensureLocalPacksMounted } from '../src/bootstrap/mountLocalPacks.js';
import { isSafePackName } from '../src/packs/registryInstaller.js';

const VENDOR = 'vendor.test.widgets';
const VENDOR_TYPE = 'vendor.test.widgets.spin';
// The purge case's OWN pack, so it shares no state with the tombstone/restore case
// (it used to need that case to have restored VENDOR first — order-dependent).
const PURGE = 'vendor.test.purge';
const PURGE_TYPE = 'vendor.test.purge.spin';
// A scoped, NON-superadmin key. `dev-token:*` is byte-identical to the built-in
// default (`middleware/apiKeyTenants.ts`), so every other case is unchanged.
const PREV_API_KEYS = process.env.OPENWOP_API_KEYS;
const MEMBER = { authorization: 'Bearer uninstall-member' };

function fabricatePack(name: string, version: string, typeIds: string[]): void {
  const dir = join(PACK_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({
    name, version,
    nodes: typeIds.map((typeId) => ({ typeId, version, label: typeId })),
  }));
}

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_API_KEYS = 'dev-token:*,uninstall-member:t-uninstall-member';
  fabricatePack(VENDOR, '1.0.0', [VENDOR_TYPE]);
  fabricatePack(PURGE, '1.0.0', [PURGE_TYPE]);
  // A pack pinned by the `email` feature (requiredPacks feature.email.nodes@1.1.0)
  // — the protected feature-pinned class.
  fabricatePack('feature.email.nodes', '1.1.0', ['feature.email.nodes.compose']);
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await __clearPackTombstones();
  const d = getToggleDefault('marketplace');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  // See chainpack-signature: process.env outlives a FILE inside a vitest worker,
  // and `resolveDefaultPackDir()` reads OPENWOP_PACK_DIR at call time. Leaving it
  // set pointed every later file in this worker at THIS test's temp pack dir.
  if (PREV_PACK_DIR === undefined) delete process.env.OPENWOP_PACK_DIR;
  else process.env.OPENWOP_PACK_DIR = PREV_PACK_DIR;
  if (PREV_API_KEYS === undefined) delete process.env.OPENWOP_API_KEYS;
  else process.env.OPENWOP_API_KEYS = PREV_API_KEYS;
});

async function jf<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', ...(init.headers as Record<string, string> ?? {}) },
  });
  const body = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  return { status: res.status, body: body as T };
}

const M = '/host/openwop-app/marketplace';

describe('pack uninstall (ADR 0194 P4)', () => {
  it('refuses the protected classes: core substrate + feature-pinned', async () => {
    const core = await jf(`${M}/packs/core.openwop.ai`, { method: 'DELETE' });
    expect(core.status).toBe(409);
    expect((core.body as { error?: string }).error).toBe('conflict');
    expect(isTombstoned('core.openwop.ai')).toBe(false);

    const pinned = await jf(`${M}/packs/feature.email.nodes`, { method: 'DELETE' });
    expect(pinned.status).toBe(409);
    expect((pinned.body as { details?: { requiredBy?: string[] } }).details?.requiredBy).toContain('email');
  });

  it('tombstone hides host-wide, blocks re-install, and restore reverses it', async () => {
    // Visible before.
    expect(getListing(VENDOR)?.tombstoned).toBeUndefined();
    const catBefore = await jf<{ nodes: { typeId: string }[] }>('/host/openwop-app/node-catalog');
    expect(catBefore.body.nodes.some((n) => n.typeId === VENDOR_TYPE)).toBe(true);

    const del = await jf(`${M}/packs/${VENDOR}`, { method: 'DELETE' });
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(del.body).toMatchObject({ tombstoned: true, purged: false });

    expect(isTombstoned(VENDOR)).toBe(true);
    expect(getListing(VENDOR)?.tombstoned).toBe(true); // listed, flagged — not hidden
    const catAfter = await jf<{ nodes: { typeId: string }[] }>('/host/openwop-app/node-catalog');
    expect(catAfter.body.nodes.some((n) => n.typeId === VENDOR_TYPE)).toBe(false);

    // Install never silently un-removes.
    const install = await jf(`${M}/install`, { method: 'POST', body: JSON.stringify({ packName: VENDOR, version: '1.0.0' }) });
    expect(install.status).toBe(409);

    const restore = await jf(`${M}/packs/${VENDOR}/restore`, { method: 'POST' });
    expect(restore.status).toBe(200);
    expect(isTombstoned(VENDOR)).toBe(false);
    const catRestored = await jf<{ nodes: { typeId: string }[] }>('/host/openwop-app/node-catalog');
    expect(catRestored.body.nodes.some((n) => n.typeId === VENDOR_TYPE)).toBe(true);
  });

  it('purge: tombstone-first gate, definition-reference gate, then deletes the dir and keeps the row', async () => {
    // Purge without tombstone → 409.
    expect((await jf(`${M}/packs/${PURGE}?purge=true`, { method: 'DELETE' })).status).toBe(409);

    // A registered definition referencing the pack's typeId blocks the purge.
    const reg = await jf('/host/openwop-app/workflows', {
      method: 'POST',
      body: JSON.stringify({ workflowId: 'p4.ref.holder', nodes: [{ nodeId: 'n1', typeId: PURGE_TYPE }], edges: [] }),
    });
    expect([200, 201]).toContain(reg.status);
    expect((await jf(`${M}/packs/${PURGE}`, { method: 'DELETE' })).status).toBe(200); // tombstone
    const blocked = await jf(`${M}/packs/${PURGE}?purge=true`, { method: 'DELETE' });
    expect(blocked.status).toBe(409);
    expect((blocked.body as { details?: { workflowIds?: string[] } }).details?.workflowIds).toContain('p4.ref.holder');

    // Delete the referencing definition → purge succeeds; dir gone; row kept.
    expect((await jf('/host/openwop-app/workflows/p4.ref.holder', { method: 'DELETE' })).status).toBe(200);
    const purged = await jf(`${M}/packs/${PURGE}?purge=true`, { method: 'DELETE' });
    expect(purged.status, JSON.stringify(purged.body)).toBe(200);
    expect(purged.body).toMatchObject({ purged: true });
    expect(existsSync(join(PACK_DIR, PURGE))).toBe(false);
    expect(isTombstoned(PURGE)).toBe(true); // boot loaders keep skipping it
  });

  /**
   * WF-MKT-1 — the reference gate must fail CLOSED on an unreadable manifest.
   *
   * `packTypeIds` used to return an empty `Set` for BOTH "declares no nodes" and
   * "could not be read" (a bare `catch { return new Set(); }`), and the gate is
   * `if (typeIds.size > 0)`, so an empty set skipped the reference check entirely
   * and the irreversible `rmSync` proceeded on a pack that registered workflow
   * definitions still resolve through on replay.
   *
   * The triggering state is MEASURED, not hypothetical: `mountLocalPacks.ts`
   * records `~/.openwop-packs/core.openwop.ai` holding ONLY
   * `.openwop-installed.json` — no `pack.json`, no `index.mjs`. The `core.openwop.*`
   * refusal covered that one name; every `vendor.*` / `feature.*` / `community.*`
   * pack in the same rubble state was purgeable with the gate inert.
   *
   * Both rubble shapes are exercised, because they took DIFFERENT code paths in
   * the old function (`existsSync` false vs the `catch`), and a single case would
   * have proved only one of them.
   */
  describe('WF-MKT-1 — an unreadable manifest REFUSES the purge (the gate cannot fail open)', () => {
    for (const [label, seed] of [
      // The measured shape: an install marker and nothing else.
      ['manifest MISSING (the measured rubble directory)', (dir: string) => {
        writeFileSync(join(dir, '.openwop-installed.json'), JSON.stringify({ installedAt: '2026-01-01T00:00:00Z' }));
      }],
      // The `catch` shape: a truncated / corrupt write.
      ['manifest UNPARSEABLE (a truncated write)', (dir: string) => {
        writeFileSync(join(dir, 'pack.json'), '{"name":"vendor.rubble.widgets","nodes":[');
      }],
    ] as const) {
      it(`${label} → 409, and the directory survives`, async () => {
        const name = `vendor.rubble${label.includes('MISSING') ? 'a' : 'b'}.widgets`;
        const dir = join(PACK_DIR, name);
        mkdirSync(dir, { recursive: true });
        seed(dir);

        // Tombstone first (purge requires it). Via the helper, NOT the DELETE
        // route: rubble has no listing, so the route 404s — and a 404 would have
        // left the case asserting a 409 the tombstone-first gate produced, with
        // the new refusal never reached. Measured while writing this.
        await tombstonePack(name, 'test');
        const purged = await jf(`${M}/packs/${name}?purge=true`, { method: 'DELETE' });

        expect(purged.status, `an unreadable manifest must REFUSE, got ${purged.status} ${JSON.stringify(purged.body)}`).toBe(409);
        expect((purged.body as { details?: { reason?: string } }).details?.reason).toBe('manifest_unreadable');
        // The point of the whole finding: the bytes are still there.
        expect(existsSync(dir), 'the irreversible rmSync must NOT have run').toBe(true);
      });
    }

    it('a pack directory that is already GONE still purges (the refusal is about unreadable, not absent)', async () => {
      // Discriminator: without this, "refuse on !readable" could have been
      // implemented as "refuse whenever pack.json is not found", which would
      // break idempotent cleanup of an already-deleted pack forever.
      const name = 'vendor.nodir.widgets';
      expect(existsSync(join(PACK_DIR, name))).toBe(false);
      await tombstonePack(name, 'test');
      const purged = await jf(`${M}/packs/${name}?purge=true`, { method: 'DELETE' });
      expect(purged.status, JSON.stringify(purged.body)).toBe(200);
      expect(purged.body).toMatchObject({ purged: true });
    });

    it('a WELL-FORMED manifest declaring no nodes still purges (the gate is not simply closed)', async () => {
      const name = 'vendor.nonodes.widgets';
      const dir = join(PACK_DIR, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'pack.json'), JSON.stringify({ name, version: '1.0.0' })); // no `nodes` key at all
      await tombstonePack(name, 'test');
      const purged = await jf(`${M}/packs/${name}?purge=true`, { method: 'DELETE' });
      expect(purged.status, JSON.stringify(purged.body)).toBe(200);
      expect(existsSync(dir)).toBe(false);
    });
  });

  it('a tombstoned pack is never re-mounted by the local-pack boot path', async () => {
    await tombstonePack('core.openwop.ai', 'test'); // simulate a (hypothetical) removed pack
    // Clear any existing mount FIRST. If the dest is already a symlink into this
    // repo, the mount pass ALSO lands it in `skipped` (the "already mounted"
    // branch) — so with the tombstone skip deleted this case stayed green
    // (wave-10 probe, measured vacuous). With the dest absent, only the
    // tombstone check keeps it unmounted.
    const dest = join(PACK_DIR, 'core.openwop.ai');
    const present = (() => { try { lstatSync(dest); return true; } catch { return false; } })();
    if (present) rmSync(dest, { recursive: true, force: true });
    try {
      const result = ensureLocalPacksMounted();
      expect(result.mounted).not.toContain('core.openwop.ai');
      expect(result.skipped).toContain('core.openwop.ai');
      expect(existsSync(dest), 'a tombstoned pack must not be re-linked').toBe(false);
    } finally {
      await restorePack('core.openwop.ai');
      ensureLocalPacksMounted(); // put the mount back for any later case
    }
  });

  it('superadmin-gates the mutations', async () => {
    // An AUTHENTICATED, non-superadmin principal — the case the gate exists for.
    // (An anonymous call is refused upstream by auth, so it never reached
    // `requireSuperadmin`.) Both the uninstall and the restore route.
    const del = await jf(`${M}/packs/${VENDOR}`, { method: 'DELETE', headers: MEMBER });
    expect(del.status, JSON.stringify(del.body)).toBe(403);
    expect((del.body as { error?: string }).error).toBe('forbidden');
    expect(isTombstoned(VENDOR), 'the refused uninstall changed nothing').toBe(false);
    await tombstonePack(VENDOR, 'test');
    try {
      const restore = await jf(`${M}/packs/${VENDOR}/restore`, { method: 'POST', headers: MEMBER });
      expect(restore.status, JSON.stringify(restore.body)).toBe(403);
      expect(isTombstoned(VENDOR), 'the refused restore changed nothing').toBe(true);
    } finally {
      await restorePack(VENDOR);
    }
  });

  it('rejects a path-traversal pack name before any filesystem op (defense-in-depth)', async () => {
    // A sentinel dir OUTSIDE the pack dir that a traversal purge would target.
    const outside = join(PACK_DIR, 'outside-target');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), 'x');
    // '..%2Foutside-target' decodes to '../outside-target' in the route param.
    const trav = encodeURIComponent('../outside-target');
    const del = await jf(`${M}/packs/${trav}?purge=true`, { method: 'DELETE' });
    expect(del.status).toBe(400);
    expect((del.body as { error?: string }).error).toBe('invalid_pack_name');
    // The sentinel is untouched — the guard fired before the rmSync path.
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
  });
});

describe('isSafePackName (unit)', () => {
  it('accepts real pack names, rejects path escapes', async () => {
    for (const ok of ['feature.email.nodes', 'core.openwop.ai', 'vendor.test.widgets', 'local.openwop-app']) {
      expect(isSafePackName(ok), ok).toBe(true);
    }
    for (const bad of ['../etc', 'a/b', 'a\\b', '..', '.', '', 'a..b', '.hidden', 'trail.', 'a\0b', 'x/../y']) {
      expect(isSafePackName(bad), bad).toBe(false);
    }
  });
});
