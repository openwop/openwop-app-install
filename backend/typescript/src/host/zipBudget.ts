/**
 * The decompression budget every OOXML import shares (ADR 1055 D3).
 *
 * An import route caps the COMPRESSED upload; what a zip inflates to is
 * unbounded. MEASURED 2026-11-04: a 98 KB `.docx` inflated to a 42 MB part and
 * took the process to 640 MB RSS. Two checks, both needed:
 *
 *  - The central directory declares each entry's uncompressed size. A declared
 *    size over the cap refuses before anything is inflated (the fast path).
 *  - A zip can LIE about that size, and JSZip compares the declared size with the
 *    real one only after a full inflate (`jszip/lib/compressedObject.js`). So
 *    every read here is a COUNTED stream that stops the moment an entry passes
 *    its cap, or the archive passes its total. The overshoot is one inflate
 *    step: JSZip feeds the inflater 16 KiB of compressed input at a time, which
 *    at DEFLATE's ~1000:1 ceiling is ~16 MB of output, bounded and transient.
 *
 * Lifted from the slides importer's own guard (ADR 0328), which had the first
 * check and a post-inflate length check. Each caller maps `ZipBudgetError` to
 * its own response; the messages are the slides importer's, unchanged.
 */
import JSZip from 'jszip';

export interface ZipBudget {
  /** Largest uncompressed size of any one entry read. */
  maxEntryBytes: number;
  /** Largest uncompressed total across every entry read. */
  maxTotalBytes: number;
  /** Most entries the archive may list (a directory of millions is its own bomb). */
  maxEntries?: number;
}

export type ZipBudgetErrorCode = 'entry_too_large' | 'archive_too_large' | 'too_many_entries' | 'unreadable';

export class ZipBudgetError extends Error {
  constructor(readonly code: ZipBudgetErrorCode, message: string) {
    super(message);
    this.name = 'ZipBudgetError';
  }
}

/** JSZip keeps the central-directory size on the (unexposed) `_data`; read it
 *  structurally. A test pins that the field still exists, so a JSZip upgrade
 *  that drops it fails loud (the counted read below still holds the line). */
type ZipEntrySize = { _data?: { uncompressedSize?: number } };
export function declaredUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const n = (entry as JSZip.JSZipObject & ZipEntrySize)._data?.uncompressedSize;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** JSZip's `internalStream` exists at runtime (`jszip/lib/zipObject.js`) but is
 *  missing from its typings; this is its shape. */
interface InternalStreamEntry {
  internalStream(type: 'uint8array'): {
    on(event: 'data', cb: (chunk: Uint8Array) => void): unknown;
    on(event: 'error', cb: (err: unknown) => void): unknown;
    on(event: 'end', cb: () => void): unknown;
    resume(): unknown;
    pause(): unknown;
  };
}

/** An opened archive plus the running total of what has been inflated from it. */
export interface BudgetedZip {
  zip: JSZip;
  /** Inflate one entry as UTF-8 text, counted. `null` when the entry is absent. */
  readText(name: string): Promise<string | null>;
  /** Inflate one entry and discard it, counted. Proves its real size. */
  measure(name: string): Promise<number>;
  /** Bytes inflated so far. */
  readonly inflated: number;
}

export async function openZipWithinBudget(buf: Buffer, budget: ZipBudget): Promise<BudgetedZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new ZipBudgetError('unreadable', 'not a readable zip file');
  }
  const names = Object.keys(zip.files);
  if (budget.maxEntries !== undefined && names.length > budget.maxEntries) {
    throw new ZipBudgetError('too_many_entries', 'file lists too many parts to import');
  }
  let total = 0;

  /** Inflate one entry, counted. `null` = absent; `chunks` empty unless `keep`. */
  const inflate = async (name: string, keep: boolean): Promise<{ bytes: number; chunks: Uint8Array[] } | null> => {
    const entry = zip.file(name);
    if (!entry) return null;
    const declared = declaredUncompressedSize(entry);
    if (declared !== null && declared > budget.maxEntryBytes) throw new ZipBudgetError('entry_too_large', `part ${name} is too large to import`);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    await new Promise<void>((resolve, reject) => {
      // The JSZip StreamHelper, not `nodeStream()`: its Node adapter cannot stop
      // the worker once it starts (destroy() does not reach it), so a refused
      // entry kept inflating to the end in the background (DE87CD-2).
      // `pause()` stops the worker itself.
      const helper = (entry as JSZip.JSZipObject & InternalStreamEntry).internalStream('uint8array');
      let done = false;
      const fail = (err: ZipBudgetError): void => { if (done) return; done = true; helper.pause(); reject(err); };
      helper.on('data', (chunk: Uint8Array) => {
        // Counted BEFORE the `done` check, so `inflated` reports work the
        // worker actually did, including any after a refusal.
        bytes += chunk.length;
        total += chunk.length;
        if (done) return;
        if (bytes > budget.maxEntryBytes) return fail(new ZipBudgetError('entry_too_large', `part ${name} is too large to import`));
        if (total > budget.maxTotalBytes) return fail(new ZipBudgetError('archive_too_large', 'file expands past the import budget'));
        if (keep) chunks.push(chunk);
      });
      helper.on('error', () => fail(new ZipBudgetError('unreadable', `part ${name} could not be read`)));
      helper.on('end', () => { if (!done) { done = true; resolve(); } });
      helper.resume();
    });
    return { bytes, chunks };
  };

  return {
    zip,
    async readText(name) {
      const r = await inflate(name, true);
      return r === null ? null : Buffer.concat(r.chunks).toString('utf8');
    },
    async measure(name) {
      return (await inflate(name, false))?.bytes ?? 0;
    },
    get inflated() { return total; },
  };
}
