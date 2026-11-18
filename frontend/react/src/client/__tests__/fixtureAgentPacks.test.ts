/**
 * Issue 5799 — every pack that declares itself a fixture is hidden from people.
 *
 * `FIXTURE_AGENT_PACKS` is a hand-kept set, so this derives the population from the
 * packs themselves: a pack whose manifest lists the `fixtures` keyword and ships
 * agents must be in the set, and every name in the set must still be a real pack.
 * Red when a new fixture pack lands without being listed, or a listed one is renamed.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_AGENT_PACKS } from '../agentHandles.js';

const PACKS = join(process.cwd(), '..', '..', 'packs');
const manifests = readdirSync(PACKS)
  .map((d) => join(PACKS, d, 'pack.json'))
  .filter((p) => existsSync(p))
  .map((p) => JSON.parse(readFileSync(p, 'utf8')) as { name: string; keywords?: string[]; agents?: unknown[] });

describe('issue 5799 — fixture agent packs', () => {
  it('reads the real pack directory (a broken walk would assert nothing)', () => {
    expect(manifests.length).toBeGreaterThan(50);
  });

  it('every pack that declares `fixtures` and ships agents is hidden', () => {
    const declared = manifests.filter((m) => (m.keywords ?? []).includes('fixtures') && (m.agents ?? []).length > 0).map((m) => m.name);
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((n) => !FIXTURE_AGENT_PACKS.has(n))).toEqual([]);
  });

  it('every hidden pack still exists', () => {
    const names = new Set(manifests.map((m) => m.name));
    expect([...FIXTURE_AGENT_PACKS].filter((n) => !names.has(n))).toEqual([]);
  });
});
