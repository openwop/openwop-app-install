/** ADR 0863 D9: local SSH transport preparation. This does not connect, authenticate,
 * provision a runner, or grant permission to execute an unreviewed candidate.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

// Installed by the runner's operator, outside any submitted checkout. Request
// data goes on stdin; neither a request nor a returned result chooses a command.
export const REMOTE_GATE_WORKER = '/usr/local/libexec/openwop-ci-worker';

const FIELDS = ['runnerId', 'host', 'user', 'port', 'hostKey', 'publicHostKey', 'identityFile', 'policySha256'];
function path(value, name) {
  assert.equal(typeof value, 'string', name);
  // OpenSSH parses -o values again and expands percent tokens in filenames.
  // Keep this initial transport's private paths literal and single-valued.
  assert(value.length > 1 && value.length <= 4096 && isAbsolute(value)
    && /^\/[A-Za-z0-9_./-]+$/.test(value) && !value.split('/').includes('..'), name);
}

/** The first supported runner lane pins one ordinary Ed25519 key, not a CA,
 * wildcard, hashed host inventory, DNS assertion or automatically accepted key.
 */
export function pinnedHostKey(publicHostKey) {
  assert.equal(typeof publicHostKey, 'string', 'public host key required');
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/.exec(publicHostKey);
  assert(match && match[1].length <= 128, 'one Ed25519 public host key required');
  const blob = Buffer.from(match[1], 'base64');
  assert.equal(blob.toString('base64'), match[1], 'host key base64 is not canonical');
  // SSH wire encoding: string "ssh-ed25519", followed by a 32-byte public key.
  assert.equal(blob.length, 51, 'invalid Ed25519 host key length');
  assert.equal(blob.readUInt32BE(0), 11, 'invalid host key type length');
  assert.equal(blob.subarray(4, 15).toString('ascii'), 'ssh-ed25519', 'invalid host key type');
  assert.equal(blob.readUInt32BE(15), 32, 'invalid Ed25519 key size');
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/** Build argv for spawn/execFile with shell:false. The caller must write exactly
 * knownHostsBytes to a new private file (0600, private directory) and retain it
 * until SSH exits. A plan's pin is NOT an authenticatedHostKey observation.
 */
export function remoteGateSshPlan(trust, knownHostsFile) {
  assert(trust && typeof trust === 'object' && !Array.isArray(trust), 'local runner trust required');
  assert.deepEqual(Object.keys(trust).sort(), [...FIELDS].sort(), 'runner trust fields must be explicit and closed');
  assert.match(trust.runnerId, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'runner identity');
  assert.equal(typeof trust.host, 'string', 'runner host');
  assert(trust.host.length <= 253 && trust.host.split('.').every((label) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)), 'literal DNS/IPv4 runner host required');
  assert.match(trust.user, /^[a-z_][a-z0-9_-]{0,31}$/, 'runner account');
  assert.notEqual(trust.user, 'root', 'a dedicated unprivileged runner account is required');
  assert(Number.isSafeInteger(trust.port) && trust.port >= 1 && trust.port <= 65535, 'runner port');
  assert.match(trust.policySha256, /^[a-f0-9]{64}$/, 'locally approved runner policy');
  assert.equal(pinnedHostKey(trust.publicHostKey), trust.hostKey, 'public host key differs from locally verified fingerprint');
  path(trust.identityFile, 'explicit local identity path');
  path(knownHostsFile, 'private known-hosts path');
  const alias = `openwop-ci-${trust.runnerId}`;
  const options = {
    BatchMode: 'yes', RequestTTY: 'no', StrictHostKeyChecking: 'yes',
    UserKnownHostsFile: knownHostsFile, GlobalKnownHostsFile: '/dev/null',
    HostKeyAlias: alias, HostKeyAlgorithms: 'ssh-ed25519', CheckHostIP: 'no',
    VerifyHostKeyDNS: 'no', UpdateHostKeys: 'no', CanonicalizeHostname: 'no',
    ForwardAgent: 'no', ForwardX11: 'no', ForwardX11Trusted: 'no', Tunnel: 'no',
    ClearAllForwardings: 'yes', PermitLocalCommand: 'no',
    ProxyCommand: 'none', ProxyJump: 'none', ControlMaster: 'no', ControlPath: 'none',
    // -i silently drops an unavailable path and restores default user keys.
    // IdentityFile retains the explicit path even when absent: fail closed.
    IdentitiesOnly: 'yes', IdentityFile: trust.identityFile, IdentityAgent: 'none', AddKeysToAgent: 'no',
    PasswordAuthentication: 'no', KbdInteractiveAuthentication: 'no',
    GSSAPIAuthentication: 'no', PreferredAuthentications: 'publickey',
    ConnectionAttempts: '1', ConnectTimeout: '15', ServerAliveInterval: '15',
    ServerAliveCountMax: '3', SendEnv: '-*',
  };
  return {
    executable: '/usr/bin/ssh',
    args: ['-F', '/dev/null', '-T', ...Object.entries(options).flatMap(([key, value]) => ['-o', `${key}=${value}`]),
      '-p', String(trust.port), '--', `${trust.user}@${trust.host}`, REMOTE_GATE_WORKER],
    knownHostsBytes: Buffer.from(`${alias} ${trust.publicHostKey}\n`),
    runnerId: trust.runnerId, policySha256: trust.policySha256, pinnedHostKey: trust.hostKey,
  };
}
