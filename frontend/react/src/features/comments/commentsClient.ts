/**
 * Collaboration / Comments API client (ADR 0021). Authed org-scoped threads under
 * /host/openwop-app/comments/orgs/:orgId. No public surface. The resource picker
 * composes the CMS + KB clients (listPages / listCollections) — comments reference
 * those resources, they never copy their data.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }
/**
 * The COMPLETE commentable set, mirroring the backend's `RESOURCE_TYPES`
 * (`features/comments/commentsService.ts`). The two lists are pinned together by
 * `backend/typescript/test/comments-deep-link.test.ts` § "CMNT-1 — the frontend
 * ResourceType union matches the backend set", which parses THIS declaration and
 * compares it to the backend constant (and fails loudly if its pattern stops
 * matching, rather than passing vacuously).
 *
 * CMNT-1 / CMNT-UX-1 correction: this union used to carry FOUR members while the
 * backend registered SIX (`priority_idea`, `creative_brief` had no frontend
 * representation at all), and `CommentsPage` coerced every non-`kb_collection`
 * type to `cms_page`. A notification deep-link for any of the other four
 * therefore opened a DIFFERENT resource's thread. Both halves are fixed: the
 * union is complete, and the page parses the query against `ALL_RESOURCE_TYPES`
 * rather than coercing.
 */
export type ResourceType =
  | 'cms_page' | 'kb_collection' | 'chat_message'
  | 'canvas_document' | 'priority_idea' | 'creative_brief' | 'canvas_slides';
export const ALL_RESOURCE_TYPES: readonly ResourceType[] = [
  'cms_page', 'kb_collection', 'chat_message', 'canvas_document', 'priority_idea', 'creative_brief', 'canvas_slides',
];
export function isResourceType(v: unknown): v is ResourceType {
  return typeof v === 'string' && (ALL_RESOURCE_TYPES as readonly string[]).includes(v);
}
// The subset that has a resource *picker* on `/comments`. The other four are
// anchored inline or reached by deep-link (there is no list to choose from), so
// they stay out of the selector — but they are first-class thread targets and
// the page renders them when a link names one.
export const RESOURCE_TYPES: readonly ResourceType[] = ['cms_page', 'kb_collection'];

export type CommentStatus = 'open' | 'resolved';
export interface Comment {
  commentId: string;
  orgId: string;
  resourceType: ResourceType;
  resourceId: string;
  parentId?: string;
  body: string;
  authorId: string;
  /** ADR 0659 D10 — the human an agent-authored comment was made for. */
  onBehalfOf?: string;
  status: CommentStatus;
  /** ADR 0881 D5 — the org members mentioned AND notified. */
  mentions?: string[];
  /** ADR 0881 D6 — who resolved it (an `agent:` id on the workflow lane, with the
   *  human in `resolvedOnBehalfOf`) and when; absent while open. */
  resolvedBy?: string;
  resolvedOnBehalfOf?: string;
  resolvedAt?: string;
  /** ADR 0881 D6 — set when the author changed the body. */
  editedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** ADR 0881 D7 — what the caller may do on this thread (server-authoritative). */
export interface ThreadViewer { userId: string; canWrite: boolean; canModerate: boolean }

/** A write's answer: the row, plus mentioned members who could not open the resource
 *  and so were not notified (ADR 0881 D5) — never stored on the row. */
export type CommentWrite = Comment & { unnotifiedMentions?: string[] };

const root = `${config.baseUrl}/host/openwop-app`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/**
 * CMNT-UX-9 / CMNT-UX-18 — a refusal a caller can REASON about, on EVERY lane.
 *
 * `deleteComment` threw `deleteComment returned 403`, which the panel showed
 * verbatim in a toast. The backend distinguishes two very different refusals —
 * 403 "only the author or an org admin may delete" and 409 "this comment has
 * replies from other people, an org admin is required; you can resolve it
 * instead" — and both arrived as a status code. The status now rides the error
 * so the UI can say which happened, and in the user's language.
 *
 * CMNT-UX-18 — that fix was DELETE-ONLY. `listThread`, `postComment` and
 * `updateComment` all went through `asJson`, which threw a bare `Error` carrying
 * the server's `message`, and the panel rendered it verbatim: backend prose
 * written for an API consumer (`` `body` is required and MUST be a non-empty
 * string. ``, `Only the author may edit a comment body.`, `Resource not found in
 * this organization.`) — English, with backticks and RFC-2119 keywords, to a
 * user whose UI is in `fr`/`es`/`pt-BR`. EVERY lane now throws this type, and
 * the panel maps (status, code) to a localized key and NEVER re-renders
 * `e.message`.
 *
 * `code` is the host error envelope's `error` field (`OpenwopError.toEnvelope`
 * → `{ error, message, details }`), carried so a lane can discriminate two
 * refusals that share a status. It is `undefined` for a non-JSON body — the
 * mapping must therefore never REQUIRE it.
 */
export class CommentsHttpError extends Error {
  /** `field` — the envelope's `details.field`, so a lane can name WHICH input was
   *  refused (CM2UX-8: a stale mention reads differently from bad text). */
  constructor(message: string, readonly status: number, readonly code: string | undefined = undefined, readonly field: string | undefined = undefined) {
    super(message);
    this.name = 'CommentsHttpError';
  }
}

/** Parse the host error envelope without ever letting its prose reach a user. */
async function refusal(res: Response, ctx: string): Promise<CommentsHttpError> {
  let detail = '';
  let code: string | undefined;
  let field: string | undefined;
  try {
    const body = (await res.json()) as { message?: string; error?: string; details?: { field?: unknown } };
    detail = body?.message ?? '';
    if (typeof body?.error === 'string') code = body.error;
    if (typeof body?.details?.field === 'string') field = body.details.field;
  } catch { /* non-JSON */ }
  return new CommentsHttpError(detail || `${ctx} returned ${res.status}`, res.status, code, field);
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) throw await refusal(res, ctx);
  return (await res.json()) as T;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${root}/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

const base = (orgId: string): string => `${root}/comments/orgs/${encodeURIComponent(orgId)}/comments`;

/**
 * Read one resource's thread.
 *
 * ADR 0659 D1/D2 — the route now RESOLVES the target before it reads, and
 * answers a UNIFORM `404 not_found` when the target does not exist OR the caller
 * cannot see it (a subject-bound knowledge collection they are not bound to).
 * The two cases are deliberately indistinguishable on the wire: telling a caller
 * "it exists, you just can't see it" is an existence oracle. So this client does
 * NOT try to tell them apart either, and the panel renders ONE state for both.
 * 403 is treated identically by the panel in case the final contract differs.
 */
/** The thread plus the caller's capabilities on it (ADR 0881 D7). `viewer` is `null`
 *  against a host that predates it — the panel then claims nothing about ownership. */
export async function readThread(orgId: string, resourceType: ResourceType, resourceId: string): Promise<{ comments: Comment[]; viewer: ThreadViewer | null }> {
  const q = new URLSearchParams({ resourceType, resourceId });
  const res = await fetch(`${base(orgId)}?${q.toString()}`, fetchOpts({ headers: authedHeaders() }));
  const out = await asJson<{ comments: Comment[]; viewer?: ThreadViewer }>(res, 'listThread');
  return { comments: out.comments, viewer: out.viewer ?? null };
}

export async function listThread(orgId: string, resourceType: ResourceType, resourceId: string): Promise<Comment[]> {
  return (await readThread(orgId, resourceType, resourceId)).comments;
}

export async function postComment(orgId: string, input: { resourceType: ResourceType; resourceId: string; body: string; parentId?: string; mentions?: string[] }): Promise<CommentWrite> {
  const res = await fetch(base(orgId), fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<CommentWrite>(res, 'postComment');
}

export async function updateComment(orgId: string, commentId: string, patch: { body?: string; status?: CommentStatus; mentions?: string[] }): Promise<CommentWrite> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(commentId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson<CommentWrite>(res, 'updateComment');
}

export async function deleteComment(orgId: string, commentId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/${encodeURIComponent(commentId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  // 204 No Content — there is no body to parse, so this lane cannot use `asJson`.
  if (!res.ok) throw await refusal(res, 'deleteComment');
}
