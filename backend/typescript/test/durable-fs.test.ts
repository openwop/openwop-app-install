import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { FsSurface } from '../src/host/inMemorySurfaces.js';
import { createDurableFs } from '../src/host/durable/durableFs.js';
import { _setDurableStorageForTesting } from '../src/host/durable/durableKv.js';

let storage: Storage;
beforeAll(async () => { storage = await openStorage('memory://'); _setDurableStorageForTesting(storage); });
afterAll(async () => { await storage.close(); });

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('durable fs surface', () => {
  const fs: FsSurface = createDurableFs({ tenantId: 'fs-t' });

  it('write/read round-trips content + size; durable across instances', async () => {
    const w = await fs.write({ path: 'docs/a.txt', contentBase64: b64('hello') }) as { ok: boolean };
    expect(w.ok).toBe(true);
    const r = await fs.read({ path: 'docs/a.txt' }) as { contentBase64: string; size: number };
    expect(Buffer.from(r.contentBase64, 'base64').toString()).toBe('hello');
    expect(r.size).toBe(5);
    // a fresh surface instance sees the same durable file
    expect(Buffer.from(((await createDurableFs({ tenantId: 'fs-t' }).read({ path: 'docs/a.txt' })) as { contentBase64: string }).contentBase64, 'base64').toString()).toBe('hello');
  });

  it('createOnly refuses to overwrite', async () => {
    await fs.write({ path: 'once.txt', contentBase64: b64('1') });
    expect(await fs.write({ path: 'once.txt', contentBase64: b64('2'), createOnly: true })).toEqual({ ok: false, reason: 'already_exists' });
  });

  it('stat distinguishes files, directories, and absent paths', async () => {
    await fs.write({ path: 'dir/inner.txt', contentBase64: b64('x') });
    const file = await fs.stat({ path: 'dir/inner.txt' }) as { found: boolean; isFile: boolean };
    expect(file).toMatchObject({ found: true, isFile: true, isDirectory: false });
    const dir = await fs.stat({ path: 'dir' }) as { found: boolean; isDirectory: boolean };
    expect(dir).toMatchObject({ found: true, isFile: false, isDirectory: true });
    expect(await fs.stat({ path: 'ghost' })).toEqual({ found: false });
  });

  it('list returns immediate children (files + virtual dirs)', async () => {
    await fs.write({ path: 'top/f1.txt', contentBase64: b64('a') });
    await fs.write({ path: 'top/sub/f2.txt', contentBase64: b64('b') });
    const ls = await fs.list({ path: 'top' }) as { entries: Array<{ name: string; isDirectory: boolean }> };
    const names = ls.entries.map((e) => `${e.name}${e.isDirectory ? '/' : ''}`);
    expect(new Set(names)).toEqual(new Set(['f1.txt', 'sub/']));
  });

  it('delete removes a file; recursive on a directory', async () => {
    await fs.write({ path: 'rm/a.txt', contentBase64: b64('a') });
    await fs.write({ path: 'rm/b.txt', contentBase64: b64('b') });
    expect((await fs.delete({ path: 'rm' }) as { deleted: boolean }).deleted).toBe(true);
    expect(await fs.stat({ path: 'rm/a.txt' })).toEqual({ found: false });
  });

  it('rejects absolute paths and ..-traversal', async () => {
    await expect(fs.read({ path: '/etc/passwd' })).rejects.toThrow(/sandbox/);
    await expect(fs.write({ path: '../escape', contentBase64: b64('x') })).rejects.toThrow(/sandbox/);
    await expect(fs.read({ path: 'a/../../b' })).rejects.toThrow(/sandbox/);
  });
});
