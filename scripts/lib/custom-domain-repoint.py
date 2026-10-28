#!/usr/bin/env python3
"""ADR 0940: fingerprint-conditional edge handoff with an owned rollback receipt."""
import argparse
import copy
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from uuid import UUID, uuid4
import tempfile


class Refused(RuntimeError):
    pass


def save_text(path, value):
    temporary = path.with_name(path.name + '.' + str(uuid4()) + '.tmp')
    with temporary.open('x') as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def save(path, value):
    save_text(path, json.dumps(value, indent=2, sort_keys=True) + '\n')


def saved_request(path, body):
    # Publish one fully written immutable record. Concurrent resumes must all
    # use the winner's id/body, even if its response was lost. A replacement
    # would destroy the only id capable of recovering an accepted request.
    temporary = path.with_name(path.name + '.' + str(uuid4()) + '.candidate')
    save(temporary, {'requestId': str(uuid4()), 'body': body})
    try:
        try:
            os.link(temporary, path)
        except FileExistsError:
            pass
    finally:
        temporary.unlink()
    record = json.loads(path.read_text())
    if record.get('body') != body or not UUID(record.get('requestId', '')).int:
        raise Refused('saved request does not match the captured handoff')
    return record['requestId']


def resource(value, path):
    parsed = urlparse(value)
    return parsed.scheme == 'https' and parsed.hostname in ('www.googleapis.com', 'compute.googleapis.com') and parsed.path == '/compute/v1/' + path and not parsed.query and not parsed.fragment


def configuration(row):
    # Output-only identity fields change after a write; compare EVERY remaining
    # field, so an intervening route/host-rule edit cannot earn our receipt.
    return {key: value for key, value in row.items() if key not in ('id', 'kind', 'creationTimestamp', 'selfLink', 'fingerprint')}


class Cloud:
    def __init__(self, project, account):
        self.project, self.account = project, account
        self.token = None

    def gc(self, *args, optional=False):
        result = subprocess.run(['gcloud', *args, '--project', self.project, '--account', self.account, '--quiet', '--format=json'], capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=180)
        if result.returncode:
            if optional:
                return None
            raise Refused('gcloud operation failed; URL-map ownership has not been assumed')
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def api(self, method, path, body=None):
        if self.token is None:
            try:
                self.token = subprocess.check_output(['gcloud', 'auth', 'print-access-token', '--account', self.account, '--project', self.project], text=True, stdin=subprocess.DEVNULL, timeout=30).strip()
            except subprocess.CalledProcessError:
                raise Refused('cannot authenticate the pinned account; no request sent') from None
            if not re.fullmatch(r'[A-Za-z0-9._~+/-]+=*', self.token):
                raise Refused('authentication returned an invalid token; no request sent')
        request = Request('https://compute.googleapis.com/compute/v1/' + path,
                          data=None if body is None else json.dumps(body).encode(), method=method,
                          headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code >= 500 or error.code == 408:
                raise URLError('Compute outcome ambiguous (HTTP ' + str(error.code) + ')') from None
            # Never echo authorization headers, tokens or an untrusted response.
            raise Refused('Compute request refused (HTTP ' + str(error.code) + '); captured fingerprint was not refreshed') from None

    def map(self, name):
        return self.gc('compute', 'url-maps', 'describe', name, '--global')

    def patch(self, name, directory, prefix, fingerprint, target):
        body = {'fingerprint': fingerprint, 'defaultService': target}
        request_id = saved_request(directory / (prefix + '-request.json'), body)
        path = f'projects/{self.project}/global/urlMaps/{name}?' + urlencode({'requestId': request_id})
        # An ambiguous transport outcome is retried ONLY with the persisted
        # identical id/body. Never re-read/rebase a fingerprint to force a write.
        operation = None
        for attempt in range(2):
            try:
                operation = self.api('PATCH', path, body)
                break
            except (URLError, TimeoutError, OSError, json.JSONDecodeError):
                if attempt:
                    raise Refused('PATCH outcome unknown; retain this directory and resume the identical saved request') from None
        save(directory / (prefix + '-operation.json'), operation)
        if not isinstance(operation, dict) or not isinstance(operation.get('name'), str) or not re.fullmatch(r'[A-Za-z0-9_-]+', operation['name']):
            raise Refused('Compute did not return a valid operation; no successful handoff claimed')
        for _ in range(90):
            if operation.get('error'):
                raise Refused('Compute operation failed; no successful handoff or owned rollback claimed')
            if operation.get('status') == 'DONE':
                return
            time.sleep(2)
            operation = self.api('GET', f'projects/{self.project}/global/operations/' + operation['name'])
            save(directory / (prefix + '-operation.json'), operation)
        raise Refused('Compute operation is still pending; retain recovery data and reconcile before retrying')


def validate_backend(backend, path):
    if not resource(backend.get('selfLink', ''), path) or backend.get('loadBalancingScheme') != 'EXTERNAL_MANAGED' or backend.get('protocol') != 'HTTP':
        raise Refused('existing backend has the wrong project/scope/load-balancing scheme/protocol')


def target_resources(cloud, service, region, prefix, apply):
    neg, backend = prefix + '-neg-' + service, prefix + '-be-' + service
    neg_path = f'projects/{cloud.project}/regions/{region}/networkEndpointGroups/{neg}'
    backend_path = f'projects/{cloud.project}/global/backendServices/{backend}'
    n = cloud.gc('compute', 'network-endpoint-groups', 'describe', neg, '--region', region, optional=True)
    if n is None and apply:
        cloud.gc('compute', 'network-endpoint-groups', 'create', neg, '--region', region, '--network-endpoint-type=serverless', '--cloud-run-service', service)
        n = cloud.gc('compute', 'network-endpoint-groups', 'describe', neg, '--region', region)
    if n is not None:
        run = n.get('cloudRun', {})
        if not resource(n.get('selfLink', ''), neg_path) or n.get('networkEndpointType') != 'SERVERLESS' or run.get('service') != service or run.get('tag') or run.get('urlMask'):
            raise Refused('existing NEG has the wrong project/region/type/Cloud Run target')
    b = cloud.gc('compute', 'backend-services', 'describe', backend, '--global', optional=True)
    if b is None and apply:
        cloud.gc('compute', 'backend-services', 'create', backend, '--global', '--load-balancing-scheme=EXTERNAL_MANAGED', '--protocol=HTTP')
        b = cloud.gc('compute', 'backend-services', 'describe', backend, '--global')
    if b is not None:
        validate_backend(b, backend_path)
        groups = b.get('backends', [])
        if not groups and apply:
            cloud.gc('compute', 'backend-services', 'add-backend', backend, '--global', '--network-endpoint-group', neg, '--network-endpoint-group-region', region)
            b = cloud.gc('compute', 'backend-services', 'describe', backend, '--global')
            validate_backend(b, backend_path)
            groups = b.get('backends', [])
        if groups and (len(groups) != 1 or not resource(groups[0].get('group', ''), neg_path)):
            raise Refused('existing backend does not contain exactly the intended project/region NEG')
        if apply and not groups:
            raise Refused('backend is still unwired after attachment')
    return n is not None and b is not None and bool(b.get('backends')), 'https://www.googleapis.com/compute/v1/' + backend_path


def rollback(directory):
    receipt = json.loads((directory / 'rollback-receipt.json').read_text())
    if os.environ.get('OPENWOP_EDGE_APPLY_PROJECT') != receipt['project']:
        raise Refused('rollback requires OPENWOP_EDGE_APPLY_PROJECT=' + receipt['project'])
    cloud = Cloud(receipt['project'], receipt['account'])
    current = cloud.map(receipt['map'])
    before = json.loads((directory / 'urlmap.json').read_text())
    if str(current.get('id')) == receipt['resourceId'] and configuration(current) == configuration(before):
        print('Previous configuration is already present; no rollback write made.')
        return
    saved_request = (directory / 'rollback-request.json').exists()
    if str(current.get('id')) != receipt['resourceId'] or (not saved_request and (current.get('fingerprint') != receipt['fingerprint'] or current.get('defaultService') != receipt['target'])):
        raise Refused('URL map changed since this handoff; rollback refuses to overwrite it')
    cloud.patch(receipt['map'], directory, 'rollback', receipt['fingerprint'], receipt['previous'])
    after = cloud.map(receipt['map'])
    before = json.loads((directory / 'urlmap.json').read_text())
    if str(after.get('id')) != receipt['resourceId'] or configuration(after) != configuration(before):
        raise Refused('rollback finished but read-back differs; retain recovery data and reconcile')
    print('Rollback verified; only the owned default-service change was restored.')


def apply_saved(directory):
    plan = json.loads((directory / 'handoff.json').read_text())
    if os.environ.get('OPENWOP_EDGE_APPLY_PROJECT') != plan['project']:
        raise Refused('apply/resume requires OPENWOP_EDGE_APPLY_PROJECT=' + plan['project'])
    before = json.loads((directory / 'urlmap.json').read_text())
    if str(before.get('id')) != plan['resourceId']:
        raise Refused('saved snapshot identity does not match its handoff context')
    cloud = Cloud(plan['project'], plan['account'])
    current = cloud.map(plan['map'])
    if str(current.get('id')) != plan['resourceId']:
        raise Refused('URL-map resource was replaced; captured handoff cannot be applied')
    target_resources(cloud, plan['service'], plan['region'], plan['prefix'], True)
    cloud.patch(plan['map'], directory, 'apply', before['fingerprint'], plan['target'])
    after = cloud.map(plan['map'])
    expected = copy.deepcopy(before)
    expected['defaultService'] = plan['target']
    if str(after.get('id')) != str(before['id']) or not after.get('fingerprint') or configuration(after) != configuration(expected):
        raise Refused('post-apply URL map is not exactly our expected change; no owned rollback receipt issued')
    complete, _ = target_resources(cloud, plan['service'], plan['region'], plan['prefix'], False)
    if not complete:
        raise Refused('post-apply target wiring is incomplete; reconcile using the saved snapshot')
    save(directory / 'rollback-receipt.json', dict(project=plan['project'], account=plan['account'], map=plan['map'], resourceId=str(before['id']), fingerprint=after['fingerprint'], target=after['defaultService'], previous=before['defaultService']))
    script = Path(__file__).resolve()
    save_text(directory / 'rollback.sh', '#!/usr/bin/env bash\nset -euo pipefail\nexec python3 ' + shlex.quote(str(script)) + ' --rollback ' + shlex.quote(str(directory)) + '\n')
    print('Handoff verified. Conditional rollback: OPENWOP_EDGE_APPLY_PROJECT=' + plan['project'] + ' bash ' + shlex.quote(str(directory / 'rollback.sh')))


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--service')
    parser.add_argument('--project')
    parser.add_argument('--region', default=os.environ.get('OPENWOP_DEPLOY_REGION', 'us-central1'))
    parser.add_argument('--account', default=os.environ.get('OPENWOP_DEPLOY_ACCOUNT'))
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--apply', action='store_true')
    action.add_argument('--rollback', type=Path)
    action.add_argument('--resume', type=Path)
    args = parser.parse_args(argv)
    if args.resume:
        apply_saved(args.resume.resolve())
        return 0
    if args.rollback:
        rollback(args.rollback.resolve())
        return 0
    if not args.service or not args.project or not args.account:
        parser.error('--service, --project and --account are required')
    prefix = os.environ.get('OPENWOP_EDGE_PREFIX', 'owp-edge')
    if any(not re.fullmatch(r'[a-z](?:[a-z0-9-]*[a-z0-9])?', value) for value in (args.service, args.project, args.region, prefix)) or max(len(prefix + '-neg-' + args.service), len(prefix + '-urlmap')) > 63:
        parser.error('resource names must be lowercase letters, digits and dashes, within GCP length limits')
    if not re.fullmatch(r'[A-Za-z0-9._%+@-]+', args.account):
        parser.error('account must be an explicit gcloud account name')
    cloud = Cloud(args.project, args.account)
    name = prefix + '-urlmap'
    before = cloud.map(name)
    if not before.get('id') or not before.get('fingerprint') or not before.get('defaultService'):
        raise Refused('URL map lacks identity, fingerprint or a previous default; refusing handoff')
    base = Path(os.environ.get('CUSTOM_DOMAIN_EDGE_SNAPSHOT_DIR', os.getcwd())).resolve()
    base.mkdir(parents=True, exist_ok=True)
    directory = Path(tempfile.mkdtemp(prefix='repoint-', dir=base))
    save(directory / 'urlmap.json', before)
    save_text(directory / 'previous-default.txt', before['defaultService'] + '\n')
    save_text(directory / 'fingerprint.txt', before['fingerprint'] + '\n')
    print('snapshot: ' + str(directory), flush=True)
    target = 'https://www.googleapis.com/compute/v1/' + f'projects/{args.project}/global/backendServices/{prefix}-be-{args.service}'
    already = resource(before['defaultService'], f'projects/{args.project}/global/backendServices/{prefix}-be-{args.service}')
    print('URL map: ' + name + ' in ' + args.project + ' (account ' + args.account + ')')
    print('Previous default: ' + before['defaultService'])
    print('Target default: ' + target + '; Cloud Run ' + args.service + ' in ' + args.region)
    # Already-target is only a no-op after the exact target wiring is proven.
    complete, _ = target_resources(cloud, args.service, args.region, prefix, False)
    if already:
        if not complete:
            raise Refused('URL map already names this backend but its wiring is incomplete')
        print('Already pointing at the verified target; nothing changed.')
        return 0
    print('Plan: create missing target NEG/backend, then PATCH only defaultService with the captured fingerprint.')
    if not args.apply:
        print('dry-run: nothing changed; no unconditional rollback script was issued')
        return 0
    save(directory / 'handoff.json', dict(project=args.project, account=args.account, map=name, service=args.service, region=args.region, prefix=prefix, target=target, resourceId=str(before['id'])))
    print('Resume an ambiguous outcome with this SAME directory: --resume ' + shlex.quote(str(directory)))
    apply_saved(directory)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (Refused, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print('custom-domain-repoint: ' + str(error), file=sys.stderr)
        sys.exit(1)
