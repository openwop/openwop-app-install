/**
 * ADR 0946 P0 — the VariantSet store + service.
 *
 * ONE collection of immutable VERSION rows keyed
 * `${tenantId}::${campaignId}::${setId}::v${pad(version)}`, so "the sets of a
 * campaign" and "the versions of a set" are prefix reads, never a scan.
 *
 * - Create writes v1 with `putIfAbsent`.
 * - Revise names the version it edits (`baseVersion`). A stale base is a 409;
 *   an unchanged hash is a no-op that returns the head; otherwise v(N+1) is
 *   inserted with `putIfAbsent`, so two concurrent revisions of N cannot both
 *   land (the loser gets a 409).
 * - Old rows are never rewritten: `superseded` is derived at read.
 *
 * Validation is closed-world: concept axes are closed enums, every member names
 * an existing concept, and every ref must resolve in the campaign's OWN org (a
 * media asset, an email template version, a CMS page version). `contentHash` is
 * computed here from the referenced content, never taken from the caller.
 *
 * @see docs/adr/0946-creative-variant-factory.md
 */

import { createHash, randomUUID } from 'node:crypto';
import { OpenwopError } from '../../../types.js';
import { DurableCollection, hostExtStorage } from '../../../host/hostExtPersistence.js';
import { canonicalize } from '../../../host/auditChainService.js';
import { cleanString } from '../../../host/boundedStrings.js';
import { createLogger } from '../../../observability/logger.js';
import { getAsset, type MediaAsset } from '../../media/mediaService.js';
import { resolveMediaAsset } from '../../../host/inMemorySurfaces.js';
import { getVerdict } from '../../../host/creativeFidelity/index.js';
import { featureAccessRefusal } from '../../../host/workflowFeatureGate.js';
import type { CreativeRender } from '../../creative-briefs/render/renderService.js';
import type { MarketingCampaign } from '../types.js';
import {
  FORMAT_FAMILIES, HOOK_TYPES, MEMBER_KINDS, VISUAL_TREATMENTS,
  type Concept, type VariantMember, type VariantMemberKind, type VariantMemberRef, type VariantSet, type VariantSetRow,
} from './types.js';

const log = createLogger('campaign-orchestration.variants');

export const MAX_CONCEPTS = 12;
export const MAX_MEMBERS = 200;
/** Versions are never pruned (reviews and experiment arms bind to them), so a
 *  set is capped; a round past this starts a new set. */
export const MAX_VERSIONS_PER_SET = 100;
const MAX_COPY_FIELDS = 20;
const MAX_COPY_CHARS = 2000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CHANNEL_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const COPY_KEY_RE = /^[a-z][a-zA-Z0-9_]{0,39}$/;

const pad = (v: number): string => String(v).padStart(6, '0');
const setPrefix = (tenantId: string, campaignId: string, setId: string): string => `${tenantId}::${campaignId}::${setId}::v`;
const campaignPrefix = (tenantId: string, campaignId: string): string => `${tenantId}::${campaignId}::`;

const variantSets = new DurableCollection<VariantSetRow>(
  'campaign-orchestration:variantset',
  (r) => `${setPrefix(r.tenantId, r.campaignId, r.setId)}${pad(r.version)}`,
  undefined,
  (r) => r.tenantId,
);

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** sha256 over the canonical concepts + members, order-independent. Status,
 *  timestamps and authorship are not content and stay out of the hash. */
export function variantSetHash(concepts: Concept[], members: VariantMember[]): string {
  const c = [...concepts].sort((a, b) => a.conceptId.localeCompare(b.conceptId));
  const m = [...members].sort((a, b) => a.memberId.localeCompare(b.memberId));
  return sha256(canonicalize({ concepts: c, members: m }));
}

function invalid(message: string, details: Record<string, unknown> = {}): OpenwopError {
  return new OpenwopError('validation_error', message, 400, { reason: 'variant_set_invalid', ...details });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalid(`${field} "${String(value)}" is not valid — use one of: ${allowed.join(', ')}.`, { field });
  }
  return value as T;
}

function idOrMint(value: unknown, field: string, prefix: string): string {
  if (value === undefined) return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  if (typeof value !== 'string' || !ID_RE.test(value)) throw invalid(`${field} must match ${ID_RE.source}.`, { field });
  return value;
}

function boundedText(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') throw invalid(`${field} must be a string.`, { field });
  const clean = cleanString(value, max);
  if (required && clean.length === 0) throw invalid(`${field} must be a non-empty string.`, { field });
  if (value.trim().length > max) throw invalid(`${field} is longer than ${max} characters.`, { field });
  return clean || undefined;
}

const CONCEPT_KEYS = new Set(['conceptId', 'axes', 'rationale']);
const AXES_KEYS = new Set(['angle', 'personaId', 'hook', 'visual', 'format']);
const MEMBER_KEYS = new Set(['memberId', 'conceptId', 'channel', 'kind', 'ref', 'renderId', 'productRef', 'fidelityVerdictId']);

function refuseUnknownKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) throw invalid(`Unknown field "${k}" in ${where}.`, { field: `${where}.${k}` });
}

function parseConcept(raw: unknown, i: number): Concept {
  const where = `concepts[${i}]`;
  if (!isRecord(raw)) throw invalid(`${where} must be an object.`, { field: where });
  refuseUnknownKeys(raw, CONCEPT_KEYS, where);
  if (!isRecord(raw.axes)) throw invalid(`${where}.axes must be an object.`, { field: `${where}.axes` });
  refuseUnknownKeys(raw.axes, AXES_KEYS, `${where}.axes`);
  const personaId = raw.axes.personaId === undefined ? undefined : idOrMint(raw.axes.personaId, `${where}.axes.personaId`, 'p');
  return {
    conceptId: idOrMint(raw.conceptId, `${where}.conceptId`, 'con'),
    axes: {
      angle: boundedText(raw.axes.angle, `${where}.axes.angle`, 120, true)!,
      ...(personaId ? { personaId } : {}),
      hook: oneOf(raw.axes.hook, HOOK_TYPES, `${where}.axes.hook`),
      visual: oneOf(raw.axes.visual, VISUAL_TREATMENTS, `${where}.axes.visual`),
      format: oneOf(raw.axes.format, FORMAT_FAMILIES, `${where}.axes.format`),
    },
    rationale: boundedText(raw.rationale, `${where}.rationale`, 2000, true)!,
  };
}

interface ResolvedRef { ref: VariantMemberRef; contentHash: string; asset?: MediaAsset }

/** Foreign ids are opaque owner-issued ids, not locally minted concept ids.
 * Syntax bounds do not establish identity: every use below resolves its owner. */
function ownerId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.length > 200 || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw invalid(`${field} must be an existing owner-issued id.`, { field });
  }
  return value;
}

async function requireSourceFeature(feature: string, tenantId: string): Promise<void> {
  const reason = await featureAccessRefusal(feature, tenantId);
  if (reason) throw new OpenwopError('forbidden', 'The referenced content is unavailable for this workspace.', 403, { feature, reason });
}

/** Per-parse memo of CMS page versions by pageId. `listVersions` scans the CMS
 *  version collection (its ids are random, so there is no point read by
 *  page + number); one scan per distinct page, not one per landing member. */
type PageVersionCache = Map<string, Promise<Array<{ pageId: string; version: number; snapshot: unknown }>>>;
interface ParseCache {
  pages: PageVersionCache;
  assetIds: ReadonlySet<string>;
  renders?: Promise<CreativeRender[]>;
}

/** Resolve a member's ref in the campaign's org and compute its content hash.
 *  A ref that does not resolve there is a 400 naming the member, never a
 *  silently dropped member. */
async function resolveRef(tenantId: string, orgId: string, kind: VariantMemberKind, raw: unknown, where: string, pages: PageVersionCache): Promise<ResolvedRef> {
  if (!isRecord(raw)) throw invalid(`${where}.ref must be an object.`, { field: `${where}.ref` });
  const keys = Object.keys(raw).sort().join(',');
  if (kind === 'copy') {
    if (keys !== 'copy' || !isRecord(raw.copy)) throw invalid(`${where}: a copy member's ref is { copy: { field: text } }.`, { field: `${where}.ref` });
    const entries = Object.entries(raw.copy);
    if (entries.length === 0 || entries.length > MAX_COPY_FIELDS) throw invalid(`${where}: copy needs 1–${MAX_COPY_FIELDS} fields.`, { field: `${where}.ref.copy` });
    const copy: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (!COPY_KEY_RE.test(k)) throw invalid(`${where}: copy field name "${k}" is not valid.`, { field: `${where}.ref.copy` });
      copy[k] = boundedText(v, `${where}.ref.copy.${k}`, MAX_COPY_CHARS, true)!;
    }
    return { ref: { copy }, contentHash: sha256(canonicalize({ copy })) };
  }
  if (kind === 'image' || kind === 'video') {
    if (keys !== 'mediaAssetId' || typeof raw.mediaAssetId !== 'string') throw invalid(`${where}: an ${kind} member's ref is { mediaAssetId }.`, { field: `${where}.ref` });
    const asset = await getAsset(tenantId, orgId, raw.mediaAssetId);
    if (!asset) throw invalid(`${where}: media asset not found in this campaign's workspace.`, { field: `${where}.ref.mediaAssetId`, reason: 'variant_ref_not_found' });
    if (!asset.contentType.startsWith(`${kind}/`)) throw invalid(`${where}: the media asset is ${asset.contentType}, not ${kind}.`, { field: `${where}.ref.mediaAssetId` });
    let contentHash = asset.contentHash;
    if (!contentHash) {
      const bytes = await resolveMediaAsset(asset.serveToken);
      if (!bytes || bytes.tenantId !== tenantId) throw invalid(`${where}: media bytes are unavailable.`, { reason: 'variant_ref_not_found' });
      contentHash = createHash('sha256').update(Buffer.from(bytes.contentBase64, 'base64')).digest('hex');
    }
    return { ref: { mediaAssetId: asset.assetId }, contentHash, asset };
  }
  if (kind === 'email') {
    if (keys !== 'emailTemplateId,version' || typeof raw.emailTemplateId !== 'string' || !Number.isInteger(raw.version)) {
      throw invalid(`${where}: an email member's ref is { emailTemplateId, version }.`, { field: `${where}.ref` });
    }
    await requireSourceFeature('email', tenantId);
    const { getTemplateVersion } = await import('../../email/emailService.js');
    const v = await getTemplateVersion(tenantId, orgId, raw.emailTemplateId, raw.version as number);
    if (!v) throw invalid(`${where}: email template version not found in this campaign's workspace.`, { field: `${where}.ref`, reason: 'variant_ref_not_found' });
    return { ref: { emailTemplateId: v.templateId, version: v.version }, contentHash: v.contentHash };
  }
  // landing — a CMS page VERSION (an immutable snapshot), never the live draft.
  if (keys !== 'pageId,pageVersion' || typeof raw.pageId !== 'string' || !Number.isInteger(raw.pageVersion)) {
    throw invalid(`${where}: a landing member's ref is { pageId, pageVersion }.`, { field: `${where}.ref` });
  }
  await requireSourceFeature('cms', tenantId);
  let versions = pages.get(raw.pageId);
  if (!versions) {
    const { listVersions } = await import('../../cms/cmsService.js');
    versions = listVersions(tenantId, orgId, raw.pageId);
    pages.set(raw.pageId, versions);
  }
  const pv = (await versions).find((v) => v.version === raw.pageVersion);
  if (!pv) throw invalid(`${where}: page version not found in this campaign's workspace. Snapshot the draft first.`, { field: `${where}.ref`, reason: 'variant_ref_not_found' });
  return { ref: { pageId: pv.pageId, pageVersion: pv.version }, contentHash: sha256(canonicalize(pv.snapshot)) };
}

async function parseMember(tenantId: string, orgId: string, raw: unknown, i: number, conceptIds: Set<string>, cache: ParseCache): Promise<VariantMember> {
  const where = `members[${i}]`;
  if (!isRecord(raw)) throw invalid(`${where} must be an object.`, { field: where });
  refuseUnknownKeys(raw, MEMBER_KEYS, where);
  if (typeof raw.conceptId !== 'string' || !conceptIds.has(raw.conceptId)) {
    throw invalid(`${where}.conceptId must name a concept in this set.`, { field: `${where}.conceptId` });
  }
  if (typeof raw.channel !== 'string' || raw.channel.length > 64 || !CHANNEL_RE.test(raw.channel)) {
    throw invalid(`${where}.channel must be a channel id such as "meta.feed".`, { field: `${where}.channel` });
  }
  const kind = oneOf(raw.kind, MEMBER_KINDS, `${where}.kind`);
  const { ref, contentHash, asset } = await resolveRef(tenantId, orgId, kind, raw.ref, where, cache.pages);
  const member: VariantMember = { memberId: idOrMint(raw.memberId, `${where}.memberId`, 'mem'), conceptId: raw.conceptId, channel: raw.channel, kind, ref, contentHash };
  if (raw.productRef !== undefined) {
    if (!isRecord(raw.productRef)) throw invalid(`${where}.productRef must be an object.`, { field: `${where}.productRef` });
    refuseUnknownKeys(raw.productRef, new Set(['productId', 'variantId']), `${where}.productRef`);
    await requireSourceFeature('commerce', tenantId);
    const productId = ownerId(raw.productRef.productId, `${where}.productRef.productId`);
    const { getProduct } = await import('../../commerce/commerceService.js');
    const product = await getProduct(tenantId, orgId, productId);
    if (!product || product.productId !== productId) throw invalid(`${where}: product not found in this campaign's workspace.`, { reason: 'variant_ref_not_found' });
    const variantId = raw.productRef.variantId === undefined ? undefined : ownerId(raw.productRef.variantId, `${where}.productRef.variantId`);
    if (variantId && !product.variants.some((v) => v.variantId === variantId)) throw invalid(`${where}: product variant not found.`, { reason: 'variant_ref_not_found' });
    member.productRef = { productId, ...(variantId ? { variantId } : {}) };
  }
  if (raw.renderId !== undefined) {
    const renderId = ownerId(raw.renderId, `${where}.renderId`);
    if (!cache.renders && asset) {
      const { listRendersForAssets } = await import('../../creative-briefs/render/renderService.js');
      cache.renders = listRendersForAssets(tenantId, orgId, cache.assetIds);
    }
    if (!asset || !(await cache.renders)?.some((r) => r.renderId === renderId && r.mediaAssetId === asset.assetId)) {
      throw invalid(`${where}: render does not belong to this media asset and workspace.`, { reason: 'variant_ref_not_found' });
    }
    member.renderId = renderId;
  }
  if (raw.fidelityVerdictId !== undefined) {
    const verdictId = ownerId(raw.fidelityVerdictId, `${where}.fidelityVerdictId`);
    const verdict = await getVerdict(tenantId, orgId, verdictId);
    if (!asset || !verdict || verdict.verdictId !== verdictId || verdict.assetId !== asset.assetId || verdict.assetSha256 !== contentHash
      || (member.productRef && verdict.productId !== member.productRef.productId)) {
      throw invalid(`${where}: fidelity verdict does not describe these media bytes and product.`, { reason: 'variant_ref_not_found' });
    }
    member.fidelityVerdictId = verdictId;
  }
  return member;
}

export interface VariantSetContent { concepts: Concept[]; members: VariantMember[] }

/** Closed-world parse of `{ concepts, members }` against the campaign's org. */
export async function parseVariantSetContent(tenantId: string, orgId: string, body: unknown): Promise<VariantSetContent> {
  if (!isRecord(body)) throw invalid('Body must be an object with concepts and members.');
  const rawConcepts = body.concepts;
  const rawMembers = body.members ?? [];
  if (!Array.isArray(rawConcepts) || rawConcepts.length === 0 || rawConcepts.length > MAX_CONCEPTS) {
    throw invalid(`concepts must be an array of 1–${MAX_CONCEPTS} concepts.`, { field: 'concepts' });
  }
  if (!Array.isArray(rawMembers) || rawMembers.length > MAX_MEMBERS) {
    throw invalid(`members must be an array of at most ${MAX_MEMBERS} members.`, { field: 'members' });
  }
  const concepts = rawConcepts.map((c, i) => parseConcept(c, i));
  const conceptIds = new Set<string>();
  for (const c of concepts) {
    if (conceptIds.has(c.conceptId)) throw invalid(`Duplicate conceptId "${c.conceptId}".`, { field: 'concepts' });
    conceptIds.add(c.conceptId);
  }
  const members: VariantMember[] = [];
  const memberIds = new Set<string>();
  const assetIds = new Set<string>();
  for (const raw of rawMembers) {
    if (isRecord(raw) && isRecord(raw.ref) && typeof raw.ref.mediaAssetId === 'string') assetIds.add(raw.ref.mediaAssetId);
  }
  const cache: ParseCache = { pages: new Map(), assetIds };
  for (let i = 0; i < rawMembers.length; i += 1) {
    const m = await parseMember(tenantId, orgId, rawMembers[i], i, conceptIds, cache);
    if (memberIds.has(m.memberId)) throw invalid(`Duplicate memberId "${m.memberId}".`, { field: 'members' });
    memberIds.add(m.memberId);
    members.push(m);
  }
  return { concepts, members };
}

function toView(row: VariantSetRow, headVersion: number): VariantSet {
  return { ...row, status: row.version < headVersion ? 'superseded' : row.status, headVersion };
}

function recordAction(action: 'created' | 'revised', row: VariantSetRow, actor: string): void {
  const at = new Date().toISOString();
  try {
    void hostExtStorage()
      .appendAudit({
        timestamp: at, principalId: actor, action: `campaign.variant-set.${action}`, resource: row.setId, outcome: 'success',
        payload: { tenantId: row.tenantId, orgId: row.orgId, campaignId: row.campaignId, setId: row.setId, version: row.version, hash: row.hash, members: row.members.length, concepts: row.concepts.length },
      })
      .catch((err) => log.warn('variant-set audit append failed', { setId: row.setId, error: err instanceof Error ? err.message : String(err) }));
  } catch { /* storage unwired (unit tests) */ }
}

async function versionRows(tenantId: string, campaignId: string, setId: string): Promise<VariantSetRow[]> {
  const rows = await variantSets.listByPrefix(setPrefix(tenantId, campaignId, setId));
  return rows
    .filter((r) => r.tenantId === tenantId && r.campaignId === campaignId && r.setId === setId)
    .sort((a, b) => b.version - a.version);
}

/** Create v1 of a new set for `campaign` (draft).
 *
 * Replay/fork (ADR 0946 P4 readiness): a side-effect node passes a
 * deterministic `setId` (derived from its run and node) and supplies every
 * concept/member id, so a re-executed node finds its own v1 — same campaign,
 * same hash — and gets it back instead of a second set. A different hash under
 * that id is a 409, never an overwrite. */
export async function createVariantSet(campaign: MarketingCampaign, content: VariantSetContent, actor: string, opts: { runId?: string; setId?: string } = {}): Promise<VariantSet> {
  if (opts.setId !== undefined && !ID_RE.test(opts.setId)) throw invalid(`setId must match ${ID_RE.source}.`, { field: 'setId' });
  const row: VariantSetRow = {
    setId: opts.setId ?? `vs_${randomUUID()}`,
    tenantId: campaign.tenantId, orgId: campaign.orgId, campaignId: campaign.id,
    version: 1,
    hash: variantSetHash(content.concepts, content.members),
    status: 'draft',
    concepts: content.concepts, members: content.members,
    ...(opts.runId ? { createdByRunId: opts.runId } : {}),
    createdAt: new Date().toISOString(), createdBy: actor,
  };
  if (!(await variantSets.putIfAbsent(row))) {
    const existing = (await versionRows(campaign.tenantId, campaign.id, row.setId)).find((r) => r.version === 1);
    if (existing && existing.orgId === campaign.orgId && existing.hash === row.hash) {
      return toView(existing, (await versionRows(campaign.tenantId, campaign.id, row.setId))[0].version);
    }
    throw new OpenwopError('conflict', 'A variant set with this id already exists with different content.', 409, { reason: 'variant_set_conflict' });
  }
  recordAction('created', row, actor);
  return toView(row, 1);
}

/**
 * Revise a set: `baseVersion` must be the head. Unchanged content returns the
 * head (`changed:false`); otherwise v(N+1) is inserted. Old rows are untouched.
 */
export async function reviseVariantSet(
  campaign: MarketingCampaign, setId: string, baseVersion: number, content: VariantSetContent, actor: string, opts: { runId?: string } = {},
): Promise<{ set: VariantSet; changed: boolean } | null> {
  const rows = await versionRows(campaign.tenantId, campaign.id, setId);
  const head = rows[0];
  if (!head || head.orgId !== campaign.orgId) return null;
  const hash = variantSetHash(content.concepts, content.members);
  // A re-executed revision (replay/fork of the node that wrote it): the head is
  // exactly the version this edit produced from this base, so return it.
  if (head.version === baseVersion + 1 && head.revisedFrom === baseVersion && head.hash === hash) {
    return { set: toView(head, head.version), changed: false };
  }
  if (head.version !== baseVersion) {
    throw new OpenwopError('conflict', `Variant set is at version ${head.version}, not ${baseVersion}. Reload and re-apply your edit.`, 409, { reason: 'variant_set_stale', headVersion: head.version });
  }
  if (hash === head.hash) return { set: toView(head, head.version), changed: false };
  if (head.version >= MAX_VERSIONS_PER_SET) {
    throw new OpenwopError('conflict', `Variant set reached ${MAX_VERSIONS_PER_SET} versions. Start a new set for the next round.`, 409, { reason: 'variant_set_version_cap' });
  }
  const next: VariantSetRow = {
    setId, tenantId: head.tenantId, orgId: head.orgId, campaignId: head.campaignId,
    version: head.version + 1,
    hash,
    status: 'draft',
    ...(head.productRefs ? { productRefs: head.productRefs } : {}),
    concepts: content.concepts, members: content.members,
    revisedFrom: head.version,
    ...(opts.runId ? { createdByRunId: opts.runId } : {}),
    createdAt: new Date().toISOString(), createdBy: actor,
  };
  if (!(await variantSets.putIfAbsent(next))) {
    // A re-executed revision (same base, same content) finds its own row.
    const landed = (await versionRows(campaign.tenantId, campaign.id, setId)).find((r) => r.version === next.version);
    if (landed && landed.hash === hash) return { set: toView(landed, landed.version), changed: false };
    throw new OpenwopError('conflict', 'Another edit created this version first. Reload and re-apply your edit.', 409, { reason: 'variant_set_stale' });
  }
  recordAction('revised', next, actor);
  return { set: toView(next, next.version), changed: true };
}

/** One version (default: the head) of a set in this campaign, or null. */
export async function getVariantSet(tenantId: string, campaignId: string, setId: string, version?: number): Promise<VariantSet | null> {
  const rows = await versionRows(tenantId, campaignId, setId);
  const head = rows[0];
  if (!head) return null;
  const row = version === undefined ? head : rows.find((r) => r.version === version);
  return row ? toView(row, head.version) : null;
}

/** Every version of a set, newest first. */
export async function listVariantSetVersions(tenantId: string, campaignId: string, setId: string): Promise<VariantSet[]> {
  const rows = await versionRows(tenantId, campaignId, setId);
  return rows.map((r) => toView(r, rows[0].version));
}

/** The head of every set in a campaign, newest first. */
export async function listVariantSets(tenantId: string, campaignId: string): Promise<VariantSet[]> {
  const rows = (await variantSets.listByPrefix(campaignPrefix(tenantId, campaignId)))
    .filter((r) => r.tenantId === tenantId && r.campaignId === campaignId);
  const heads = new Map<string, VariantSetRow>();
  for (const r of rows) {
    const cur = heads.get(r.setId);
    if (!cur || r.version > cur.version) heads.set(r.setId, r);
  }
  return [...heads.values()].map((r) => toView(r, r.version)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Subject erasure (ADR 0464): tombstone `createdBy` on every version row the
 *  subject authored. The rows are the org's creative record and are kept.
 *  Authorship is not content, so the hash does not move: this is the one
 *  rewrite an immutable version row takes. */
export async function eraseVariantSetAuthor(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let n = 0;
  for (const r of await variantSets.listForTenantIndexed(tenantId)) {
    if (r.tenantId !== tenantId || !forms.has(r.createdBy)) continue;
    // Discovery is only a candidate list. The primary may have been deleted
    // with its campaign, or changed by another eraser, since that scan.
    const id = `${setPrefix(tenantId, r.campaignId, r.setId)}${pad(r.version)}`;
    let settled = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const current = await variantSets.get(id);
      if (!current || current.tenantId !== tenantId || current.campaignId !== r.campaignId
        || current.setId !== r.setId || current.version !== r.version || !forms.has(current.createdBy)) {
        settled = true;
        break;
      }
      if (await variantSets.compareAndSwap(current, { ...current, createdBy: tombstone })) {
        n += 1;
        settled = true;
        break;
      }
    }
    if (!settled) throw new OpenwopError('conflict', 'A variant version changed during author erasure; retry.', 409, { reason: 'variant_set_erasure_conflict' });
  }
  return n;
}

/** Delete every version of every set of a campaign (the campaign-delete seam). */
export async function deleteVariantSetsForCampaign(tenantId: string, campaignId: string): Promise<number> {
  const rows = (await variantSets.listByPrefix(campaignPrefix(tenantId, campaignId)))
    .filter((r) => r.tenantId === tenantId && r.campaignId === campaignId);
  let n = 0;
  for (const r of rows) if (await variantSets.delete(`${setPrefix(r.tenantId, r.campaignId, r.setId)}${pad(r.version)}`)) n += 1;
  return n;
}
