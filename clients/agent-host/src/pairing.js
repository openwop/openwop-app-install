// ADR 0785 D3 — the companion's half of device-code pairing.
//
// start → show the code and the approval link → poll at the interval the host
// asked for until approved / denied / expired. The host returns the developer
// key exactly once, on the first poll after approval.

// The canonical, version-agnostic root (ADR 0652): it answers with or without a
// version header and does not retire with /v1, so a companion installed today
// keeps pairing after the /v1 cutover.
const PAIR_PREFIX = '/host/openwop-app/claude-code/pair/device';

export function normalizeHost(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(`Refusing a non-https host (${url.origin}). Use https, or localhost for development.`);
  }
  return url.origin;
}

/** Where API calls go: `host` + a same-origin path, or an absolute API base. */
export function apiRootFor(host, apiBase) {
  if (apiBase && /^https?:\/\//i.test(apiBase)) return normalizeApiOrigin(apiBase);
  return `${host}${apiBase ?? ''}`;
}

/** The backend base. A Firebase-fronted app serves its API under a path on the
 *  same origin (`/api`); another deploy may serve it from a different origin
 *  (`https://api.example.com`). `apiBase` takes either; the approval link always
 *  stays on `host`, the app origin the user signs in to. */
function apiUrl(host, apiBase, path) {
  if (apiBase && /^https?:\/\//i.test(apiBase)) return `${normalizeApiOrigin(apiBase)}${path}`;
  return `${host}${apiBase ?? ''}${path}`;
}

function normalizeApiOrigin(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(`Refusing a non-https API base (${url.origin}).`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * The host's DIRECT origin for long-lived connections, read from its discovery
 * record (`extensions["openwop-app.host"].streamBase`, ADR 0761). A front door
 * such as Firebase Hosting's rewrite passes plain HTTP but drops the WebSocket
 * `Upgrade` and buffers streams, so the device socket, MCP and the permission
 * long-poll must bypass it (ADR 0785, measured 2026-10-04: a device upgrade
 * through the door answered 404, the direct origin 401).
 *
 * Accepted only as the host itself validates it: https (localhost http for
 * development), no credentials, no query or fragment. Anything else, or any
 * failure to read discovery, is null: the caller keeps the paired root.
 */
export function validStreamBase(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url;
  try { url = new URL(raw.trim()); } catch { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export async function discoverStreamBase(apiRoot, { fetchFn = fetch, timeoutMs = 5000 } = {}) {
  try {
    const res = await fetchFn(`${apiRoot}/.well-known/openwop`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const json = await res.json();
    return validStreamBase(json?.extensions?.['openwop-app.host']?.streamBase);
  } catch {
    return null;
  }
}

/** Where a paired companion sends its traffic: the direct origin when the host
 *  advertised one, else the root it was paired against. */
export function serviceRootFor(credential) {
  return validStreamBase(credential?.streamBase) ?? apiRootFor(credential.host, credential.apiBase);
}

async function postJson(fetchFn, url, body) {
  const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, json };
}

export async function startPairing({ host, apiBase, label, platform, fetchFn = fetch }) {
  const { status, json } = await postJson(fetchFn, apiUrl(host, apiBase, `${PAIR_PREFIX}/start`), { label, platform });
  if (status === 404) throw new Error('This host does not offer Claude Code pairing (the operator has not enabled it).');
  if (status === 429) throw new Error('Too many pairing attempts from this network. Wait a few minutes and try again.');
  if (status !== 201 || !json?.deviceCode) throw new Error(`Pairing could not start (HTTP ${status}).`);
  return { ...json, verificationUrl: `${host}${json.verificationPath}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until the pairing resolves. Resolves `{ status: 'approved', token, ... }`
 * or `{ status: 'denied' }` / `{ status: 'expired' }`. Never throws on a
 * pending poll; network errors are retried until the code expires.
 */
export async function waitForApproval({ host, apiBase, deviceCode, interval, expiresIn, fetchFn = fetch, sleepFn = sleep, now = Date.now }) {
  const deadline = now() + expiresIn * 1000;
  let waitS = Math.max(1, interval);
  while (now() < deadline) {
    await sleepFn(waitS * 1000);
    let res;
    try {
      res = await postJson(fetchFn, apiUrl(host, apiBase, `${PAIR_PREFIX}/poll`), { deviceCode });
    } catch {
      continue; // transient network error: keep polling until the code expires
    }
    if (res.status === 404) return { status: 'expired' };
    if (res.status === 429) { waitS = Math.min(waitS * 2, 60); continue; }
    if (res.status !== 200 || !res.json) continue;
    if (res.json.status === 'pending') { waitS = Math.max(1, res.json.interval ?? waitS); continue; }
    return res.json; // approved | denied | failed (with a message the host wrote for a person)
  }
  return { status: 'expired' };
}
