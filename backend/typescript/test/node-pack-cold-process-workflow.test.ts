/**
 * Actual native process boundary, real HTTP registration/run/engine output.
 * No module reset, import suffix, fake executor, runner change or timeout raise.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { WorkflowDefinition } from '../src/executor/types.js';
import { deploymentMarker } from '../src/host/oidcTrustGuard.js';
import { bareRunId } from './support/bareRunId.js';
import {
  PACK, TYPE, OPERATOR, REGISTRY, childEnvironment, createFixture, integer, layout, record,
  text, valueFor, writeCapsule, type Capsule, type Version,
} from './support/nodePolicyColdFixture.js';

interface Termination { code: number | null; signal: NodeJS.Signals | null }
interface Host {
  proc: ChildProcess; base: string; ready: Record<string, unknown>;
  state(): Promise<Record<string, unknown>>;
  stop(): Promise<Termination>;
}
let capsule: Capsule | undefined, old: Host | undefined;
let live = true;
let orchestrationFault: Error | undefined;
const children = new Set<ChildProcess>();
const closeReceipts = new Map<ChildProcess, Promise<Termination>>();
function assertLive(): void {
  assert(live, 'Owned orchestration already closed');
  if (orchestrationFault) throw orchestrationFault;
}

async function startHost(phase: 'old' | 'fresh'): Promise<Host> {
  assertLive(); assert(capsule);
  const own = capsule;
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(deploymentMarker(process.env), null, 'ORIGINAL parent posture must admit a local test seam');
  const launchEnv = childEnvironment(own.root);
  const entry = fileURLToPath(new URL('./support/nodePolicyColdHost.ts', import.meta.url));
  // Same real Node/tsx child convention as test/support/appProcess.ts.
  // Check ORIGINAL posture above before dropping every non-allowlisted env key.
  const proc = spawn(process.execPath, ['--import', 'tsx', entry, layout(own.root).capsule, own.nonce, phase], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: launchEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(proc);
  let ended = false, stopping = false, readyReceived = false, seq = 0;
  const pending = new Map<number, { yes: (value: Record<string, unknown>) => void; no: (error: Error) => void }>();
  let readyYes: ((value: Record<string, unknown>) => void) | undefined;
  let readyNo: ((error: Error) => void) | undefined;
  const readyPromise = new Promise<Record<string, unknown>>((yes, no) => { readyYes = yes; readyNo = no; });
  function fail(error: Error): void {
    orchestrationFault ??= error; // A late/unrequested IPC fault cannot disappear.
    clearTimeout(timer); readyNo?.(error);
    for (const waiter of pending.values()) waiter.no(error);
    pending.clear();
    // Only this exact fixture child is terminated; its actual close is still owed.
    if (!ended && proc.pid !== undefined && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  const timer = setTimeout(() => { fail(new Error('Owned memory host did not reach actual startup admission')); }, 15000);
  const closed = new Promise<Termination>(resolve => {
    proc.once('close', (code, signal) => {
      ended = true; clearTimeout(timer);
      const error = new Error('Owned host closed before its pending operation settled');
      if (!stopping && live) fail(error);
      readyNo?.(error);
      for (const waiter of pending.values()) waiter.no(error);
      pending.clear(); resolve({ code, signal });
    });
  });
  closeReceipts.set(proc, closed);
  proc.once('error', fail);
  // Preserve full real child diagnostics in the test runner's stdout/stderr.
  proc.stdout?.on('data', (data: Buffer) => { process.stdout.write(data); });
  proc.stderr?.on('data', (data: Buffer) => { process.stderr.write(data); });
  proc.on('message', (value: unknown) => {
    try {
      const message = record(value);
      if (message.ready === true) {
        assert.equal(readyReceived, false, 'Duplicate child readiness');
        readyReceived = true;
        assert.equal(message.nonce, own.nonce); assert.equal(message.phase, phase);
        assert.equal(integer(message.pid), proc.pid);
        const port = integer(message.port); assert(port > 0 && port <= 65535);
        clearTimeout(timer); readyYes?.(message); return;
      }
      const id = integer(message.id), waiter = pending.get(id);
      assert(waiter, 'Unrequested child IPC reply');
      if (message.ok !== true) { pending.delete(id); waiter.no(new Error(text(message.error))); return; }
      const state = record(message.state); pending.delete(id); waiter.yes(state);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      fail(failure);
    }
  });
  function send(cmd: 'state' | 'exit', id: number): void {
    assertLive(); assert(!ended && proc.connected, 'No command may target an ended host');
    proc.send({ id, cmd, nonce: own.nonce }, error => { if (error) fail(error); });
  }
  const ready = await readyPromise; assertLive();
  const base = 'http://127.0.0.1:' + integer(ready.port);
  return { proc, base, ready,
    state() {
      assertLive(); const id = ++seq;
      return new Promise<Record<string, unknown>>((yes, no) => {
        pending.set(id, { yes, no });
        try { send('state', id); } catch (error) { pending.delete(id); no(error instanceof Error ? error : new Error(String(error))); }
      });
    },
    async stop() {
      assertLive(); assert(!ended, 'A spontaneous exit is not the requested shutdown control');
      stopping = true;
      send('exit', ++seq);
      const receipt = await closed; assertLive();
      expect(receipt).toEqual({ code: 0, signal: null });
      expect(proc.exitCode).toBe(0); expect(proc.signalCode).toBeNull();
      return receipt;
    },
  };
}
function http(base: string) {
  const origin = new URL(base); assert.equal(origin.protocol, 'http:'); assert.equal(origin.hostname, '127.0.0.1');
  let cookie = '';
  async function request(method: 'GET' | 'POST', path: string, body?: unknown) {
    assertLive(); assert(path.startsWith('/'));
    const response = await fetch(base + path, { method, redirect: 'error', headers: {
      'content-type': 'application/json', 'OpenWOP-Version': '2', 'accept-language': 'en',
      ...(cookie ? { cookie } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assertLive();
    const headers: Headers & { getSetCookie?: () => string[] } = response.headers;
    assert(typeof headers.getSetCookie === 'function');
    for (const value of headers.getSetCookie()) { const next = /(__session=[^;]+)/.exec(value)?.[1]; if (next) cookie = next; }
    const raw: unknown = await response.json(); assertLive();
    return { status: response.status, body: record(raw), headers: response.headers };
  }
  return { get: (path: string) => request('GET', path), post: (path: string, body?: unknown) => request('POST', path, body),
    hasCookie: () => cookie.startsWith('__session=') };
}
type Client = ReturnType<typeof http>;
async function admit(host: Host): Promise<Client> {
  const client = http(host.base);
  const login = await client.post('/host/openwop-app/test/login', { email: 'node-import-cold@example.invalid', tenantId: OPERATOR });
  expect(login.status).toBe(201); expect(text(record(login.body.user).userId).length).toBeGreaterThan(0);
  expect(client.hasCookie()).toBe(true);
  const list = await client.get('/host/openwop-app/marketplace/listings');
  expect(list.status).toBe(200); expect(record(list.body.viewer).canAdminister).toBe(true);
  return client;
}
async function workflow(client: Client, host: Host, version: Version): Promise<string> {
  assert(capsule);
  const definition: WorkflowDefinition = {
    workflowId: 'node-import-cold.' + capsule.nonce.slice(0, 12),
    nodes: [{ nodeId: 'probe', typeId: TYPE }], edges: [],
  };
  const registered = await client.post('/host/openwop-app/workflows', definition);
  expect(registered.status, JSON.stringify(registered.body)).toBe(201);
  expect(registered.body.workflowId).toBe(definition.workflowId); expect(registered.body.nodeCount).toBe(1);
  const started = await client.post('/runs', { workflowId: definition.workflowId, inputs: {} });
  expect(started.status, JSON.stringify(started.body)).toBe(201);
  const runId = text(started.body.runId), bare = bareRunId(runId);
  expect(bare.length).toBeGreaterThan(0);
  // Host-extension read intentionally uses the accepted host bare-ID helper;
  // no bare id is put on a major-2 protocol path.
  const bundle = await vi.waitFor(async () => {
    const read = await client.get('/host/openwop-app/runs/' + encodeURIComponent(bare) + '/debug-bundle');
    expect(read.status).toBe(200); expect(read.body.status, JSON.stringify(read.body)).toBe('completed'); return read.body;
  }, { timeout: 5000, interval: 25 });
  expect(bundle.workflowId).toBe(definition.workflowId);
  expect(bundle.truncated).toBe(false); assert(Array.isArray(bundle.events));
  const events = bundle.events.map(record);
  expect(events.filter(event => event.type === 'run.completed')).toHaveLength(1);
  expect(events.filter(event => event.type === 'node.failed' || event.type === 'run.failed')).toEqual([]);
  const completed = events.filter(event => event.type === 'node.completed' && event.nodeId === 'probe');
  expect(completed).toHaveLength(1);
  const completion = completed[0]; assert(completion);
  const outputs = record(record(completion.payload).outputs);
  expect(outputs.value).toBe(valueFor(capsule.nonce, version));
  expect(outputs.processId).toBe(host.proc.pid); expect(outputs.tenant).toBe(OPERATOR);
  return runId;
}
beforeAll(async () => {
  capsule = createFixture();
  expect(statSync(layout(capsule.root).capsule).mode & 0o777).toBe(0o600);
  old = await startHost('old');
});
afterAll(async () => {
  live = false; // A timed-out continuation cannot spawn, send, fetch or write.
  for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  for (const receipt of closeReceipts.values()) await receipt;
  if (capsule) rmSync(capsule.root, { recursive: true, force: true });
});

it('ends the loaded old host, then installs the requested version before first import in a fresh OS host and runs it through the real engine', async () => {
  assert(capsule && old);
  const root = capsule.root, oldInitial = record(old.ready.state);
  expect(oldInitial.manifestVersion).toBe('1.0.0'); expect(oldInitial.moduleVersion).toBeNull();
  expect(oldInitial.control).toBe(''); expect(oldInitial.markerValid).toBe(true); expect(oldInitial.unexpected).toEqual([]);
  const oldClient = await admit(old);
  const oldRun = await workflow(oldClient, old, '1.0.0');
  const loaded = await old.state();
  expect(loaded.moduleVersion).toBe('1.0.0'); expect(loaded.tier).toBe('operator-trusted');
  expect(loaded.control).toBe('1.0.0\n');
  const entry = pathToFileURL(join(layout(root).packDir, PACK, 'index.mjs')).href;
  expect(loaded.moduleEntry).toBe(entry);
  const noop = await oldClient.post('/host/openwop-app/marketplace/install', { packName: PACK, version: '1.0.0' });
  expect(noop.status).toBe(200); expect(noop.body).toMatchObject({ installed: false, alreadyInstalled: true, reason: 'already_installed' });
  expect(await old.state()).toEqual(loaded); // Genuine unchanged no-op, including registry traffic.
  const refused = await oldClient.post('/host/openwop-app/marketplace/install', { packName: PACK, version: '1.1.0' });
  expect(refused.status).toBe(409); expect(refused.body.error).toBe('conflict');
  expect(record(refused.body.details)).toMatchObject({ packName: PACK, version: '1.1.0', reason: 'pack_restart_required' });
  expect(refused.body.message).toContain('Configure the desired version for startup and restart');
  expect(refused.headers.get('cache-control')).toContain('no-store');
  const rendered = JSON.stringify(refused.body);
  for (const privateValue of [root, REGISTRY, readFileSync(join(layout(root).assets, 'key.pub'), 'utf8')]) expect(rendered).not.toContain(privateValue);
  const afterRefusal = await old.state();
  const { requests: priorRequests, ...loadedCore } = loaded;
  const { requests: refusalRequests, ...refusedCore } = afterRefusal;
  expect(refusedCore).toEqual(loadedCore); // Disk, marker, module, entry, evaluation and unexpected transport unchanged.
  assert(Array.isArray(priorRequests) && Array.isArray(refusalRequests));
  expect(refusalRequests.length).toBeGreaterThan(priorRequests.length);
  expect(refusalRequests).toContain(REGISTRY + '/v2/packs/' + PACK + '/-/1.1.0.sig');
  // Actual installer verifies the desired archive BEFORE its pre-replacement guard.
  const oldAgain = await workflow(oldClient, old, '1.0.0');
  expect((await old.state()).control).toBe('1.0.0\n');
  const oldTermination = await old.stop(); // Actual OS close event resolved here, not just an IPC ACK.
  assertLive(); assert(old.proc.pid);
  capsule = { root, nonce: capsule.nonce, phase: 'old-exited', oldPid: old.proc.pid, oldExitCode: 0,
    oldDigest: text(loaded.digest), oldControl: text(loaded.control) };
  writeCapsule(capsule);
  expect(statSync(layout(root).capsule).mode & 0o777).toBe(0o600);
  const fresh = await startHost('fresh'); // Cannot be reached before old close, including on timeout.
  expect(fresh.proc).not.toBe(old.proc);
  const prior = record(fresh.ready.beforeStartup), initial = record(fresh.ready.state);
  expect(prior).toMatchObject({ packDir: loaded.packDir, manifestVersion: '1.0.0', digest: loaded.digest, files: loaded.files, markerValid: true, control: '1.0.0\n' });
  expect(initial.packDir).toBe(loaded.packDir); expect(initial.manifestVersion).toBe('1.1.0');
  expect(initial.markerValid).toBe(true); expect(initial.moduleVersion).toBeNull();
  expect(initial.control).toBe('1.0.0\n'); expect(initial.unexpected).toEqual([]);
  expect(initial.requests).toContain(REGISTRY + '/v2/packs/' + PACK + '/-/1.1.0.sig');
  const freshClient = await admit(fresh);
  const newRun = await workflow(freshClient, fresh, '1.1.0');
  const current = await fresh.state();
  expect(current.moduleVersion).toBe('1.1.0'); expect(current.tier).toBe('operator-trusted');
  expect(current.moduleEntry).toBe(entry); expect(current.control).toBe('1.0.0\n1.1.0\n');
  expect(current.manifestVersion).toBe('1.1.0'); expect(current.markerValid).toBe(true);
  expect(current.digest).not.toBe(loaded.digest); expect(current.unexpected).toEqual([]);
  const freshTermination = await fresh.stop();
  console.info('node-import-cold ' + JSON.stringify({
    oldPid: old.proc.pid, freshPid: fresh.proc.pid, oldTermination, freshTermination,
    samePackDir: initial.packDir === loaded.packDir, capsuleMode: '0600',
    oldDigest: loaded.digest, newDigest: current.digest, oldRun, oldAgain, newRun,
    oldValue: valueFor(capsule.nonce, '1.0.0'), freshValue: valueFor(capsule.nonce, '1.1.0'),
  }));
});
