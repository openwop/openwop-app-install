/**
 * The gate that would have caught #2871's collateral damage.
 *
 * `chain-config-conformance.test.ts` checks that every REQUIRED config key is
 * PRESENT ("KEY-PRESENCE, not value validation", per its own docblock). Nothing
 * checked the other direction — a key the node's schema does not declare at all.
 *
 * That blind spot let a scripted retarget write 65 stray keys across 58 nodes —
 * `config.audience` onto 24, `inputs.title` onto 41 — and ship them to the
 * registry green. Both conformance suites passed before and after the repair;
 * neither could see it.
 *
 * Note on scope: this closed-world check catches only 15 of those 65, because
 * most of the nodes that received a stray declare `additionalProperties: true`.
 * The remaining 50 are pinned by shape in the second describe block below. Two
 * assertions, because one corpus does not cover the defect.
 *
 * A node whose schema says `additionalProperties: false` is making a closed-world
 * claim. An authored key outside it is one of exactly two defects — a schema that
 * under-declares what the node honours, or authored config nothing reads — and
 * both are worth failing a build over. Which one it is cannot be decided by this
 * test, so it fails and makes a human decide.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { globSync } from 'node:fs';

const REPO = join(import.meta.dirname, '..', '..', '..');

/**
 * Known violations as of 2026-08-02, each PRE-DATING this gate. Listed
 * individually — a count alone would let one be swapped for another.
 *
 * `core.storage.kv-{get,set}.config.key` is CONFIRMED a schema gap, not dead
 * config: `packs/core.openwop.storage/index.mjs:17` spreads
 * `{...ctx.config, ...ctx.inputs}` into the host storage call, so `key` is
 * honoured — `kv-get.config.json` simply never declared it.
 *
 * The remaining 6 entries (3 node types: `openapi-call`, `chatCompletion`,
 * `web.search`) are NOT yet diagnosed — each is either the same schema gap or
 * dead authored config, and telling them apart means reading each impl. They are
 * recorded so the gate can protect new work today instead of waiting on three
 * unrelated investigations. Tracked as `GRD-8` in
 * `docs/steward/CODEBASE-ASSESSMENT.md`. This list may only ever SHRINK.
 */
const BASELINE = new Set<string>([
  // EMPTY as of ADR 0525. All six entries were diagnosed rather than carried:
  // four were schema gaps (the key IS honoured — by the chain loader's
  // pre-flight, by a registration-time rewriter, or by the node itself reading
  // config-or-inputs) and are now declared; two were genuinely dead and one of
  // those was a LIVE DEFECT — `core.web.search` read `config.maxResults` only,
  // so two chains asking for 8 via `inputs` silently ran at the default 5.
  //
  // A baseline entry is a standing grant of permission to an undiagnosed
  // condition. Diagnosing these took one pass and turned up a live defect, which
  // is the argument against carrying them.
]);

interface Schema { properties?: Record<string, unknown>; additionalProperties?: unknown }

function loadSchemas(): Map<string, { config?: Schema; inputs?: Schema }> {
  const out = new Map<string, { config?: Schema; inputs?: Schema }>();
  for (const manifest of globSync(join(REPO, 'packs', '*', 'pack.json'))) {
    const base = dirname(manifest);
    let pack: { nodes?: { typeId?: string; id?: string; configSchemaRef?: string; inputSchemaRef?: string }[] };
    try { pack = JSON.parse(readFileSync(manifest, 'utf8')); } catch { continue; }
    for (const node of pack.nodes ?? []) {
      const typeId = node.typeId ?? node.id;
      if (!typeId) continue;
      const read = (ref?: string): Schema | undefined => {
        if (!ref) return undefined;
        const p = join(base, ref);
        if (!existsSync(p)) return undefined;
        try { return JSON.parse(readFileSync(p, 'utf8')) as Schema; } catch { return undefined; }
      };
      out.set(typeId, { config: read(node.configSchemaRef), inputs: read(node.inputSchemaRef) });
    }
  }
  return out;
}

interface Violation { key: string; pack: string; chainId: string; nodeId: string }

function findViolations(): { violations: Violation[]; nodesChecked: number; closedWorldChecks: number } {
  const schemas = loadSchemas();
  const violations: Violation[] = [];
  let nodesChecked = 0;
  let closedWorldChecks = 0;
  for (const manifest of globSync(join(REPO, 'examples', 'workflow-chain-packs', '*', 'pack.json'))) {
    const pack = JSON.parse(readFileSync(manifest, 'utf8')) as {
      chains?: { chainId: string; dag?: { nodes?: { id: string; typeId: string; config?: Record<string, unknown>; inputs?: Record<string, unknown> }[] } }[];
    };
    const packName = manifest.split('/').slice(-2)[0]!;
    for (const chain of pack.chains ?? []) {
      for (const node of chain.dag?.nodes ?? []) {
        nodesChecked += 1;
        const schema = schemas.get(node.typeId);
        if (!schema) continue;
        for (const kind of ['config', 'inputs'] as const) {
          const s = schema[kind];
          // Only a schema that CLOSES its world is making a claim to check.
          if (!s || s.additionalProperties !== false) continue;
          closedWorldChecks += 1;
          const allowed = new Set(Object.keys(s.properties ?? {}));
          for (const key of Object.keys(node[kind] ?? {})) {
            if (!allowed.has(key)) {
              violations.push({ key: `${node.typeId}.${kind}.${key}`, pack: packName, chainId: chain.chainId, nodeId: node.id });
            }
          }
        }
      }
    }
  }
  return { violations, nodesChecked, closedWorldChecks };
}

describe('chain nodes author no key their node type does not declare', () => {
  const { violations, nodesChecked, closedWorldChecks } = findViolations();

  it('fixture guard: the corpus and the closed-world schemas are both real', () => {
    // Without this the whole file passes vacuously the day a glob or a manifest
    // field is renamed — the way a gate stops gating. The thresholds sit just
    // under the real values (551 / 364), not far below: a guard set at 100 when
    // reality is 364 still passes with `additionalProperties` handling inverted
    // (measured: 253), so a slack threshold is a guard that has already stopped
    // guarding.
    expect(nodesChecked, 'no chain nodes scanned').toBeGreaterThan(500);   // real: 551
    expect(closedWorldChecks, 'no node type closes its world — nothing was actually checked').toBeGreaterThan(300); // real: 364
  });

  it('has no violation outside the recorded baseline', () => {
    const unexpected = violations.filter((v) => !BASELINE.has(v.key));
    expect(
      unexpected.map((v) => `${v.pack}/${v.chainId}#${v.nodeId} → ${v.key}`),
      'a chain authors a key its node type does not declare (see this file\'s docblock)',
    ).toEqual([]);
  });

  it('the baseline only shrinks — a fixed entry must be deleted from it', () => {
    const stillPresent = new Set(violations.map((v) => v.key));
    const stale = [...BASELINE].filter((k) => !stillPresent.has(k));
    expect(stale, 'these baseline entries are fixed; delete them so the ceiling cannot drift back up').toEqual([]);
  });
});

describe('the retarget of #2871 stays repaired', () => {
  const NOTIFY = 'feature.notifications.nodes.notify';

  /**
   * The 4 non-notify `inputs.title` that are LEGITIMATE — each present at
   * `91e398f52^`, i.e. authored before the retarget and untouched by it. These
   * notebook nodes genuinely take a title. Enumerated rather than counted so a
   * new stray cannot hide by replacing one.
   */
  const ALLOWED_NON_NOTIFY_TITLES = new Set([
    'notebooks.ingest-audio#ingest',
    'notebooks.ingest-youtube#ingest',
    'notebooks.mcp.add-source#write',
    'notebooks.transform#write',
  ]);

  it('no non-notify node carries either of the retarget\'s two keys', () => {
    // The specific corruption, pinned by shape rather than by count: `audience`
    // and `title` were written onto whatever node the regex happened to land on.
    // BOTH keys are pinned — `inputs.title` was 41 of the 65, and the
    // closed-world gate above sees only 15 of them.
    const strays: string[] = [];
    for (const manifest of globSync(join(REPO, 'examples', 'workflow-chain-packs', '*', 'pack.json'))) {
      const pack = JSON.parse(readFileSync(manifest, 'utf8')) as {
        chains?: { chainId: string; dag?: { nodes?: { id: string; typeId: string; config?: Record<string, unknown>; inputs?: Record<string, unknown> }[] } }[];
      };
      for (const chain of pack.chains ?? []) {
        for (const node of chain.dag?.nodes ?? []) {
          if (node.typeId === NOTIFY) continue;
          if ('audience' in (node.config ?? {})) strays.push(`${chain.chainId}#${node.id} config.audience`);
          // `inputs.title` was 41 of the 65 strays — the LARGER half. Pinning only
          // `audience` would have left it unpoliced, and the closed-world gate
          // above catches just 15 of the 65 (notify's own input schema is
          // `additionalProperties: true`, so most stray titles are legal there).
          if ('title' in (node.inputs ?? {}) && !ALLOWED_NON_NOTIFY_TITLES.has(`${chain.chainId}#${node.id}`)) {
            strays.push(`${chain.chainId}#${node.id} inputs.title`);
          }
        }
      }
    }
    expect(strays).toEqual([]);
  });

  it('every notify node is titled with its OWN chain\'s label', () => {
    // Six were titled with a NEIGHBOURING chain's label — a wrong title is the
    // one part of this that a user actually reads.
    const wrong: string[] = [];
    let checked = 0;
    for (const manifest of globSync(join(REPO, 'examples', 'workflow-chain-packs', '*', 'pack.json'))) {
      const pack = JSON.parse(readFileSync(manifest, 'utf8')) as {
        chains?: { chainId: string; label?: string; dag?: { nodes?: { id: string; typeId: string; inputs?: Record<string, unknown> }[] } }[];
      };
      for (const chain of pack.chains ?? []) {
        for (const node of chain.dag?.nodes ?? []) {
          if (node.typeId !== NOTIFY) continue;
          checked += 1;
          const title = (node.inputs ?? {}).title;
          if (title !== chain.label) wrong.push(`${chain.chainId}#${node.id}: ${JSON.stringify(title)} ≠ ${JSON.stringify(chain.label)}`);
        }
      }
    }
    expect(checked, 'no notify nodes found — the assertion below would be vacuous').toBeGreaterThan(50);
    expect(wrong).toEqual([]);
  });
});
