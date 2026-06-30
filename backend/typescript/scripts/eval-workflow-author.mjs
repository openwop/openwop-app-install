#!/usr/bin/env node
/**
 * Eval harness for the AI Workflow Author (ADR 0072) — measures authoring
 * QUALITY against a real model, the one thing unit tests can't (CI has no
 * provider key). Runs a battery of natural-language intents through the live
 * pipeline and scores each authored workflow:
 *   - registered?            (the run produced a persisted workflow)
 *   - closed-world?          (every node typeId is in this host's catalog)
 *   - structurally sane?     (>=1 node; every edge references declared nodes)
 *
 * Talks to a RUNNING app over HTTP (no in-process boot), so point it at a local
 * dev server or the deployed demo. The app MUST have the `workflow-author`
 * toggle ON and an AI provider configured (managed key or the caller's BYOK).
 *
 * Usage:
 *   OPENWOP_EVAL_BASE_URL=http://localhost:8080 \
 *   [OPENWOP_EVAL_BEARER=<token>] \
 *   [OPENWOP_EVAL_MIN_PASS=0.8] \
 *   node scripts/eval-workflow-author.mjs
 *
 * Exit: 0 = pass-rate >= threshold (or skipped — no base URL); 1 = below / error.
 */

const BASE = process.env.OPENWOP_EVAL_BASE_URL;
const BEARER = process.env.OPENWOP_EVAL_BEARER;
const MIN_PASS = Number(process.env.OPENWOP_EVAL_MIN_PASS ?? '0.8');
const RUN_TIMEOUT_MS = Number(process.env.OPENWOP_EVAL_RUN_TIMEOUT_MS ?? '120000');

const INTENTS = [
  'When a new high-value lead arrives, summarize it and notify the deal owner.',
  'Extract the key fields from an uploaded invoice and flag anything over $10,000 for approval.',
  'Classify an inbound support ticket by topic and severity, then draft a first response.',
  'Summarize a long document into three bullet points.',
  'Review a piece of marketing content for brand compliance, then hold it for human approval before publishing.',
  'Take a meeting transcript and produce action items with owners.',
];

if (!BASE) {
  console.log('⊘ eval-workflow-author: skipped — set OPENWOP_EVAL_BASE_URL to a running app');
  console.log('  (the app must have the `workflow-author` toggle ON and an AI provider configured)');
  process.exit(0);
}

const headers = { 'content-type': 'application/json', ...(BEARER ? { authorization: `Bearer ${BEARER}` } : {}) };
const url = (p) => `${BASE.replace(/\/+$/, '')}${p}`;

async function getJson(p) {
  const r = await fetch(url(p), { headers });
  if (!r.ok) throw new Error(`GET ${p} → ${r.status}`);
  return r.json();
}

async function legalTypeIds() {
  const body = await getJson('/v1/host/openwop-app/node-catalog');
  return new Set((body.nodes ?? []).map((n) => n.typeId));
}

async function listWorkflowIds() {
  const body = await getJson('/v1/host/openwop-app/workflows');
  return new Set((body.workflows ?? []).map((w) => w.workflowId));
}

async function draft(intent) {
  const r = await fetch(url('/v1/host/openwop-app/workflow-author/draft'), {
    method: 'POST', headers, body: JSON.stringify({ intent }),
  });
  if (r.status === 404) throw new Error('feature not enabled (turn the `workflow-author` toggle ON for this caller)');
  if (!r.ok) throw new Error(`draft → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function waitForRun(runId) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  // Date.now polling loop is fine in a CLI script (not a workflow script).
  while (Date.now() < deadline) {
    const run = await getJson(`/v1/runs/${runId}`);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return run;
    await new Promise((res) => setTimeout(res, 1500));
  }
  return { status: 'timeout' };
}

function scoreDefinition(def, legal) {
  const issues = [];
  const nodes = Array.isArray(def?.nodes) ? def.nodes : [];
  if (nodes.length === 0) issues.push('no nodes');
  const ids = new Set(nodes.map((n) => n.nodeId));
  for (const n of nodes) {
    if (!legal.has(n.typeId)) issues.push(`out-of-catalog typeId: ${n.typeId}`);
  }
  for (const e of def?.edges ?? []) {
    if (!ids.has(e.sourceNodeId) || !ids.has(e.targetNodeId)) issues.push(`dangling edge: ${e.edgeId}`);
  }
  return issues;
}

async function main() {
  console.log(`▶ eval-workflow-author against ${BASE} (${INTENTS.length} intents, min pass ${MIN_PASS})\n`);
  const legal = await legalTypeIds();
  const rows = [];
  for (const intent of INTENTS) {
    const before = await listWorkflowIds();
    let row = { intent: intent.slice(0, 48), ok: false, detail: '' };
    try {
      const { runId } = await draft(intent);
      const run = await waitForRun(runId);
      if (run.status !== 'completed') { row.detail = `run ${run.status}`; rows.push(row); continue; }
      const after = await listWorkflowIds();
      const authored = [...after].filter((id) => !before.has(id));
      if (authored.length === 0) { row.detail = 'no workflow registered'; rows.push(row); continue; }
      const def = await getJson(`/v1/workflows/${encodeURIComponent(authored[0])}`);
      const issues = scoreDefinition(def, legal);
      row.ok = issues.length === 0;
      row.detail = row.ok ? `${(def.nodes ?? []).length} nodes, closed-world ✓` : issues.join('; ');
    } catch (err) {
      row.detail = err instanceof Error ? err.message : String(err);
    }
    rows.push(row);
  }

  console.log('Intent'.padEnd(50), 'Result');
  console.log('-'.repeat(72));
  for (const r of rows) console.log(r.intent.padEnd(50), r.ok ? 'PASS' : 'FAIL', r.detail ? `— ${r.detail}` : '');
  const passed = rows.filter((r) => r.ok).length;
  const rate = passed / rows.length;
  console.log(`\n${passed}/${rows.length} passed (${(rate * 100).toFixed(0)}%) · threshold ${(MIN_PASS * 100).toFixed(0)}%`);
  process.exit(rate >= MIN_PASS ? 0 : 1);
}

main().catch((err) => { console.error('eval failed:', err.message); process.exit(1); });
