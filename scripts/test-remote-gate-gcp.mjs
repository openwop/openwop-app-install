import assert from 'node:assert/strict';
import test from 'node:test';
import { DISABLED_FLAG, instanceDecision } from './lib/remote-gate-gcp.mjs';

// ADR 0863 D9 P3, release-manager requirement 6: the disabled flag, an unreadable
// instance, or a state a Mac cannot start from is fallback (gate locally), never
// red and never a start. Pure decision; no GCE call.
const vm = (status, items = []) => ({ status, metadata: { items } });

test('the disabled flag is fallback in every state, including RUNNING', () => {
  for (const status of ['RUNNING', 'TERMINATED', 'STAGING']) {
    const d = instanceDecision(vm(status, [{ key: DISABLED_FLAG, value: 'budget' }]));
    assert.match(d.fallback, /disabled \(budget\)/);
    assert.equal(d.action, undefined, `${status}: never started or used`);
  }
});

test('running is ready; stopped is started; transitions wait; anything else falls back', () => {
  assert.deepEqual(instanceDecision(vm('RUNNING')), { action: 'ready' });
  assert.deepEqual(instanceDecision(vm('TERMINATED')), { action: 'start' });
  for (const s of ['PROVISIONING', 'STAGING', 'STOPPING', 'SUSPENDING']) assert.deepEqual(instanceDecision(vm(s)), { action: 'wait' });
  assert.match(instanceDecision(vm('SUSPENDED')).fallback, /suspended/);
  assert.match(instanceDecision(vm('REPAIRING')).fallback, /repairing/);
  assert.match(instanceDecision(null).fallback, /unreadable/);
});
