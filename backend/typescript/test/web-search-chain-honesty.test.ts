/**
 * RATCHET — every chain that consumes `core.web.search` must handle the
 * not-configured case.
 *
 * With no search key the surface returns `engine:'demo'` placeholders (ADR 0101
 * decided this should be an explicit signal, never a silent stub). A chain that
 * feeds those into a synthesis prompt saying "ground every claim in the search
 * results" produces output that READS as researched and isn't — the same
 * "looks like it worked" class as the ADR 0491 incident.
 *
 * Found by sweeping the 6 search-consuming chains: only `research.web-brief`
 * handled it. `outreach.researched-firsttouch` was the sharp one — it told the
 * model to "open with a SPECIFIC observation from the research" and then SENDS AN
 * EMAIL to a real prospect.
 *
 * Two ways to satisfy this, both legitimate:
 *   - PROMPT-GUARDED: a downstream node's prompt names the `demo`/`stub` engine
 *     and refuses to treat those results as findings.
 *   - CODE-GUARDED: the chain feeds a persistence path that fails closed on
 *     non-durable engines (`engineIsDurable`), e.g. the KickTodo dossier. This is
 *     the STRONGER form — it does not depend on a model obeying an instruction.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PACKS_DIR = join(import.meta.dirname, '../../../examples/workflow-chain-packs');

/** Chains whose results reach a code-level fail-closed gate rather than a prompt.
 *  Each entry names the guard so a reader can verify the claim, not just trust it. */
const CODE_GUARDED: Record<string, string> = {
  'kicktodo.research':
    'feeds creatorService.recordResearch → engineIsDurable (throws StubSourceError)',
  'openwop-app.kicktodo.challenge-factory':
    'feeds creatorService.recordResearch → engineIsDurable (throws StubSourceError)',
};

interface ChainNode { id: string; typeId: string; config?: Record<string, unknown> }
interface Chain { chainId: string; dag?: { nodes?: ChainNode[] } }

function loadChains(): Array<{ pack: string; chain: Chain }> {
  const out: Array<{ pack: string; chain: Chain }> = [];
  for (const dir of readdirSync(PACKS_DIR)) {
    const file = join(PACKS_DIR, dir, 'pack.json');
    if (!existsSync(file)) continue;
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { chains?: Chain[] };
    for (const chain of doc.chains ?? []) out.push({ pack: dir, chain });
  }
  return out;
}

const searchChains = loadChains().filter(({ chain }) =>
  (chain.dag?.nodes ?? []).some((n) => n.typeId === 'core.web.search'),
);

describe('chains consuming core.web.search handle the not-configured case', () => {
  it('the sweep finds chains at all (guards against a silently-empty ratchet)', () => {
    // Without this, a broken path or a renamed node type would make every
    // assertion below vacuously pass.
    expect(searchChains.length).toBeGreaterThanOrEqual(5);
  });

  it.each(searchChains.map(({ pack, chain }) => [chain.chainId, pack, chain] as const))(
    '%s (%s) is prompt-guarded or code-guarded',
    (chainId, _pack, chain) => {
      if (CODE_GUARDED[chainId]) {
        expect(CODE_GUARDED[chainId]).toBeTruthy();
        return;
      }
      // Prompt-guarded: some downstream node must name BOTH placeholder engines,
      // so the model is told exactly what to look for.
      const configs = (chain.dag?.nodes ?? []).map((n) => JSON.stringify(n.config ?? {}));
      const guarded = configs.some((c) => c.includes("'demo'") && c.includes("'stub'"));
      expect(
        guarded,
        `Chain "${chainId}" feeds core.web.search results into its nodes without handling the `
        + `not-configured case. With no search key the results are engine:'demo' placeholders, so this `
        + `chain would produce output that reads as researched but isn't. Either add the guard to the `
        + `synthesising node's prompt (see research.web-brief) or route it through a code-level `
        + `fail-closed gate and register it in CODE_GUARDED with the guard named.`,
      ).toBe(true);
    },
  );
});
