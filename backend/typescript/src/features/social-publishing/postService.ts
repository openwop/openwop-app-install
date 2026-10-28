/**
 * ADR 0953 D3 — the social post store and its state machine.
 *
 * Every write is a `compareAndSwap` on the read row (a legal-transition table
 * only rejects a write it sees). Any edit to what would be posted (account,
 * platform, text, link, media) changes `contentHash`, voids the approval and
 * returns the post to `draft` (ADR 0924's version-bound approval).
 *
 * P0 has no publish path: nothing here talks to a platform.
 *
 * @see docs/adr/0953-social-publishing-and-scheduling.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { cleanString } from '../../host/boundedStrings.js';
import { OpenwopError } from '../../types.js';
import { SOCIAL_PLATFORMS, type SocialMedia, type SocialPlatform, type SocialPost, type SocialPostStatus } from './types.js';

const posts = new DurableCollection<SocialPost>(
  'social:post',
  (p) => `${p.tenantId}::${p.orgId}::${p.postId}`,
  undefined,
  (p) => p.tenantId,
);

/** Caption limits from each platform's publishing docs. Over the limit is refused
 *  at save, so a draft never holds text the platform would reject. */
export const TEXT_LIMITS: Readonly<Record<SocialPlatform, number>> = {
  'facebook-page': 63_206, instagram: 2_200, linkedin: 3_000, x: 280, tiktok: 2_200, youtube: 5_000,
};
const MEDIA_MAX = 10;
/** Stored posts per org. Bounds the per-org scan; Q5's pending cap lands with P2. */
export const POSTS_PER_ORG_MAX = 2_000;
/** Scheduling horizon: the scheduler refuses a one-shot beyond 366 days (ADR 0309). */
const HORIZON_MS = 366 * 86_400_000;

const nowIso = (): string => new Date().toISOString();
const key = (tenantId: string, orgId: string, postId: string): string => `${tenantId}::${orgId}::${postId}`;
const invalid = (field: string, message: string): OpenwopError => new OpenwopError('validation_error', message, 400, { field });

export function contentHashOf(p: Pick<SocialPost, 'platform' | 'accountRef' | 'text' | 'link' | 'media'>): string {
  return createHash('sha256').update(JSON.stringify([p.platform, p.accountRef, p.text, p.link ?? null, p.media.map((m) => [m.mediaAssetId, m.kind])])).digest('hex');
}

// ── Input parsing ────────────────────────────────────────────────────────────

const isPlatform = (v: unknown): v is SocialPlatform => typeof v === 'string' && (SOCIAL_PLATFORMS as readonly string[]).includes(v);

function parseLink(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 2048) throw invalid('link', 'The link must be an http(s) URL of at most 2048 characters.');
  let u: URL;
  try { u = new URL(v); } catch { throw invalid('link', 'The link must be an http(s) URL.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw invalid('link', 'The link must be an http(s) URL.');
  return u.toString();
}

function parseMedia(v: unknown): SocialMedia[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MEDIA_MAX) throw invalid('media', `media must be a list of at most ${MEDIA_MAX} items.`);
  return v.map((m, i) => {
    const o = (m ?? {}) as Record<string, unknown>;
    const id = typeof o.mediaAssetId === 'string' ? o.mediaAssetId.trim() : '';
    if (!id || id.length > 200) throw invalid(`media[${i}].mediaAssetId`, 'Each media item needs a mediaAssetId.');
    if (o.kind !== 'image' && o.kind !== 'video') throw invalid(`media[${i}].kind`, 'A media kind is image or video.');
    return { mediaAssetId: id, kind: o.kind };
  });
}

function parseScheduledFor(v: unknown, now: number): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw invalid('scheduledFor', 'scheduledFor must be an ISO date-time.');
  if (t <= now) throw invalid('scheduledFor', 'scheduledFor must be in the future.');
  if (t - now > HORIZON_MS) throw invalid('scheduledFor', 'A post can be scheduled at most 366 days ahead.');
  return new Date(t).toISOString();
}

function parseText(v: unknown, platform: SocialPlatform): string {
  const raw = typeof v === 'string' ? v.trim() : '';
  if (raw.length > 2 * TEXT_LIMITS[platform]) throw invalid('text', `${platform} allows at most ${TEXT_LIMITS[platform]} characters.`); // bound the scrub
  const text = cleanString(raw, raw.length, '').trim();
  if (!text) throw invalid('text', 'A post needs text.');
  // The scrub replaces secret-shaped runs. A post must never go out with text
  // other than what its author wrote, so a scrubbed caption is refused, not saved.
  if (text !== raw) throw invalid('text', 'The text contains something that looks like a key or token (a run of 40 or more letters and digits). Remove it.');
  // Code points, not UTF-16 units: an emoji is one character to the platform.
  if ([...text].length > TEXT_LIMITS[platform]) throw invalid('text', `${platform} allows at most ${TEXT_LIMITS[platform]} characters.`);
  return text;
}

function parseAccountRef(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || s.length > 200 || /\s/.test(s)) throw invalid('accountRef', 'accountRef is the page, profile or channel id to post as.');
  return s;
}

const optId = (v: unknown, field: string): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 200) throw invalid(field, `${field} is not valid.`);
  return v;
};

// ── Reads ────────────────────────────────────────────────────────────────────

export async function getPost(tenantId: string, orgId: string, postId: string): Promise<SocialPost | null> {
  const p = await posts.get(key(tenantId, orgId, postId));
  return p && p.tenantId === tenantId && p.orgId === orgId && p.postId === postId ? p : null;
}

export async function listPosts(tenantId: string, orgId: string, filter: { status?: SocialPostStatus; campaignId?: string } = {}): Promise<SocialPost[]> {
  return (await posts.listByPrefix(`${tenantId}::${orgId}::`))
    .filter((p) => p.tenantId === tenantId && p.orgId === orgId)
    .filter((p) => !filter.status || p.status === filter.status)
    .filter((p) => !filter.campaignId || p.campaignId === filter.campaignId)
    .sort((a, b) => (a.scheduledFor ?? a.createdAt).localeCompare(b.scheduledFor ?? b.createdAt));
}

// ── Writes ───────────────────────────────────────────────────────────────────

export interface DraftInput {
  platform?: unknown; accountRef?: unknown; connectionId?: unknown; campaignId?: unknown;
  text?: unknown; link?: unknown; media?: unknown; aiGenerated?: unknown; scheduledFor?: unknown;
}

export async function createDraft(tenantId: string, orgId: string, input: DraftInput, createdBy: string): Promise<SocialPost> {
  if (!isPlatform(input.platform)) throw invalid('platform', `platform must be one of ${SOCIAL_PLATFORMS.join(', ')}.`);
  const platform = input.platform;
  if ((await listPosts(tenantId, orgId)).length >= POSTS_PER_ORG_MAX) {
    throw new OpenwopError('validation_error', `This organization already has ${POSTS_PER_ORG_MAX} posts. Delete old drafts first.`, 409, { reason: 'posts_cap', max: POSTS_PER_ORG_MAX });
  }
  const now = nowIso();
  const body = {
    platform,
    accountRef: parseAccountRef(input.accountRef),
    text: parseText(input.text, platform),
    media: parseMedia(input.media),
  };
  const link = parseLink(input.link);
  const scheduledFor = parseScheduledFor(input.scheduledFor, Date.now());
  const connectionId = optId(input.connectionId, 'connectionId');
  const campaignId = optId(input.campaignId, 'campaignId');
  const post: SocialPost = {
    postId: `spost:${randomUUID()}`, tenantId, orgId,
    ...body,
    ...(link ? { link } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(campaignId ? { campaignId } : {}),
    contentHash: contentHashOf({ ...body, ...(link ? { link } : {}) }),
    // ADR 0953 D9: from P3 this is derived from the 0945 provenance stamp, and a
    // person can never mark generated media as not generated. Until then a
    // person may only turn the flag ON.
    aiDisclosure: { aiGenerated: input.aiGenerated === true },
    ...(scheduledFor ? { scheduledFor } : {}),
    status: 'draft', version: 1, createdBy, createdAt: now, updatedAt: now,
  };
  if (!(await posts.compareAndSwap(null, post))) throw new OpenwopError('conflict', 'A post with this id already exists.', 409, { reason: 'post_exists' });
  return post;
}

/** States a person may still edit. Once publishing starts the post is the platform's. */
const EDITABLE: readonly SocialPostStatus[] = ['draft', 'pending_approval', 'scheduled', 'failed'];

/**
 * Edit a post. A change to what would be posted voids the approval and returns
 * the post to `draft`; a schedule-only change keeps the approval (it binds the
 * content, not the time). `expectedVersion` makes a stale editor's write a 409.
 */
export async function updatePost(
  tenantId: string, orgId: string, postId: string,
  patch: DraftInput & { expectedVersion?: unknown },
): Promise<SocialPost | null> {
  const cur = await getPost(tenantId, orgId, postId);
  if (!cur) return null;
  if (patch.expectedVersion !== undefined && patch.expectedVersion !== cur.version) {
    throw new OpenwopError('conflict', 'The post changed while you were editing it. Reload and try again.', 409, { reason: 'post_changed', version: cur.version });
  }
  if (!EDITABLE.includes(cur.status)) {
    throw new OpenwopError('conflict', `A ${cur.status} post cannot be edited.`, 409, { reason: 'not_editable', status: cur.status });
  }
  if (patch.platform !== undefined && patch.platform !== cur.platform) {
    throw invalid('platform', 'The platform of a post cannot change. Create a new post for another platform.');
  }
  const body = {
    platform: cur.platform,
    accountRef: patch.accountRef !== undefined ? parseAccountRef(patch.accountRef) : cur.accountRef,
    text: patch.text !== undefined ? parseText(patch.text, cur.platform) : cur.text,
    media: patch.media !== undefined ? parseMedia(patch.media) : cur.media,
  };
  const link = patch.link !== undefined ? parseLink(patch.link) : cur.link;
  const contentHash = contentHashOf({ ...body, ...(link ? { link } : {}) });
  const next: SocialPost = { ...cur, ...body, contentHash, version: cur.version + 1, updatedAt: nowIso() };
  delete next.link; if (link) next.link = link;
  if (patch.connectionId !== undefined) { delete next.connectionId; const c = optId(patch.connectionId, 'connectionId'); if (c) next.connectionId = c; }
  if (patch.campaignId !== undefined) { delete next.campaignId; const c = optId(patch.campaignId, 'campaignId'); if (c) next.campaignId = c; }
  if (patch.aiGenerated === true) next.aiDisclosure = { ...cur.aiDisclosure, aiGenerated: true };
  if (patch.scheduledFor !== undefined) { delete next.scheduledFor; const s = parseScheduledFor(patch.scheduledFor, Date.now()); if (s) next.scheduledFor = s; }
  if (contentHash !== cur.contentHash || (patch.connectionId !== undefined && next.connectionId !== cur.connectionId)) {
    // ADR 0924: the approval was for other content. The post starts over.
    delete next.approval;
    next.status = 'draft';
    // P2 unregisters the job in the same step; P0 has no jobs.
  } else if (cur.status === 'failed') {
    next.status = 'draft';
  }
  delete next.lastError;
  if (!(await posts.compareAndSwap(cur, next))) {
    throw new OpenwopError('conflict', 'The post changed while you were editing it. Reload and try again.', 409, { reason: 'post_changed' });
  }
  return next;
}

/** Cancel a post that has not started publishing. Idempotent on `canceled`. */
export async function cancelPost(tenantId: string, orgId: string, postId: string): Promise<SocialPost | null> {
  const cur = await getPost(tenantId, orgId, postId);
  if (!cur) return null;
  if (cur.status === 'canceled') return cur;
  if (!EDITABLE.includes(cur.status)) {
    throw new OpenwopError('conflict', `A ${cur.status} post cannot be canceled.`, 409, { reason: 'not_cancelable', status: cur.status });
  }
  const next: SocialPost = { ...cur, status: 'canceled', version: cur.version + 1, updatedAt: nowIso() };
  delete next.approval;
  if (!(await posts.compareAndSwap(cur, next))) {
    throw new OpenwopError('conflict', 'The post changed while you were canceling it. Reload and try again.', 409, { reason: 'post_changed' });
  }
  return next;
}

/** Delete a draft or canceled post. A post that reached a platform is kept: it
 *  is the record of what was published (a public delete is its own gated act, D4). */
export async function deletePost(tenantId: string, orgId: string, postId: string): Promise<boolean> {
  const cur = await getPost(tenantId, orgId, postId);
  if (!cur) return false;
  if (cur.status !== 'draft' && cur.status !== 'canceled') {
    throw new OpenwopError('conflict', `A ${cur.status} post cannot be deleted. Cancel it first.`, 409, { reason: 'not_deletable', status: cur.status });
  }
  return posts.delete(key(tenantId, orgId, postId));
}

/** ADR 0464 — the post is the client's content, so it is kept; only the person
 *  in it goes (`createdBy`, `approval.decidedBy`). Tenant-scoped only. */
export async function eraseSocialPostSubjects(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let n = 0;
  for (const p of await posts.listForTenantIndexed(tenantId)) {
    if (p.tenantId !== tenantId) continue;
    let current: SocialPost | null = p;
    let complete = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!current) { complete = true; break; }
      const hitCreator = forms.has(current.createdBy);
      const hitDecider = !!current.approval?.decidedBy && forms.has(current.approval.decidedBy);
      if (!hitCreator && !hitDecider) { complete = true; break; }
      const next: SocialPost = { ...current, ...(hitCreator ? { createdBy: tombstone } : {}), version: current.version + 1 };
      if (hitDecider && current.approval) next.approval = { ...current.approval, decidedBy: tombstone };
      if (await posts.compareAndSwap(current, next)) { n++; complete = true; break; }
      // Rebuild from the winning row, preserving a concurrent edit/cancellation.
      current = await getPost(tenantId, p.orgId, p.postId);
    }
    // The erasure fan-out must report this feature incomplete rather than
    // silently reporting success with a person's identifiers still present.
    if (!complete) throw new OpenwopError('conflict', 'The post kept changing during subject erasure. Retry erasure.', 409, { reason: 'subject_erasure_conflict' });
  }
  return n;
}
