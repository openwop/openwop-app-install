/**
 * Sharing API client (ADR 0013). Authed link management under
 * /host/openwop-app/sharing/orgs/:orgId; reads CMS pages + KB collections to pick a
 * resource, and surfaces the PUBLIC /shared/:token URL.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }
// Mirrors the backend's authoritative RESOURCE_TYPES (sharingService.ts): the host
// resolves all of these. The mint picker currently offers only the two with a
// `listResources` source; the others arrive via API/feature flows and MUST still
// render a correct label in the link list (ADR 0122 Phase 4 / ADR 0116 2b).
export type ResourceType = 'cms_page' | 'kb_collection' | 'document' | 'conversation' | 'prompt' | 'commerce_quote' | 'commerce_order' | 'app_builder_canvas' | 'slides_canvas' | 'creative_brief' | 'booking_manage' | 'sign_request';
export interface ResourceRef { id: string; label: string }

export interface ShareLink {
  /** ADR 0448 P2 — the at-rest identifier. The RAW token appears only on the
   *  mint response (`MintedLink.token`) and can never be re-read later. */
  tokenHash: string;
  resourceType: ResourceType;
  resourceId: string;
  label?: string;
  cardTitle?: string;
  createdAt: string;
  expiresAt?: string;
  revoked: boolean;
  /** R2 SR-7 — the server has always counted content views (PUB-7 CAS) and
   *  accepted a mint-time view cap; the list rows carry both. */
  viewCount?: number;
  /** R3-SH1 — when the link was last viewed (absent until the first view). */
  lastViewedAt?: string;
  maxViews?: number;
  /** SHARE-UX-1 — the resource this link points at no longer resolves (the row
   *  is alive, the thing it references is gone). The server sets it only when it
   *  actually KNOWS: a failed card lookup is not an absence, and the two private
   *  capability types have no card by design and are never flagged. */
  resourceMissing?: boolean;
  /** SHARE-1 HONESTY — the link's OWNING FEATURE is toggled off for this tenant,
   *  so `resolveActiveLink` refuses the token with the uniform 404. The row still
   *  exists and the toggle is reversible, which is exactly why it needs saying:
   *  nothing else on the row distinguishes "an admin darkened this" from "this
   *  works". Set by the server, which is the only side that can know. */
  featureDisabled?: boolean;
}

/**
 * SHARE-UX-2 — the ONE status derivation for a link row, because the page used
 * to have none: "Active links" filtered on `revoked` alone and then rendered
 * "expires {past date}" underneath a heading asserting the opposite. The owner's
 * question — "which of these still work?" — was answered wrongly, and not in the
 * conservative direction: it invited re-sending a link the server will 410.
 *
 * Order matters: revocation is deliberate and outranks a lapsed clock; an
 * orphaned link is reported as orphaned rather than live, because it is the one
 * state the owner can act on (the URL still resolves the gate and then 404s).
 *
 * `feature-off` (SHARE-1 HONESTY) sits BELOW the two terminal states and ABOVE
 * `expiring`/`live`, and that placement is the whole point: a darkened link does
 * not work, so it must never fall through to a green chip or to "expires soon",
 * which are both claims that it does. Revoked and expired outrank it because
 * they are terminal — re-enabling the feature would not bring those back.
 */
export type LinkStatus = 'revoked' | 'expired' | 'cap-reached' | 'feature-off' | 'orphaned' | 'expiring' | 'live';

/** Days within which an expiry is worth flagging on the row. */
const EXPIRING_SOON_DAYS = 7;

export function linkStatus(l: ShareLink, now: number = Date.now()): LinkStatus {
  if (l.revoked) return 'revoked';
  let expiringSoon = false;
  if (l.expiresAt) {
    const exp = Date.parse(l.expiresAt);
    // An UNPARSEABLE expiry reads as expired, matching the server's own
    // fail-closed branch (`resolveActiveLink`) — the row must not claim to work
    // when the resolver would refuse it.
    if (Number.isNaN(exp) || exp <= now) return 'expired';
    expiringSoon = exp - now <= EXPIRING_SOON_DAYS * 86_400_000;
  }
  // The same bar, applied to the gate the server now enforces: `resolveActiveLink`
  // refuses every token whose owning feature is off, so a row for one of those
  // must not report a working state. Before this, such a row rendered `live`.
  // SHUX-5 — the view cap, applied at the same bar as the two states above. The
  // server refuses an exhausted link on EVERY public lane (ADR 0644 D2 closed the
  // card lane, D8 the frame-view and capability lanes), so a row for one must not
  // report a working state. It ranks BELOW revoked/expired — those are terminal in
  // a way nothing reverses — and ABOVE `feature-off`, which an admin can undo.
  // Before this, such a row rendered `live`, which is the exact class of lie this
  // function was written to remove.
  if (typeof l.maxViews === 'number' && (l.viewCount ?? 0) >= l.maxViews) return 'cap-reached';
  if (l.featureDisabled) return 'feature-off';
  if (l.resourceMissing) return 'orphaned';
  return expiringSoon ? 'expiring' : 'live';
}

/** Does this link still resolve for a recipient? */
export const isLinkLive = (l: ShareLink, now: number = Date.now()): boolean => {
  const s = linkStatus(l, now);
  // `feature-off` is NOT live — the resolver 404s it today. It is filed with the
  // dead links (where the owner can read WHY) rather than under "Active", which
  // is the heading that was asserting the opposite.
  return s === 'live' || s === 'expiring' || s === 'orphaned';
};

/** The mint response — the ONE moment the raw token (and thus the URL) exists. */
export type MintedLink = ShareLink & { token: string };

const root = `${config.baseUrl}/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

/** R2 review F1 — fetch one source-feature list for the picker. `[]` ONLY on
 *  404 (the documented best-effort case: the source feature is off, so its
 *  routes don't exist). Every other failure THROWS so the page can render its
 *  `resourcesFailed` state — the old swallow-everything shape made that state
 *  unreachable and presented a 500 as "this org has nothing to share". */
async function pickerFetch<T>(path: string, ctx: string): Promise<T | null> {
  const res = await fetch(`${root}${path}`, fetchOpts({ headers: authedHeaders() }));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${ctx} returned ${res.status}`);
  return (await res.json()) as T;
}

/** Pickable resources of a given type for the org ([] if the source feature is
 *  off; THROWS on a real failure — see `pickerFetch`). */
export async function listResources(orgId: string, type: ResourceType): Promise<ResourceRef[]> {
  if (type === 'cms_page') {
    const body = await pickerFetch<{ pages: Array<{ pageId: string; title: string; status: string }> }>(`/cms/orgs/${encodeURIComponent(orgId)}/pages`, 'list pages');
    return (body?.pages ?? []).map((p) => ({ id: p.pageId, label: `${p.title} (${p.status})` }));
  }
  // ADR 0122 Phase 5 — the backend resolves document/conversation/prompt shares; the
  // picker now lists them too (each via its owning feature's list endpoint).
  if (type === 'document') {
    const body = await pickerFetch<{ documents: Array<{ documentId: string; title: string }> }>(`/documents/orgs/${encodeURIComponent(orgId)}/documents`, 'list documents');
    return (body?.documents ?? []).map((d) => ({ id: d.documentId, label: d.title }));
  }
  if (type === 'prompt') {
    const body = await pickerFetch<{ entries: Array<{ entryId: string; name: string }> }>(`/prompts/orgs/${encodeURIComponent(orgId)}/entries`, 'list prompts');
    return (body?.entries ?? []).map((e) => ({ id: e.entryId, label: e.name }));
  }
  if (type === 'conversation') {
    // Conversations are tenant-scoped (no org path); the backend resolver validates
    // tenant membership on mint.
    const body = await pickerFetch<{ sessions: Array<{ sessionId: string; title: string }> }>('/chat/sessions', 'list conversations');
    return (body?.sessions ?? []).map((s) => ({ id: s.sessionId, label: s.title }));
  }
  if (type === 'creative_brief') {
    // R2 SR-8 — the share lane existed end-to-end (resolver + purge cascades)
    // with no mint site anywhere. Only an APPROVED brief is mintable (the
    // backend validator enforces the same rule; a demoted brief goes dark).
    const body = await pickerFetch<{ briefs: Array<{ briefId: string; title: string; status: string }> }>(`/creative-briefs/orgs/${encodeURIComponent(orgId)}/briefs`, 'list briefs');
    return (body?.briefs ?? []).filter((b) => b.status === 'approved').map((b) => ({ id: b.briefId, label: b.title }));
  }
  const body = await pickerFetch<{ collections: Array<{ collectionId: string; name: string }> }>(`/kb/orgs/${encodeURIComponent(orgId)}/collections`, 'list collections');
  return (body?.collections ?? []).map((c) => ({ id: c.collectionId, label: c.name }));
}

const linksBase = (orgId: string): string => `${root}/sharing/orgs/${encodeURIComponent(orgId)}/links`;

export async function listLinks(orgId: string): Promise<ShareLink[]> {
  const res = await fetch(linksBase(orgId), fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ links: ShareLink[] }>(res, 'listLinks')).links;
}

export async function createLink(orgId: string, input: { resourceType: ResourceType; resourceId: string; label?: string; expiresInDays?: number }): Promise<MintedLink> {
  const res = await fetch(linksBase(orgId), fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<MintedLink>(res, 'createLink');
}

/** Management ops accept the tokenHash (list rows) or a raw token (mint-time). */
export async function revokeLink(orgId: string, token: string): Promise<void> {
  const res = await fetch(`${linksBase(orgId)}/${encodeURIComponent(token)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`revokeLink returned ${res.status}`);
}

/** The raw public API endpoint for a token (returns JSON). */
const sharedUrl = (token: string): string => `${root}/shared/${encodeURIComponent(token)}`;

/** The user-facing SPA viewer URL for a token — what you hand to a recipient
 *  (renders the read-only page, NOT raw JSON). ADR 0122 Phase 6. */
export const sharedPageUrl = (token: string): string => `${window.location.origin}/shared/${encodeURIComponent(token)}`;

/** A resolved public share (the shape the public, unauthenticated endpoint returns). */
export interface SharedResource {
  resourceType: ResourceType;
  label?: string;
  resource: Record<string, unknown>;
  /** When this content was captured. R2 SR-3: present ONLY for types the
   *  server actually snapshots (conversations); absent ⇒ the view is LIVE and
   *  the viewer must say so instead of claiming a snapshot date. */
  snapshotAt?: string;
  /** When the link stops working, when the owner set an expiry. */
  expiresAt?: string;
}

/** R2 SR-2/SR-10 — why a public resolve failed, so the viewer can tell the
 *  truth: `expired` (the server's 410) and `gone` (404 — revoked or never
 *  existed, deliberately indistinguishable) are terminal; `unavailable`
 *  (network / 5xx) is retryable and must NEVER claim the link is dead.
 *
 *  SHARE-UX-1 adds `resourceGone`: the server ALWAYS distinguished "the link is
 *  dead" (`'Shared link not found.'`) from "the link is fine, the thing it
 *  pointed at was deleted" (`'Shared resource not found.'`), and this client read
 *  only `res.status` — so the recipient of a link whose document was deleted was
 *  told, in the app's voice, that the owner had probably revoked it. The owner
 *  did nothing of the kind. The distinction now rides `details.reason` rather
 *  than a message string, so it survives rewording and translation. */
export type SharedResolveFailure = 'expired' | 'gone' | 'resourceGone' | 'unavailable';

/** Resolve a share token on the PUBLIC, unauthenticated surface (no auth headers —
 *  the unguessable token is the credential). Used by the public viewer page.
 *  Throws an Error carrying `kind: SharedResolveFailure`. */
export async function resolveSharedPublic(token: string): Promise<SharedResource> {
  let res: Response;
  try { res = await fetch(sharedUrl(token)); }
  catch { throw Object.assign(new Error('resolveShared network failure'), { kind: 'unavailable' as SharedResolveFailure }); }
  if (res.status === 410) throw Object.assign(new Error('expired'), { kind: 'expired' as SharedResolveFailure });
  if (res.status === 404) {
    // A 404 whose body says WHY. Absent/unparseable ⇒ `gone`, the conservative
    // reading: never invent "the content was deleted" from a body we could not
    // read, because that would be a new false claim replacing the old one.
    let reason: unknown;
    try { reason = ((await res.json()) as { details?: { reason?: unknown } })?.details?.reason; } catch { /* non-JSON body */ }
    const kind: SharedResolveFailure = reason === 'resource-gone' ? 'resourceGone' : 'gone';
    throw Object.assign(new Error(String(kind)), { kind });
  }
  if (!res.ok) throw Object.assign(new Error(`resolveShared returned ${res.status}`), { kind: 'unavailable' as SharedResolveFailure });
  return (await res.json()) as SharedResource;
}

/** ADR 0328 P7 — per-frame view tallies for one link (owner surface). */
export async function listFrameViews(orgId: string, token: string): Promise<{ frame: number; count: number }[]> {
  const res = await fetch(`${linksBase(orgId)}/${encodeURIComponent(token)}/frame-views`, fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ frames: { frame: number; count: number }[] }>(res, 'list frame views');
  return body.frames;
}
