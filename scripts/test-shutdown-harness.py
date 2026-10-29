#!/usr/bin/env python3
"""Exercise the real shutdown harness against small, isolated backend processes."""
from pathlib import Path
import os
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def exercise(*, reject_listener=False):
    with tempfile.TemporaryDirectory(prefix='owp-shutdown-harness-') as directory:
        root = Path(directory)
        (root / 'scripts/lib').mkdir(parents=True)
        (root / 'backend/typescript/lib').mkdir(parents=True)
        scratch = root / 'scratch'
        scratch.mkdir()
        shutil.copy2(ROOT / 'scripts/test-shutdown.sh', root / 'scripts/test-shutdown.sh')
        helper = (ROOT / 'scripts/lib/gate-ports.sh').read_text()
        if reject_listener:
            # The helper's real foreign-PID behavior is covered by GATE-1. This
            # proves shutdown honors that refusal instead of testing the occupant.
            helper += '\ngate_assert_port_owned_by() { echo OWNERSHIP_REFUSED >&2; return 1; }\n'
        (root / 'scripts/lib/gate-ports.sh').write_text(helper)
        (root / 'backend/typescript/lib/index.js').write_text('''
const http = require('node:http');
const grace = Number(process.env.OPENWOP_SHUTDOWN_GRACE_MS);
if (grace === 8000) {
  console.error('FIRST_BOOT_CAUSE_SENTINEL');
  process.exit(17);
}
console.error('SECOND_BOOT_SENTINEL');
const server = http.createServer((_request, response) => response.end('ok'));
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  setTimeout(() => {
    console.error('shutdown: still alive after grace — forcing');
    process.exit(1);
  }, grace).unref();
});
// Bound the disposable fixture even if the harness loses its child.
setTimeout(() => process.exit(2), 20000).unref();
''')
        result = subprocess.run(['bash', str(root / 'scripts/test-shutdown.sh')],
                                env={**os.environ, 'TMPDIR': str(scratch)},
                                capture_output=True, text=True, timeout=35)
        output = result.stdout + result.stderr
        assert result.returncode != 0, output
        assert 'exited before listening (exit 17)' in output, output
        match = re.search(r'shutdown logs kept: ([^)\n]+)', output)
        assert match, output
        work = Path(match.group(1))
        assert work.parent == scratch, output
        first = (work / 'backend-8000.log').read_text()
        second = (work / 'backend-3000.log').read_text()
        assert 'FIRST_BOOT_CAUSE_SENTINEL' in first and 'SECOND_BOOT_SENTINEL' not in first
        assert 'SECOND_BOOT_SENTINEL' in second and 'FIRST_BOOT_CAUSE_SENTINEL' not in second
        if reject_listener:
            assert 'OWNERSHIP_REFUSED' in output and '0 passed, 2 failed' in output, output
            assert 'shutdown: still alive after grace' not in second, second
        else:
            assert '2 passed, 1 failed' in output, output
            assert 'shutdown: still alive after grace' in second, second


exercise()
exercise(reject_listener=True)
print('shutdown harness: retained both boot logs; exit 17 diagnosed; listener refusal honored')
