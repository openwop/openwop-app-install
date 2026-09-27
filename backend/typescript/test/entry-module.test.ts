/**
 * The entry-point guard — `host/entryModule.ts`.
 *
 * These cases are not hypothetical. The old one-liner
 * (`import.meta.url === \`file://${process.argv[1]}\``) failed BOTH of them, and
 * the failure mode is a process that exits 0 having done nothing at all: no
 * server, no log line, no error. It cost days of "SHUTDOWN-1 is flaky" before
 * anyone measured it, because a worktree under `/Users/...` passes and one under
 * `/tmp` (a symlink to `/private/tmp` on macOS) cannot ever pass.
 *
 * Each test builds a REAL file and a REAL symlink rather than asserting against
 * hand-written strings — a string fixture would encode my belief about what Node
 * produces, which is exactly the thing that was wrong.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntryModule } from '../src/host/entryModule.js';

let root: string;
let realDir: string;
let linkDir: string;
let entry: string;

beforeAll(() => {
  // `mkdtemp` under os.tmpdir() is itself symlinked on macOS, so resolve it —
  // otherwise the "real" path in this test is not real and the symlink case
  // silently tests nothing.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'owp-entry-')));
  realDir = join(root, 'real');
  linkDir = join(root, 'link');
  mkdirSync(realDir);
  writeFileSync(join(realDir, 'index.js'), '// entry\n');
  symlinkSync(realDir, linkDir, 'dir');
  entry = join(realDir, 'index.js');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('isEntryModule', () => {
  it('matches when argv[1] is the real path', () => {
    expect(isEntryModule(pathToFileURL(entry).href, entry)).toBe(true);
  });

  it('matches THROUGH A SYMLINK — the /tmp -> /private/tmp case', () => {
    const viaLink = join(linkDir, 'index.js');
    // Precondition, asserted rather than assumed: the two spellings really are
    // different strings, or this test proves nothing.
    expect(viaLink).not.toBe(entry);
    expect(isEntryModule(pathToFileURL(entry).href, viaLink)).toBe(true);
  });

  it('matches a path containing a SPACE (percent-encoding, not concatenation)', () => {
    const spaced = join(root, 'a dir');
    mkdirSync(spaced, { recursive: true });
    const spacedEntry = join(spaced, 'index.js');
    writeFileSync(spacedEntry, '// entry\n');
    // `file://${path}` leaves the raw space in; `import.meta.url` encodes it.
    expect(pathToFileURL(spacedEntry).href).toContain('%20');
    expect(isEntryModule(pathToFileURL(spacedEntry).href, spacedEntry)).toBe(true);
  });

  it('does NOT match a different file — the guard still guards', () => {
    const other = join(realDir, 'other.js');
    writeFileSync(other, '// not the entry\n');
    expect(isEntryModule(pathToFileURL(entry).href, other)).toBe(false);
  });

  it('fails CLOSED when argv[1] is absent (node -e, embedders)', () => {
    expect(isEntryModule(pathToFileURL(entry).href, undefined)).toBe(false);
  });

  it('does not throw when argv[1] does not exist on disk', () => {
    const ghost = join(root, 'nope', 'gone.js');
    expect(() => isEntryModule(pathToFileURL(entry).href, ghost)).not.toThrow();
    expect(isEntryModule(pathToFileURL(entry).href, ghost)).toBe(false);
  });
});
