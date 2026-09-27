/**
 * Content digest for a pack directory — the generator-side twin of
 * `backend/typescript/src/packs/packContentDigest.ts` (ADR 0555 P0).
 *
 * TWO IMPLEMENTATIONS ON PURPOSE, PINNED BY A TEST. The generator must run in
 * `scripts/ci.sh` before the backend build, so it cannot import the compiled
 * module, and the backend bundle must not reach up into `scripts/`. Drift
 * between the two is catastrophic rather than cosmetic — if they disagree,
 * every pack fails steward attestation at once and the fail-closed policy
 * stops the whole product dispatching. So
 * `backend/typescript/test/pack-content-digest-parity.test.ts` runs BOTH over
 * the same fixtures and asserts byte-equal output. Edit one, edit both, or the
 * gate goes red.
 *
 * Algorithm (keep this comment in sync with the TS twin):
 *   every entry under the pack dir, recursively, sorted by POSIX-normalised
 *   relative path, folded into one sha256 over `<relpath>\0<kind>\0<leaf>\n`:
 *     f  regular file → leaf = sha256(bytes)
 *     l  symlink      → leaf = sha256(link target STRING), never its content
 *     o  other        → leaf = sha256('')  (presence recorded, never ignored)
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

const EXCLUDED_NAMES = new Set([
  '.openwop-installed.json',
  'node_modules',
  '.git',
  '.DS_Store',
]);

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

/** @returns {Array<{path: string, kind: 'f'|'l'|'o', leaf: string}>} */
export function listPackEntries(packDir) {
  const out = [];

  const walk = (absDir, relPrefix) => {
    let names;
    try {
      names = readdirSync(absDir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (EXCLUDED_NAMES.has(name)) continue;
      const abs = join(absDir, name);
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        let target = '';
        try {
          target = readlinkSync(abs);
        } catch {
          target = '';
        }
        out.push({ path: rel, kind: 'l', leaf: createHash('sha256').update(target).digest('hex') });
      } else if (st.isDirectory()) {
        walk(abs, rel);
      } else if (st.isFile()) {
        let leaf;
        try {
          leaf = createHash('sha256').update(readFileSync(abs)).digest('hex');
        } catch {
          continue;
        }
        out.push({ path: rel, kind: 'f', leaf });
      } else {
        out.push({ path: rel, kind: 'o', leaf: EMPTY_SHA256 });
      }
    }
  };

  walk(packDir, '');
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** @returns {string} hex sha256 folding the whole pack directory. */
export function packContentDigest(packDir) {
  const h = createHash('sha256');
  for (const e of listPackEntries(packDir)) {
    h.update(`${e.path}\0${e.kind}\0${e.leaf}\n`);
  }
  return h.digest('hex');
}
