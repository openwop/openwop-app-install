/**
 * Durable filesystem host surface (Phase 2) — `host.fs` over `Storage`.
 *
 * Each file is one durable kv row (`hostsurf:fs:<tenant>:<path>`), so written
 * files survive restarts and are visible across instances — unlike the
 * in-memory `sandboxed-local-fs`, which is per-instance and ephemeral.
 * Directories are virtual (inferred from key prefixes). Method-for-method
 * parity with `createFs` in inMemorySurfaces.ts, including absolute-path and
 * `..`-traversal rejection (RFC 0014 §C / SECURITY fs-path-traversal).
 */

import type { BundleScope, FsSurface } from '../inMemorySurfaces.js';
import { requireDurableStorage } from './durableStore.js';

/** Normalize a user path INTO the tenant sandbox; reject anything that escapes.
 *  Returns a clean, posix, leading-slash-free relative path ('' === root). */
function normPath(relRaw: unknown): string {
  const rel = String(relRaw ?? '');
  if (/^[/\\]/.test(rel) || /^[A-Za-z]:/.test(rel)) {
    throw Object.assign(new Error('Absolute paths escape the tenant sandbox.'), { code: 'path_outside_sandbox' });
  }
  const parts: string[] = [];
  for (const seg of rel.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) {
        throw Object.assign(new Error('Path escapes tenant sandbox.'), { code: 'path_outside_sandbox' });
      }
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

interface FsEntry { contentBase64: string; size: number; mtimeMs: number }

export function createDurableFs(scope: BundleScope): FsSurface {
  const root = `hostsurf:fs:${encodeURIComponent(scope.tenantId)}:`;
  const fileKey = (p: string) => `${root}${p}`;
  const storage = () => requireDurableStorage();

  return {
    async read({ path }) {
      const raw = await storage().kvGet(fileKey(normPath(path)));
      if (raw === null) throw Object.assign(new Error('No such file.'), { code: 'not_found' });
      const e = JSON.parse(raw) as FsEntry;
      return { contentBase64: e.contentBase64, size: e.size };
    },

    async write({ path, contentBase64, createOnly }) {
      const p = normPath(path);
      const key = fileKey(p);
      if (createOnly && (await storage().kvGet(key)) !== null) {
        return { ok: false, reason: 'already_exists' };
      }
      const content = String(contentBase64 ?? '');
      const size = Buffer.from(content, 'base64').byteLength;
      await storage().kvSet(key, JSON.stringify({ contentBase64: content, size, mtimeMs: Date.now() } satisfies FsEntry));
      return { ok: true, path: String(path) };
    },

    async delete({ path }) {
      const p = normPath(path);
      let deleted = await storage().kvDelete(fileKey(p));
      // Recursive: also remove any children under `<path>/`.
      const childPrefix = `${fileKey(p)}/`;
      for (const row of await storage().kvList(childPrefix)) {
        if (await storage().kvDelete(row.key)) deleted = true;
      }
      return { deleted };
    },

    async stat({ path }) {
      const p = normPath(path);
      const raw = await storage().kvGet(fileKey(p));
      if (raw !== null) {
        const e = JSON.parse(raw) as FsEntry;
        return { found: true, size: e.size, isFile: true, isDirectory: false, mtimeMs: e.mtimeMs };
      }
      // Directory if any descendant exists.
      const children = await storage().kvList(`${fileKey(p)}/`);
      if (p !== '' && children.length > 0) {
        return { found: true, size: 0, isFile: false, isDirectory: true, mtimeMs: 0 };
      }
      return { found: false };
    },

    async list({ path }) {
      const base = normPath(path ?? '.');
      const listPrefix = base === '' ? root : `${root}${base}/`;
      const rows = await storage().kvList(listPrefix);
      const files = new Set<string>();
      const dirs = new Set<string>();
      for (const row of rows) {
        const rest = row.key.slice(listPrefix.length); // path relative to `base`
        if (rest === '') continue;
        const slash = rest.indexOf('/');
        if (slash === -1) files.add(rest);
        else dirs.add(rest.slice(0, slash));
      }
      const entries = [
        ...[...dirs].map((name) => ({ name, isFile: false, isDirectory: true })),
        ...[...files].filter((f) => !dirs.has(f)).map((name) => ({ name, isFile: true, isDirectory: false })),
      ].sort((a, b) => a.name.localeCompare(b.name));
      return { entries };
    },
  };
}
