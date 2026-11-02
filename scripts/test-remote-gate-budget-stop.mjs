import assert from 'node:assert/strict';
import test from 'node:test';
import { budgetStop, FLAG } from './remote-gate-budget-stop/handler.mjs';

// ADR 0863 D9 P3: the budget action. Only cost >= budget stops and flags the VM;
// the target is fixed by the deployment, not the message. Fake fetch, no GCE.
const target = { project: 'p', zone: 'z', instance: 'i', log: () => {} };
const msg = body => ({ data: Buffer.from(JSON.stringify(body)).toString('base64') });
function fakeFetch({ fail } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push([init.method ?? 'GET', url, init.body ? JSON.parse(init.body) : undefined]);
    const json = url.includes('/token') ? { access_token: 't' }
      : url.endsWith('/wait') ? { name: 'op', operationType: url.includes('op-set') ? 'setMetadata' : 'stop', status: 'DONE',
        ...(fail && url.includes(fail) ? { error: { errors: [{ code: 'SERVICE_ACCOUNT_ACCESS_DENIED' }] } } : {}) }
        : url.endsWith('/setMetadata') ? { name: 'op-set', status: 'RUNNING' }
          : url.endsWith('/stop') ? { name: 'op-stop', status: 'RUNNING' }
            : { metadata: { fingerprint: 'fp', items: [{ key: 'keep', value: 'v' }, { key: FLAG, value: 'old' }] } };
    return { ok: true, status: 200, json: async () => json };
  };
  return { fetch, calls };
}

test('at or over budget: sets the flag with the fingerprint, then stops, waiting on both operations', async () => {
  const f = fakeFetch();
  const out = await budgetStop(msg({ costAmount: 200, budgetAmount: 200 }), { ...target, fetch: f.fetch });
  assert.equal(out.action, 'stopped');
  const methods = f.calls.map(([m, u]) => `${m} ${u.replace(/^.*\/zones\/z/, '…')}`);
  assert.deepEqual(methods.slice(1), ['GET …/instances/i', 'POST …/instances/i/setMetadata', 'POST …/operations/op-set/wait',
    'POST …/instances/i/stop', 'POST …/operations/op-stop/wait']);
  const body = f.calls[2][2];
  assert.equal(body.fingerprint, 'fp');
  assert.deepEqual(body.items.map(i => i.key), ['keep', FLAG], 'other metadata kept, one flag');
});

test('a failed operation is an error, never a logged success', async () => {
  const f = fakeFetch({ fail: 'op-set' });
  await assert.rejects(budgetStop(msg({ costAmount: 250, budgetAmount: 200 }), { ...target, fetch: f.fetch }), /setMetadata failed: SERVICE_ACCOUNT_ACCESS_DENIED/);
});

test('under budget, or a malformed message: nothing is called', async () => {
  for (const m of [msg({ costAmount: 199.99, budgetAmount: 200 }), msg({ budgetAmount: 200 }), { data: '!!' }, undefined]) {
    const f = fakeFetch();
    assert.equal((await budgetStop(m, { ...target, fetch: f.fetch })).action, 'none');
    assert.equal(f.calls.length, 0);
  }
});
