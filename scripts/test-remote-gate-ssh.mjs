import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pinnedHostKey, remoteGateSshPlan, REMOTE_GATE_WORKER } from './lib/remote-gate-ssh.mjs';

function fixture() {
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]);
  return { runnerId: 'fixture-mac', host: 'runner.example.invalid', user: 'ci_worker', port: 22,
    publicHostKey: `ssh-ed25519 ${blob.toString('base64')}`,
    hostKey: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
    identityFile: '/tmp/explicit-identity', policySha256: 'a'.repeat(64) };
}
const plan = (trust = fixture()) => remoteGateSshPlan(trust, '/tmp/private-runner/known_hosts');

test('pins the verified key to a dedicated alias and keeps paths as individual argv', () => {
  const trust = fixture(); const out = plan(trust);
  assert.equal(out.knownHostsBytes.toString(), `openwop-ci-fixture-mac ${trust.publicHostKey}\n`);
  assert.equal(out.pinnedHostKey, trust.hostKey);
  assert(!('authenticatedHostKey' in out), 'a plan must not claim an SSH authentication happened');
  assert(out.args.includes(`IdentityFile=${trust.identityFile}`));
  assert.deepEqual(out.args.slice(-5), ['-p', '22', '--', 'ci_worker@runner.example.invalid', REMOTE_GATE_WORKER]);
});

for (const [name, mutate, reason] of [
  ['changed pin', (t) => { t.hostKey = `SHA256:${'B'.repeat(43)}`; }, /fingerprint/],
  ['missing pin', (t) => { delete t.hostKey; }, /explicit and closed/],
  ['shell host', (t) => { t.host = 'host;touch /tmp/forged'; }, /runner host/],
  ['SSH option host', (t) => { t.host = '-oProxyCommand=evil'; }, /runner host/],
  ['wildcard host', (t) => { t.host = '*.example.invalid'; }, /runner host/],
  ['embedded account', (t) => { t.host = 'root@host'; }, /runner host/],
  ['shell account', (t) => { t.user = 'ci$(id)'; }, /runner account/],
  ['root account', (t) => { t.user = 'root'; }, /unprivileged/],
  ['unapproved command', (t) => { t.workerCommand = 'sh -c evil'; }, /explicit and closed/],
  ['proxy override', (t) => { t.proxyCommand = 'evil'; }, /explicit and closed/],
  ['port string', (t) => { t.port = '22'; }, /runner port/],
  ['port overflow', (t) => { t.port = 65536; }, /runner port/],
  ['relative identity', (t) => { t.identityFile = 'id_ed25519'; }, /identity path/],
  ['newline identity', (t) => { t.identityFile = '/tmp/key\n'; }, /identity path/],
  ['token expansion in identity', (t) => { t.identityFile = '/tmp/key-%h'; }, /identity path/],
  ['multiple public keys', (t) => { t.publicHostKey += '\n' + t.publicHostKey; }, /one Ed25519/],
  ['known-hosts marker', (t) => { t.publicHostKey = '@cert-authority ' + t.publicHostKey; }, /one Ed25519/],
  ['truncated public key', (t) => { t.publicHostKey = 'ssh-ed25519 YQ=='; }, /host key length/],
  ['missing policy', (t) => { t.policySha256 = ''; }, /runner policy/],
]) test(`refuses ${name} before any transport`, () => {
  const trust = fixture(); mutate(trust); assert.throws(() => plan(trust), reason);
});

test('known-hosts path cannot become two paths or invoke SSH token expansion', () => {
  for (const file of ['/tmp/private runner/known_hosts', '/tmp/key-%h', '/tmp/../shared/key', '/tmp/key"other']) {
    assert.throws(() => remoteGateSshPlan(fixture(), file), /known-hosts path/, file);
  }
});

test('rejects malformed SSH wire length even if its fingerprint was supplied', () => {
  const trust = fixture(); const blob = Buffer.from(trust.publicHostKey.split(' ')[1], 'base64');
  blob.writeUInt32BE(31, 15); trust.publicHostKey = `ssh-ed25519 ${blob.toString('base64')}`;
  assert.throws(() => pinnedHostKey(trust.publicHostKey), /key size/);
});

test('installed OpenSSH effective config disables ambient config and forwarding without connecting', () => {
  const out = plan();
  const read = spawnSync(out.executable, ['-G', ...out.args], { encoding: 'utf8', timeout: 5000 });
  assert.equal(read.status, 0, read.stderr);
  const config = new Map(read.stdout.trim().split('\n').map((line) => { const i = line.indexOf(' '); return [line.slice(0, i), line.slice(i + 1)]; }));
  assert.deepEqual(read.stdout.split('\n').filter((line) => line.startsWith('identityfile ')), ['identityfile /tmp/explicit-identity']);
  for (const [key, value] of Object.entries({
    hostname: 'runner.example.invalid', user: 'ci_worker', port: '22',
    batchmode: 'yes', requesttty: 'false', stricthostkeychecking: 'true',
    forwardagent: 'no', forwardx11: 'no', forwardx11trusted: 'no', tunnel: 'false',
    clearallforwardings: 'yes', permitlocalcommand: 'no',
    identitiesonly: 'yes', identityagent: 'none', passwordauthentication: 'no',
    kbdinteractiveauthentication: 'no', verifyhostkeydns: 'false', updatehostkeys: 'false',
    hostkeyalias: 'openwop-ci-fixture-mac', hostkeyalgorithms: 'ssh-ed25519',
    globalknownhostsfile: '/dev/null', userknownhostsfile: '/tmp/private-runner/known_hosts',
  })) assert.equal(config.get(key), value, key);
  for (const key of ['proxycommand', 'proxyjump', 'localforward', 'remoteforward', 'sendenv']) assert(!config.has(key), key);
});
