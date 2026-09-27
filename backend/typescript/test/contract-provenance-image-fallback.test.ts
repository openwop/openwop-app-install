/**
 * RFC 0146 `contractProvenance` survives the runtime stage — the half that was
 * missing, and was invisible because its failure looks exactly like its
 * legitimate absence.
 *
 * MEASURED 2026-08-15 against the live deployment:
 *
 *   contractProvenance.ts   PRESENT in the running commit (649e6707e)
 *   the wire               NO `contractProvenance`
 *
 * The derivation cannot work in production BY CONSTRUCTION:
 * `@openwop/openwop-conformance` is a devDependency and `Dockerfile:85` runs
 * `npm ci --omit=dev`, so `require.resolve` throws in the runtime stage. The
 * feature was deployed and silently inert exactly where a staleness signal is
 * worth anything.
 *
 * WHY NOBODY NOTICED, and the reason this test exists rather than a warning
 * log: RFC 0146 requirement 1 makes absence LEGITIMATE (absent ⇒ unspecified).
 * So an honest omission and a broken derivation are **indistinguishable on the
 * wire** — the field simply is not there, and both readings are consistent with
 * a conformant host. A check that cannot separate them is not a check.
 *
 * So this pins the PRODUCTION path specifically: with the package unresolvable,
 * the image stamp must still produce a provenance.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readImageCorpusSuite, contractProvenanceSuiteVersion } from '../src/host/buildInfo.js';

const dirs: string[] = [];
const stampDir = (contents: string | null): string => {
  const d = mkdtempSync(join(tmpdir(), 'rfc0146-'));
  dirs.push(d);
  if (contents !== null) writeFileSync(join(d, 'corpus-suite.txt'), contents, 'utf8');
  return d;
};

afterEach(() => {
  delete process.env.OPENWOP_BUILD_META_DIR;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('RFC 0146 — the image stamp carries provenance past `npm ci --omit=dev`', () => {
  it('reads a published suite version from the image stamp', () => {
    expect(readImageCorpusSuite(stampDir('1.106.0\n'))).toBe('1.106.0');
  });

  it('an ABSENT stamp yields null — omission, never a guess', () => {
    // Requirement 1: absent ⇒ unspecified. Requirement 2 makes advertising a
    // revision the host does not implement a false statement, so there is no
    // safe default to substitute here. Silence is the honest answer.
    expect(readImageCorpusSuite(stampDir(null))).toBeNull();
  });

  it('REJECTS anything that is not a published conformance version', () => {
    // Requirement 4: `suiteVersion` takes a published conformance version and
    // nothing else — a vendor build identifier belongs in `implementation`.
    // Without this, a stamp writer bug puts arbitrary text on the wire as a
    // contract claim.
    for (const junk of ['main', 'v1.106.0-dirty+local', 'unknown', '', 'openwop-app@0.1.0']) {
      expect(readImageCorpusSuite(stampDir(`${junk}\n`)), `accepted "${junk}"`).toBeNull();
    }
  });

  it('the resolver honours the build-meta seam', () => {
    process.env.OPENWOP_BUILD_META_DIR = stampDir('1.106.0\n');
    expect(contractProvenanceSuiteVersion()).toBe('1.106.0');
  });

  it('THE PRODUCTION CASE — package unresolvable, image stamp still yields provenance', async () => {
    // Asserted through the PURE choice, because the inline version could not
    // fail: in a dev tree the package resolves, so the fallback never ran and
    // deleting it left the test green. This drives the branch directly.
    const { chooseProvenance } = await import('../src/host/contractProvenance.js');
    expect(chooseProvenance(undefined, '1.106.0')).toEqual({ suiteVersion: '1.106.0' });
  });

  it('neither source ⇒ OMIT, never a guess', async () => {
    const { chooseProvenance } = await import('../src/host/contractProvenance.js');
    expect(chooseProvenance(undefined, null)).toBeUndefined();
  });

  it('the package stamp WINS when present — it carries corpusCommit too', async () => {
    const { chooseProvenance } = await import('../src/host/contractProvenance.js');
    const full = { suiteVersion: '1.106.0', corpusCommit: 'a'.repeat(40) };
    expect(chooseProvenance(full, '9.9.9')).toEqual(full);
  });
});
