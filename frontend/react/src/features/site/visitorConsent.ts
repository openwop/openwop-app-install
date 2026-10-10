/**
 * ADR 0860 D5 — a public visitor's analytics choice, and the ONE rule for when the
 * first-party visitor key may exist on the device.
 *
 * THE RECORD OF TRUTH is server-side, on the existing public consent lane
 * (`/public-consent/:orgId`, ADR 0586 / CONS-2): every choice is POSTed there, and
 * the `subjectToken` it returns rides the beacon, the page read and the funnel
 * routes, so the server applies the same choice (ADR 0857 D3). This module keeps
 * only what the device needs to remember the choice — the token and the boolean,
 * per org, in `localStorage['owp:consent']` (storage the choice itself needs).
 *
 * THE DECISION for an org:
 *   - a stored choice ⇒ that choice;
 *   - else the posture the server reports for this request (`opt-out` ⇒ allowed,
 *     `opt-in` ⇒ denied — the region-aware default, ADR 0860 D2);
 *   - else `unknown` (posture not loaded, failed or 404): nothing is written AND
 *     an already-stored key is not sent.
 *
 * THE KEY is `owp:vk:<orgId>` (architect M2: one key per org, so a refusal on one
 * site never deletes another's, and no single identifier is shared across
 * tenants). It is written only under `allowed` and REMOVED under `denied` — which
 * also clears the key every earlier visitor got before consent existed. The legacy
 * origin-wide `owp:vk` is deleted on first use, unconditionally.
 *
 * Storage can throw (private mode, blocked site data): the choice is also held in
 * memory for the tab, so a visitor is never re-asked within one session.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { config } from '../../client/config.js';

export type ConsentRegime = 'opt-in' | 'opt-out';
export type ConsentDecision = 'allowed' | 'denied' | 'unknown';
interface StoredChoice { token?: string; analytics: boolean; at: string }

const CHOICES_KEY = 'owp:consent';
const LEGACY_VK = 'owp:vk';
const vkKey = (orgId: string): string => `owp:vk:${orgId}`;
const LANE = (orgId: string): string => `${config.baseUrl}/host/openwop-app/public-consent/${encodeURIComponent(orgId)}`;

const memChoices = new Map<string, StoredChoice>();
const postures = new Map<string, Promise<ConsentRegime | null>>();
const regimes = new Map<string, ConsentRegime | null>();
const listeners = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  listeners.forEach((l) => l());
}

function storage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

function readChoices(): Record<string, StoredChoice> {
  try {
    const raw = storage()?.getItem(CHOICES_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, StoredChoice>) : {};
  } catch { return {}; }
}

function writeChoice(orgId: string, choice: StoredChoice): void {
  memChoices.set(orgId, choice);
  try { storage()?.setItem(CHOICES_KEY, JSON.stringify({ ...readChoices(), [orgId]: choice })); } catch { /* the in-memory copy holds for this tab */ }
}

/** The visitor's recorded choice for this org, or null. */
export function storedChoice(orgId: string): StoredChoice | null {
  const mem = memChoices.get(orgId);
  if (mem) return mem;
  const c = readChoices()[orgId];
  return c && typeof c.analytics === 'boolean' ? c : null;
}

/** The regime the server reports for this request, fetched once per org per tab.
 *  Any failure (network, 404 because the lane is off) resolves to `null`. */
export function loadPosture(orgId: string): Promise<ConsentRegime | null> {
  let p = postures.get(orgId);
  if (!p) {
    p = (async (): Promise<ConsentRegime | null> => {
      // `null` is UNKNOWN, never "no consent needed": it renders no banner and
      // writes no key, so a failed read fails closed without claiming anything.
      let regime: ConsentRegime | null = null;
      try {
        const r = await fetch(`${LANE(orgId)}/posture`);
        const body = r.ok ? ((await r.json()) as { regime?: unknown }) : {};
        if (body.regime === 'opt-in' || body.regime === 'opt-out') regime = body.regime;
      } catch { /* unknown */ }
      regimes.set(orgId, regime);
      emit();
      return regime;
    })();
    postures.set(orgId, p);
  }
  return p;
}

export function regimeFor(orgId: string): ConsentRegime | null | undefined {
  return regimes.has(orgId) ? regimes.get(orgId) : undefined;
}

export function decisionFor(orgId: string): ConsentDecision {
  const c = storedChoice(orgId);
  if (c) return c.analytics ? 'allowed' : 'denied';
  const regime = regimes.get(orgId);
  if (regime === 'opt-out') return 'allowed';
  if (regime === 'opt-in') return 'denied';
  return 'unknown';
}

function removeKey(orgId: string): void {
  try { storage()?.removeItem(vkKey(orgId)); } catch { /* nothing stored */ }
}

/**
 * The org's visitor key, applying the decision. `allowed` ⇒ the stored key (minted
 * once); `denied` ⇒ the key is removed and null returned; `unknown` ⇒ null and
 * nothing written. Call from effects and handlers, never during render (it may
 * write storage).
 */
export function getVisitorKey(orgId: string): string | null {
  if (!orgId) return null;
  const s = storage();
  try { s?.removeItem(LEGACY_VK); } catch { /* best-effort */ }
  const decision = decisionFor(orgId);
  if (decision === 'denied') { removeKey(orgId); return null; }
  if (decision === 'unknown' || !s) return null;
  try {
    const existing = s.getItem(vkKey(orgId));
    if (existing) return existing;
    const minted = `vk-${crypto.randomUUID()}`;
    s.setItem(vkKey(orgId), minted);
    return minted;
  } catch {
    return null;
  }
}

/** The consent-lane token to send with this org's analytics calls, if any. */
export function consentTokenFor(orgId: string): string | undefined {
  return storedChoice(orgId)?.token;
}

async function postChoice(orgId: string, analytics: boolean, token: string | undefined): Promise<Response> {
  return fetch(LANE(orgId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ categories: { analytics }, ...(token ? { subjectToken: token } : {}) }),
  });
}

/**
 * Record a choice on the consent lane, then remember it. A refusal is remembered
 * (and the key removed) even when the POST fails — failing closed is always safe —
 * but the failure still throws so the banner can say so. A grant that fails is NOT
 * remembered: no token means the server would refuse anyway.
 */
export async function recordChoice(orgId: string, analytics: boolean): Promise<void> {
  const at = new Date().toISOString();
  try {
    let token = storedChoice(orgId)?.token;
    let r = await postChoice(orgId, analytics, token);
    // A token the server no longer accepts (a rotated secret) is discarded and a
    // fresh one minted; the 400 names exactly that exit (consent/routes.ts).
    if (r.status === 400 && token) { token = undefined; r = await postChoice(orgId, analytics, undefined); }
    if (!r.ok) throw new Error(String(r.status));
    const body = (await r.json()) as { subjectToken?: unknown };
    const minted = typeof body.subjectToken === 'string' ? body.subjectToken : token;
    writeChoice(orgId, { ...(minted ? { token: minted } : {}), analytics, at });
  } catch (err) {
    const kept = storedChoice(orgId)?.token;
    if (!analytics) writeChoice(orgId, { ...(kept ? { token: kept } : {}), analytics: false, at });
    throw err;
  } finally {
    getVisitorKey(orgId); // apply: mint on allow, remove on deny
    emit();
  }
}

const repaired = new Set<string>();
/**
 * grade-code M4 — a stored token the server refuses (a rotated session secret)
 * would otherwise keep a visitor who chose "allow" dark forever, because the
 * beacon's 400 is swallowed. A beacon that sees `field:'consentToken'` calls this:
 * the visitor's SAME choice is re-recorded once per tab, which mints a fresh token
 * (`recordChoice` discards a refused one). Best-effort.
 */
export async function repairConsentTokenFrom(orgId: string, res: Response): Promise<void> {
  if (res.status !== 400 || repaired.has(orgId)) return;
  const c = storedChoice(orgId);
  if (!c?.token) return;
  try {
    const body = (await res.json()) as { error?: { details?: { field?: unknown } }; details?: { field?: unknown } };
    const field = body.error?.details?.field ?? body.details?.field;
    if (field !== 'consentToken') return;
  } catch { return; }
  repaired.add(orgId);
  writeChoice(orgId, { analytics: c.analytics, at: c.at });
  try { await recordChoice(orgId, c.analytics); } catch { /* stays tokenless; the server decides by region */ }
}

export function subscribeVisitorConsent(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** React binding: re-renders on any choice or posture change, and loads the
 *  posture for `orgId` once. */
export function useVisitorConsent(orgId: string): { decision: ConsentDecision; regime: ConsentRegime | null | undefined; choice: StoredChoice | null } {
  useSyncExternalStore(subscribeVisitorConsent, () => version, () => version);
  useEffect(() => { if (orgId) void loadPosture(orgId); }, [orgId]);
  return { decision: decisionFor(orgId), regime: regimeFor(orgId), choice: storedChoice(orgId) };
}

/** Test seam — module state is per page load. */
export function __resetVisitorConsentForTests(): void {
  memChoices.clear(); postures.clear(); regimes.clear(); repaired.clear(); emit();
}
