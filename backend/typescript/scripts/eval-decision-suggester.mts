#!/usr/bin/env -S node --import tsx
/**
 * ADR 0853 D3 merge gate — scores the decision suggester's REAL prompt and
 * verdict parser (imported from source) against a real quick-class model, over
 * the labelled set in `test/fixtures/decision-suggester-eval.json`. CI has no
 * provider key, so this runs by hand:
 *
 *   OPENWOP_EVAL_ANTHROPIC_KEY=sk-ant-… \
 *   [OPENWOP_EVAL_MODEL=claude-haiku-4-5-20251001] \
 *   node --import tsx scripts/eval-decision-suggester.mts
 *
 * Bar: precision >= 0.8 AND recall >= 0.5. Exit 0 = met; 1 = not met; 2 = skipped (no key).
 */
import { readFileSync } from 'node:fs';
import { fenceUntrustedBlock } from '../src/host/untrustedContent.js';
import { parseVerdict, SUGGESTER_PROMPT } from '../src/features/team-intent-ledger/decisionSuggester.js';
import { requestEvalText } from './eval-anthropic-http.mjs';

const KEY = process.env.OPENWOP_EVAL_ANTHROPIC_KEY;
const MODEL = process.env.OPENWOP_EVAL_MODEL ?? 'claude-haiku-4-5-20251001';
if (!KEY) { console.log('eval-decision-suggester: SKIPPED (set OPENWOP_EVAL_ANTHROPIC_KEY)'); process.exit(2); }

const { cases } = JSON.parse(readFileSync(new URL('../test/fixtures/decision-suggester-eval.json', import.meta.url), 'utf8')) as { cases: Array<{ text: string; decision: boolean }> };
let tp = 0, fp = 0, fn = 0, tn = 0;
for (const c of cases) {
  const text = await requestEvalText({ apiKey: KEY, model: MODEL, maxTokens: 200, system: SUGGESTER_PROMPT, user: fenceUntrustedBlock(c.text, 'a team chat message') });
  const said = parseVerdict(text)?.isDecision === true;
  if (said && c.decision) tp++; else if (said) fp++; else if (c.decision) fn++; else tn++;
  if (said !== c.decision) console.log(`  ${said ? 'FALSE POSITIVE' : 'MISSED'}: ${c.text}`);
}
const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
console.log(`eval-decision-suggester: ${MODEL} — precision ${precision.toFixed(2)}, recall ${recall.toFixed(2)} (tp ${tp}, fp ${fp}, fn ${fn}, tn ${tn})`);
const met = precision >= 0.8 && recall >= 0.5;
console.log(met ? 'BAR MET' : 'BAR NOT MET (precision >= 0.8 and recall >= 0.5)');
process.exit(met ? 0 : 1);
