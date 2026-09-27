/**
 * ADR 0081 Phase 3 — live agent tool execution (node-as-tool projection).
 *
 * The suite's PURE compute nodes (variance-compute, talent-score) are projected as live
 * agent tools so a dispatched agent can call them for real; connector-backed nodes
 * (bigquery.query, email.draft) are deliberately NOT projected (they need the executor
 * broker ctx — meta-workflow path only). Verifies resolution, real execution, fail-closed,
 * and the connector-node exclusion.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodes as insightsNodes } from '../../../packs/feature.insights-suite.nodes/index.mjs';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { NodeContext, NodeModule, NodeOutcome } from '../src/executor/types.js';
import { builtinAgentToolIds, createAgentToolProvider } from '../src/host/agentToolProvider.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VARIANCE = 'openwop:feature.insights-suite.nodes.variance-compute';
const TALENT = 'openwop:feature.insights-suite.nodes.talent-score';

beforeAll(() => {
  // Register the pure compute nodes so the projection's registry lookup resolves them.
  const reg = getNodeRegistry();
  for (const [typeId, fn] of Object.entries(insightsNodes)) {
    const execute: NodeModule['execute'] = async (ctx) => (await fn(ctx)) as NodeOutcome;
    reg.register({ typeId, version: '1.0.0', execute });
  }
});

describe('ADR 0081 §3 — node-as-tool projection', () => {
  it('projects the pure compute nodes as live agent tools (with a def)', () => {
    expect(builtinAgentToolIds()).toEqual(expect.arrayContaining([VARIANCE, TALENT, 'openwop:knowledge.search']));
    const p = createAgentToolProvider({ tenantId: 'tenant-a' });
    expect(p.resolveTool(VARIANCE)?.inputSchema).toMatchObject({ type: 'object' });
    expect(p.resolveTool(TALENT)?.name).toBe(TALENT); // resolveTool returns the AgentToolDef directly
  });

  it('does NOT project connector-backed nodes (they need the broker ctx — meta-workflow only)', () => {
    const p = createAgentToolProvider({ tenantId: 'tenant-a' });
    expect(p.resolveTool('openwop:core.bigquery.query')).toBeUndefined();
    expect(p.resolveTool('openwop:core.email.draft')).toBeUndefined();
  });

  it('executeTool runs variance-compute for real (deterministic)', async () => {
    const p = createAgentToolProvider({ tenantId: 'tenant-a' });
    const r = await p.executeTool({ name: VARIANCE, input: { businessUnit: 'BU1', actuals: { sales: 90 }, plan: { sales: 100 } } });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.content) as { verdict: string; flagged: Array<{ metric: string }> };
    expect(out.verdict).toBe('off_plan');
    expect(out.flagged.map((f) => f.metric)).toContain('sales');
  });

  it('executeTool runs talent-score; missing subjectId fails closed (isError)', async () => {
    const p = createAgentToolProvider({ tenantId: 'tenant-a' });
    const ok = await p.executeTool({ name: TALENT, input: { subjectId: 'subj-x', performance: 3, potential: 3 } });
    expect(ok.isError).toBeFalsy();
    expect((JSON.parse(ok.content) as { box: number }).box).toBe(9);
    const bad = await p.executeTool({ name: TALENT, input: { performance: 2, potential: 2 } });
    expect(bad.isError).toBe(true);
  });
});

/**
 * `PROBE-IS-11` (closes `ISC-12`) — ADR 0600 §8. The model-facing prompt↔node
 * PARITY TRIPWIRE.
 *
 * Pack `description` fields and prompt bodies reach the model's system prompt, so
 * drift there is drift in what the model believes about the world. The Financial
 * agent was told: *"Carry the 'data as-of' timestamp and any query reference
 * forward so the human can verify. Never present a number you cannot trace"* —
 * and `variance-compute` returns no timestamp, no query reference and no source
 * id. An instruction to cite a structurally absent thing does not produce
 * silence; it produces a confident, unfalsifiable traceability story. The pack
 * description made the same promise ("with the exact SQL for 'Verify Source'"),
 * naming a surface ADR 0082 deleted.
 *
 * This is the `promptCatalogParity` shape CLAUDE.md names: the prompt's claim
 * about the tool's outputs is TEST-PINNED to the tool's actual outputs, so the
 * next person to add a provenance field (or remove one) is told.
 */
describe('PROBE-IS-11 — the Financial prompt does not promise provenance the node cannot emit', () => {
  const promptPath = join(REPO_ROOT, 'packs', 'feature.insights-suite.agents', 'prompts', 'financial.md');
  const packPath = join(REPO_ROOT, 'packs', 'feature.insights-suite.agents', 'pack.json');

  it('the node emits exactly the output keys the prompt enumerates — no more, no fewer', async () => {
    const mod = await getNodeRegistry().resolve('feature.insights-suite.nodes.variance-compute');
    expect(mod, 'variance-compute did not resolve through the trust-gated pack lane').toBeTruthy();
    const out = await mod!.execute({
      config: {}, inputs: { businessUnit: 'TX', actuals: { sales: 95 }, plan: { sales: 100 } },
    } as unknown as NodeContext) as { status: string; outputs: Record<string, unknown> };
    expect(out.status).toBe('success');

    const prompt = readFileSync(promptPath, 'utf8');
    const enumerated = [...prompt.matchAll(/`([a-zA-Z]+)`/g)].map((m) => m[1]!);
    for (const key of Object.keys(out.outputs)) {
      expect(
        enumerated.includes(key),
        `variance-compute emits \`${key}\` and the prompt's output enumeration does not list it — `
        + 'the model is being told a smaller world than it lives in',
      ).toBe(true);
    }
    // The other direction, which is the one ISC-12 was: the prompt must not name
    // an output the node does not produce.
    for (const claimed of ['asOf', 'queryRef', 'sql', 'sourceId', 'timestamp']) {
      expect(
        Object.keys(out.outputs).includes(claimed) || !new RegExp(`\`${claimed}\``).test(prompt),
        `the prompt names \`${claimed}\` as an output and the node does not emit it`,
      ).toBe(true);
    }
  });

  it('neither the prompt nor the pack description promises SQL provenance', () => {
    const prompt = readFileSync(promptPath, 'utf8');
    const pack = readFileSync(packPath, 'utf8');
    // The exact phrasings that shipped, pinned so a revert is loud. Both named a
    // surface that does not exist: `Verify Source` was the deleted dashboard's.
    expect(pack).not.toContain("the exact SQL for 'Verify Source'");
    expect(prompt).not.toContain('Carry the "data as-of" timestamp and any query reference forward');
    expect(prompt).not.toContain('a scheduled/workflow run that hands you\nthe figures');
    // …and the honest replacement is actually there (a deletion is not a fix).
    expect(prompt).toContain('The variance tool returns no provenance');
  });

  /**
   * ADR 0600 §Correction 3 — THE TWO ASSERTIONS ABOVE ARE BOTH TOO NARROW TO HAVE
   * CLOSED `ISC-12`, AND THEY WENT GREEN OVER A PROMPT THAT STILL CARRIED IT.
   *
   * The output-key parity test matches only BACKTICK-DELIMITED identifiers
   * (/`([a-zA-Z]+)`/). The description test pins three exact historical
   * phrasings. Neither instrument can see PROSE. Two prose survivors shipped:
   *
   *   - *"say so plainly and give the 'data as-of' timestamp"* — the same
   *     promise §8 removed from the bullet directly above it, still standing
   *     two bullets later;
   *   - *"…and what to ask about it — with the source query attached"* — the
   *     CLOSING SENTENCE of the prompt.
   *
   * So `XCH-IS-1` was recorded CLOSED at grade B in `LLM-EXCHANGE-AUDIT.md`
   * over a prompt that still told the model to cite a structurally absent thing.
   *
   * The replacement instrument is the CLOSED WORLD §7 chose for `ISC-15`, for
   * the same reason: a rule that polices a NAME (or a fixed phrase) cannot see
   * what it was not told about, and a rule that says "every occurrence must be
   * on a reviewed list" makes the next one FAIL until a human reads it.
   *
   * Note what it deliberately does NOT do: a bare `not.toContain('with the
   * source query attached')` would now be FALSE, because the corrected prompt
   * QUOTES the phrase it removed (§8's "corrections are inline notes, not
   * rewrites" style). An assertion whose window can be re-opened by the content
   * it inspects is the vacuity shape this feature has already produced five
   * times. Reviewing the LINE is not window-delimited.
   *
   * Its honest bound: the world is closed over `PROVENANCE_TERMS`. A directive
   * phrased with none of them ("attach the origin") is invisible, exactly as
   * `ISC-15`'s allowlist is bounded by the node ids on it.
   */
  const PROVENANCE_TERMS = [
    'data as-of', 'data as of', 'source query', 'query reference', 'source id',
    'sql', 'provenance', 'traceab', 'verify source',
  ] as const;

  /**
   * Every line of the prompt that mentions provenance, READ and confirmed to be
   * either a statement that the provenance is ABSENT or a correction note
   * quoting a removed instruction — never a directive to supply one.
   *
   * To change the prompt's provenance language you must edit this list, which
   * means reading what you wrote. That is the whole mechanism.
   */
  const REVIEWED_PROVENANCE_LINES: readonly string[] = [
    'traceable to the data you were handed. **The variance tool returns no provenance** —',
    'else: no query reference, no "data as-of" timestamp, no source id. So carry forward',
    'whatever provenance the HUMAN gave you in the task, and where they gave none, state',
    'plainly that the figures are untraceable from here rather than describing a',
    '*(This paragraph used to read "carry the data as-of timestamp and any query',
    'not produce silence; it produces a confident, unfalsifiable traceability story.)*',
    '§Correction 3 / `ISC-12`: this bullet used to end "and give the data as-of',
    'end "with the source query attached" — the closing instruction of the prompt, asking',
  ];

  it('every provenance mention in the prompt is on the reviewed list (a closed world, not a phrase pin)', () => {
    const lines = readFileSync(promptPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    const mentions = lines.filter((l) => PROVENANCE_TERMS.some((term) => l.toLowerCase().includes(term)));

    // Anti-vacuity floor: if the term list ever stops matching the prompt, this
    // test would pass by matching nothing at all — the "a probe that RAN NOTHING
    // reports green" shape. Both survivors were on lines, so the floor is real.
    expect(mentions.length, 'the provenance term list matched NOTHING — the instrument is inert').toBeGreaterThanOrEqual(8);

    for (const line of mentions) {
      expect(
        REVIEWED_PROVENANCE_LINES.includes(line),
        `the prompt mentions provenance on a line nobody has reviewed:\n  ${line}\n`
        + 'Read it. If it INSTRUCTS the model to supply a "data as-of" timestamp, a source '
        + 'query or any other citation, delete it — `variance-compute` emits none of them '
        + '(ADR 0600 §8 / §Correction 3). If it states the ABSENCE, add it to '
        + 'REVIEWED_PROVENANCE_LINES.',
      ).toBe(true);
    }

    // The other direction: a reviewed entry that no longer matches is a stale
    // approval, and a stale approval is how a list stops being a review.
    for (const reviewed of REVIEWED_PROVENANCE_LINES) {
      expect(
        mentions.includes(reviewed),
        `REVIEWED_PROVENANCE_LINES carries a line the prompt no longer has:\n  ${reviewed}\n`
        + 'Remove it — a list that outlives what it approved is not a review.',
      ).toBe(true);
    }
  });

  it('the two ISC-12 prose survivors are gone as INSTRUCTIONS (and the closed world is why)', () => {
    const prompt = readFileSync(promptPath, 'utf8');
    // Directive form, not mere mention: the survivors were imperatives. Pinned in
    // ADDITION to the closed world, because these two are the measured defect and
    // a reader should see them named. Whitespace-tolerant — the prompt is wrapped.
    const flat = prompt.replace(/\s+/g, ' ');
    expect(flat).not.toContain('say so plainly and give the "data as-of" timestamp');
    expect(flat).not.toContain('to ask about it — with the source query attached.');
  });
});
