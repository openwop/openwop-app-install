/**
 * Collaboration / Comments service (host-extension, ADR 0021). Threaded comments
 * that REFERENCE a `(resourceType, resourceId)` — they never copy resource data.
 * A static resolver registry validates that the target is in the caller's org
 * (the Sharing 0013 lesson: one map, a new commentable type is one entry) and
 * yields the resource's title + owner for the notification emit (Phase 2). The
 * comment thread store is the single source of truth for threads; CMS (0009) /
 * KB (0011) bodies stay in their own services.
 *
 * @see docs/adr/0021-comments.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { type SubjectCaller, subjectReadAllowed } from '../../host/subjectAccess.js';
import { cleanString } from '../../host/boundedStrings.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { getPage } from '../cms/cmsService.js';
import { getAsset, type MediaAsset } from '../media/mediaService.js';
import { getBrief as getCreativeBrief } from '../creative-briefs/creativeBriefsService.js';
import { getList as getPriorityList, listRankedIdeas } from '../priority-matrix/priorityMatrixService.js';
import { getCollection } from '../kb/kbService.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { getCanvasForTenant } from '../../host/canvasSurface.js';
import { getConversationMeta } from '../../host/conversationStore.js';
import { isVisibleToAsync } from '../../host/conversationVisibility.js';
import { listMembers } from '../../host/accessControlService.js';
import { emitHostEvent, type HostEventOrigin } from '../../host/hostEventDispatcher.js';
import type { ToggleSubject } from '../../host/featureToggles/types.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('features.comments');

// ADR 0081 P5 — a comment's `body` is author free-text (may name/quote people); declare
// it for log-masking (ADR 0077). `authorId` is an opaque principal id (RFC 0048), not PII.
declarePiiFields('comments.comment', ['body']);

// ADR 0021 (extension) — `chat_message` makes an inline chat message commentable
// (inline comments on agent output), via the SAME one-map-entry pattern as cms/kb.
// The resourceId is
// `${sessionId}#${messageId}`: the sessionId is validated by tenant ownership, the
// messageId is the opaque UI anchor. v1 is INTRA-TENANT (a chat session is
// tenant-private, unlike the org-shared cms/kb resources); cross-tenant comments on
// a SHARED session (RFC 0122 share grant) are a follow-up (see ADR).
export type ResourceType = 'cms_page' | 'kb_collection' | 'chat_message' | 'priority_idea' | 'canvas_document' | 'creative_brief' | 'canvas_slides' | 'media_asset';
export const RESOURCE_TYPES: readonly ResourceType[] = ['cms_page', 'kb_collection', 'chat_message', 'priority_idea', 'canvas_document', 'creative_brief', 'canvas_slides', 'media_asset'];

export type CommentStatus = 'open' | 'resolved';

/** ADR 0947 D2 — THE scope every comment-write lane checks (HTTP, chat tool,
 *  workflow surface): a reviewer role can annotate without workspace edit rights,
 *  and `workspace:write` implies it (accessControlService `unionScopes`). */
export const COMMENT_WRITE_SCOPE = 'host:comments:write' as const;

/** ADR 0947 D2 — where on the subject a comment points, and which version of it. */
export type AnchorRect = { x: number; y: number; w: number; h: number };
export type AnchorTarget =
  | { kind: 'region'; x: number; y: number; w: number; h: number }
  | { kind: 'point'; x: number; y: number }
  | { kind: 'timecode'; startMs: number; endMs?: number; region?: AnchorRect }
  | { kind: 'element'; sectionId: string; field?: string };
export interface CommentAnchor {
  /** The subject version annotated (a media content hash, a CMS page version). */
  subjectVersion: string;
  target: AnchorTarget;
}
/** ADR 0947 D2 — a `change-request` blocks its review stage until resolved (ADR 0947 D3). */
export type CommentIntent = 'note' | 'change-request';
/** ADR 0947 D2 — a client sees `shared` only (ADR 0947 D6). Default `internal`. */
export type CommentVisibility = 'internal' | 'shared';

export interface Comment {
  commentId: string;
  tenantId: string;
  orgId: string;
  resourceType: ResourceType;
  resourceId: string;
  parentId?: string;
  body: string;
  authorId: string;
  /** ADR 0659 D10 — the human principal an agent-authored comment was made FOR. Absent on
   *  a human-authored row (where `authorId` already is that principal). */
  onBehalfOf?: string;
  status: CommentStatus;
  /** ADR 0881 D5 — the org members this comment @mentioned AND notified (a member who
   *  could not see the target is never stored here; see `unnotifiedMentions`). */
  mentions?: string[];
  /** ADR 0881 D6 — who resolved it and when; cleared on reopen. `resolvedBy` is
   *  `agent:<runId>` on the workflow lane, with the human in `resolvedOnBehalfOf`. */
  resolvedBy?: string;
  resolvedOnBehalfOf?: string;
  resolvedAt?: string;
  /** ADR 0881 D6 — set when the author changed the body. */
  editedAt?: string;
  /** ADR 0947 D2 — a pin on the subject at one version. Root comments only;
   *  immutable after create (a pin never moves onto another version). */
  anchor?: CommentAnchor;
  /** ADR 0947 D2 — absent ⇒ `note`. */
  intent?: CommentIntent;
  /** ADR 0947 D2 — absent ⇒ `internal`. */
  visibility?: CommentVisibility;
  createdAt: string;
  updatedAt: string;
}

const MAX = { body: 4000, mentions: 20, participants: 50 } as const;

/** ADR 0947 D2 — the version a media annotation is made on (see the `media_asset` target). */
export function mediaSubjectVersion(a: Pick<MediaAsset, 'assetId' | 'contentHash'>): string {
  return a.contentHash ?? `legacy:${a.assetId}`;
}

/** No asset carries a duration yet (ADR 0947 Q5: accept and bound). 24 h. */
const MAX_TIMECODE_MS = 24 * 60 * 60 * 1000;

function anchorError(message: string, reason: string): OpenwopError {
  return new OpenwopError('validation_error', message, 400, { field: 'anchor', reason });
}

const unit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
function closedKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw anchorError(`\`${where}\` has unknown properties: ${extra.join(', ')}.`, 'unknown_property');
}
function parseRect(raw: unknown, where: string): AnchorRect {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw anchorError(`\`${where}\` must be an object.`, 'bad_shape');
  const r = raw as Record<string, unknown>;
  closedKeys(r, ['kind', 'x', 'y', 'w', 'h'], where);
  const { x, y, w, h } = r;
  if (!unit(x) || !unit(y) || !unit(w) || !unit(h) || w === 0 || h === 0 || x + w > 1 || y + h > 1) {
    throw anchorError(`\`${where}\` must be a normalised box inside the subject (x, y, w, h in 0–1, w and h above 0).`, 'out_of_range');
  }
  return { x, y, w, h };
}

/** ADR 0947 D2 — closed-world parse of an anchor's SHAPE; the target checks it against the subject. */
export function parseAnchor(raw: unknown): CommentAnchor {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw anchorError('`anchor` must be an object.', 'bad_shape');
  const a = raw as Record<string, unknown>;
  closedKeys(a, ['subjectVersion', 'target'], 'anchor');
  const subjectVersion = typeof a.subjectVersion === 'string' ? a.subjectVersion.trim() : '';
  if (!subjectVersion || subjectVersion.length > 200) throw anchorError('`anchor.subjectVersion` is required.', 'missing_version');
  const t = a.target;
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw anchorError('`anchor.target` must be an object.', 'bad_shape');
  const tr = t as Record<string, unknown>;
  switch (tr.kind) {
    case 'region': {
      const rect = parseRect(tr, 'anchor.target');
      return { subjectVersion, target: { kind: 'region', ...rect } };
    }
    case 'point': {
      closedKeys(tr, ['kind', 'x', 'y'], 'anchor.target');
      if (!unit(tr.x) || !unit(tr.y)) throw anchorError('A point needs x and y in 0–1.', 'out_of_range');
      return { subjectVersion, target: { kind: 'point', x: tr.x, y: tr.y } };
    }
    case 'timecode': {
      closedKeys(tr, ['kind', 'startMs', 'endMs', 'region'], 'anchor.target');
      const { startMs, endMs } = tr;
      if (typeof startMs !== 'number' || !Number.isInteger(startMs) || startMs < 0 || startMs > MAX_TIMECODE_MS) {
        throw anchorError('`startMs` must be a whole number of milliseconds from 0.', 'out_of_range');
      }
      if (endMs !== undefined && (typeof endMs !== 'number' || !Number.isInteger(endMs) || endMs <= startMs || endMs > MAX_TIMECODE_MS)) {
        throw anchorError('`endMs` must be after `startMs`.', 'out_of_range');
      }
      const region = tr.region === undefined ? undefined : parseRect(tr.region, 'anchor.target.region');
      return { subjectVersion, target: { kind: 'timecode', startMs, ...(endMs !== undefined ? { endMs: endMs as number } : {}), ...(region ? { region } : {}) } };
    }
    case 'element': {
      closedKeys(tr, ['kind', 'sectionId', 'field'], 'anchor.target');
      const sectionId = typeof tr.sectionId === 'string' ? tr.sectionId.trim() : '';
      if (!sectionId || sectionId.length > 200) throw anchorError('An element anchor needs `sectionId`.', 'missing_section');
      if (tr.field !== undefined && (typeof tr.field !== 'string' || !tr.field.trim() || tr.field.length > 200)) throw anchorError('`field` must be a non-empty string.', 'bad_shape');
      return { subjectVersion, target: { kind: 'element', sectionId, ...(typeof tr.field === 'string' ? { field: tr.field.trim() } : {}) } };
    }
    default:
      throw anchorError('`anchor.target.kind` must be region, point, timecode or element.', 'unknown_kind');
  }
}

/**
 * ADR 0881 D1/D2 — the caller as the comments lanes know it. Feature-local on purpose:
 * it extends the shared `SubjectCaller` without widening it.
 *
 *  - `subject` — the canonical user (HTTP `resolveCallerUser`; tool/workflow
 *    `actingUserId`). Every subject-bound resolver reads it.
 *  - `principal` — the DOOR's spelling, `req.userId ?? principalId`, which is how a
 *    conversation stamps its owner and participants. For an unbound OIDC session it is
 *    `oidc:<sub>` while `subject` is `user:<hash>` (the ADR's correction H4), so the
 *    conversation predicate is asked with this, never with `subject`.
 *  - `toggle` — the owning-feature entitlement subject (HTTP `toggleSubjectOf(req)`,
 *    which carries the cohort principal and the operator's `planExempt`).
 */
export interface CommentCaller extends SubjectCaller {
  principal?: string;
  toggle?: Omit<ToggleSubject, 'tenantId'>;
}

/** The caller a RECIPIENT is checked as (ADR 0881 D3): one id, every spelling. */
function recipientCaller(userId: string): CommentCaller {
  return { subject: userId, principal: userId, toggle: { userId } };
}

/** A resolved commentable target. `restricted` (ADR 0881 D8) = its visibility is
 *  narrower than the org (a private conversation, a subject-bound corpus, a
 *  project-owned canvas or list): no host event is emitted for it. `archived` (D1) = a
 *  read-only target that refuses new comments. */
export interface ResolvedTarget {
  title: string; ownerId: string; restricted: boolean; archived?: boolean;
  /** ADR 0947 D2 — present only on targets that accept an anchor: checks one
   *  against the subject at its CURRENT version, throwing a 400 when it does not fit. */
  checkAnchor?: (anchor: CommentAnchor) => void;
}

/** A commentable resource: validate it is in (tenant, org) and visible to the caller,
 *  and yield the title + owner used for the notification emit. Returns null when not
 *  (the caller maps that to a uniform 404 — no existence leak). */
interface CommentTarget {
  /** ADR 0881 D2 — the feature that OWNS this resource type. Its entitlement (toggle +
   *  plan) is checked in ONE place, `resolveCommentTarget`, before `validate` runs.
   *  `null` = always on: `cms` and `kb` have no toggle (ALWAYS-ON, ADR 0027) and chat is
   *  core. A non-null id MUST be a registered toggle (`comments-adr0881.test.ts` D2). */
  featureId: string | null;
  validate(tenantId: string, orgId: string, resourceId: string, caller: CommentCaller): Promise<ResolvedTarget | null>;
}

const TARGETS: Record<ResourceType, CommentTarget> = {
  // ADR 0353 P4 — threaded review comments on a creative brief.
  creative_brief: {
    featureId: 'creative-briefs',
    async validate(tenantId, orgId, resourceId) {
      const b = await getCreativeBrief(tenantId, orgId, resourceId);
      return b ? { title: b.title, ownerId: b.createdBy, restricted: false } : null;
    },
  },
  cms_page: {
    featureId: null,
    async validate(tenantId, orgId, resourceId) {
      const p = await getPage(tenantId, orgId, resourceId);
      if (!p) return null;
      // ADR 0947 D2 — a page takes `element` pins on a section of its CURRENT version.
      const sectionIds = new Set(p.sections.map((sec) => sec.sectionId));
      return {
        title: p.title, ownerId: p.createdBy, restricted: false,
        checkAnchor: (anchor) => {
          if (anchor.subjectVersion !== String(p.version)) throw anchorError('`anchor.subjectVersion` is not this page\'s current version.', 'stale_subject_version');
          if (anchor.target.kind !== 'element') throw anchorError('A page takes only `element` anchors.', 'kind_not_allowed');
          if (!sectionIds.has(anchor.target.sectionId)) throw anchorError('`anchor.target.sectionId` is not a section of this page version.', 'unknown_section');
        },
      };
    },
  },
  // ADR 0947 D2 — a media asset (image, video, audio, document). Media is ALWAYS-ON
  // (ADR 0027), so no owning toggle; the org check is `getAsset`'s. Asset bytes are
  // immutable (an AI edit mints a new asset, ADR 0229), so the version is the
  // content hash, or `legacy:<assetId>` for rows uploaded before the hash existed.
  media_asset: {
    featureId: null,
    async validate(tenantId, orgId, resourceId) {
      const a = await getAsset(tenantId, orgId, resourceId);
      if (!a) return null;
      const timed = /^(video|audio)\//.test(a.contentType);
      return {
        title: a.name, ownerId: a.uploadedBy, restricted: false,
        checkAnchor: (anchor) => {
          if (anchor.subjectVersion !== mediaSubjectVersion(a)) throw anchorError('`anchor.subjectVersion` is not this asset\'s version.', 'stale_subject_version');
          if (anchor.target.kind === 'element') throw anchorError('A media asset takes region, point or timecode anchors.', 'kind_not_allowed');
          if (anchor.target.kind === 'timecode' && !timed) throw anchorError('Only a video or audio asset takes a timecode anchor.', 'kind_not_allowed');
        },
      };
    },
  },
  kb_collection: {
    featureId: null,
    async validate(tenantId, orgId, resourceId, caller) {
      const c = await getCollection(tenantId, orgId, resourceId, caller); // KBC-1 / R3 Blocker 2 — the commenter's principal, fail-closed when absent
      return c ? { title: c.name, ownerId: c.createdBy, restricted: Boolean(c.boundSubject) } : null;
    },
  },
  // A chat message: resourceId is `${sessionId}#${messageId}`; the messageId is the
  // opaque UI anchor. ADR 0881 D1 — a conversation is owner/participant-private, so the
  // thread is exactly as visible as the conversation: the session must EXIST (the
  // visibility predicate answers `true` for a null meta, so existence is checked first)
  // AND be visible through `isVisibleToAsync`, the predicate the chat routes use. Before
  // this, any tenant member read and wrote the threads on another person's private chat.
  // Chat sessions carry no org field; the `_orgId` stays unused (`CMWF-4`, open).
  chat_message: {
    featureId: null,
    async validate(tenantId, _orgId, resourceId, caller) {
      const sessionId = resourceId.split('#')[0] ?? '';
      if (!sessionId) return null;
      const session = await hostExtStorage().getChatSession(tenantId, sessionId);
      if (!session) return null;
      const meta = await getConversationMeta(tenantId, sessionId);
      if (!caller.preAuthorized && !(await isVisibleToAsync(meta, tenantId, caller.principal ?? caller.subject))) return null;
      const archived = meta?.type === 'channel' && meta.channel?.archived === true;
      return { title: session.title || 'Conversation', ownerId: '', restricted: true, ...(archived ? { archived } : {}) };
    },
  },
  // A priority idea (ADR 0232): resourceId is `${listId}#${cardId}`. Validated by
  // the LIST's tenant + org (the aggregate root); the card lives on the list's board.
  // The ADR 0820 §8.1 entitlement check now rides `featureId` (ADR 0881 D2).
  priority_idea: {
    featureId: 'priority-matrix',
    async validate(tenantId, orgId, resourceId, caller) {
      const [listId, cardId] = resourceId.split('#');
      if (!listId || !cardId) return null;
      const list = await getPriorityList(tenantId, listId);
      if (!list || list.orgId !== orgId) return null;
      // ADR 0842 D8 — a project-bound list is membership-scoped (ADR 0610 D3′).
      if (list.projectId && !(await subjectReadAllowed(tenantId, { kind: 'project', id: list.projectId }, caller))) return null;
      const idea = (await listRankedIdeas(tenantId, listId)).find((r) => r.card.id === cardId);
      return idea ? { title: idea.card.title, ownerId: idea.card.createdBy ?? list.createdBy, restricted: Boolean(list.projectId) } : null;
    },
  },
  // A rich-text document canvas (ADR 0334): resourceId is the canvasId for a
  // whole-canvas thread, OR `${canvasId}#${threadId}` for an inline range-anchored
  // thread. Tenant-partitioned (org rides `ownerSubject`); ADR 0659 D9 — an owned
  // canvas resolves only for a caller who may READ that subject.
  canvas_document: {
    featureId: 'document-editor',
    async validate(tenantId, _orgId, resourceId, caller) {
      const canvasId = resourceId.split('#')[0] ?? '';
      const c = await getCanvasForTenant(tenantId, canvasId);
      if (!c || c.canvasTypeId !== 'canvas.document') return null;
      if (c.ownerSubject && !(await subjectReadAllowed(tenantId, c.ownerSubject, caller))) return null;
      const st = c.state && typeof c.state === 'object' && !Array.isArray(c.state) ? (c.state as Record<string, unknown>) : {};
      const title = typeof st.title === 'string' && st.title ? st.title : (c.name || 'Document');
      return { title, ownerId: '', restricted: Boolean(c.ownerSubject) };
    },
  },
  // A slide deck (ADR 0886 D5): resourceId is the canvasId for a whole-deck
  // thread, OR `${canvasId}#${slideId}` for ONE slide. Same rules as
  // `canvas_document` — tenant-partitioned, an owned deck needs READ on its owner
  // subject — plus the slide must still be IN the deck: a deleted slide's thread
  // resolves to nothing (the panel's gone-state), never to whatever slide now
  // sits at that position. Slide ids are kept stable across edits (the editor's
  // own ids; the Slide Designer render tool preserves them, ADR 0886 D5).
  canvas_slides: {
    featureId: 'slides',
    async validate(tenantId, _orgId, resourceId, caller) {
      const parts = resourceId.split('#');
      if (parts.length > 2) return null;
      const [canvasId = '', slideId] = parts;
      const c = await getCanvasForTenant(tenantId, canvasId);
      if (!c || c.canvasTypeId !== 'canvas.slides') return null;
      if (c.ownerSubject && !(await subjectReadAllowed(tenantId, c.ownerSubject, caller))) return null;
      const st = c.state && typeof c.state === 'object' && !Array.isArray(c.state) ? (c.state as Record<string, unknown>) : {};
      const deckTitle = typeof st.title === 'string' && st.title ? st.title : (c.name || 'Slide deck');
      let title = deckTitle;
      if (slideId !== undefined) {
        const slides = Array.isArray(st.slides) ? (st.slides as unknown[]) : [];
        const slide = slides.find((x) => x && typeof x === 'object' && (x as { id?: unknown }).id === slideId) as { name?: unknown } | undefined;
        if (!slide) return null;
        if (typeof slide.name === 'string' && slide.name) title = `${deckTitle} — ${slide.name}`;
      }
      return { title, ownerId: '', restricted: Boolean(c.ownerSubject) };
    },
  },
};

/** Test-only: the owning feature each target declares (the drift guard reads the SAME values the gate reads). */
export function __targetFeatureIds(): Record<ResourceType, string | null> {
  return Object.fromEntries(RESOURCE_TYPES.map((t) => [t, TARGETS[t].featureId])) as Record<ResourceType, string | null>;
}

// GOV-1: `tenantOf` arms the tenant secondary index (bounded retention-purge scan).
const comments = new DurableCollection<Comment>('comments:thread', (c) => c.commentId, undefined, (c) => c.tenantId);

export function isResourceType(v: unknown): v is ResourceType {
  return typeof v === 'string' && (RESOURCE_TYPES as readonly string[]).includes(v);
}

// ── reads ──
/**
 * CMNT-3 — read through the TENANT INDEX, never `list()`.
 *
 * Every read below used `comments.list()` = a `kvList` over the whole
 * `comments:thread` namespace + a decode of every row in every tenant + an
 * in-memory filter. The collection was constructed WITH `tenantOf` (the index is
 * armed, line ~134) and the retention purger already read through it — the
 * bounded lane was present and simply unused on the hot path, which is every
 * `/comments` render, every inline expand, and every `openwop:comments.list`
 * tool turn.
 *
 * One helper so a future read cannot pick the unbounded lane by accident. Note
 * the index is a bounded scan, not a filter: it enumerates only this tenant's
 * markers, so cross-tenant rows are never decoded at all — the `tenantId ===`
 * check below is defence in depth against a stale marker, not the boundary.
 */
async function rowsForTenant(tenantId: string): Promise<Comment[]> {
  if (!tenantId) return []; // fail-closed: an unscoped read must never fall back to list()
  return (await comments.listForTenantIndexed(tenantId)).filter((c) => c.tenantId === tenantId);
}

/**
 * ADR 0659 D1 — THE commentable-target predicate. Every lane resolves through this and
 * nothing else.
 *
 * The defect it closes: `createComment` used to pass `{ subject: authorId }` here, i.e.
 * the comment's AUTHOR as the visibility CALLER. Authorship is provenance ("who wrote
 * this"); visibility is authorization ("whose access decides"). Conflating them failed in
 * BOTH directions at once — the read lanes had no caller at all and leaked subject-bound
 * corpora (`CMNT-15`/`CMWF-1`), while the workflow lane's `agent:${runId}` author is never
 * a bound member, so a node could never comment on one and was told `not_found`, which was
 * false (`CMWF-2`).
 *
 * `caller` is REQUIRED and never defaults to the author: a site that forgets it passes
 * `{subject: undefined}`, which `subjectReadAllowed` refuses on a bound target — the
 * direction a forgotten gate must fail in.
 */
async function resolveCommentTarget(
  tenantId: string, orgId: string, resourceType: ResourceType, resourceId: string, caller: CommentCaller,
): Promise<ResolvedTarget | null> {
  const target = TARGETS[resourceType];
  if (!(await ownerEntitled(tenantId, target.featureId, caller))) return null;
  return target.validate(tenantId, orgId, resourceId, caller);
}

/**
 * ADR 0881 D2 — the owning feature's entitlement (toggle + plan, `resolveOne`), the
 * ADR 0820 §8.1 rule generalised from `priority_idea` to every target. A tenant refused
 * the owning feature gets the uniform `null`, never a throw; a resolver error fails
 * closed. Before this, a paywalled feature's threads and resource titles stayed
 * reachable through `comments`.
 */
async function ownerEntitled(tenantId: string, featureId: string | null, caller: CommentCaller): Promise<boolean> {
  if (featureId === null) return true;
  const toggle = caller.toggle ?? (caller.subject ? { userId: caller.subject } : {});
  try {
    return Boolean((await resolveOne(featureId, { tenantId, ...toggle }))?.enabled);
  } catch {
    return false;
  }
}

/**
 * The thread, or `null` when the target does not exist OR the caller cannot see it — a
 * UNIFORM answer, so this is not an existence oracle. Callers map `null` to their own
 * lane's refusal (404 on HTTP, `toolEmpty` for a chat tool, typed `not_found` on the
 * workflow surface) and MUST NOT distinguish the two causes.
 */
export async function listThread(
  tenantId: string, orgId: string, resourceType: ResourceType, resourceId: string, caller: CommentCaller,
): Promise<Comment[] | null> {
  // Fail-closed FIRST: an unscoped read must never reach a resolver (which would hand an
  // empty tenantId to another feature's store). Caught by `comments-bounded-reads`.
  if (!tenantId) return null;
  if (!(await resolveCommentTarget(tenantId, orgId, resourceType, resourceId, caller))) return null;
  return (await rowsForTenant(tenantId))
    .filter((c) => c.orgId === orgId && c.resourceType === resourceType && c.resourceId === resourceId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)); // thread order: oldest first
}

/**
 * ADR 0659 D1 — ORDERING. The by-id lanes cannot resolve the target before the store read
 * (the target is only known FROM the row), so the row is read first and the caller-gate
 * runs on it. An invisible target returns the IDENTICAL `null` the missing-row path
 * returns, and it runs BEFORE any author/admin guard — otherwise `updateComment`'s 403
 * would still distinguish "exists, not yours" from "absent", which is the oracle D1 closes.
 */
export async function getComment(tenantId: string, orgId: string, commentId: string, caller: CommentCaller): Promise<Comment | null> {
  const c = await comments.get(commentId);
  if (!c || c.tenantId !== tenantId || c.orgId !== orgId) return null;
  if (!(await resolveCommentTarget(tenantId, orgId, c.resourceType, c.resourceId, caller))) return null;
  return c;
}

// ── notification planning (ADR 0881 D3/D4/D5) ──

export type CommentNotifyType = 'comment.added' | 'comment.reply' | 'comment.mention' | 'comment.resolved';

/** One addressed notification. */
export interface CommentRecipient { userId: string; type: CommentNotifyType }

/** What a write needs delivered: the target's title + who, already filtered. */
export interface CommentNotifyPlan {
  resourceTitle: string;
  recipients: CommentRecipient[];
  /** Who DID the thing — the author for a new comment, the resolver for a resolution
   *  (`CM2CD-7`: it used to be the comment's author on a "resolved" notification). */
  actorId: string;
}

/** Highest wins when one person is on several lists (D4): one notification per person. */
const NOTIFY_PRECEDENCE: Record<CommentNotifyType, number> = { 'comment.mention': 4, 'comment.reply': 3, 'comment.resolved': 2, 'comment.added': 1 };

/** The HUMAN a row speaks for: its `onBehalfOf`, else a non-agent author. An
 *  `agent:<runId>` with no human behind it is nobody to notify (`CM2WF-6`). */
function humanOf(c: Pick<Comment, 'authorId' | 'onBehalfOf'>): string | undefined {
  if (c.onBehalfOf) return c.onBehalfOf;
  return c.authorId.startsWith('agent:') ? undefined : c.authorId;
}

/**
 * ADR 0881 D3 — THE recipient filter. A candidate is notified only when they are a
 * human, not the actor, a member of the comment's org (matched on `member.subject`, the
 * key member rows are written under — never `resolveEffectiveAccess`, which grants owner
 * to an unknown subject in demo mode), AND can still resolve the target themselves
 * (visibility + owning-feature entitlement). Before this, a person removed from the org
 * was told a private page's title through the inbox. Drops are silent by design (an
 * unreachable recipient is not the writer's error) and logged as a count only.
 */
async function deliverable(
  tenantId: string, orgId: string, resourceType: ResourceType, resourceId: string,
  candidates: readonly CommentRecipient[], actors: ReadonlySet<string>, members: ReadonlySet<string>,
  /** `CM2CD-1` — ids `splitMentions` already resolved the target for, in this write. */
  verified: ReadonlySet<string> = new Set(),
): Promise<CommentRecipient[]> {
  const best = new Map<string, CommentNotifyType>();
  for (const c of candidates) {
    if (!c.userId || c.userId.startsWith('agent:') || actors.has(c.userId)) continue;
    const prev = best.get(c.userId);
    if (!prev || NOTIFY_PRECEDENCE[c.type] > NOTIFY_PRECEDENCE[prev]) best.set(c.userId, c.type);
  }
  const out: CommentRecipient[] = [];
  let dropped = 0;
  for (const [userId, type] of best) {
    if (members.has(userId) && (verified.has(userId) || (await resolveCommentTarget(tenantId, orgId, resourceType, resourceId, recipientCaller(userId))))) {
      out.push({ userId, type });
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) log.debug('comment_notify_recipients_dropped', { tenantId, resourceType, dropped });
  return out;
}

async function orgMemberSubjects(tenantId: string, orgId: string): Promise<Set<string>> {
  return new Set((await listMembers(tenantId, orgId)).map((m) => m.subject).filter((x): x is string => typeof x === 'string' && x.length > 0));
}

/**
 * ADR 0881 D5 — validate a mention list. Every id MUST be a member of the comment's
 * org (the channels S3 lesson: never accept any string as a person) — a non-member is a
 * 400 and nothing is written. Members who cannot see the target are split out: they
 * are neither stored nor notified, and the author is told who (`unnotifiedMentions`).
 */
async function splitMentions(
  tenantId: string, orgId: string, resourceType: ResourceType, resourceId: string,
  raw: unknown, members: ReadonlySet<string>, actors: ReadonlySet<string>,
): Promise<{ notified: string[]; unnotified: string[] }> {
  if (raw === undefined || raw === null) return { notified: [], unnotified: [] };
  if (!Array.isArray(raw) || raw.some((m) => typeof m !== 'string' || !m)) {
    throw new OpenwopError('validation_error', '`mentions` MUST be an array of member ids.', 400, { field: 'mentions' });
  }
  const ids = [...new Set(raw as string[])].filter((m) => !actors.has(m));
  if (ids.length > MAX.mentions) {
    throw new OpenwopError('validation_error', `At most ${MAX.mentions} people can be mentioned in one comment.`, 400, { field: 'mentions' });
  }
  if (ids.some((m) => !members.has(m))) {
    throw new OpenwopError('validation_error', 'Only members of this organization can be mentioned.', 400, { field: 'mentions' });
  }
  const notified: string[] = [];
  const unnotified: string[] = [];
  for (const m of ids) {
    if (await resolveCommentTarget(tenantId, orgId, resourceType, resourceId, recipientCaller(m))) notified.push(m); else unnotified.push(m);
  }
  return { notified, unnotified };
}

/** ADR 0881 D8 — a comment host event, ids only. Never for a RESTRICTED target: a
 *  private conversation, a bound corpus, an owned canvas or list — the webhook fan-out is
 *  tenant-wide and a binding's run acts for nobody, so the activity is itself the leak. */
async function emitCommentEvent(verb: 'created' | 'resolved', c: Comment, target: ResolvedTarget, origin?: HostEventOrigin): Promise<void> {
  if (target.restricted) return;
  await emitHostEvent({
    type: `host.comments.comment.${verb}`,
    tenantId: c.tenantId,
    payload: {
      orgId: c.orgId, resourceType: c.resourceType, resourceId: c.resourceId, commentId: c.commentId,
      ...(c.parentId ? { parentId: c.parentId } : {}),
    },
    ...(origin ? { origin } : {}),
  });
}

// ── writes ──
export async function createComment(input: {
  tenantId: string; orgId: string; resourceType: unknown; resourceId: unknown; parentId?: unknown; body: unknown;
  /** Provenance — WHO WROTE IT. On the workflow lane this is `agent:${runId}`. */
  authorId: string;
  /** ADR 0659 D1 — authorization: WHOSE ACCESS DECIDES. Never derived from `authorId`. */
  caller: CommentCaller;
  /** ADR 0659 D10 — the human principal a run acted for, so erasure reaches
   *  agent-authored rows (`authorId` is `agent:${runId}` and matches no subject key). */
  onBehalfOf?: string;
  /** ADR 0881 D5 — HTTP lane only (the chat tool and the node do not pass it). */
  mentions?: unknown;
  /** ADR 0617 D1a — the emitting run, from the workflow surface. */
  origin?: HostEventOrigin;
  /** ADR 0947 D2 — a pin on the subject (root comments only). */
  anchor?: unknown;
  intent?: unknown;
  visibility?: unknown;
  /** ADR 0947 Q2 — only a person on the HTTP lane may share a comment with the
   *  client. The agent tool and the workflow surface pass false: they may pin and
   *  raise a change request, never publish a note to a client. */
  mayShare?: boolean;
}): Promise<{ comment: Comment; notify: CommentNotifyPlan; unnotifiedMentions: string[] }> {
  if (!isResourceType(input.resourceType)) {
    throw new OpenwopError('validation_error', `\`resourceType\` MUST be one of: ${RESOURCE_TYPES.join(', ')}.`, 400, { field: 'resourceType' });
  }
  const resourceType = input.resourceType;
  const resourceId = typeof input.resourceId === 'string' ? input.resourceId.trim() : '';
  if (!resourceId) throw new OpenwopError('validation_error', '`resourceId` is required.', 400, { field: 'resourceId' });
  const body = cleanString(input.body, MAX.body);
  if (!body) throw new OpenwopError('validation_error', '`body` is required and MUST be a non-empty string.', 400, { field: 'body' });

  // The resource MUST exist in THIS (tenant, org), be readable by the CALLER (ADR 0659
  // D1) and its owning feature be usable (ADR 0881 D2) — every miss is the same 404.
  const target = await resolveCommentTarget(input.tenantId, input.orgId, resourceType, resourceId, input.caller);
  if (!target) throw new OpenwopError('not_found', 'Resource not found in this organization.', 404, { resourceId });
  // ADR 0881 D1 — an archived channel is read-only; its threads take no new comments.
  if (target.archived) throw new OpenwopError('conflict', 'This channel is archived, so its threads are read-only.', 409, { resourceId });

  // A reply's parent MUST be a live comment on the SAME thread (a root comment —
  // single-level threading in v1; a reply-to-reply re-parents to the root).
  let parent: Comment | undefined;
  if (input.parentId != null && input.parentId !== '') {
    const pid = typeof input.parentId === 'string' ? input.parentId : '';
    const p = pid ? await comments.get(pid) : null;
    if (!p || p.tenantId !== input.tenantId || p.orgId !== input.orgId
      || p.resourceType !== resourceType || p.resourceId !== resourceId) {
      throw new OpenwopError('validation_error', '`parentId` does not reference a comment on this thread.', 400, { field: 'parentId' });
    }
    parent = p.parentId ? ((await comments.get(p.parentId)) ?? p) : p; // flatten reply-to-reply to the root
  }

  // ADR 0947 D2 — anchor, intent and visibility describe a THREAD, so they sit on
  // its root; a reply inherits them. Everything is checked before anything is stored.
  const hasProofing = input.anchor !== undefined || input.intent !== undefined || input.visibility !== undefined;
  if (parent && hasProofing) {
    throw new OpenwopError('validation_error', 'A reply takes the anchor, intent and visibility of its thread.', 400, { field: 'anchor', reason: 'reply_not_anchorable' });
  }
  let anchor: CommentAnchor | undefined;
  if (input.anchor !== undefined) {
    anchor = parseAnchor(input.anchor);
    if (!target.checkAnchor) throw anchorError(`A ${resourceType} comment cannot carry an anchor.`, 'not_anchorable');
    target.checkAnchor(anchor);
  }
  if (input.intent !== undefined && input.intent !== 'note' && input.intent !== 'change-request') {
    throw new OpenwopError('validation_error', "`intent` MUST be 'note' or 'change-request'.", 400, { field: 'intent' });
  }
  if (input.visibility !== undefined && input.visibility !== 'internal' && input.visibility !== 'shared') {
    throw new OpenwopError('validation_error', "`visibility` MUST be 'internal' or 'shared'.", 400, { field: 'visibility' });
  }
  if (input.visibility === 'shared' && !input.mayShare) {
    throw new OpenwopError('validation_error', 'Only a person can share a comment with the client.', 400, { field: 'visibility', reason: 'share_not_allowed' });
  }

  const actors = new Set([input.authorId, ...(input.onBehalfOf ? [input.onBehalfOf] : [])]);
  // `CM2CD-1` — the member list is read only when someone could be told: a mention, a
  // reply (there is always a thread author), or a root on a resource with an owner.
  const mayNotify = input.mentions !== undefined || parent !== undefined || Boolean(target.ownerId);
  const members = mayNotify ? await orgMemberSubjects(input.tenantId, input.orgId) : new Set<string>();
  const mentioned = await splitMentions(input.tenantId, input.orgId, resourceType, resourceId, input.mentions, members, actors);

  const now = new Date().toISOString();
  const comment: Comment = {
    commentId: `cmt:${randomUUID()}`,
    tenantId: input.tenantId, orgId: input.orgId,
    resourceType, resourceId,
    ...(parent ? { parentId: parent.commentId } : {}),
    body, authorId: input.authorId,
    ...(input.onBehalfOf ? { onBehalfOf: input.onBehalfOf } : {}),
    ...(mentioned.notified.length ? { mentions: mentioned.notified } : {}),
    ...(anchor ? { anchor } : {}),
    ...(input.intent === 'change-request' ? { intent: 'change-request' as const } : {}),
    ...(input.visibility === 'shared' ? { visibility: 'shared' as const } : {}),
    status: 'open', createdAt: now, updatedAt: now,
  };
  await comments.put(comment);

  // ADR 0881 D4 — a root tells the resource owner; a reply tells EVERYONE in the
  // thread (the root's author + every earlier replier, capped); mentions tell the
  // mentioned. One notification per person, highest precedence wins, all through D3.
  const candidates: CommentRecipient[] = mentioned.notified.map((userId) => ({ userId, type: 'comment.mention' as const }));
  if (parent) {
    const thread = (await rowsForTenant(input.tenantId))
      .filter((c) => c.orgId === input.orgId && (c.commentId === parent.commentId || c.parentId === parent.commentId) && c.commentId !== comment.commentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const people = [...new Set(thread.map(humanOf).filter((x): x is string => Boolean(x)))].slice(0, MAX.participants);
    for (const userId of people) candidates.push({ userId, type: 'comment.reply' });
  } else if (target.ownerId) {
    candidates.push({ userId: target.ownerId, type: 'comment.added' });
  }
  const recipients = candidates.length
    ? await deliverable(input.tenantId, input.orgId, resourceType, resourceId, candidates, actors, members, new Set(mentioned.notified))
    : [];
  await emitCommentEvent('created', comment, target, input.origin);
  return { comment, notify: { resourceTitle: target.title, recipients, actorId: input.authorId }, unnotifiedMentions: mentioned.unnotified };
}

/** The outcome of an update: the row, plus what to deliver (ADR 0881 D5/D6). */
export interface CommentUpdate { comment: Comment; notify: CommentNotifyPlan; unnotifiedMentions: string[] }

/** Edit own body (with optional new mentions) and/or flip open↔resolved. Body edits are
 *  author-only; resolve/reopen is any member's. Returns null when not found. */
export async function updateComment(
  tenantId: string, orgId: string, commentId: string,
  actor: { id: string; onBehalfOf?: string },
  patch: { body?: unknown; status?: unknown; mentions?: unknown },
  caller: CommentCaller,
  origin?: HostEventOrigin,
): Promise<CommentUpdate | null> {
  const existing = await getComment(tenantId, orgId, commentId, caller); // D1 — gate BEFORE the author guard
  if (!existing) return null;
  const target = await resolveCommentTarget(tenantId, orgId, existing.resourceType, existing.resourceId, caller);
  if (!target) return null; // raced away between the two reads — the same uniform null
  const next: Comment = { ...existing };
  const now = new Date().toISOString();
  const actors = new Set([actor.id, ...(actor.onBehalfOf ? [actor.onBehalfOf] : [])]);
  const candidates: CommentRecipient[] = [];
  let unnotifiedMentions: string[] = [];
  let members: Set<string> | null = null;
  let verified = new Set<string>();

  if (patch.mentions !== undefined && patch.body === undefined) {
    throw new OpenwopError('validation_error', '`mentions` can only change together with `body`.', 400, { field: 'mentions' });
  }
  if (patch.body !== undefined) {
    if (existing.authorId !== actor.id) {
      throw new OpenwopError('forbidden_scope', 'Only the author may edit a comment body.', 403, { commentId });
    }
    // `CM2CD-4` — an archived channel's threads are read-only for edits too, not
    // only for new comments (an edit can add mentions, which notify).
    if (target.archived) throw new OpenwopError('conflict', 'This channel is archived, so its threads are read-only.', 409, { commentId });
    const body = cleanString(patch.body, MAX.body);
    if (!body) throw new OpenwopError('validation_error', '`body` MUST be a non-empty string.', 400, { field: 'body' });
    if (body !== existing.body) { next.body = body; next.editedAt = now; }
    if (patch.mentions !== undefined) {
      members = await orgMemberSubjects(tenantId, orgId);
      const split = await splitMentions(tenantId, orgId, existing.resourceType, existing.resourceId, patch.mentions, members, actors);
      unnotifiedMentions = split.unnotified;
      verified = new Set(split.notified);
      // Edits never re-notify: only people not already on the row hear about it.
      const already = new Set(existing.mentions ?? []);
      for (const m of split.notified) if (!already.has(m)) candidates.push({ userId: m, type: 'comment.mention' });
      if (split.notified.length) next.mentions = split.notified; else delete next.mentions;
    }
  }
  let resolvedNow = false;
  if (patch.status !== undefined) {
    if (patch.status !== 'open' && patch.status !== 'resolved') {
      throw new OpenwopError('validation_error', "`status` MUST be 'open' or 'resolved'.", 400, { field: 'status' });
    }
    // D6 — stamps move only on a real transition; a re-resolve is a no-op.
    if (patch.status !== existing.status) {
      next.status = patch.status;
      if (patch.status === 'resolved') {
        resolvedNow = true;
        next.resolvedBy = actor.id;
        if (actor.onBehalfOf) next.resolvedOnBehalfOf = actor.onBehalfOf; else delete next.resolvedOnBehalfOf;
        next.resolvedAt = now;
        const author = humanOf(existing);
        if (author) candidates.push({ userId: author, type: 'comment.resolved' });
      } else {
        delete next.resolvedBy; delete next.resolvedOnBehalfOf; delete next.resolvedAt;
      }
    }
  }
  next.updatedAt = now;
  await comments.put(next);
  const recipients = candidates.length
    ? await deliverable(tenantId, orgId, existing.resourceType, existing.resourceId, candidates, actors, members ?? await orgMemberSubjects(tenantId, orgId), verified)
    : [];
  if (resolvedNow) await emitCommentEvent('resolved', next, target, origin);
  return { comment: next, notify: { resourceTitle: target.title, recipients, actorId: actor.id }, unnotifiedMentions };
}

/**
 * ADR 0288 P2 consumer — SYSTEM prune of comment threads on resources that no
 * longer exist (chat messages of a deleted conversation): the content has no
 * reachable surface left. Deliberately bypasses `deleteComment`'s actor gate —
 * this is lifecycle cleanup fired by the owning deletion, not a user action
 * (the same reasoning as the resource's own cascade). Bounded tenant-indexed
 * scan; idempotent.
 */
export async function pruneThreadsForDeletedResources(
  tenantId: string, resourceType: ResourceType, resourceIds: readonly string[],
): Promise<number> {
  if (resourceIds.length === 0) return 0;
  const doomed = new Set(resourceIds);
  let n = 0;
  for (const c of await comments.listForTenantIndexed(tenantId)) {
    if (c.resourceType !== resourceType || !doomed.has(c.resourceId)) continue;
    await comments.delete(c.commentId);
    n += 1;
  }
  return n;
}

/**
 * Prune every thread for a base resource AND its composite `${base}#*` children
 * (ADR 0334 6b) — a canvas.document delete must cascade the whole-canvas thread
 * (`resourceId === base`) plus all inline range-anchored threads
 * (`resourceId === ${base}#${threadId}`), whose threadIds aren't known at delete
 * time. Exact-or-`#`-prefix match so a sibling id sharing a string prefix (but
 * not the `#` boundary) is never swept. Bounded tenant-indexed scan; idempotent.
 */
export async function pruneThreadsForResourceAndComposites(
  tenantId: string, resourceType: ResourceType, base: string,
): Promise<number> {
  if (!base) return 0;
  const prefix = `${base}#`;
  let n = 0;
  for (const c of await comments.listForTenantIndexed(tenantId)) {
    if (c.resourceType !== resourceType) continue;
    if (c.resourceId !== base && !c.resourceId.startsWith(prefix)) continue;
    await comments.delete(c.commentId);
    n += 1;
  }
  return n;
}

export async function deleteComment(
  tenantId: string, orgId: string, commentId: string, actor: { userId: string; isAdmin: boolean },
  caller: CommentCaller,
): Promise<boolean> {
  const existing = await getComment(tenantId, orgId, commentId, caller); // D1 — gate BEFORE the actor guard
  if (!existing) return false;
  if (existing.authorId !== actor.userId && !actor.isAdmin) {
    throw new OpenwopError('forbidden_scope', 'Only the author or an org admin may delete a comment.', 403, { commentId });
  }
  // Deleting a ROOT cascades its replies (a reply has no children — reply-to-reply
  // flattens to the root at create time). Guard the cascade so a NON-admin author
  // can't destroy OTHER people's replies by deleting the comment they replied under:
  // if foreign-authored replies exist, only an org admin may delete the root (the
  // author can `resolve` it instead). No data loss by a non-privileged actor.
  const replies = existing.parentId
    ? []
    : (await rowsForTenant(tenantId)).filter((c) => c.parentId === commentId && c.orgId === orgId); // CMNT-3 — indexed, not a full-collection scan
  if (!actor.isAdmin && replies.some((r) => r.authorId !== actor.userId)) {
    throw new OpenwopError('conflict', 'This comment has replies from other people — only an org admin can delete it. You can resolve it instead.', 409, { commentId, replies: replies.length });
  }
  for (const r of replies) await comments.delete(r.commentId);
  return comments.delete(commentId);
}

// ADR 0081 P5 — time-based retention (ADR 0077 seam). Delete this tenant's comment
// threads NOT touched within the window — age on `updatedAt` (an active thread keeps
// being touched; a year-dormant thread's free-text body is the stale PII). No-op on a
// falsy tenant / non-PII classification (fail-closed).
registerRetentionPurger({
  feature: 'comments',
  dryRun: 'rows-by-age',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    return purgeRowsByAge('comments', await comments.listForTenantIndexed(tenantId), tenantId, cutoffIso,
      (c) => ({ tenantId: c.tenantId, updatedAt: c.updatedAt, id: c.commentId }),
      (id) => comments.delete(id));
  },
});

// GDPR data-subject erasure (subject-erasure seam, ADR 0077 / ADR 0081 follow-up): a
// comment's free-text `body` is the subject's PII and `authorId` is the opaque principal
// (RFC 0048), so when a DSAR `subjectKey` is that userId, delete every comment authored by
// the subject. Tenant-scoped, fail-closed on a falsy subject. Returns the count removed.
// Orphan trade-off (intentional, matches the retention purger + ADR 0081 P5): erasing an
// author's root comment leaves others' replies with a dangling `parentId` — they still
// render via `listThread`, just lose their anchor. Subject erasure correctly takes
// priority over thread cosmetics; we do NOT re-parent or tombstone.
/** ADR 0659 D10 — matches `authorId` OR `onBehalfOf`: a comment an agent wrote at a
 *  person's direction is that person's, and `agent:${runId}` matches no subject key. */
export async function deleteSubjectComments(tenantId: string, subjectKey: string): Promise<number> {
  if (!subjectKey) return 0;
  let removed = 0;
  // CMNT-3 — indexed, not a full-collection scan. Erasure runs once per resolved
  // subject key, so the old `list()` was N tenant-wide scans per DSAR.
  for (const c of await rowsForTenant(tenantId)) {
    if (c.authorId === subjectKey || c.onBehalfOf === subjectKey) { await comments.delete(c.commentId); removed += 1; continue; } // D10
    // ADR 0881 D10 — the person-shaped fields on OTHER people's rows: a mention of the
    // subject and a resolution by them. The row stays (it is the author's speech).
    const mentions = c.mentions?.filter((m) => m !== subjectKey);
    const resolvedBySubject = c.resolvedBy === subjectKey || c.resolvedOnBehalfOf === subjectKey;
    if ((c.mentions && mentions && mentions.length !== c.mentions.length) || resolvedBySubject) {
      const next: Comment = { ...c };
      if (mentions && mentions.length) next.mentions = mentions; else delete next.mentions;
      if (resolvedBySubject) { delete next.resolvedBy; delete next.resolvedOnBehalfOf; }
      await comments.put(next);
    }
  }
  return removed;
}

const commentsEraser = async (tenantId: string, subjectKey: string): Promise<void> => { await deleteSubjectComments(tenantId, subjectKey); };
registerSubjectEraser(commentsEraser);

/** Test-only: every comment row of one tenant (a cascade check cannot go through a
 *  thread read, which resolves the deleted target to null). */
export async function __commentsForTenant(tenantId: string): Promise<Comment[]> { return rowsForTenant(tenantId); }

/** Test-only: clear the comment store. */
export async function __resetCommentsStore(): Promise<void> { await comments.__clear(); }
