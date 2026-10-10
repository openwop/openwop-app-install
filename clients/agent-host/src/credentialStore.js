// ADR 0785 D3 — where a paired device keeps its developer key.
//
// macOS: the login keychain (`security`), so the key is never a plain file.
// Elsewhere: a file under the user's home, directory 0700 and file 0600, written
// atomically (temp + rename) so a crash never leaves a half-written credential.
// The metadata (host, deviceId, tenantId, expiry) lives in the same file on every
// platform; on macOS the token field there is empty and the keychain holds it.
//
// Every function takes an explicit `home` so tests never touch the real one.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const SERVICE = 'openwop-agent-host';

export function defaultHome() {
  return process.env.OPENWOP_AGENT_HOST_HOME || join(homedir(), '.openwop', 'agent-host');
}

const credPath = (home) => join(home, 'credentials.json');

/** Keychain use is opt-out (`useKeychain:false`) and only ever on darwin. */
function keychainAvailable(useKeychain) {
  return useKeychain !== false && platform() === 'darwin';
}

function keychainAccount(host) { return host; }

export function saveCredential({ home = defaultHome(), host, apiBase = '', streamBase, token, deviceId, tenantId, expiresAt, useKeychain } = {}) {
  if (!host || !token) throw new Error('saveCredential needs host and token');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  let storedToken = token;
  let tokenIn = 'file';
  if (keychainAvailable(useKeychain)) {
    // -U updates an existing item for this (service, account) instead of failing.
    // KNOWN EXPOSURE (code review #5): `security` takes the secret as an argv
    // value, so for the instant the child runs, another user on this Mac can read
    // it with `ps`. `security` has no stdin form for a non-interactive write. The
    // file fallback (`useKeychain:false`) avoids argv entirely; a native keychain
    // binding would too, at the cost of a compiled dependency — tracked in ADR 0785.
    execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', keychainAccount(host), '-w', token], { stdio: 'ignore' });
    storedToken = '';
    tokenIn = 'keychain';
  }
  const record = { host, apiBase, ...(streamBase ? { streamBase } : {}), deviceId, tenantId, expiresAt, tokenIn, token: storedToken, savedAt: new Date().toISOString() };
  const tmp = `${credPath(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, credPath(home));
  chmodSync(credPath(home), 0o600);
  return { tokenIn };
}

/** Record (or clear, with null) the host's direct origin beside the pairing. It is
 *  not secret; the token field is carried over byte-for-byte, so a keychain-held
 *  key stays out of the file and a file-held one is not lost. */
export function setStreamBase({ home = defaultHome(), streamBase } = {}) {
  if (!existsSync(credPath(home))) return false;
  const record = JSON.parse(readFileSync(credPath(home), 'utf8'));
  if (streamBase) record.streamBase = streamBase; else delete record.streamBase;
  const tmp = `${credPath(home)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, credPath(home));
  chmodSync(credPath(home), 0o600);
  return true;
}

/** The saved credential with its token resolved, or null when not paired. */
export function loadCredential({ home = defaultHome() } = {}) {
  if (!existsSync(credPath(home))) return null;
  const record = JSON.parse(readFileSync(credPath(home), 'utf8'));
  if (record.tokenIn === 'keychain') {
    try {
      record.token = execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', keychainAccount(record.host), '-w'], { encoding: 'utf8' }).trim();
    } catch {
      record.token = '';
    }
  }
  return record;
}

/** Forget this machine's pairing locally. Revoking the key is a signed-in action in the web app. */
export function clearCredential({ home = defaultHome() } = {}) {
  const record = existsSync(credPath(home)) ? JSON.parse(readFileSync(credPath(home), 'utf8')) : null;
  if (record?.tokenIn === 'keychain') {
    try { execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', keychainAccount(record.host)], { stdio: 'ignore' }); } catch { /* already gone */ }
  }
  rmSync(credPath(home), { force: true });
  return record;
}
