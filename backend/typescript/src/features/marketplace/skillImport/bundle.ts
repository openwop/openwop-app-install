/**
 * ADR 1044 D5 / D6 — read an import's source into bounded, path-safe text.
 *
 * Three input shapes: `skillMd` (the file's text), `files` (a path → text map, a
 * folder), or `zipBase64` (a zipped folder). All three end as one SKILL.md plus
 * the other files, each with a size and, for text, its content. Nothing is
 * written to disk and nothing is executed.
 */

import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { refuse } from './refusal.js';

export const BUNDLE_LIMITS = {
  maxFiles: 64,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxZipBytes: 512 * 1024,
  maxPathLength: 255,
} as const;

export type SourceFormat = 'skill-md' | 'files' | 'zip';

export interface BundleFile {
  path: string;
  bytes: number;
  /** UTF-8 text; absent for a binary file. */
  text?: string;
  /** Hex of the first four bytes, for a binary file only (executable detection). */
  magic?: string;
}

export interface SkillSource {
  format: SourceFormat;
  sha256: string;
  skillMd: string;
  /** Every file other than SKILL.md, after the optional top-level folder is stripped. */
  others: BundleFile[];
}

export interface SkillImportInput {
  skillMd?: unknown;
  files?: unknown;
  zipBase64?: unknown;
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** OS clutter a zip tool adds; skipped, never counted as the skill's own files. */
const isClutter = (p: string): boolean => p.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(p) || /(^|\/)Thumbs\.db$/i.test(p);

/** A relative, forward-slash path with no traversal, drive, control character or empty segment. */
export function assertSafePath(path: string): void {
  const unsafe = (why: string): never => { throw refuse('bundle_path_unsafe', `Bundle path "${path.slice(0, 120)}" is not allowed: ${why}.`, { path: path.slice(0, 255) }); };
  if (path.length === 0) unsafe('empty path');
  if (path.length > BUNDLE_LIMITS.maxPathLength) unsafe('path is too long');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(path)) unsafe('control character');
  if (path.includes('\\')) unsafe('backslash');
  if (path.startsWith('/') || path.startsWith('~')) unsafe('absolute path');
  if (/^[A-Za-z]:/.test(path)) unsafe('drive letter');
  const segs = path.replace(/\/$/, '').split('/');
  if (segs.some((s) => s === '..')) unsafe('parent-directory segment');
  if (segs.some((s) => s === '' || s === '.')) unsafe('empty or "." segment');
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
function decodeText(bytes: Uint8Array): string | undefined {
  try { return utf8.decode(bytes); } catch { return undefined; }
}

/** Strip one top-level folder when the bundle is `<folder>/SKILL.md`. */
function locateSkillMd(entries: BundleFile[]): { skillMd: BundleFile; others: BundleFile[] } {
  let files = entries;
  if (!files.some((f) => f.path === 'SKILL.md')) {
    const tops = new Set(files.map((f) => f.path.split('/')[0]));
    const top = tops.size === 1 ? [...tops][0]! : undefined;
    if (top && files.some((f) => f.path === `${top}/SKILL.md`)) {
      files = files.map((f) => ({ ...f, path: f.path.slice(top.length + 1) }));
    }
  }
  const skillMd = files.find((f) => f.path === 'SKILL.md');
  if (!skillMd) throw refuse('skill_md_missing', 'The bundle has no SKILL.md at its root or inside a single top-level folder.');
  if (skillMd.text === undefined) throw refuse('bundle_invalid', 'SKILL.md is not valid UTF-8 text.');
  return { skillMd, others: files.filter((f) => f !== skillMd) };
}

function checkBudget(files: BundleFile[]): void {
  if (files.length > BUNDLE_LIMITS.maxFiles) {
    throw refuse('bundle_too_large', `The bundle has ${files.length} files; at most ${BUNDLE_LIMITS.maxFiles} are allowed.`, { files: files.length });
  }
  const total = files.reduce((n, f) => n + f.bytes, 0);
  if (total > BUNDLE_LIMITS.maxTotalBytes) {
    throw refuse('bundle_too_large', `The bundle expands to ${total} bytes; at most ${BUNDLE_LIMITS.maxTotalBytes} are allowed.`, { bytes: total });
  }
}

function oneFile(path: string, bytes: number): void {
  if (bytes > BUNDLE_LIMITS.maxFileBytes) {
    throw refuse('bundle_too_large', `"${path}" is ${bytes} bytes; at most ${BUNDLE_LIMITS.maxFileBytes} are allowed per file.`, { path, bytes });
  }
}

/** JSZip keeps the central-directory size on the unexposed `_data` (the pptx
 *  import precedent): read it so an oversized entry is refused before inflating. */
type ZipEntrySize = { _data?: { uncompressedSize?: number }; unsafeOriginalName?: string };

async function readZip(b64: string): Promise<{ files: BundleFile[]; buf: Buffer }> {
  if (!/^[A-Za-z0-9+/=\s]*$/.test(b64)) throw refuse('bundle_invalid', '`zipBase64` is not base64.');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) throw refuse('bundle_invalid', '`zipBase64` is empty.');
  if (buf.length > BUNDLE_LIMITS.maxZipBytes) {
    throw refuse('bundle_too_large', `The zip is ${buf.length} bytes; at most ${BUNDLE_LIMITS.maxZipBytes} are allowed.`, { bytes: buf.length });
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf, { createFolders: false });
  } catch (err) {
    throw refuse('bundle_invalid', `The zip could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entries = Object.values(zip.files);
  if (entries.length > BUNDLE_LIMITS.maxFiles * 2) {
    throw refuse('bundle_too_large', `The zip has ${entries.length} entries; at most ${BUNDLE_LIMITS.maxFiles} files are allowed.`, { files: entries.length });
  }
  const files: BundleFile[] = [];
  let budget: number = BUNDLE_LIMITS.maxTotalBytes;
  for (const entry of entries) {
    const raw = (entry as JSZip.JSZipObject & ZipEntrySize).unsafeOriginalName ?? entry.name;
    assertSafePath(raw);
    if (entry.dir) continue;
    if (isClutter(raw)) continue;
    const mode = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : 0;
    // S_IFLNK — a symlink entry could point the folder outside itself on extraction.
    if ((mode & 0o170000) === 0o120000) {
      throw refuse('bundle_path_unsafe', `Bundle entry "${raw.slice(0, 120)}" is a symbolic link.`, { path: raw.slice(0, 255) });
    }
    const declared = (entry as JSZip.JSZipObject & ZipEntrySize)._data?.uncompressedSize;
    if (typeof declared === 'number') {
      oneFile(raw, declared);
      if (declared > budget) throw refuse('bundle_too_large', `The bundle expands past ${BUNDLE_LIMITS.maxTotalBytes} bytes.`);
    }
    const bytes = await entry.async('uint8array');
    oneFile(raw, bytes.length); // a directory that lies about the size
    budget -= bytes.length;
    if (budget < 0) throw refuse('bundle_too_large', `The bundle expands past ${BUNDLE_LIMITS.maxTotalBytes} bytes.`);
    const text = decodeText(bytes);
    files.push(text !== undefined
      ? { path: raw, bytes: bytes.length, text }
      : { path: raw, bytes: bytes.length, magic: Buffer.from(bytes.slice(0, 4)).toString('hex') });
  }
  return { files, buf };
}

/** Normalise the request into one SKILL.md plus the bundle's other files. */
export async function readSkillSource(input: SkillImportInput): Promise<SkillSource> {
  const given = (['skillMd', 'files', 'zipBase64'] as const).filter((k) => input[k] !== undefined && input[k] !== null);
  if (given.length === 0) throw refuse('source_missing', 'Send one of `skillMd` (the file text), `files` (path → text) or `zipBase64` (a zipped folder).', {}, 400);
  if (given.length > 1) throw refuse('source_ambiguous', `Send exactly one source; got ${given.join(', ')}.`, { given }, 400);

  if (given[0] === 'skillMd') {
    if (typeof input.skillMd !== 'string' || input.skillMd.trim().length === 0) {
      throw refuse('source_missing', '`skillMd` must be a non-empty string.', {}, 400);
    }
    const bytes = Buffer.byteLength(input.skillMd, 'utf8');
    oneFile('SKILL.md', bytes);
    return { format: 'skill-md', sha256: sha256(input.skillMd), skillMd: input.skillMd, others: [] };
  }

  if (given[0] === 'files') {
    const raw = input.files;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw refuse('bundle_invalid', '`files` must be an object mapping relative paths to file text.', {}, 400);
    const entries: BundleFile[] = [];
    for (const [path, text] of Object.entries(raw as Record<string, unknown>)) {
      assertSafePath(path);
      if (typeof text !== 'string') throw refuse('bundle_invalid', `\`files["${path.slice(0, 120)}"]\` must be a string.`, { path: path.slice(0, 255) }, 400);
      if (isClutter(path)) continue;
      const bytes = Buffer.byteLength(text, 'utf8');
      oneFile(path, bytes);
      entries.push({ path, bytes, text });
    }
    checkBudget(entries);
    const { skillMd, others } = locateSkillMd(entries);
    const canonical = JSON.stringify(entries.map((e) => [e.path, e.text]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    return { format: 'files', sha256: sha256(canonical), skillMd: skillMd.text!, others };
  }

  if (typeof input.zipBase64 !== 'string') throw refuse('bundle_invalid', '`zipBase64` must be a base64 string.', {}, 400);
  const { files, buf } = await readZip(input.zipBase64);
  checkBudget(files);
  const { skillMd, others } = locateSkillMd(files);
  return { format: 'zip', sha256: sha256(buf), skillMd: skillMd.text!, others };
}

/** Executable-looking files (CHAN-P5-2): refused, never installed, never run. */
const EXEC_EXT = /\.(?:sh|bash|zsh|fish|ksh|csh|command|py|pyw|pyc|js|mjs|cjs|ts|mts|cts|jsx|tsx|rb|pl|pm|php|lua|tcl|r|ps1|psm1|psd1|bat|cmd|vbs|wsf|exe|com|scr|dll|so|dylib|bin|elf|app|applescript|scpt|jar|class|msi|pkg|dmg|deb|rpm|apk|appimage|wasm|run|out)$/i;
const EXEC_MAGIC = ['7f454c46', 'cafebabe', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'bebafeca'];

export function isScriptFile(f: BundleFile): string | null {
  if (f.path.split('/')[0] === 'scripts') return 'it is under scripts/';
  if (EXEC_EXT.test(f.path)) return 'it has an executable or script extension';
  if (f.text !== undefined && f.text.startsWith('#!')) return 'it starts with a shebang';
  const magic = f.magic;
  if (magic && (EXEC_MAGIC.includes(magic) || magic.startsWith('4d5a'))) return 'it is a compiled executable';
  return null;
}
