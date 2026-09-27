/**
 * USERS-15 — PII-shaped identifiers must not reach the logs from the SSO/SCIM
 * seams. `authScim.ts` logged `userName` (an email in practice) and
 * `authSaml.ts` logged `nameId` (a persistent NameID SHOULD be opaque but is an
 * email at many IdPs). Both now log `userId` / a subject digest.
 *
 * A CROSS-FILE PIN, comments stripped (the `ratchet-gates-count-comments`
 * lesson): every `log.<level>({...})` argument object in the named files is
 * extracted and asserted to carry none of the forbidden keys. Non-vacuous: the
 * scan must find a real population of log calls in each file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');
const FILES = ['routes/authScim.ts', 'routes/authSaml.ts', 'routes/authSamlSso.ts'];
const FORBIDDEN = /\b(userName|nameId|email|displayName|principalId)\s*[:,}]/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Every `log.<level>(<name>, { … })` payload literal, balanced-brace extracted. */
function logPayloads(src: string): string[] {
  const out: string[] = [];
  const re = /\blog\.(info|warn|error|debug)\(\s*'[^']*'\s*,\s*\{/g;
  for (const m of src.matchAll(re)) {
    let i = m.index! + m[0].length - 1;
    let depth = 0;
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    out.push(src.slice(start, i + 1));
  }
  return out;
}

describe('USERS-15 — auth seam logs carry ids/digests only', () => {
  for (const rel of FILES) {
    it(`${rel}: no userName/nameId/email/displayName/principalId key inside any log.* payload`, () => {
      const code = stripComments(readFileSync(join(SRC, rel), 'utf8'));
      const payloads = logPayloads(code);
      expect(payloads.length, `${rel}: the scan found no log payloads — inert`).toBeGreaterThanOrEqual(2);
      for (const p of payloads) expect(p, `${rel} logs a PII-shaped key: ${p}`).not.toMatch(FORBIDDEN);
    });
  }

  it('is non-vacuous — the scanner recognises a forbidden payload when shown one', () => {
    const sample = "log.info('x', { userName, linked: true });";
    expect(logPayloads(sample)[0]).toMatch(FORBIDDEN);
    expect(logPayloads("log.info('y', { userId: u.userId, tenantId });")[0]).not.toMatch(FORBIDDEN);
  });
});
