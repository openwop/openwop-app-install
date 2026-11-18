/**
 * #6053 steps 3–4 — no path mints a NEW undeclared API key.
 *
 * An empty scope declaration means "undeclared", which ADR 0795 D3 keeps for keys
 * minted before it, and `keyDeclarationPermits` lets it through every scope check.
 * So any mint that forgot `scopes` produced a key with its issuer's full authority.
 * Steps 1–2 (rewrite stored `[]` to `['*']`, then make empty deny) change live keys
 * and wait for the owner's go; this closes the producers first.
 *
 * Red when: `issueApiKey` defaults a missing or empty `scopes` (the refusal cases);
 * rotate copies a legacy `[]` (the rotate case); a `src/` call to `issueApiKey`
 * omits `scopes` (the ratchet).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { __issueUndeclaredLegacyKeyForTest, issueApiKey, listApiKeys, rotateApiKey } from '../src/features/developer-keys/apiKeyService.js';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

const T = 'issue-6053';
const ME = 'user:issue-6053';

describe('#6053 — a new API key always declares its scopes', () => {
  it('issueApiKey refuses a missing or empty scope list', async () => {
    for (const scopes of [undefined, []]) {
      await expect(issueApiKey({ tenantId: T, name: 'k', createdBy: ME, scopes })).rejects.toMatchObject({ httpStatus: 400, details: { field: 'scopes' } });
    }
  });

  it("an explicit ['*'] or a named scope mints", async () => {
    expect((await issueApiKey({ tenantId: T, name: 'all', createdBy: ME, scopes: ['*'] })).key.scopes).toEqual(['*']);
    expect((await issueApiKey({ tenantId: T, name: 'read', createdBy: ME, scopes: ['workspace:read'] })).key.scopes).toEqual(['workspace:read']);
  });

  it("rotating a legacy undeclared key mints an explicit ['*'], never a new []", async () => {
    const legacy = await __issueUndeclaredLegacyKeyForTest({ tenantId: `${T}-rot`, name: 'legacy', createdBy: ME });
    expect(legacy.key.scopes).toEqual([]);
    const out = await rotateApiKey(`${T}-rot`, legacy.key.keyId, { isAdmin: true, callerSubject: ME }, { rotatedBy: ME });
    expect(out?.key.scopes).toEqual(['*']);
    const listed = await listApiKeys(`${T}-rot`, { isAdmin: true, callerSubject: ME });
    expect(listed.find((k) => k.keyId === out?.key.keyId)?.scopes).toEqual(['*']);
  });
});

/** Every `issueApiKey(` call in src/, with its argument text up to the matching paren. */
function issueCalls(): Array<{ file: string; text: string }> {
  const root = join(import.meta.dirname, '../src');
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.ts')) continue;
      const src = readFileSync(p, 'utf8');
      for (let i = src.indexOf('issueApiKey('); i !== -1; i = src.indexOf('issueApiKey(', i + 1)) {
        if (/function\s+$/.test(src.slice(Math.max(0, i - 20), i))) continue; // the declaration
        let depth = 0;
        let j = i + 'issueApiKey'.length;
        for (; j < src.length; j++) {
          if (src[j] === '(') depth++;
          else if (src[j] === ')' && --depth === 0) break;
        }
        out.push({ file: p.slice(root.length + 1), text: src.slice(i, j + 1) });
      }
    }
  };
  walk(root);
  return out;
}

describe('#6053 step 4 — ratchet: every src/ call to issueApiKey names its scopes', () => {
  it('finds the known callers (non-vacuous) and every one passes `scopes`', () => {
    const calls = issueCalls();
    expect(calls.length, 'the scan found no callers — it stopped matching').toBeGreaterThanOrEqual(6);
    const missing = calls.filter((c) => !/\bscopes\s*[:,}]/.test(c.text)).map((c) => `${c.file}: ${c.text.slice(0, 80)}`);
    expect(missing, `issueApiKey calls without scopes:\n${missing.join('\n')}`).toEqual([]);
  });

  it('the legacy-key test seam is referenced by no src/ module but its own', () => {
    const root = join(import.meta.dirname, '../src');
    const users: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (p.endsWith('.ts') && !p.endsWith('developer-keys/apiKeyService.ts') && readFileSync(p, 'utf8').includes('__issueUndeclaredLegacyKeyForTest')) users.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    expect(users, 'a production module reaches the undeclared-key test seam').toEqual([]);
  });
});
