#!/usr/bin/env python3
"""Run the actual frontend static scheduler with bounded child-process fixtures."""
from pathlib import Path
import json
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
source = (ROOT / 'scripts/ci.sh').read_text()
start = source.index('run_frontend_static() (')
end = source.index('\nbg_lane_start frontend-static run_frontend_static', start)
scheduler = source[start:end]

with tempfile.TemporaryDirectory(prefix='owp-fe-static-') as directory:
    root = Path(directory)
    (root / 'frontend/react').mkdir(parents=True)
    (root / 'bin').mkdir()
    npm = root / 'bin/npm'
    # The commands are fixtures; the scheduler, wait statuses and child-process
    # overlap are real. flock makes the start/end event order unambiguous.
    npm.write_text('''#!/usr/bin/env python3
from pathlib import Path
import fcntl, json, os, sys, time
path = Path(os.environ['EVENTS'])
name = sys.argv[2]
def event(kind):
    with path.open('a') as out:
        fcntl.flock(out, fcntl.LOCK_EX)
        out.write(json.dumps(dict(kind=kind, name=name, args=sys.argv[1:],
            envDir=os.environ.get('OPENWOP_VITE_ENV_DIR'))) + '\\n')
event('start')
if os.environ['MODE'] == 'parallel':
    deadline = time.monotonic() + 5
    while len([x for x in path.read_text().splitlines() if json.loads(x)['kind'] == 'start']) < 3:
        if time.monotonic() > deadline:
            event('barrier-timeout'); sys.exit(93)
        time.sleep(0.01)
else:
    time.sleep(0.15)
print('OUTPUT_' + name)
event('end')
sys.exit(17 if name == os.environ['FAIL_LANE'] else 0)
''')
    npm.chmod(0o755)
    for serial in (True, False):
        for failure in ('', 'lint', 'build', 'check:test-types'):
            events = root / 'events.jsonl'
            events.write_text('')
            scratch = root / 'scratch'
            scratch.mkdir(exist_ok=True)
            # Also exercise the adopter-only env path, including its cleanup.
            envdir = root / 'adopter-env'
            envdir.mkdir(exist_ok=True)
            script = ('set -euo pipefail\n'
                      'budget_env_dir() { echo "$TEST_ENV_DIR"; }\n' + scheduler +
                      '\nrun_frontend_static\n')
            result = subprocess.run(['bash', '-c', script], env={**os.environ,
                'ROOT': str(root), 'PATH': str(root / 'bin') + ':' + os.environ['PATH'],
                'TMPDIR': str(scratch), 'TEST_ENV_DIR': str(envdir),
                'STEWARD_LANE_MODE': 'adopter', 'EVENTS': str(events),
                'MODE': 'serial' if serial else 'parallel', 'FAIL_LANE': failure,
                'OPENWOP_CI_SERIAL_LANES': '1' if serial else '0'},
                text=True, capture_output=True, timeout=15)
            assert result.returncode == (17 if failure else 0), result.stdout + result.stderr
            records = [json.loads(line) for line in events.read_text().splitlines()]
            active = set()
            peak = 0
            for event in records:
                assert event['kind'] in ('start', 'end'), records
                name = event['name']
                if event['kind'] == 'start':
                    assert name not in active
                    active.add(name)
                    peak = max(peak, len(active))
                else:
                    active.remove(name)
            assert not active and len(records) == 6, records
            assert peak == (1 if serial else 3), (serial, peak, records)
            starts = [event for event in records if event['kind'] == 'start']
            assert {event['name'] for event in starts} == {'lint', 'build', 'check:test-types'}
            for event in starts:
                expected_args = ['run', event['name']]
                if event['name'] == 'lint':
                    expected_args += ['--', '--max-warnings=0']
                assert event['args'] == expected_args, event
                assert event['envDir'] == (str(envdir) if event['name'] == 'build' else None), event
                assert 'OUTPUT_' + event['name'] in result.stdout
            assert not envdir.exists() and not list(scratch.iterdir())
            print(f'frontend static: serial={serial} failure={failure or "none"} peak={peak} exit={result.returncode}')
