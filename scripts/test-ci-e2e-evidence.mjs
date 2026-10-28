import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Execute the actual two-pass shell block with a launcher seam. The seam models
// Playwright's documented output-directory cleanup, not application behavior.
const ci = readFileSync(path.join(root, 'scripts/ci.sh'), 'utf8');
const start = ci.indexOf('  e2e_rc=0\n');
const end = ci.indexOf('  # ONLY our own PID.', start);
assert.ok(start >= 0 && end > start, 'required/serial execution block exists');
const block = ci.slice(start, end);

for (const code of [0, 1, 130, 143]) {
  test(`required exit ${code}: artifacts survive and interruption is not followed by another pass`, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'owp-e2e-evidence-'));
    try {
      mkdirSync(path.join(dir, 'frontend/react'), { recursive: true });
      mkdirSync(path.join(dir, 'bin'));
      writeFileSync(path.join(dir, 'bin/npm'), `#!/usr/bin/env node
const fs=require('node:fs'), p=require('node:path');
const args=process.argv.slice(2), serial=args.includes('test:e2e:serial');
const output=args.find(x=>x.startsWith('--output='))?.slice(9) ?? 'test-results';
fs.rmSync(output,{recursive:true,force:true}); fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(p.join(output,serial?'advisory.txt':'required.txt'),'witness');
fs.appendFileSync(process.env.CALLS,(serial?'advisory':'required')+'\\n');
process.exit(serial?0:Number(process.env.REQUIRED_EXIT));
`, { mode: 0o755 });
      const result = spawnSync('bash', ['-c', `${block}\nexit "$e2e_rc"\n`], {
        env: { ...process.env, ROOT: dir, E2E_PORT_FE: '5100', E2E_PORT_BE: '8100',
          PATH: `${dir}/bin:${process.env.PATH}`, REQUIRED_EXIT: String(code), CALLS: path.join(dir, 'calls') },
        encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.status, code, result.stderr);
      assert.equal(readFileSync(path.join(dir, 'calls'), 'utf8'),
        code === 130 || code === 143 ? 'required\n' : 'required\nadvisory\n');
      assert.ok(existsSync(path.join(dir, 'frontend/react/test-results/required/required.txt')),
        'the advisory pass must not erase required failure evidence');
      if (code < 2) assert.ok(existsSync(path.join(dir, 'frontend/react/test-results/advisory/advisory.txt')));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
