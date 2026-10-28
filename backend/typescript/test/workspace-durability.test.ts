/**
 * ADR 0551 P0 — the workspace is DURABLE. This file used to prove it was not.
 *
 * It began as a characterization test pinning the gap: `workspaceStore.ts` was
 * a module-scope `Map`, so the store died on restart and was invisible to a
 * second instance — while `spec/v1/agent-workspace.md` §9 requires that "a run
 * replayed on another host MUST observe the same workspace snapshot". Those
 * assertions were written to FLIP when the durable store landed, and they did:
 * both went red the moment the `Map` was replaced, which is the whole reason
 * they were phrased that way rather than left as a note in an ADR.
 *
 * What replaces them is the test that was IMPOSSIBLE before — write, close the
 * database, reopen it, and read the file back.
 *
 * Expected etags are LITERALS (sha256 of the content, first 16 hex, computed
 * independently with `shasum -a 256`), never `workspaceEtag` itself.
 *
 * Sabotage that turns it red (wave 64 probes, witnessed): the DSN durability
 * class (8fw5g2-wsd-durability-class), a non-file sqlite DSN (-wsd-file-dsn), a
 * random or version-free etag (-wsd-etag-random, -wsd-etag-version), the write
 * not using the derived etag (-wsd-etagfor), and the tenant term dropped from
 * the get / list query (-wsd-wct-get, -wsd-wct-list).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage, storageDurability } from '../src/storage/index.js';
import {
  putWorkspaceFile,
  getWorkspaceFile,
  listWorkspaceFiles,
  workspaceEtag,
} from '../src/host/workspaceStore.js';

const T = 'durability-tenant';
const W = 'durability-ws';

const tmpDirs: string[] = [];
/** A file-backed sqlite DSN in a temp dir removed after the case. */
async function fileDsn(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return `sqlite://${join(dir, 'ws.db')}`;
}
afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe('ADR 0551 — storage durability is derived from the DSN, not the adapter', () => {
  it('classifies every supported DSN form', () => {
    // Adapter TYPE cannot answer this: `memory://` resolves to the SQLite
    // backend at `:memory:`, so "is the sqlite adapter" and "survives a
    // restart" are different questions.
    expect(storageDurability('memory://')).toBe('process');
    expect(storageDurability(':memory:')).toBe('process');
    expect(storageDurability('sqlite://:memory:')).toBe('process');
    expect(storageDurability('sqlite:///var/data/app.db')).toBe('durable');
    expect(storageDurability('postgres://user@host/db')).toBe('durable');
    expect(storageDurability('postgresql://user@host/db')).toBe('durable');
  });
});

describe('ADR 0551 P0 — the workspace survives a restart', () => {
  it('a file written before close is readable after reopening the SAME database', async () => {
    // The assertion the module-`Map` implementation could never pass. Two
    // Storage instances over one file stand in for "the process restarted" /
    // "a second Cloud Run instance served the read".
    const dsn = await fileDsn('ws-durable-');

    const before = await openStorage(dsn);
    const put = await putWorkspaceFile(before, T, W, 'DIRECTIVES.md', { content: 'be helpful' });
    expect(put.ok).toBe(true);
    if (!put.ok) throw new Error('expected the write to succeed');
    await before.close?.();

    const after = await openStorage(dsn);
    const read = await getWorkspaceFile(after, T, W, 'DIRECTIVES.md');
    expect(read?.content).toBe('be helpful');
    expect(read?.version).toBe(1);
    // The etag must survive too — a client holding it across a restart is
    // exactly the If-Match case, and a regenerated etag would 409 them forever.
    expect(read?.etag).toBe(put.file.etag);
    await after.close?.();
  });

  it('If-Match written before a restart still matches after it', async () => {
    const dsn = await fileDsn('ws-durable-cas-');

    const before = await openStorage(dsn);
    const first = await putWorkspaceFile(before, T, W, 'A.md', { content: 'v1' });
    if (!first.ok) throw new Error('expected the write to succeed');
    await before.close?.();

    const after = await openStorage(dsn);
    const second = await putWorkspaceFile(after, T, W, 'A.md', {
      content: 'v2',
      ifMatch: first.file.etag,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected the CAS to succeed across the restart');
    expect(second.file.version).toBe(2);
    await after.close?.();
  });
});

describe('ADR 0551 P0 — the etag is content-derived, not random', () => {
  it('is reproducible for the same (version, content)', () => {
    // The previous etag was `"${version}-${Math.random()...}"`. That could
    // never satisfy the replay-determinism guarantee the run-start workspace
    // snapshot carries: identical content produced a different etag on every
    // write, so the snapshot was not reproducible by construction.
    expect(workspaceEtag(1, 'hello')).toBe('"1-2cf24dba5fb0a30e"');
    expect(workspaceEtag(1, 'hello')).toBe(workspaceEtag(1, 'hello'));
  });

  it('differs when the content differs', () => {
    expect(workspaceEtag(1, 'hello')).not.toBe(workspaceEtag(1, 'goodbye'));
  });

  it('differs when the VERSION differs, even for identical content', () => {
    // Why version is mixed in alongside the digest: a file reverted to earlier
    // content must still get a distinct etag. Otherwise an If-Match built
    // against v1 would spuriously match v3 with the same bytes, and the CAS
    // would wave through a writer that is genuinely stale.
    expect(workspaceEtag(1, 'same')).not.toBe(workspaceEtag(3, 'same'));
  });

  it('a real write round-trips the derived etag', async () => {
    const s = await openStorage(':memory:');
    const put = await putWorkspaceFile(s, T, W, 'E.md', { content: 'body' });
    if (!put.ok) throw new Error('expected the write to succeed');
    expect(put.file.etag).toBe('"1-230d8358dc8e8890"');
    await s.close?.();
  });
});

describe('ADR 0551 P0 — WCT-1 isolation is now a database key, not a Map lookup', () => {
  // Twin of workspace.test.ts › "RFC 0059 §E — WCT-1 cross-owner isolation" ›
  // "a file under {tenant-a, ws-a} is invisible to other owners" for the
  // in-process read. What only THIS case asserts (wave 64, ruling 8): the
  // isolation holds AFTER the durability path — written, closed, and read back
  // through a REOPENED file database, where the owner triple must be in the key.
  it('one owner cannot read or list another owner’s file', async () => {
    // The protocol-tier SECURITY invariant (`workspace-cross-tenant-isolation`)
    // held before too — keys already carried the owner triple — but it held in
    // process memory. It is now structural in the primary key, so it survives
    // the restart along with the data.
    const dsn = await fileDsn('ws-durable-wct-');
    const before = await openStorage(dsn);
    await putWorkspaceFile(before, 'tenant-a', 'ws-a', 'SECRET.md', { content: 'A-only' });
    await before.close?.();

    const s = await openStorage(dsn);
    expect(await getWorkspaceFile(s, 'tenant-b', 'ws-a', 'SECRET.md')).toBeNull();
    expect(await getWorkspaceFile(s, 'tenant-a', 'ws-b', 'SECRET.md')).toBeNull();
    expect(await listWorkspaceFiles(s, 'tenant-b', 'ws-a')).toHaveLength(0);
    expect(await listWorkspaceFiles(s, 'tenant-a', 'ws-b')).toHaveLength(0);
    // Positive controls, after the reopen: the owner still reads AND lists it.
    expect((await getWorkspaceFile(s, 'tenant-a', 'ws-a', 'SECRET.md'))?.content).toBe('A-only');
    expect((await listWorkspaceFiles(s, 'tenant-a', 'ws-a')).map((f) => f.path)).toEqual(['SECRET.md']);
    await s.close?.();
  });
});
