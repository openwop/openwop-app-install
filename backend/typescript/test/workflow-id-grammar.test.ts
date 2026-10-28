/**
 * ADR 0794 — one grammar and one mint for workflow ids.
 *
 * Three things are pinned here:
 *  1. every mint produces `wf.<origin>.…` with an origin from the closed set;
 *  2. the browser's mints (`blank`, `dup`) and its client-creatable origin set
 *     equal the server's (the builder mints offline, so there are two functions —
 *     they may not drift). There is no browser legacy-id mapping any more;
 *     `workflowToolName` lives only in the browser module and is pinned below;
 *  3. the RATCHET: no file outside the two mint modules builds a `wf` id by hand
 *     or pattern-matches a workflow id's spelling. Three chat readers did, and
 *     every server-minted workflow ran with no step count, names or builder link.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_ID_ORIGINS, authoredWalkthroughId, blankWorkflowId, cadenceWorkflowId, composedWorkflowId, copyWorkflowId,
  dupWorkflowId, forkWorkflowId, isServerMintedWorkflowId, isSharedWorkflowId, mintUnique, seedWorkflowId,
  subWorkflowId, workflowIdOrigin, workflowKind,
} from '../src/host/workflowId.js';
import * as browser from '../../../frontend/react/src/builder/persistence/workflowId.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

const mintOne = (): Record<string, string> => ({
  seed: seedWorkflowId('approvals.request-sign-off'),
  copy: copyWorkflowId('approvals.request-sign-off'),
  blank: blankWorkflowId(),
  dup: dupWorkflowId(),
  fork: forkWorkflowId('wf.seed.digest'),
  sub: subWorkflowId('tenant-a', 'review.step', '1.0.0'),
  cadence: cadenceWorkflowId('tenant-a', 'strategy.weekly-checkin'),
});

describe('the mint', () => {
  it('every origin in the closed set has a mint, and every mint is in the grammar', () => {
    const minted = mintOne();
    expect(Object.keys(minted).sort()).toEqual([...WORKFLOW_ID_ORIGINS].sort());
    for (const [origin, id] of Object.entries(minted)) {
      expect(workflowIdOrigin(id), id).toBe(origin);
      expect(id).toMatch(/^wf\.[a-z]+\.[A-Za-z0-9.-]+$/);
      expect(id.length, id).toBeLessThanOrEqual(128); // WORKFLOW_ID_PATTERN
    }
    expect(minted.seed).toBe('wf.seed.approvals-request-sign-off');
    expect(minted.copy).toMatch(/^wf\.copy\.approvals-request-sign-off\.[0-9a-f]{16}$/);
    expect(minted.blank).toMatch(/^wf\.blank\.[0-9a-f]{16}$/);
    expect(minted.dup).toMatch(/^wf\.dup\.[0-9a-f]{16}$/);
    expect(minted.fork).toMatch(/^wf\.fork\.digest\.[0-9a-f]{16}$/);
  });

  it('deterministic origins are stable, and tenant-scoped where they must be', () => {
    expect(subWorkflowId('t1', 'review.step', '1')).toBe(subWorkflowId('t1', 'review.step', '1'));
    expect(subWorkflowId('t1', 'review.step', '1')).not.toBe(subWorkflowId('t2', 'review.step', '1'));
    expect(subWorkflowId('t1', 'review.step', '1')).not.toBe(subWorkflowId('t1', 'review.step', '2'));
    expect(cadenceWorkflowId('t1', 'strategy.board-pack')).toBe(cadenceWorkflowId('t1', 'strategy.board-pack'));
    expect(cadenceWorkflowId('t1', 'strategy.board-pack')).not.toBe(cadenceWorkflowId('t2', 'strategy.board-pack'));
  });

  it('random origins carry 64 bits and do not repeat', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => blankWorkflowId()));
    expect(ids.size).toBe(2000);
  });

  it('only the seed origin is a shared definition', () => {
    const minted = mintOne();
    for (const [origin, id] of Object.entries(minted)) expect(isSharedWorkflowId(id), id).toBe(origin === 'seed');
  });

  it('a tenant may create only the origins the browser mints', () => {
    const minted = mintOne();
    const clientCreatable = Object.keys(minted).filter((o) => !isServerMintedWorkflowId(minted[o]!)).sort();
    expect(clientCreatable).toEqual([...browser.BROWSER_MINTED_ORIGINS].sort());
    // Ids outside the grammar are not this rule's to refuse (other families, legacy).
    for (const id of ['wf_ab12cd34', 'tmpl.intake', 'openwop-app.uppercase', 'anything']) expect(isServerMintedWorkflowId(id)).toBe(false);
  });

  it('the other families mint here too, and are not in the wf grammar', () => {
    expect(composedWorkflowId()).toMatch(/^agent-wf-[0-9a-f-]{36}$/);
    expect(authoredWalkthroughId()).toMatch(/^walkthrough\.authored\.[0-9a-f-]{36}$/);
    expect(workflowIdOrigin(composedWorkflowId())).toBeNull();
    expect(isSharedWorkflowId(authoredWalkthroughId())).toBe(false);
  });
});

describe('workflowKind', () => {
  it('names what an id is, for every family', () => {
    expect(workflowKind(authoredWalkthroughId())).toBe('walkthrough');
    expect(workflowKind(browser.recordedWalkthroughId('tour'))).toBe('walkthrough');
    for (const id of [...Object.values(mintOne()), composedWorkflowId(), 'tmpl.sales.intake', 'openwop-app.uppercase', 'wf_legacy']) {
      expect(workflowKind(id), id).toBe('workflow');
    }
  });
});

describe('mintUnique', () => {
  it('skips ids that are taken', async () => {
    const queue = ['a', 'b', 'c'];
    const id = await mintUnique(() => queue.shift()!, async (x) => x !== 'c');
    expect(id).toBe('c');
  });

  it('gives up loudly instead of returning a taken id', async () => {
    await expect(mintUnique(() => 'x', async () => true)).rejects.toThrow(/no free id/);
  });
});

describe('the browser mirror equals the server', () => {
  it('mints the same shapes', () => {
    expect(workflowIdOrigin(browser.blankWorkflowId())).toBe('blank');
    expect(workflowIdOrigin(browser.dupWorkflowId())).toBe('dup');
    expect(browser.blankWorkflowId()).toMatch(/^wf\.blank\.[0-9a-f]{16}$/);
    expect(browser.dupWorkflowId()).toMatch(/^wf\.dup\.[0-9a-f]{16}$/);
    for (const o of browser.BROWSER_MINTED_ORIGINS) expect(WORKFLOW_ID_ORIGINS).toContain(o);
  });
});

describe('workflow tool names', () => {
  const VALID = /^[a-zA-Z0-9_-]{1,64}$/;
  it('are valid provider tool names for every id shape', () => {
    for (const id of [...Object.values(mintOne()), 'openwop-app.uppercase', 'x'.repeat(128)]) {
      expect(browser.workflowToolName(id), id).toMatch(VALID);
    }
  });

  it('two copies of one long-named template never share a tool name', () => {
    const chain = 'feature.a-very-long-feature-name.with-a-very-long-chain-name-indeed';
    const a = browser.workflowToolName(copyWorkflowId(chain));
    const b = browser.workflowToolName(copyWorkflowId(chain));
    expect(a).not.toBe(b);
    // The control: truncating the sanitized id alone WOULD collide.
    const cut = (id: string): string => `workflow_${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
    expect(cut(copyWorkflowId(chain))).toBe(cut(copyWorkflowId(chain)));
  });
});

/* ── the ratchet ──────────────────────────────────────────────────────────── */

const MINT_MODULES = new Set([
  'backend/typescript/src/host/workflowId.ts',
  'frontend/react/src/builder/persistence/workflowId.ts',
]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'i18n') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Strip comments so prose about ids (there is a lot of it) cannot trip the gate. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

// Building a workflow id by hand: a template literal of ANY family's shape that
// interpolates, or a string concatenation onto a `wf` prefix.
const HAND_MINT = /`(wf[._]|agent-wf-|walkthrough\.(authored|recorded)\.)[^`]*\$\{|['"]wf[._][a-z.]*['"]\s*\+/;
// Reading the spelling of a `wf` id, however it is written: a prefix/substring
// test, a split on the separator, or a regex that names the prefix.
const READS_SPELLING = /(startsWith|includes|indexOf|endsWith)\(\s*['"`](wf[._]|tmpl\.|openwop-app\.|walkthrough\.|agent-wf-)|\/[^/\n]*\bwf\\?[._][^/\n]*\/[a-z]*\.(test|exec)\(|\.(match|search|replace)\(\s*\/[^/\n]*\bwf\\?[._]/;

describe('ratchet: nothing outside the mint builds or pattern-matches a workflow id', () => {
  const files = [
    ...sources(join(REPO, 'backend', 'typescript', 'src')),
    ...sources(join(REPO, 'frontend', 'react', 'src')),
  ];

  it('scans a real population', () => {
    // Floor = the MEASURED population (grade-tests wave 64, 19d13e682: 3,597 files, re-measured
    // through this walker at HEAD).
    // The old floor of 1,500 let half the tree drop out of the scan unnoticed.
    expect(files.length).toBeGreaterThanOrEqual(3597);
    // The gate can see what it polices: the mint module itself matches both patterns.
    const mint = code(readFileSync(join(REPO, 'backend/typescript/src/host/workflowId.ts'), 'utf8'));
    expect(HAND_MINT.test(mint)).toBe(true);
    // Each reading form is detectable — a pattern that cannot fire is not a gate.
    for (const probe of [
      "id.startsWith('wf_')", "id.includes('wf.seed')", "id.indexOf('wf.') === 0",
      "/^wf\\.seed\\./.test(id)", "id.match(/^wf_/)", "id.startsWith('walkthrough.')", "id.startsWith('tmpl.')", "/^(wf\\.seed\\.|tmpl\\.)/.exec(id)",
    ]) expect(READS_SPELLING.test(probe), probe).toBe(true);
    for (const probe of ['`wf.${slug}.${x}`', '`agent-wf-${id}`', '`walkthrough.recorded.${s}`', "'wf.' + slug"]) {
      expect(HAND_MINT.test(probe), probe).toBe(true);
    }
  });

  it('has an EMPTY baseline', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(REPO, file);
      if (MINT_MODULES.has(rel)) continue;
      const text = code(readFileSync(file, 'utf8'));
      if (HAND_MINT.test(text)) offenders.push(`${rel}: builds a wf id by hand — call host/workflowId.ts`);
      if (READS_SPELLING.test(text)) offenders.push(`${rel}: reads a workflow id's spelling — ask workflowIdOrigin()/isSharedWorkflowId()`);
    }
    expect(offenders).toEqual([]);
  });
});
