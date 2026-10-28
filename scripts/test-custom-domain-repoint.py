#!/usr/bin/env python3
"""Exercise the real repoint controller against a fingerprint-enforcing fake cloud.

The only transports are replaced: unexpected calls fail, and no token or cloud
mutation can reach GCP. Removing the captured fingerprint, identity validation,
operation wait or rollback ownership check breaks the corresponding witness.
"""
import copy
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import io
import json
import os
import subprocess
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs

SPEC = importlib.util.spec_from_file_location('repoint', Path(__file__).parent / 'lib/custom-domain-repoint.py')
repoint = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(repoint)
RealCloud = repoint.Cloud
API = 'https://www.googleapis.com/compute/v1/'
OLD = API + 'projects/old-proj/global/backendServices/old-backend'
TARGET = API + 'projects/edge-proj/global/backendServices/owp-edge-be-mh-backend'
NEG = API + 'projects/edge-proj/regions/us-central1/networkEndpointGroups/owp-edge-neg-mh-backend'


class FakeCloud(RealCloud):
    def __init__(self):
        super().__init__('edge-proj', 'op@example.com')
        self.row = dict(id='42', name='owp-edge-urlmap', fingerprint='fp-0', defaultService=OLD,
                        hostRules=[{'hosts': ['keep.example'], 'pathMatcher': 'keep'}], pathMatchers=[{'name': 'keep', 'defaultService': OLD}])
        self.neg = None
        self.backend = None
        self.calls = []
        self.requests = {}
        self.patch_attempts = []
        self.mutations = 0
        self.lose_responses = 0
        self.before_patch = None
        self.after_patch = None
        self.operation_failure = False
        self.pending = False
        self.async_failure = False
        self.operation_polls = 0
        self.waits = {}
        self.on_poll = None
        self.transport_lock = threading.Lock()
        self.invalid_after_attach = False

    def gc(self, *args, optional=False):
        self.calls.append(args)
        command = args[:3]
        if command == ('compute', 'url-maps', 'describe'):
            self.assert_map(args[3])
            with self.transport_lock:
                return copy.deepcopy(self.row)
        if command == ('compute', 'network-endpoint-groups', 'describe'):
            return copy.deepcopy(self.neg)
        if command == ('compute', 'backend-services', 'describe'):
            return copy.deepcopy(self.backend)
        if command == ('compute', 'network-endpoint-groups', 'create'):
            assert self.neg is None
            self.neg = dict(selfLink=NEG, networkEndpointType='SERVERLESS', cloudRun={'service': 'mh-backend'})
            return {}
        if command == ('compute', 'backend-services', 'create'):
            assert self.backend is None
            self.backend = dict(selfLink=TARGET, loadBalancingScheme='EXTERNAL_MANAGED', protocol='HTTP', backends=[])
            return {}
        if command == ('compute', 'backend-services', 'add-backend'):
            assert self.backend and not self.backend['backends']
            self.backend['backends'] = [{'group': NEG}]
            if self.invalid_after_attach:
                self.backend['selfLink'] = TARGET.replace('edge-proj', 'peer-proj')
            return {}
        raise AssertionError('Unexpected gcloud transport: ' + repr(args))

    @staticmethod
    def assert_map(name):
        assert name == 'owp-edge-urlmap'

    def mutate(self, body):
        self.mutations += 1
        self.row['defaultService'] = body['defaultService']
        self.row['fingerprint'] = 'fp-write-' + str(self.mutations)
        if self.after_patch:
            hook, self.after_patch = self.after_patch, None
            hook()

    def api(self, method, path, body=None):
        # The fake provider, like Compute, deduplicates a request atomically.
        with self.transport_lock:
            return self.transport(method, path, body)

    def transport(self, method, path, body=None):
        if method == 'GET' and path.startswith('projects/edge-proj/global/operations/'):
            request_id = path.rsplit('/', 1)[-1].removeprefix('operation-')
            saved_body, operation = self.requests[request_id]
            self.operation_polls += 1
            if self.on_poll:
                self.on_poll()
            if operation['status'] != 'DONE':
                self.waits[request_id] -= 1
                if self.waits[request_id] == 0:
                    operation['status'] = 'DONE'
                    if self.async_failure:
                        operation['error'] = {'errors': [{'code': 'RESOURCE_NOT_READY'}]}
                    else:
                        self.mutate(saved_body)
                    self.requests[request_id] = (saved_body, copy.deepcopy(operation))
            return copy.deepcopy(operation)
        expected = 'projects/edge-proj/global/urlMaps/owp-edge-urlmap?'
        assert method == 'PATCH' and path.startswith(expected), (method, path)
        assert set(body) == {'fingerprint', 'defaultService'}, body
        request_id = parse_qs(path.split('?', 1)[1])['requestId'][0]
        self.patch_attempts.append((request_id, copy.deepcopy(body)))
        if request_id in self.requests:
            previous, operation = self.requests[request_id]
            assert body == previous, 'retry changed the saved request body'
        else:
            if self.before_patch:
                hook, self.before_patch = self.before_patch, None
                hook()
            if body['fingerprint'] != self.row['fingerprint']:
                raise repoint.Refused('Compute fingerprint conditionNotMet (HTTP 412)')
            operation = {'name': 'operation-' + request_id, 'status': 'RUNNING' if self.pending else 'DONE'}
            if self.operation_failure:
                operation.update(status='DONE', error={'errors': [{'code': 'RESOURCE_NOT_READY'}]})
            elif self.pending:
                self.waits[request_id] = 2
            else:
                self.mutate(body)
            self.requests[request_id] = (copy.deepcopy(body), copy.deepcopy(operation))
        if self.lose_responses:
            self.lose_responses -= 1
            raise URLError('response lost after acceptance')
        return copy.deepcopy(operation)


class RepointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.cloud = FakeCloud()
        self.env = patch.dict(os.environ, {'CUSTOM_DOMAIN_EDGE_SNAPSHOT_DIR': str(self.root), 'OPENWOP_EDGE_APPLY_PROJECT': 'edge-proj', 'OPENWOP_EDGE_PREFIX': 'owp-edge', 'OPENWOP_DEPLOY_REGION': 'us-central1'})
        self.env.start()
        self.factory = patch.object(repoint, 'Cloud', side_effect=self.client)
        self.factory.start()
        self.output = patch('sys.stdout', new_callable=io.StringIO)
        self.output.start()

    def tearDown(self):
        self.output.stop()
        self.factory.stop()
        self.env.stop()
        self.temp.cleanup()

    def client(self, project, account):
        self.assertEqual((project, account), ('edge-proj', 'op@example.com'))
        return self.cloud

    def invoke(self, *extra):
        return repoint.main(['--service', 'mh-backend', '--project', 'edge-proj', '--account', 'op@example.com', *extra])

    def directory(self):
        directories = list(self.root.glob('repoint-*'))
        self.assertEqual(len(directories), 1)
        return directories[0]

    def seed_target(self):
        repoint.target_resources(self.cloud, 'mh-backend', 'us-central1', 'owp-edge', True)

    def test_dry_run_has_single_snapshot_and_no_mutation_or_unsafe_rollback(self):
        self.assertEqual(self.invoke(), 0)
        self.assertEqual(self.cloud.mutations, 0)
        self.assertIsNone(self.cloud.neg)
        self.assertEqual(sum(call[:3] == ('compute', 'url-maps', 'describe') for call in self.cloud.calls), 1)
        self.assertEqual(json.loads((self.directory() / 'urlmap.json').read_text())['fingerprint'], 'fp-0')
        self.assertFalse((self.directory() / 'rollback.sh').exists())

    def test_apply_confirmation_precedes_every_mutation(self):
        with patch.dict(os.environ, {'OPENWOP_EDGE_APPLY_PROJECT': 'wrong-project'}), self.assertRaisesRegex(repoint.Refused, 'requires'):
            self.invoke('--apply')
        self.assertIsNone(self.cloud.neg)
        self.assertIsNone(self.cloud.backend)
        self.assertEqual(self.cloud.mutations, 0)

    def test_verified_already_target_is_noop_and_snapshot_directories_are_unique(self):
        self.invoke('--apply')
        mutations = self.cloud.mutations
        self.cloud.calls.clear()
        self.assertEqual(self.invoke('--apply'), 0)
        self.assertEqual(self.cloud.mutations, mutations)
        self.assertFalse(any(call[2] in ('create', 'add-backend') for call in self.cloud.calls))
        self.assertEqual(len(list(self.root.glob('repoint-*'))), 2)

    def test_already_target_with_missing_wiring_refuses_without_repair_mutation(self):
        self.cloud.row['defaultService'] = TARGET
        with self.assertRaisesRegex(repoint.Refused, 'incomplete'):
            self.invoke('--apply')
        self.assertIsNone(self.cloud.neg)
        self.assertIsNone(self.cloud.backend)
        self.assertEqual(self.cloud.mutations, 0)

    def test_forward_waits_then_rollback_restores_only_default_and_repeated_rollback_is_noop(self):
        before = copy.deepcopy(self.cloud.row)
        self.cloud.pending = True
        self.cloud.on_poll = lambda: self.assertFalse((self.directory() / 'rollback-receipt.json').exists())
        with patch.object(repoint.time, 'sleep'):
            self.assertEqual(self.invoke('--apply'), 0)
        self.assertEqual(self.cloud.operation_polls, 2)
        self.cloud.pending = False
        self.cloud.on_poll = None
        directory = self.directory()
        self.assertTrue((directory / 'rollback.sh').exists())
        self.assertEqual(self.cloud.row['defaultService'], TARGET)
        self.assertEqual(repoint.main(['--rollback', str(directory)]), 0)
        self.assertEqual(repoint.configuration(self.cloud.row), repoint.configuration(before))
        mutations = self.cloud.mutations
        self.assertEqual(repoint.main(['--rollback', str(directory)]), 0)
        self.assertEqual(self.cloud.mutations, mutations)

    def test_concurrent_forward_change_412_preserves_peer_map(self):
        def peer():
            self.cloud.row['fingerprint'] = 'peer-fp'
            self.cloud.row['description'] = 'peer change'
        self.cloud.before_patch = peer
        with self.assertRaisesRegex(repoint.Refused, '412'):
            self.invoke('--apply')
        self.assertEqual(self.cloud.mutations, 0)
        self.assertEqual(self.cloud.row['description'], 'peer change')
        self.assertFalse((self.directory() / 'rollback-receipt.json').exists())

    def test_concurrent_rollback_change_is_preserved(self):
        self.invoke('--apply')
        self.cloud.row.update(fingerprint='peer-fp', description='peer change')
        with self.assertRaisesRegex(repoint.Refused, 'changed'):
            repoint.main(['--rollback', str(self.directory())])
        self.assertEqual(self.cloud.mutations, 1)
        self.assertEqual(self.cloud.row['description'], 'peer change')

    def test_peer_change_between_rollback_read_and_patch_is_rejected_by_captured_fingerprint(self):
        self.invoke('--apply')
        self.cloud.before_patch = lambda: self.cloud.row.update(fingerprint='late-peer', description='late peer')
        with self.assertRaisesRegex(repoint.Refused, '412'):
            repoint.main(['--rollback', str(self.directory())])
        self.assertEqual(self.cloud.row['description'], 'late peer')
        self.assertEqual(self.cloud.mutations, 1)

    def test_lost_apply_responses_resume_across_invocations_with_same_id_body(self):
        self.cloud.lose_responses = 2
        with self.assertRaisesRegex(repoint.Refused, 'unknown'):
            self.invoke('--apply')
        directory = self.directory()
        context = json.loads((directory / 'handoff.json').read_text())
        self.assertEqual((context['project'], context['account'], context['map'], context['resourceId']), ('edge-proj', 'op@example.com', 'owp-edge-urlmap', '42'))
        self.assertFalse((directory / 'rollback.sh').exists())
        self.assertEqual(repoint.main(['--resume', str(directory)]), 0)
        self.assertEqual(len({request_id for request_id, _ in self.cloud.patch_attempts}), 1)
        self.assertTrue(all(body == self.cloud.patch_attempts[0][1] for _, body in self.cloud.patch_attempts))
        self.assertEqual(self.cloud.mutations, 1)
        self.assertTrue((directory / 'rollback-receipt.json').exists())

    def test_lost_rollback_responses_reconcile_without_mutating_again(self):
        self.invoke('--apply')
        directory = self.directory()
        self.cloud.lose_responses = 2
        with self.assertRaisesRegex(repoint.Refused, 'unknown'):
            repoint.main(['--rollback', str(directory)])
        self.assertEqual(repoint.main(['--rollback', str(directory)]), 0)
        self.assertEqual(self.cloud.mutations, 2)
        self.assertEqual(self.cloud.row['defaultService'], OLD)
        self.assertEqual(self.cloud.patch_attempts[-1], self.cloud.patch_attempts[-2])

    def test_operation_failure_never_issues_success_receipt(self):
        self.cloud.operation_failure = True
        with self.assertRaisesRegex(repoint.Refused, 'operation failed'):
            self.invoke('--apply')
        self.assertEqual(self.cloud.row['defaultService'], OLD)
        self.assertFalse((self.directory() / 'rollback.sh').exists())

    def test_error_only_on_operation_get_never_issues_receipt(self):
        self.cloud.pending = True
        self.cloud.async_failure = True
        with patch.object(repoint.time, 'sleep'), self.assertRaisesRegex(repoint.Refused, 'operation failed'):
            self.invoke('--apply')
        self.assertEqual(self.cloud.operation_polls, 2)
        self.assertEqual(self.cloud.mutations, 0)
        self.assertFalse((self.directory() / 'rollback-receipt.json').exists())

    def test_concurrent_invocations_publish_one_immutable_recoverable_request(self):
        self.invoke()  # one private original snapshot, no mutation
        directory = self.directory()
        repoint.save(directory / 'handoff.json', dict(project='edge-proj', account='op@example.com', map='owp-edge-urlmap', service='mh-backend', region='us-central1', prefix='owp-edge', target=TARGET, resourceId='42'))
        self.seed_target()
        barrier = threading.Barrier(2)
        link = repoint.os.link
        def publish(source, destination):
            barrier.wait(timeout=5)
            return link(source, destination)
        with patch.object(repoint.os, 'link', side_effect=publish), ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(repoint.apply_saved, directory) for _ in range(2)]
            for future in futures:
                future.result(timeout=10)
        record = json.loads((directory / 'apply-request.json').read_text())
        self.assertEqual({request_id for request_id, _ in self.cloud.patch_attempts}, {record['requestId']})
        self.assertEqual(self.cloud.mutations, 1)
        self.assertEqual(record['body'], {'fingerprint': 'fp-0', 'defaultService': TARGET})
        self.assertTrue((directory / 'rollback-receipt.json').exists())

    def test_changed_postapply_configuration_does_not_earn_owned_rollback(self):
        self.cloud.after_patch = lambda: self.cloud.row.update(description='another operator', fingerprint='peer-after')
        with self.assertRaisesRegex(repoint.Refused, 'not exactly'):
            self.invoke('--apply')
        self.assertFalse((self.directory() / 'rollback-receipt.json').exists())

    def test_target_identity_and_already_target_wiring_are_fail_closed(self):
        for defect in ('service', 'region', 'project', 'tag', 'extra-backend', 'scheme', 'protocol'):
            with self.subTest(defect=defect):
                self.cloud.neg = self.cloud.backend = None
                self.seed_target()
                if defect == 'service': self.cloud.neg['cloudRun']['service'] = 'wrong'
                if defect == 'region': self.cloud.neg['selfLink'] = NEG.replace('us-central1', 'us-east1')
                if defect == 'project': self.cloud.neg['selfLink'] = NEG.replace('edge-proj', 'wrong-proj')
                if defect == 'tag': self.cloud.neg['cloudRun']['tag'] = 'unexpected'
                if defect == 'extra-backend': self.cloud.backend['backends'].append({'group': NEG})
                if defect == 'scheme': self.cloud.backend['loadBalancingScheme'] = 'EXTERNAL'
                if defect == 'protocol': self.cloud.backend['protocol'] = 'HTTPS'
                self.cloud.row['defaultService'] = TARGET
                with self.assertRaises(repoint.Refused): self.invoke('--apply')
                self.assertEqual(self.cloud.mutations, 0)

    def test_final_backend_after_attachment_is_revalidated(self):
        self.cloud.invalid_after_attach = True
        with self.assertRaisesRegex(repoint.Refused, 'wrong project'):
            self.invoke('--apply')
        self.assertEqual(self.cloud.mutations, 0)

    def test_missing_option_values_exit_two_without_transport(self):
        for option in ('--service', '--project', '--region', '--account', '--rollback', '--resume'):
            with self.subTest(option=option), patch('sys.stderr', new_callable=io.StringIO):
                with self.assertRaises(SystemExit) as error:
                    repoint.main([option])
                self.assertEqual(error.exception.code, 2)
        self.assertEqual(self.cloud.calls, [])


class CredentialTests(unittest.TestCase):
    def test_gcloud_reads_and_provisioning_are_noninteractive_and_account_pinned(self):
        cloud = RealCloud('edge-proj', 'op@example.com')
        result = subprocess.CompletedProcess([], 0, stdout='{"id":"42"}', stderr='')
        with patch.object(repoint.subprocess, 'run', return_value=result) as transport:
            self.assertEqual(cloud.map('owp-edge-urlmap'), {'id': '42'})
        transport.assert_called_once_with(['gcloud', 'compute', 'url-maps', 'describe', 'owp-edge-urlmap', '--global', '--project', 'edge-proj', '--account', 'op@example.com', '--quiet', '--format=json'], capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=180)

    def test_ambiguous_http_failure_is_distinct_from_fingerprint_refusal(self):
        cloud = RealCloud('edge-proj', 'op@example.com')
        cloud.token = 'valid-fixture'
        for code, error_type in [(503, URLError), (412, repoint.Refused)]:
            with self.subTest(code=code), patch.object(repoint, 'urlopen', side_effect=HTTPError('https://compute.googleapis.com/', code, 'fixture', None, None)):
                with self.assertRaises(error_type):
                    cloud.api('PATCH', 'projects/edge-proj/global/urlMaps/owp-edge-urlmap', {'fingerprint': 'fp-0', 'defaultService': TARGET})

    def test_invalid_auth_output_is_rejected_without_exposing_it(self):
        cloud = RealCloud('edge-proj', 'op@example.com')
        invalid = 'private-fixture-token\nunexpected'
        with patch.object(repoint.subprocess, 'check_output', return_value=invalid), patch.object(repoint, 'urlopen') as transport:
            with self.assertRaises(repoint.Refused) as error:
                cloud.api('GET', 'projects/edge-proj/global/operations/op')
            self.assertNotIn('private-fixture-token', str(error.exception))
            transport.assert_not_called()

    def test_api_keeps_token_in_memory_and_pins_account(self):
        cloud = RealCloud('edge-proj', 'op@example.com')
        token = 'private-fixture-token'
        with patch.object(repoint.subprocess, 'check_output', return_value=token) as auth, patch.object(repoint, 'urlopen', return_value=io.BytesIO(b'{"status":"DONE"}')) as transport:
            self.assertEqual(cloud.api('GET', 'projects/edge-proj/global/operations/op'), {'status': 'DONE'})
        auth.assert_called_once_with(['gcloud', 'auth', 'print-access-token', '--account', 'op@example.com', '--project', 'edge-proj'], text=True, stdin=subprocess.DEVNULL, timeout=30)
        request = transport.call_args.args[0]
        self.assertEqual(request.get_header('Authorization'), 'Bearer ' + token)
        self.assertNotIn(token, request.full_url)
        self.assertEqual(transport.call_args.kwargs['timeout'], 30)


if __name__ == '__main__':
    unittest.main()
