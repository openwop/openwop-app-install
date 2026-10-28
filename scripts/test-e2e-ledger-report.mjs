import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./e2e-ledger-report.mjs', import.meta.url));

function report(outcomes) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-ledger-report-test-'));
  try {
    const ledger = join(dir, 'ledger');
    writeFileSync(ledger, outcomes.map((outcome) => `2026-10-27T00:00:00Z\ttest-head\t${outcome}\n`).join(''));
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, OPENWOP_CI_E2E_LEDGER: ledger },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('required successes remain visible when the advisory pass fails', () => {
  const output = report(['ran:pass;serial=pass', 'ran:pass;serial=FAIL', 'ran:fail', 'skipped:disabled']);
  assert.match(output, /RAN\s+3\s+\(2 required pass, 1 required fail, 0 unknown\)/);
  assert.match(output, /ADVISORY 1 pass, 1 fail, 1 not recorded/);
  assert.match(output, /SKIPPED 1/);
  assert.match(output, /run rate 75%/);
});

test('legacy successes do not invent a successful advisory result', () => {
  const output = report(['ran:pass', 'ran:fail']);
  assert.match(output, /RAN\s+2\s+\(1 required pass, 1 required fail, 0 unknown\)/);
  assert.match(output, /ADVISORY 0 pass, 0 fail, 2 not recorded/);
});

test('an unfamiliar recorded result is never counted as passing', () => {
  const output = report(['ran:unknown;serial=unmeasured']);
  assert.match(output, /RAN\s+1\s+\(0 required pass, 0 required fail, 1 unknown\)/);
  assert.match(output, /ADVISORY 0 pass, 0 fail, 1 not recorded/);
});
