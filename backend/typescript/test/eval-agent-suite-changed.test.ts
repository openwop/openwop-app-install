/**
 * NP-EVAL-2 / EVAL-3 — `scripts/eval-agent-suite.mts --changed` must select the
 * suites whose target agent's pack changed.
 *
 * Why this exists: the first version read `split('/')[2]` of a repo-root-relative
 * `packs/<pack>/<file>` path (the FILE name) and prefix-matched agent ids against
 * it, so it selected nothing on every run and exited 0. Sabotage-witnessed: with
 * `changedPackDirs` reading `parts[2]` again, the real-manifest case below goes red
 * (it selects no suite).
 *
 * EVD-3 (CLI half): with `--baseline`, a run that produced no comparison must fail
 * the gate. Before, `verdict !== 'regressed'` passed a summary with no regression
 * block, so a baseline that could not be used read as "not regressed".
 * Sabotage-witnessed: dropping the `baselineRequested` branch reds both cases.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentsDeclaredBy, changedPackDirs, gateOutcome, selectChangedTargets } from '../scripts/eval-agent-suite-targets.mjs';

const PACKS = join(dirname(fileURLToPath(import.meta.url)), '../../../packs');
const readReal = (dir: string) => JSON.parse(readFileSync(join(PACKS, dir, 'pack.json'), 'utf8'));

describe('eval-agent-suite --changed target selection', () => {
  it('a prompt edit in a real agent pack selects that agent\'s suite and nothing else', () => {
    const diff = [
      'packs/vendor.openwop-app.agent-author.agents/prompts/agent-author.md',
      'backend/typescript/src/index.ts',
      'packs/feature.agent-author.nodes/index.mjs', // a node pack declares no agents
    ];
    const agents = agentsDeclaredBy(changedPackDirs(diff), readReal);
    const targets = selectChangedTargets([
      { ref: 'vendor.openwop-app.agent-author.evals.agent-author@1.0.0', suite: { targetAgentId: 'vendor.openwop-app.agent-author.agents.agent-author' } },
      { ref: 'other@1.0.0', suite: { targetAgentId: 'vendor.openwop-app.workflow-author.agents.workflow-architect' } },
      { ref: 'untargeted@1.0.0', suite: {} },
    ], agents);
    expect(targets).toEqual([{ suiteRef: 'vendor.openwop-app.agent-author.evals.agent-author@1.0.0', agentId: 'vendor.openwop-app.agent-author.agents.agent-author' }]);
  });

  it('matches by declared agent, never by id prefix', () => {
    const manifests: Record<string, unknown> = { 'feature.crm.agents': { agents: [{ agentId: 'feature.crm.agents.rep' }] } };
    const agents = agentsDeclaredBy(changedPackDirs(['packs/feature.crm.agents/pack.json']), (d) => manifests[d]);
    const targets = selectChangedTargets([
      { ref: 'a@1', suite: { targetAgentId: 'feature.crm.agents.rep' } },
      { ref: 'b@1', suite: { targetAgentId: 'feature.crm-x.agents.rep' } },
      { ref: 'c@1', suite: { targetAgentId: 'feature.crm.agents.rep-two' } },
    ], agents);
    expect(targets.map((t) => t.suiteRef)).toEqual(['a@1']);
  });

  it('a deleted pack (manifest unreadable) and paths outside packs/ select nothing', () => {
    const agents = agentsDeclaredBy(
      changedPackDirs(['packs/gone.agents/pack.json', 'examples/workflow-chain-packs/x/pack.json', 'packs']),
      () => { throw new Error('ENOENT'); },
    );
    expect(agents.size).toBe(0);
  });
});

describe('eval-agent-suite gate with --baseline (EVD-3)', () => {
  it('passes a passing, not-regressed comparison and fails a regression', () => {
    expect(gateOutcome({ passed: true, regression: { verdict: 'not_regressed' } }, { baselineRequested: true })).toEqual({ ok: true });
    expect(gateOutcome({ passed: true, regression: { verdict: 'regressed' } }, { baselineRequested: true }).ok).toBe(false);
    expect(gateOutcome({ passed: false }, { baselineRequested: false }).ok).toBe(false);
  });

  it('fails when a baseline was requested and the summary carries no regression block', () => {
    const g = gateOutcome({ passed: true }, { baselineRequested: true });
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/no regression verdict/);
    // Without --baseline, no regression block is the normal shape.
    expect(gateOutcome({ passed: true }, { baselineRequested: false })).toEqual({ ok: true });
  });

  it('fails an inconclusive verdict caused by baseline_unavailable, and not a merely inconclusive one', () => {
    const g = gateOutcome({ passed: true, regression: { verdict: 'inconclusive' } }, { baselineRequested: true, regressionReason: 'baseline_unavailable' });
    expect(g).toMatchObject({ ok: false });
    expect(g.reason).toMatch(/baseline_unavailable/);
    expect(gateOutcome({ passed: true, regression: { verdict: 'inconclusive' } }, { baselineRequested: true, regressionReason: 'too_few_pairs' })).toEqual({ ok: true });
  });
});
