/** ADR 0863 D9 P3: the budget's ACTION. A Billing Budget only notifies; this
 * stops the gate VM and flags it so no Mac restarts it (the controller reads the
 * flag as fallback). Runs as openwop-ci-budget-stop@, whose only role is a custom
 * one bound on this instance. Acts only when cost >= budget; a malformed message
 * does nothing (and says so). No client library: a metadata-server token + REST. */
export const FLAG = 'openwop-ci-disabled';

export async function budgetStop(message, { project, zone, instance, fetch = globalThis.fetch, log = console.log }) {
  let data;
  try { data = JSON.parse(Buffer.from(message?.data ?? '', 'base64').toString('utf8')); }
  catch { log('budget-stop: unreadable message; no action'); return { action: 'none', reason: 'unreadable' }; }
  const cost = Number(data?.costAmount); const budget = Number(data?.budgetAmount);
  if (!Number.isFinite(cost) || !Number.isFinite(budget) || budget <= 0) { log('budget-stop: no amounts; no action'); return { action: 'none', reason: 'no amounts' }; }
  if (cost < budget) { log(`budget-stop: ${cost} < ${budget}; no action`); return { action: 'none', reason: 'under budget' }; }
  const tokenRes = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
  const { access_token: token } = await tokenRes.json();
  const zoneApi = `https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}`;
  const api = `${zoneApi}/instances/${instance}`;
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  // GCE operations are asynchronous: an accepted request is not a done one. Wait
  // and read the operation's own error (dry run 2026-11-01: setMetadata was
  // accepted, then failed SERVICE_ACCOUNT_ACCESS_DENIED, and this logged success).
  async function run(url, init) {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`${url.split('/').pop()} ${res.status}`);
    let op = await res.json();
    for (let i = 0; i < 10 && op.status !== 'DONE'; i++) {
      const w = await fetch(`${zoneApi}/operations/${op.name}/wait`, { method: 'POST', headers: auth });
      if (!w.ok) throw new Error(`wait ${w.status}`);
      op = await w.json();
    }
    if (op.status !== 'DONE') throw new Error(`${op.operationType} not done`);
    if (op.error?.errors?.length) throw new Error(`${op.operationType} failed: ${op.error.errors.map(e => e.code).join(',')}`);
    return op;
  }
  // Flag first, so no Mac restarts it even if the stop fails; then stop. Each
  // step's failure is thrown (the function errors, and Eventarc retries).
  const current = await fetch(api, { headers: auth });
  if (!current.ok) throw new Error(`get ${current.status}`);
  const { metadata } = await current.json();
  const items = (metadata.items ?? []).filter(i => i.key !== FLAG).concat({ key: FLAG, value: `budget ${cost}/${budget}` });
  await run(`${api}/setMetadata`, { method: 'POST', headers: auth, body: JSON.stringify({ fingerprint: metadata.fingerprint, items }) });
  await run(`${api}/stop`, { method: 'POST', headers: auth });
  log(`budget-stop: ${cost} >= ${budget}; set ${FLAG} and stopped ${instance} (both operations DONE without error)`);
  return { action: 'stopped', cost, budget };
}
