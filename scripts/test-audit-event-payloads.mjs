#!/usr/bin/env node
/**
 * The event-payload ratchet's STALE check under a subset run (ADR 0702 × ADR 0880).
 *
 * MEASURED 2026-10-14, slot 71: a Tracegate enforce gate ran 603 of 2,566 backend
 * files. `runOrchestrator.decided` was sampled VALID by files that ran, while the
 * only file that still emits its admitted violation (`dispatch-iteration-counter
 * .test.ts`, a forward-compat `noop`) was reused, not run. The ratchet called the
 * admission stale and the train went red on a diff that touched none of it.
 *
 * Each case builds a sample directory and runs the real script on it:
 *   control — valid + violating samples: the admission is exercised → green;
 *   full    — valid only, --ratchet: STALE → exit 1 (a full run may judge it);
 *   subset  — valid only, --ratchet --no-stale: not judged → exit 0.
 * The control is what makes the other two mean something: if the "valid" sample
 * were not valid, `full` would not say STALE.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'audit-event-payloads.mjs');
const TYPE = 'runOrchestrator.decided';
// `origin` is the emitting file; the ratchet counts only host files (`src/…`), never
// `test/…` or the conformance seed seams, so the fixture names a host file.
const sample = (payload) => JSON.stringify({ type: TYPE, payload, wire: payload, origin: 'src/host/payloadStaleFixture.ts' });
const VALID = sample({ agentId: 'agent:tracegate-fixture', decision: { kind: 'terminate' } });
const NOOP = sample({ agentId: 'agent:tracegate-fixture', decision: { kind: 'noop' } });

function audit(lines, args) {
  const dir = mkdtempSync(join(tmpdir(), 'owp-payload-stale-test.'));
  try {
    writeFileSync(join(dir, 'samples-1.jsonl'), `${lines.join('\n')}\n`);
    const r = spawnSync('node', [SCRIPT, ...args], { env: { ...process.env, OPENWOP_PAYLOAD_AUDIT: dir }, encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('control: the admitted violation is exercised, so the ratchet is green', () => {
  const r = audit([VALID, NOOP], ['--ratchet']);
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /STALE/);
});

test('full run: a sampled admission with no violation is STALE and fails', () => {
  const r = audit([VALID], ['--ratchet']);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, new RegExp(`STALE admissions[\\s\\S]*${TYPE.replace('.', '\\.')}`));
});

test('subset run (--no-stale): the same samples are not judged and do not fail', () => {
  const r = audit([VALID], ['--ratchet', '--no-stale']);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /not judged \(subset run, --no-stale\)/);
  assert.doesNotMatch(r.out, /STALE admissions/);
});
