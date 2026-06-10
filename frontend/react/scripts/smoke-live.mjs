#!/usr/bin/env node
/**
 * Live contract smoke against a deployed backend (default app.openwop.dev).
 *
 * Verifies — against REAL production infra — the request/response contract the
 * frontend client layer depends on (requestJson / runsClient / byokClient /
 * classifyHttpError). This is the real-infra counterpart to the mocked unit
 * tests; it is NOT wired into CI (it makes live network calls). Run manually:
 *
 *   npm run smoke:live                       # app.openwop.dev
 *   SMOKE_BASE=https://host/api npm run smoke:live
 *
 * It does NOT require auth: it asserts the anon-session issuance + the
 * sign-in/auth gate the SPA handles, not a full LLM completion (that needs a
 * signed-in/BYOK credential the smoke deliberately doesn't carry).
 */
const BASE = process.env.SMOKE_BASE ?? 'https://app.openwop.dev/api';
let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};

// Carry cookies across calls so the anon-session issued on the first request
// is reused (mirrors the SPA's cookie-mode auth).
let cookie = '';
async function call(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
  // undici exposes set-cookie via getSetCookie(); headers.get('set-cookie') is null.
  const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (sc.length > 0) cookie = sc[0].split(';')[0];
  return res;
}

console.log(`Live smoke → ${BASE}\n`);

// 1. readiness
{
  const res = await call('/readiness');
  ok('readiness → 200', res.status === 200, `got ${res.status}`);
}

// 2. capabilities shape the discovery/runs clients depend on
{
  const res = await call('/.well-known/openwop');
  ok('capabilities → 200', res.status === 200, `got ${res.status}`);
  const caps = await res.json().catch(() => ({}));
  ok('capabilities.protocolVersion present', typeof caps.protocolVersion === 'string', String(caps.protocolVersion));
  ok('capabilities.stream.modes includes updates', Array.isArray(caps.stream?.modes) && caps.stream.modes.includes('updates'));
  ok('capabilities.aiProviders.supported non-empty', Array.isArray(caps.aiProviders?.supported) && caps.aiProviders.supported.length > 0,
    JSON.stringify(caps.aiProviders?.supported));
}

// 4. BYOK secrets endpoint reachable for anon (byokClient.listStoredRefs contract)
{
  const res = await call('/v1/host/sample/byok/secrets');
  ok('byok/secrets → 200', res.status === 200, `got ${res.status}`);
  if (res.status === 200) {
    const body = await res.json().catch(() => ({}));
    ok('byok response has credentialRefs[]', Array.isArray(body.credentialRefs));
  }
}

// 5. chat dispatch auth gate — the error path classifyHttpError + the chat
//    dispatcher must handle. Anon + managed provider → 401 sign_in_required.
{
  const res = await call('/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      workflowId: 'sample.chat.turn',
      inputs: { provider: 'openai', model: 'gpt-4o-mini', credentialRef: 'managed:openai', messages: [{ role: 'user', content: 'hi' }] },
    }),
  });
  ok('anon chat dispatch → 401 (auth-gated)', res.status === 401, `got ${res.status}`);
  const body = await res.json().catch(() => ({}));
  ok('error envelope has error+message', typeof body.error === 'string' && typeof body.message === 'string',
    `${body.error}: ${body.message}`);
}

// 6. an anon session cookie was issued along the way (cookie-mode auth seam)
ok('anon session cookie issued', cookie.length > 0, cookie ? cookie.split('=')[0] : 'none');

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
