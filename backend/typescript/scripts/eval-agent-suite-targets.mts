/**
 * ADR 0889 D10 — the pure half of `eval-agent-suite.mts --changed`: which stored
 * suites target an agent whose pack changed.
 *
 * Split out so it can be tested without a host, a token or a git checkout
 * (NP-EVAL-2 / EVAL-3). The first version took `split('/')[2]` of a
 * repo-root-relative `packs/<pack>/<file>` path, which is the FILE name, then
 * prefix-matched agent ids against it. No agent id starts with `pack.json`, so
 * `--changed` selected nothing on every run and exited 0: a gate that could not
 * fail.
 *
 * An agent is "changed" when the pack that DECLARES it changed. Matching is by
 * the agents the pack's manifest lists, compared in `agentStorageId` form, so a
 * legacy and a canonical spelling (ADR 0763) address the same agent and a
 * `feature.crm` pack can never select a `feature.crm-x` agent.
 */
import { agentStorageId } from '../src/executor/agentIdAliases.js';

/** The `packs/<dir>` directories touched by a `git diff --name-only` run from the
 *  repo root. Anything outside `packs/` is ignored. */
export function changedPackDirs(repoRelativePaths: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const p of repoRelativePaths) {
    const parts = p.trim().split('/');
    if (parts[0] === 'packs' && parts.length >= 3 && parts[1]) dirs.add(parts[1]);
  }
  return dirs;
}

/** The agent ids (storage form) the changed packs declare. A pack whose manifest
 *  is gone or unreadable (deleted in the diff) declares nothing. */
export function agentsDeclaredBy(dirs: Iterable<string>, readManifest: (dir: string) => unknown): Set<string> {
  const ids = new Set<string>();
  for (const dir of dirs) {
    let manifest: unknown;
    try { manifest = readManifest(dir); } catch { continue; }
    const agents = (manifest as { agents?: unknown } | null)?.agents;
    if (!Array.isArray(agents)) continue;
    for (const a of agents) {
      const id = (a as { agentId?: unknown } | null)?.agentId;
      if (typeof id === 'string' && id) ids.add(agentStorageId(id));
    }
  }
  return ids;
}

export interface ListedSuiteRow { ref: string; suite: { targetAgentId?: string } }

/** The suites to run: every listed suite whose target agent is one of `changedAgents`. */
export function selectChangedTargets(
  suites: readonly ListedSuiteRow[],
  changedAgents: ReadonlySet<string>,
): Array<{ suiteRef: string; agentId: string }> {
  return suites
    .filter((s) => typeof s.suite.targetAgentId === 'string' && changedAgents.has(agentStorageId(s.suite.targetAgentId)))
    .map((s) => ({ suiteRef: s.ref, agentId: s.suite.targetAgentId! }));
}

/** The regression half of the gate (EVD-3, CLI half). */
export interface GateSummary {
  passed: boolean;
  regression?: { verdict?: string } | undefined;
}

/**
 * Does a finished eval run clear the gate? With `--baseline`, a summary that
 * carries no regression block, or an `inconclusive` verdict because the baseline
 * could not be used (`run.metadata.eval.regressionReason === 'baseline_unavailable'`,
 * read from the progress route's `regressionReason`;
 * there is no `unavailable` wire verdict), FAILS: the caller asked for a
 * comparison and did not get one, and treating that as "not regressed" was how a
 * failed baseline silently passed the gate.
 */
export function gateOutcome(
  s: GateSummary,
  opts: { baselineRequested: boolean; regressionReason?: string | undefined },
): { ok: boolean; reason?: string } {
  if (!s.passed) return { ok: false, reason: 'the suite did not pass' };
  if (s.regression?.verdict === 'regressed') return { ok: false, reason: 'regressed against the baseline' };
  if (opts.baselineRequested) {
    if (!s.regression) return { ok: false, reason: 'a baseline was requested but the summary has no regression verdict' };
    if (s.regression.verdict === 'inconclusive' && opts.regressionReason === 'baseline_unavailable') {
      return { ok: false, reason: 'the baseline could not be used (baseline_unavailable), so there is no comparison' };
    }
  }
  return { ok: true };
}
