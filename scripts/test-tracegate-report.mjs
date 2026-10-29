// ADR 0880: interrupted/partial results cannot become complete observations.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const tool = fileURLToPath(new URL('./tracegate.mjs', import.meta.url));
const A = 'backend/typescript/test/a.test.ts';
const B = 'backend/typescript/test/b.test.ts';
function fixture(t, mode = 'enforce', decisions = { [A]: { run: true }, [B]: { run: true } }) {
  const root = mkdtempSync(join(tmpdir(), 'tracegate-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), ledger = join(root, 'ledger'), run = join(root, 'run');
  for (const path of [repo, ledger, run]) mkdirSync(path);
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(run, 'predict.json'), JSON.stringify({ mode, head: 'a'.repeat(40), decisions }));
  return {
    ledger, run,
    results(rows) {
      writeFileSync(join(run, 'results.json'), JSON.stringify({ testResults: rows.map(([file, status]) => ({
        name: join(repo, file), status, startTime: 0, endTime: 10, assertionResults: [],
      })) }));
    },
    report() {
      const result = spawnSync(process.execPath, [tool, 'report', '--lane', 'backend', '--run', run], {
        encoding: 'utf8', env: { ...process.env, OPENWOP_TRACEGATE_ROOT: repo,
          OPENWOP_TRACEGATE_LEDGER: ledger, OPENWOP_TRACEGATE_HOST: 'report-fixture' },
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    },
    coverage() { return JSON.parse(readFileSync(join(run, 'coverage.json'), 'utf8')); },
    observations() {
      return readdirSync(ledger).filter(name => name.startsWith('shadow-')).flatMap(name =>
        readFileSync(join(ledger, name), 'utf8').trim().split('\n').slice(1));
    },
  };
}

for (const broken of ['missing', 'malformed']) test(`${broken} results do not claim execution or add an observation`, t => {
  const f = fixture(t);
  if (broken === 'malformed') writeFileSync(join(f.run, 'results.json'), '{');
  const output = f.report();
  assert.deepEqual(f.observations(), []);
  assert.match(output, /incomplete.*0 of 2.*no.*observation/i);
  assert.doesNotMatch(output, /ran 2|0 misses\./);
});

test('one completed file cannot stand in for a missing required file', t => {
  const f = fixture(t); f.results([[A, 'passed']]);
  assert.match(f.report(), /incomplete.*1 of 2/i);
  assert.deepEqual(f.observations(), []);
});

test('a missing audit makes an enforce observation incomplete', t => {
  const f = fixture(t, 'enforce', { [A]: { run: true }, [B]: { run: false, audit: true } });
  f.results([[A, 'passed']]);
  assert.match(f.report(), /incomplete.*1 of 2/i);
  assert.deepEqual(f.observations(), []);
});

test('shadow mode needs results even for predicted reusable non-audits', t => {
  const f = fixture(t, 'shadow', { [A]: { run: true }, [B]: { run: false } });
  f.results([[A, 'passed']]);
  assert.match(f.report(), /incomplete.*1 of 2/i);
  assert.deepEqual(f.observations(), []);
});

test('an unrelated result cannot replace a missing selected file', t => {
  const f = fixture(t); f.results([[A, 'passed'], ['backend/typescript/test/other.test.ts', 'passed']]);
  assert.match(f.report(), /incomplete.*1 of 2/i);
  assert.deepEqual(f.observations(), []);
});

test('a nonterminal result is not an observed verdict', t => {
  const f = fixture(t); f.results([[A, 'passed'], [B, 'running']]);
  assert.match(f.report(), /incomplete.*1 of 2/i);
  assert.deepEqual(f.observations(), []);
});

test('a completed enforce selection records a real observation without demanding reused files', t => {
  const f = fixture(t, 'enforce', { [A]: { run: true }, [B]: { run: false } });
  f.results([[A, 'passed']]);
  assert.match(f.report(), /ran 1 files that needed it/);
  assert.equal(f.observations().length, 1);
});

test('a complete shadow run records its observed prediction result', t => {
  const f = fixture(t, 'shadow', { [A]: { run: true }, [B]: { run: false } });
  f.results([[A, 'passed'], [B, 'passed']]);
  assert.match(f.report(), /0 misses\./);
  assert.equal(f.observations().length, 1);
});

test('a wholly reused lane is not a new observation', t => {
  const f = fixture(t, 'enforce', { [A]: { run: false } });
  assert.match(f.report(), /no tests selected.*no.*observation/i);
  assert.deepEqual(f.observations(), []);
});

test('an incomplete run still reports a witnessed failed audit as a miss', t => {
  const f = fixture(t, 'enforce', { [A]: { run: true }, [B]: { run: false, audit: true, reason: 'green before' } });
  f.results([[B, 'failed']]);
  const output = f.report();
  assert.match(output, /incomplete.*1 of 2/i);
  assert.match(output, /1 MISS\(ES\)/);
  assert.equal(readFileSync(join(f.run, 'misses.txt'), 'utf8').trim(), B);
  assert(readdirSync(f.ledger).some(name => name.startsWith('misses-')));
  assert.deepEqual(f.observations(), []);
});

// Enforce is a scheduling choice, not proof that fewer than all files ran.
for (const mode of ['enforce', 'shadow']) test(`${mode} full passing results license the stale-entry check`, t => {
  const f = fixture(t, mode); f.results([[A, 'passed'], [B, 'passed']]); f.report();
  assert.deepEqual(f.coverage(), { version: 1, total: 2, expected: 2, observed: 2, allFilesPassed: true });
});
for (const state of ['missing', 'failed', 'running']) test(`${state} file never licenses the stale-entry check`, t => {
  const f = fixture(t); f.results([[A, 'passed'], ...(state === 'missing' ? [] : [[B, state]])]); f.report();
  assert.equal(f.coverage().allFilesPassed, false);
});
test('reused unobserved files cannot license the stale-entry check', t => {
  const f = fixture(t, 'enforce', { [A]: { run: true }, [B]: { run: false } });
  f.results([[A, 'passed']]); f.report(); assert.equal(f.coverage().allFilesPassed, false);
});
test('an audited reusable file counts when the entire lane actually passes', t => {
  const f = fixture(t, 'enforce', { [A]: { run: true }, [B]: { run: false, audit: true } });
  f.results([[A, 'passed'], [B, 'passed']]); f.report(); assert.equal(f.coverage().allFilesPassed, true);
});
test('empty coverage never licenses the stale-entry check', t => {
  const f = fixture(t, 'enforce', {}); f.results([]); f.report(); assert.equal(f.coverage().allFilesPassed, false);
});

function staleGate(t, mode, complete, audit) {
  const root = mkdtempSync(join(tmpdir(), 'tracegate-stale-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'frontend/react'), { recursive: true });
  writeFileSync(join(root, 'scripts/check-live-fetch-stale.mjs'),
    readFileSync(new URL('./check-live-fetch-stale.mjs', import.meta.url)));
  writeFileSync(join(root, 'frontend/react/test-live-fetch-allowlist.txt'), 'source/a.test.ts\n');
  const auditPath = join(root, 'audit'); writeFileSync(auditPath, audit);
  const ci = readFileSync(new URL('./ci.sh', import.meta.url), 'utf8');
  const start = ci.indexOf('step "frontend: live-fetch allowlist has no STALE entries');
  const endText = 'rm -f "$LIVE_FETCH_AUDIT"';
  const end = ci.indexOf(endText, start);
  assert(start > 0 && end > start, 'actual CI stale-check block is present');
  return spawnSync('/bin/bash', ['-eu', '-c', 'step() { :; }\n' + ci.slice(start, end + endText.length)], {
    encoding: 'utf8', env: { ...process.env, ROOT: root, FE_TG_MODE: mode,
      FE_ALL_FILES_PASSED: complete, LIVE_FETCH_AUDIT: auditPath },
  });
}

test('enforce full coverage runs the actual stale checker and refuses a stale entry', t => {
  const result = staleGate(t, 'enforce', '1', 'source/b.test.ts\n');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /source\/a\.test\.ts/);
});
test('enforce full coverage accepts an actually witnessed entry', t => {
  const result = staleGate(t, 'enforce', '1', 'source/a.test.ts\n');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /witnessed making a live call/);
});
test('a partial enforce run cannot declare an unobserved entry stale', t => {
  const result = staleGate(t, 'enforce', '0', 'source/b.test.ts\n');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no complete passing frontend coverage/);
});
for (const mode of ['shadow', 'off']) test(`${mode} keeps its existing stale-entry assertion`, t => {
  const result = staleGate(t, mode, '0', 'source/b.test.ts\n');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /source\/a\.test\.ts/);
});
