/**
 * RFC 0059 — agent workspace store: CRUD, optimistic concurrency, size
 * ceiling, WCT-1 cross-owner isolation, WSR-1 redaction.
 *
 * @see RFCS/0059-agent-workspace.md §C/§E
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  putWorkspaceFile,
  getWorkspaceFile,
  listWorkspaceFiles,
  deleteWorkspaceFile,
  WORKSPACE_MAX_FILE_BYTES,
} from '../src/host/workspaceStore.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';

const T = 'tenant-a';
const W = 'ws-a';

// ADR 0551 P0 — the store is `Storage`-backed now, so isolation between tests
// comes from a FRESH DATABASE rather than a `resetWorkspace()` that cleared
// module state. That removal is the point: there is no module state left.
let storage: Storage;
beforeEach(async () => {
  storage = await openStorage(':memory:');
});

describe('RFC 0059 §C — CRUD + concurrency', () => {
  it('PUT creates v1 with an etag; GET returns content; list omits content', async () => {
    const put = await putWorkspaceFile(storage, T, W, 'DIRECTIVES.md', { content: 'be helpful' });
    expect(put.ok).toBe(true);
    if (!put.ok) return;
    expect(put.file.version).toBe(1);
    expect(typeof put.file.etag).toBe('string');

    expect((await getWorkspaceFile(storage, T, W, 'DIRECTIVES.md'))?.content).toBe('be helpful');

    const list = await listWorkspaceFiles(storage, T, W);
    expect(list).toHaveLength(1);
    expect('content' in list[0]!).toBe(false);

    expect(await deleteWorkspaceFile(storage, T, W, 'DIRECTIVES.md')).toBe(true);
    expect(await getWorkspaceFile(storage, T, W, 'DIRECTIVES.md')).toBeNull();
  });

  it('stale If-Match → 409 workspace_conflict with currentVersion; matching → bump', async () => {
    const v1 = await putWorkspaceFile(storage, T, W, 'F.md', { content: 'v1' });
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;

    const stale = await putWorkspaceFile(storage, T, W, 'F.md', { content: 'nope', ifMatch: '"definitely-stale"' });
    expect(stale.ok).toBe(false);
    // Narrow on the `error` discriminant so `details` is the conflict shape.
    if (stale.ok || stale.error !== 'workspace_conflict') throw new Error('expected workspace_conflict');
    expect(stale.status).toBe(409);
    expect(stale.details.currentVersion).toBe(1);

    const v2 = await putWorkspaceFile(storage, T, W, 'F.md', { content: 'v2', ifMatch: v1.file.etag });
    expect(v2.ok).toBe(true);
    if (v2.ok) expect(v2.file.version).toBe(2);
  });

  it('oversize content → 413 workspace_too_large', async () => {
    const tooBig = 'x'.repeat(WORKSPACE_MAX_FILE_BYTES + 1);
    const r = await putWorkspaceFile(storage, T, W, 'BIG.md', { content: tooBig });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('workspace_too_large');
  });
});

describe('RFC 0059 §E — WCT-1 cross-owner isolation', () => {
  it('a file under {tenant-a, ws-a} is invisible to other owners', async () => {
    await putWorkspaceFile(storage, 'wct1-tenant-a', 'ws-a', 'SECRET.md', { content: 'A-only' });

    // Cross-workspace (same tenant) and cross-tenant reads find nothing.
    expect(await getWorkspaceFile(storage, 'wct1-tenant-a', 'ws-b', 'SECRET.md')).toBeNull();
    expect(await getWorkspaceFile(storage, 'wct1-tenant-b', 'ws-a', 'SECRET.md')).toBeNull();

    // List does not enumerate the other owner's path.
    expect(await listWorkspaceFiles(storage, 'wct1-tenant-a', 'ws-b')).toHaveLength(0);
    expect(await listWorkspaceFiles(storage, 'wct1-tenant-b', 'ws-a')).toHaveLength(0);

    // The owner still reads its own file.
    expect((await getWorkspaceFile(storage, 'wct1-tenant-a', 'ws-a', 'SECRET.md'))?.content).toBe('A-only');
  });
});

describe('RFC 0059 §E — WSR-1 secret redaction on write', () => {
  it('secret-shaped content is redacted before it persists', async () => {
    const put = await putWorkspaceFile(storage, T, W, 'leak.md', { content: 'key sk-ant-api03-abcdefghijklmnop1234 here' });
    expect(put.ok).toBe(true);
    if (!put.ok) return;
    expect(put.file.content).not.toContain('sk-ant-api03-abcdefghijklmnop1234');
    expect(put.file.content).toContain('sk-***');
  });
});
