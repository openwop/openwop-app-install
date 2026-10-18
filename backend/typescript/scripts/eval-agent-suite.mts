#!/usr/bin/env -S node --import tsx
/**
 * ADR 0889 D10 — run a stored agent eval suite against a RUNNING host and gate on it.
 *
 *   OPENWOP_EVAL_BASE_URL=https://app.openwop.dev/api \
 *   OPENWOP_EVAL_TOKEN=<bearer> \
 *   node --import tsx scripts/eval-agent-suite.mts \
 *     --suite core.acme.evals.support@1.2.0 --agent acme.support-resolver \
 *     [--baseline <evalRunId>] [--provider anthropic --model claude-sonnet-5-5] [--json]
 *
 *   --changed <git-ref>   instead of --suite/--agent: run every stored suite whose
 *                         target agent's pack/prompt changed since <git-ref>
 *                         (a "run evals when the prompt or model changes" hook).
 *
 * Repeated trials, the pass rule, thresholds and the regression method are the
 * SUITE's (RFC 0244 §B/§F), so the gate is the same one the Evals tab shows.
 * Exit 0 = passed (and not regressed); 1 = failed, regressed, or (with --baseline)
 * no usable comparison (EVD-3); 2 = skipped
 * (no base URL / token) — the same contract as the other eval-* scripts.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentsDeclaredBy, changedPackDirs, gateOutcome, selectChangedTargets, type ListedSuiteRow } from './eval-agent-suite-targets.mjs';

interface Summary {
  suiteId: string; suiteVersion: string; aggregateScore: number; passed: boolean;
  taskCount: number; passedCount: number; totalCostUsd?: number;
  tasks: Array<{ taskId: string; score: number; passed: boolean; latencyMs?: number; costUsd?: number; trials?: { n: number; passedCount: number; passAtK: number; passHatK: number } }>;
  trialStats?: { k: number; passAtK: number; passHatK: number; scoreStderr?: number };
  regression?: { scoreDelta: number; verdict?: string; method?: string; pairedTaskCount?: number };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BASE = process.env.OPENWOP_EVAL_BASE_URL?.replace(/\/$/, '');
const TOKEN = process.env.OPENWOP_EVAL_TOKEN;
if (!BASE || !TOKEN) {
  console.error('eval-agent-suite: skipped — set OPENWOP_EVAL_BASE_URL and OPENWOP_EVAL_TOKEN.');
  process.exit(2);
}
const HEADERS = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = { raw: text.slice(0, 300) }; }
  return { status: res.status, json };
}

async function runOne(suiteRef: string, agentId: string): Promise<boolean> {
  const configurable: Record<string, unknown> = {};
  const baseline = arg('baseline');
  if (baseline) configurable.baselineRunId = baseline;
  const provider = arg('provider'); const model = arg('model');
  if (provider || model) configurable.ai = { ...(provider ? { provider } : {}), ...(model ? { model } : {}) };
  const created = await call('POST', '/runs', { mode: 'eval', evalSuiteRef: suiteRef, agentId, configurable });
  if (created.status !== 201) {
    console.error(`eval-agent-suite: ${suiteRef} → create answered ${created.status}: ${JSON.stringify(created.json)}`);
    return false;
  }
  const runId = String(created.json.runId);
  const started = Date.now();
  let status = 'pending';
  while (!['completed', 'failed', 'cancelled'].includes(status)) {
    if (Date.now() - started > 30 * 60_000) { console.error(`eval-agent-suite: ${runId} did not finish in 30 min`); return false; }
    await new Promise((r) => setTimeout(r, 2000));
    status = String((await call('GET', `/runs/${encodeURIComponent(runId)}`)).json.status ?? 'pending');
  }
  if (status !== 'completed') {
    const run = await call('GET', `/runs/${encodeURIComponent(runId)}`);
    console.error(`eval-agent-suite: ${runId} ended ${status}: ${JSON.stringify(run.json.error ?? {})}`);
    return false;
  }
  const s = (await call('GET', `/runs/${encodeURIComponent(runId)}/eval-summary`)).json as unknown as Summary;
  if (process.argv.includes('--json')) { console.log(JSON.stringify({ runId, summary: s })); }
  else {
    console.log(`\n${s.suiteId}@${s.suiteVersion} on ${agentId} — run ${runId}`);
    console.log(`  ${s.passed ? 'PASSED' : 'FAILED'}  score ${s.aggregateScore.toFixed(3)}${s.trialStats?.scoreStderr !== undefined ? ` ± ${s.trialStats.scoreStderr.toFixed(3)}` : ''}  tasks ${s.passedCount}/${s.taskCount}  cost $${(s.totalCostUsd ?? 0).toFixed(4)}`);
    if (s.trialStats) console.log(`  pass@${s.trialStats.k} ${s.trialStats.passAtK.toFixed(3)}  pass^${s.trialStats.k} ${s.trialStats.passHatK.toFixed(3)}`);
    if (s.regression) console.log(`  vs baseline: Δ ${s.regression.scoreDelta >= 0 ? '+' : ''}${s.regression.scoreDelta.toFixed(3)}  ${s.regression.verdict ?? ''} (${s.regression.method ?? ''}, ${s.regression.pairedTaskCount ?? '?'} paired)`);
    for (const t of s.tasks) {
      const trials = t.trials ? ` ${t.trials.passedCount}/${t.trials.n} trials` : '';
      console.log(`    ${t.passed ? '✓' : '✗'} ${t.taskId}  ${t.score.toFixed(3)}${trials}  ${t.latencyMs ?? 0}ms`);
    }
  }
  // EVD-3: why a baseline comparison did not happen lives on the run's eval
  // metadata, served ONLY as the progress read's `regressionReason` (the wire
  // regression block is closed, so it never carries a reason). Absent ⇒ undefined.
  const progress = baseline ? (await call('GET', `/host/openwop-app/agent-evals/runs/${encodeURIComponent(runId)}/progress`)).json : {};
  const regressionReason = typeof progress.regressionReason === 'string' ? progress.regressionReason : undefined;
  const gate = gateOutcome(s, { baselineRequested: !!baseline, regressionReason });
  if (!gate.ok) console.error(`eval-agent-suite: ${suiteRef} on ${agentId} FAILED the gate: ${gate.reason}`);
  return gate.ok;
}

async function changedTargets(ref: string): Promise<Array<{ suiteRef: string; agentId: string }>> {
  // Files changed since <ref> under packs/ (repo-root-relative); an agent is
  // "changed" when the pack that declares it is (NP-EVAL-2 — see the helper).
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const changed = execFileSync('git', ['-C', root, 'diff', '--name-only', `${ref}...HEAD`, '--', 'packs'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const agents = agentsDeclaredBy(changedPackDirs(changed), (dir) => JSON.parse(readFileSync(join(root, 'packs', dir, 'pack.json'), 'utf8')));
  if (agents.size === 0) return [];
  const suites = (await call('GET', '/host/openwop-app/agent-evals/suites')).json.items as ListedSuiteRow[] | undefined;
  return selectChangedTargets(suites ?? [], agents);
}

const changedRef = arg('changed');
const targets = changedRef
  ? await changedTargets(changedRef)
  : [{ suiteRef: arg('suite') ?? '', agentId: arg('agent') ?? '' }];
if (targets.length === 0) { console.log('eval-agent-suite: no suite targets a changed agent.'); process.exit(0); }
if (targets.some((t) => !t.suiteRef || !t.agentId)) { console.error('usage: --suite <ref> --agent <id> | --changed <git-ref>'); process.exit(2); }
let ok = true;
for (const t of targets) ok = (await runOne(t.suiteRef, t.agentId)) && ok;
process.exit(ok ? 0 : 1);
