/**
 * Memory auto-extraction consent client (ADR 0120) — drives the caller's OWN
 * opt-in grant at /host/openwop-app/profiles/me/memory-extraction.
 *
 * The grant is the fail-closed gate for the whole feature: extraction only runs
 * for a person who has explicitly opted in, and only on chats in their personal
 * workspace (ADR 0982 D1). Learned facts land as `source:'auto-extract'` notes in
 * the SAME store the Personal Memory tab lists (ADR 0041) — there is no separate
 * review surface.
 *
 * A 404 means the route is not registered; callers hide the control (null).
 * A 401 means the caller is anonymous: the server refuses them a grant (they
 * could never open what it writes), so it is reported as "unavailable: sign in",
 * which is a true statement that learning is OFF — never as a load failure.
 *
 * @see docs/adr/0120-chat-memory-auto-extraction.md
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { apiErrorFrom } from '../../client/errorEnvelope.js';
import i18n from '../../i18n/index.js';

const PATH = `${config.baseUrl}/host/openwop-app/profiles/me/memory-extraction`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

export interface ExtractionGrant {
  granted: boolean;
  updatedAt: string | null;
  /** ADR 0982 D2 — false when this account can never extract. */
  available: boolean;
  /** Why it is unavailable, when it is. */
  unavailableReason?: 'sign-in' | 'no-personal-workspace';
}

/** Read the caller's consent grant. Returns null when the feature is unavailable (404). */
export async function getExtractionGrant(): Promise<ExtractionGrant | null> {
  const res = await fetch(PATH, fetchOpts({ headers: authedHeaders() }));
  if (res.status === 404) return null;
  if (res.status === 401) return { granted: false, updatedAt: null, available: false, unavailableReason: 'sign-in' };
  // TWIN-UX-6 — localized at the throw site; the server's prose wins when present.
  if (!res.ok) throw await apiErrorFrom(res, i18n.t('profile-memory:consentError'));
  const body = (await res.json()) as { granted: boolean; updatedAt: string | null; available?: boolean };
  const available = body.available !== false;
  return { granted: body.granted, updatedAt: body.updatedAt, available, ...(available ? {} : { unavailableReason: 'no-personal-workspace' as const }) };
}

/** Opt in (true) or out (false). Returns the resulting grant state. */
export async function setExtractionGrant(granted: boolean): Promise<ExtractionGrant> {
  const res = granted
    ? await fetch(PATH, fetchOpts({ method: 'PUT', headers: jsonHeaders() }))
    : await fetch(PATH, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  // TWIN-DEBT-4 — `!res.ok && res.status !== 204` was an unreachable condition:
  // 204 IS ok, so the second clause never fired. Kept honest as a plain !ok.
  if (!res.ok) throw await apiErrorFrom(res, i18n.t('profile-memory:consentError'));
  return granted ? ((await res.json()) as ExtractionGrant) : { granted: false, updatedAt: null, available: true };
}
