#!/usr/bin/env -S node --import tsx
/**
 * ADR 0855 D1 merge gate — runs the drift check's REAL prompt, ledger rendering,
 * parser and "explained" rule (imported from source) against a real Sonnet-class
 * model, over the seeded scenario in `test/fixtures/drift-check-eval.json`. CI has
 * no provider key, so this runs by hand:
 *
 *   OPENWOP_EVAL_ANTHROPIC_KEY=sk-ant-… \
 *   [OPENWOP_EVAL_MODEL=claude-sonnet-5-5] \
 *   node --import tsx scripts/eval-drift-check.mts [fixture]
 *
 * `fixture` defaults to the run scenario; ADR 0855 P5 (pull requests) is
 * `test/fixtures/drift-check-pr-eval.json`, whose cases carry `pullRequest`
 * {title, body, diff} composed exactly as the route composes it.
 *
 * Bar: >= 0.9 of `flag` cases flagged AND <= 0.1 of `pass` cases falsely flagged.
 * Exit 0 = met; 1 = not met; 2 = skipped (no key).
 */
import { readFileSync } from 'node:fs';
import { fenceUntrustedBlock } from '../src/host/untrustedContent.js';
import { DRIFT_PROMPT, ledgerText, parseFindings, unexplainedFindings } from '../src/features/team-intent-ledger/driftCheck.js';
import { pullRequestProduced, type PullRequestText } from '../src/features/team-intent-ledger/prDrift.js';
import { requestEvalText } from './eval-anthropic-http.mjs';

const KEY = process.env.OPENWOP_EVAL_ANTHROPIC_KEY;
const MODEL = process.env.OPENWOP_EVAL_MODEL ?? 'claude-sonnet-5-5';
if (!KEY) { console.log('eval-drift-check: SKIPPED (set OPENWOP_EVAL_ANTHROPIC_KEY)'); process.exit(2); }

interface Case { id: string; expect: 'flag' | 'pass'; ledger: { goal?: string; objectives?: string[]; inScope?: string[]; outOfScope?: string[]; openQuestions?: string[] }; decisions: string[]; produced?: string; pullRequest?: PullRequestText }
const FIXTURE = process.argv[2] ? new URL(`file://${process.argv[2].startsWith('/') ? '' : `${process.cwd()}/`}${process.argv[2]}`) : new URL('../test/fixtures/drift-check-eval.json', import.meta.url);
const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cases: Case[] };
let flagged = 0, flagCases = 0, falseFlags = 0, passCases = 0;
for (const c of cases) {
  const ledger = ledgerText('Eval project', { goal: c.ledger.goal ?? '', objectives: c.ledger.objectives ?? [], inScope: c.ledger.inScope ?? [], outOfScope: c.ledger.outOfScope ?? [], openQuestions: c.ledger.openQuestions ?? [] }, c.decisions);
  const text = await requestEvalText({ apiKey: KEY, model: MODEL, maxTokens: 600, system: DRIFT_PROMPT, user: `${fenceUntrustedBlock(ledger, 'the team ledger')}\n\n${fenceUntrustedBlock(c.pullRequest ? pullRequestProduced(c.pullRequest) : c.produced ?? '', 'the produced work')}` });
  const findings = parseFindings(text);
  const unexplained = findings ? unexplainedFindings(findings, c.decisions) : [];
  const said = unexplained.length > 0;
  if (c.expect === 'flag') { flagCases++; if (said) flagged++; else console.log(`  MISSED: ${c.id}`); }
  else { passCases++; if (said) { falseFlags++; console.log(`  FALSE FLAG: ${c.id} — ${unexplained.map((f) => f.claim).join(' | ')}`); } }
  if (!findings) console.log(`  UNPARSEABLE: ${c.id}`);
}
const recall = flagCases === 0 ? 0 : flagged / flagCases;
const falseRate = passCases === 0 ? 0 : falseFlags / passCases;
console.log(`eval-drift-check: ${MODEL} — flagged ${flagged}/${flagCases} (${recall.toFixed(2)}), false flags ${falseFlags}/${passCases} (${falseRate.toFixed(2)})`);
const met = recall >= 0.9 && falseRate <= 0.1;
console.log(met ? 'BAR MET' : 'BAR NOT MET (>= 0.9 flagged and <= 0.1 false flags)');
process.exit(met ? 0 : 1);
