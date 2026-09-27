/**
 * Creative Briefs service (ADR 0353) — CRUD + lifecycle + versions-with-diffs
 * for the visual-brief entity, plus the three deterministic BUILD modes ported
 * from the retired `vendor.myndhyve.ads-studio-core` pilot pack (manual /
 * extraction / merge) and the mood-board assembly over media's deterministic
 * weighted selection (ADR 0352 P4).
 *
 * Tenant+org IDOR-guarded throughout; versions capped; transitions validated
 * (approval gates sharing — the documents precedent).
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString, optionalCleanString } from '../../host/boundedStrings.js';
import { createLogger } from '../../observability/logger.js';
import { clearUsageForRef, getAsset, selectAssets, syncUsageRefs } from '../media/mediaService.js';
import {
  CREATIVE_BRIEF_STATUSES, STATUS_TRANSITIONS,
  type CreativeBrief, type CreativeBriefStatus, type CreativeBriefVersion, type CreativeDirection, type MoodBoardItem, type PlatformSpec,
} from './types.js';

const MAX = {
  title: 200, str: 600, palette: 8, directions: 3, moodBoard: 12,
  versionsPerBrief: 50, perOrg: 500,
} as const;

const log = createLogger('creative-briefs');

const briefs = new DurableCollection<CreativeBrief>('creative-briefs:brief', (b) => `${b.tenantId}:${b.orgId}:${b.briefId}`);
const versions = new DurableCollection<CreativeBriefVersion>('creative-briefs:version', (v) => `${v.tenantId}:${v.orgId}:${v.versionId}`);

const nowIso = (): string => new Date().toISOString();
const str = (v: unknown, max: number = MAX.str): string | undefined => optionalCleanString(v, max);

function cleanDirections(raw: unknown): CreativeDirection[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
    .map((d) => ({ label: cleanString(d.label, MAX.str), ...(str(d.rationale) ? { rationale: str(d.rationale)! } : {}) }))
    .filter((d) => d.label.length > 0)
    .slice(0, MAX.directions);
}

function cleanMoodBoard(raw: unknown): MoodBoardItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object' && typeof m.mediaAssetId === 'string')
    .map((m) => ({ mediaAssetId: cleanString(m.mediaAssetId, MAX.str), ...(str(m.note) ? { note: str(m.note)! } : {}) }))
    .slice(0, MAX.moodBoard);
}

function cleanPalette(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const p = raw.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => cleanString(x, 40)).slice(0, MAX.palette);
  return p.length > 0 ? p : undefined;
}

function cleanPlatformSpec(raw: unknown): PlatformSpec | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const spec: PlatformSpec = {
    ...(str(o.platform, 60) ? { platform: str(o.platform, 60)! } : {}),
    ...(str(o.format, 60) ? { format: str(o.format, 60)! } : {}),
    ...(typeof o.textRulePct === 'number' && Number.isFinite(o.textRulePct) ? { textRulePct: Math.max(0, Math.min(100, o.textRulePct)) } : {}),
  };
  return Object.keys(spec).length > 0 ? spec : undefined;
}

export async function listBriefs(tenantId: string, orgId: string): Promise<CreativeBrief[]> {
  // CB-CODE-4 — keys are `${tenantId}:${orgId}:` prefixed, so a bounded prefix
  // scan replaces the full-collection scan (the exact filter stays as the
  // prefix-collision belt-and-braces).
  return (await briefs.listByPrefix(`${tenantId}:${orgId}:`))
    .filter((b) => b.tenantId === tenantId && b.orgId === orgId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getBrief(tenantId: string, orgId: string, briefId: string): Promise<CreativeBrief | null> {
  const b = await briefs.get(`${tenantId}:${orgId}:${briefId}`);
  return b ?? null;
}

async function mustGet(tenantId: string, orgId: string, briefId: string): Promise<CreativeBrief> {
  const b = await getBrief(tenantId, orgId, briefId);
  if (!b) throw new OpenwopError('not_found', 'Creative brief not found.', 404, { briefId });
  return b;
}

export interface BriefContentInput {
  title?: unknown; assetType?: unknown; sceneDescription?: unknown; composition?: unknown;
  cameraAngle?: unknown; lighting?: unknown; brandPalette?: unknown; messagingIntent?: unknown;
  platformSpec?: unknown; directions?: unknown; moodBoard?: unknown; campaignBriefId?: unknown;
}

function contentFrom(input: BriefContentInput): Omit<CreativeBriefVersion['snapshot'], never> {
  return {
    title: cleanString(input.title, MAX.title),
    assetType: cleanString(input.assetType, 80) || 'image',
    sceneDescription: cleanString(input.sceneDescription, MAX.str),
    ...(str(input.composition) ? { composition: str(input.composition)! } : {}),
    ...(str(input.cameraAngle, 120) ? { cameraAngle: str(input.cameraAngle, 120)! } : {}),
    ...(str(input.lighting, 120) ? { lighting: str(input.lighting, 120)! } : {}),
    ...(cleanPalette(input.brandPalette) ? { brandPalette: cleanPalette(input.brandPalette)! } : {}),
    ...(str(input.messagingIntent) ? { messagingIntent: str(input.messagingIntent)! } : {}),
    ...(cleanPlatformSpec(input.platformSpec) ? { platformSpec: cleanPlatformSpec(input.platformSpec)! } : {}),
    directions: cleanDirections(input.directions),
    moodBoard: cleanMoodBoard(input.moodBoard),
  };
}

async function captureVersion(b: CreativeBrief, actor: string): Promise<void> {
  const v: CreativeBriefVersion = {
    versionId: `${b.briefId}:${b.version}`,
    briefId: b.briefId,
    tenantId: b.tenantId,
    orgId: b.orgId,
    version: b.version,
    snapshot: {
      title: b.title, assetType: b.assetType, sceneDescription: b.sceneDescription,
      ...(b.composition ? { composition: b.composition } : {}),
      ...(b.cameraAngle ? { cameraAngle: b.cameraAngle } : {}),
      ...(b.lighting ? { lighting: b.lighting } : {}),
      ...(b.brandPalette ? { brandPalette: b.brandPalette } : {}),
      ...(b.messagingIntent ? { messagingIntent: b.messagingIntent } : {}),
      ...(b.platformSpec ? { platformSpec: b.platformSpec } : {}),
      directions: b.directions,
      moodBoard: b.moodBoard,
    },
    capturedAt: nowIso(),
    capturedBy: actor,
  };
  await versions.put(v);
  const rows = (await versions.listByPrefix(`${b.tenantId}:${b.orgId}:${b.briefId}:`)).sort((a, c) => a.version - c.version);
  for (const stale of rows.slice(0, Math.max(0, rows.length - MAX.versionsPerBrief))) await versions.delete(`${stale.tenantId}:${stale.orgId}:${stale.versionId}`);
}

export async function createBrief(tenantId: string, orgId: string, actor: string, input: BriefContentInput): Promise<CreativeBrief> {
  // CB-CODE-4 — bounded prefix scan (see listBriefs).
  const count = (await briefs.listByPrefix(`${tenantId}:${orgId}:`)).filter((b) => b.tenantId === tenantId && b.orgId === orgId).length;
  if (count >= MAX.perOrg) throw new OpenwopError('validation_error', `Creative-brief cap reached (${MAX.perOrg}).`, 400, {});
  const content = contentFrom(input);
  if (!content.title) throw new OpenwopError('validation_error', 'Field `title` is required.', 400, { field: 'title' });
  if (!content.sceneDescription) throw new OpenwopError('validation_error', 'Field `sceneDescription` is required.', 400, { field: 'sceneDescription' });
  const ts = nowIso();
  const b: CreativeBrief = {
    briefId: `cbrief:${randomUUID()}`,
    tenantId, orgId,
    ...(str(input.campaignBriefId, 120) ? { campaignBriefId: str(input.campaignBriefId, 120)! } : {}),
    ...content,
    status: 'draft',
    version: 1,
    createdBy: actor, updatedBy: actor, createdAt: ts, updatedAt: ts,
  };
  await briefs.put(b);
  await captureVersion(b, actor);
  await stampMoodBoardUsage(b);
  return b;
}

/**
 * CB-CODE-3 / CS-DATA-4 — the SINGLE guarded writer for a version-bumping brief
 * mutation (the priority-matrix `mutateSessionRow` precedent). `mutate` is a
 * PURE function applied to the FRESHLY-READ row and committed via the storage
 * compare-and-swap; a lost race re-reads + re-applies (3 attempts), then 409s.
 * The version snapshot is captured only AFTER the CAS commit, so a snapshot can
 * never record a version the row never held (the read-modify-write overwrite
 * this replaced).
 */
async function mutateBrief(tenantId: string, orgId: string, briefId: string, actor: string, mutate: (current: CreativeBrief) => CreativeBrief, opts?: { snapshot?: boolean }): Promise<CreativeBrief> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await mustGet(tenantId, orgId, briefId);
    const next = mutate(current);
    if (await briefs.compareAndSwap(current, next)) {
      if (opts?.snapshot !== false) {
        await captureVersion(next, actor);
        await stampMoodBoardUsage(next);
      }
      return next;
    }
  }
  throw new OpenwopError('conflict', 'The brief was modified concurrently — retry.', 409, { briefId });
}

export async function updateBrief(tenantId: string, orgId: string, briefId: string, actor: string, input: BriefContentInput): Promise<CreativeBrief> {
  return mutateBrief(tenantId, orgId, briefId, actor, (existing) => {
    const content = contentFrom({
      title: input.title ?? existing.title,
      assetType: input.assetType ?? existing.assetType,
      sceneDescription: input.sceneDescription ?? existing.sceneDescription,
      composition: input.composition ?? existing.composition,
      cameraAngle: input.cameraAngle ?? existing.cameraAngle,
      lighting: input.lighting ?? existing.lighting,
      brandPalette: input.brandPalette ?? existing.brandPalette,
      messagingIntent: input.messagingIntent ?? existing.messagingIntent,
      platformSpec: input.platformSpec ?? existing.platformSpec,
      directions: input.directions ?? existing.directions,
      moodBoard: input.moodBoard ?? existing.moodBoard,
    });
    if (!content.title) throw new OpenwopError('validation_error', 'Field `title` is required.', 400, { field: 'title' });
    // R2 CRB-SP-10 — symmetric with createBrief: a PATCH could blank the
    // required sceneDescription ('' ?? existing keeps '').
    if (!content.sceneDescription) throw new OpenwopError('validation_error', 'Field `sceneDescription` is required.', 400, { field: 'sceneDescription' });
    const next: CreativeBrief = {
      ...existing, ...content,
      // A content edit on an approved brief demotes to draft (the campaign-brief
      // re-approval discipline); the sharing route purges links on demotion.
      status: existing.status === 'approved' ? 'draft' : existing.status,
      version: existing.version + 1,
      updatedBy: actor, updatedAt: nowIso(),
    };
    // R2 CRB-SP-7 (review fold-in) — `platformSpec: null` is an explicit CLEAR.
    // Absent-key means keep, and a cleaned-to-empty spec is omitted from
    // `content`, so the spread above resurrects the stored value: no payload
    // shape could clear the field (the Save button then re-armed forever).
    if (input.platformSpec === null) delete next.platformSpec;
    return next;
  });
}

export async function transitionBrief(tenantId: string, orgId: string, briefId: string, actor: string, statusRaw: unknown): Promise<CreativeBrief> {
  const status = statusRaw as CreativeBriefStatus;
  if (!CREATIVE_BRIEF_STATUSES.includes(status)) {
    throw new OpenwopError('validation_error', `\`status\` MUST be one of: ${CREATIVE_BRIEF_STATUSES.join(', ')}.`, 400, { field: 'status' });
  }
  // R2 CRB-SP-2 — this was a non-CAS read-then-put: a transition racing a
  // concurrent PATCH could erase the edit, approve content the approver never
  // saw, and REGRESS `version` (corrupting render `briefVersion` semantics).
  // Same CAS writer as every other mutation; transitions still don't bump
  // version or snapshot (round-1 semantics), so the legality check runs
  // against the FRESH row inside the mutate.
  return mutateBrief(tenantId, orgId, briefId, actor, (existing) => {
    if (existing.status === status) return existing; // idempotent no-op (CAS on identical row succeeds)
    if (!STATUS_TRANSITIONS[existing.status].includes(status)) {
      throw new OpenwopError('conflict', `Invalid transition: ${existing.status} → ${status}.`, 409, { from: existing.status, to: status });
    }
    // R2 CRB-SP-10 — approval is what unlocks EXTERNAL sharing, and the UI copy
    // says error-severity issues "must be fixed": the gate now agrees.
    if (status === 'approved') {
      const issues = validateBriefContent(existing).filter((i) => i.severity === 'error');
      if (issues.length > 0) {
        throw new OpenwopError('validation_error', `Cannot approve: ${issues.length} blocking issue(s) — ${issues.map((i) => i.message).join(' ')}`, 409, { issues });
      }
    }
    return { ...existing, status, updatedBy: actor, updatedAt: nowIso() };
  }, { snapshot: false });
}

export async function deleteBrief(tenantId: string, orgId: string, briefId: string): Promise<boolean> {
  const existing = await getBrief(tenantId, orgId, briefId);
  if (!existing) return false;
  // Versions first — a mid-way failure leaves no orphans reachable from a parent.
  for (const v of await versions.listByPrefix(`${tenantId}:${orgId}:${briefId}:`)) await versions.delete(`${v.tenantId}:${v.orgId}:${v.versionId}`);
  await briefs.delete(`${tenantId}:${orgId}:${briefId}`);
  // CB-CODE-2 / CS-DATA-2 — the mood board's media usage-refs die with the
  // brief (media owns the rows). Best-effort like the stamping that wrote them:
  // bookkeeping never blocks the delete, but a failure is visible.
  try {
    await clearUsageForRef(tenantId, orgId, 'creative-brief', briefId);
  } catch (err) {
    log.warn('usage-ref cascade failed on brief delete', { briefId, error: err instanceof Error ? err.message : String(err) });
  }
  // WF-SHARE-3 (R2 review, F8) — the share-link cascade belongs on the DELETE
  // OWNER, not on the route. It lived in `routes.ts` only, so the two callers
  // that reach this function directly — `host/campaignShowcaseSeed.ts`'s
  // demo-clear and the bulk delete above it — orphaned every `creative_brief`
  // link they killed: a live public URL to a brief that no longer exists, which
  // the retention sweep never reclaims (an orphaned link is neither revoked nor
  // expired). That is the identical non-route-deleter defect WF-SHARE-3 fixed
  // for canvases and documents, so `creative_brief` was being counted in the
  // "eleven of twelve" on the strength of a cascade half its callers skipped.
  //
  // Dynamic import: `sharing/sharingService.ts` statically imports THIS module
  // for its `creative_brief` resolver, so a static edge back would cycle — the
  // same shape `crm/bookingService.ts` and `commerce/commerceService.ts` use.
  // Idempotent, so the route-level calls that remain are harmless no-ops.
  try {
    const { purgeLinksForResource } = await import('../sharing/sharingService.js');
    await purgeLinksForResource(tenantId, 'creative_brief', briefId);
  } catch (err) {
    log.warn('share-link cascade failed on brief delete', { briefId, error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

export async function listVersions(tenantId: string, orgId: string, briefId: string): Promise<CreativeBriefVersion[]> {
  await mustGet(tenantId, orgId, briefId);
  return (await versions.listByPrefix(`${tenantId}:${orgId}:${briefId}:`)).sort((a, b) => b.version - a.version);
}

/** Field-level diff between two versions (the spec's diff view; computed, not stored). */
export function diffVersions(a: CreativeBriefVersion, b: CreativeBriefVersion): Array<{ field: string; from: unknown; to: unknown }> {
  const fields = new Set([...Object.keys(a.snapshot), ...Object.keys(b.snapshot)]);
  const out: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const f of fields) {
    const av = (a.snapshot as Record<string, unknown>)[f];
    const bv = (b.snapshot as Record<string, unknown>)[f];
    if (JSON.stringify(av) !== JSON.stringify(bv)) out.push({ field: f, from: av, to: bv });
  }
  return out;
}

// ── Mood board (ADR 0353 P3) ─────────────────────────────────────────────────

/** Assemble a mood-board PROPOSAL from the media library's deterministic
 *  weighted selection; when nothing matches, the needsAsset gap lands on the
 *  brief as the "go shoot this" note. */
export async function assembleMoodBoard(tenantId: string, orgId: string, briefId: string, actor: string, criteria: { product?: string; industry?: string; useCase?: string; personaIds?: string[]; limit?: number }): Promise<CreativeBrief> {
  await mustGet(tenantId, orgId, briefId); // 404 before the (side-effect-free) selection
  const result = await selectAssets(tenantId, orgId, { ...criteria, limit: criteria.limit ?? 6 });
  const moodBoard: MoodBoardItem[] = result.assets.map((s) => ({ mediaAssetId: s.asset.assetId, note: s.matched.length > 0 ? `matched: ${s.matched.join(', ')}` : 'library fallback' }));
  return mutateBrief(tenantId, orgId, briefId, actor, (existing) => {
    const next: CreativeBrief = {
      ...existing,
      moodBoard,
      // CB-CODE-1 — assembling onto an APPROVED brief is a content edit exactly
      // like PATCH: demote to draft (the re-approval discipline); the route
      // purges share links on the demotion, same as the PATCH flow.
      status: existing.status === 'approved' ? 'draft' : existing.status,
      ...(result.needsAsset ? { needsAssetNote: `No library asset matches ${JSON.stringify(result.needsAsset.criteria)} — plan a shoot or generate a concept.` } : {}),
      version: existing.version + 1,
      updatedBy: actor, updatedAt: nowIso(),
    };
    if (!result.needsAsset) delete (next as Partial<CreativeBrief>).needsAssetNote;
    return next;
  });
}

/** Stamp `creative-brief` usage-refs for the mood board's assets (ADR 0352 P6
 *  — the "used in N campaigns" graph). Serve tokens are media-internal, so the
 *  ref sync resolves by assetId → token via the media service's own rows. */
async function stampMoodBoardUsage(b: CreativeBrief): Promise<void> {
  try {
    const tokens: string[] = [];
    for (const item of b.moodBoard) {
      const a = await getAsset(b.tenantId, b.orgId, item.mediaAssetId);
      if (a) tokens.push(a.serveToken);
    }
    await syncUsageRefs(b.tenantId, b.orgId, { kind: 'creative-brief', id: b.briefId, label: b.title }, tokens);
  } catch (err) {
    // Best-effort — usage stamping never fails a brief write, but the failure
    // is logged rather than swallowed (CB-CODE-7).
    log.warn('mood-board usage stamping failed', { briefId: b.briefId, error: err instanceof Error ? err.message : String(err) });
  }
}

// ── The ported BUILD modes (ADR 0353 P2 — from vendor.myndhyve.ads-studio-core) ──

export interface BuildIssue { field: string; severity: 'error' | 'warning'; message: string }

/** Deterministic completeness validation (the pilot pack's `validateBrief`,
 *  re-expressed for the visual-brief shape). */
export function validateBriefContent(b: Pick<CreativeBrief, 'title' | 'sceneDescription' | 'directions' | 'messagingIntent' | 'platformSpec'>): BuildIssue[] {
  const issues: BuildIssue[] = [];
  if (!b.title?.trim()) issues.push({ field: 'title', severity: 'error', message: 'A title is required' });
  if (!b.sceneDescription?.trim()) issues.push({ field: 'sceneDescription', severity: 'error', message: 'A scene description is required' });
  if (!b.directions || b.directions.length === 0) issues.push({ field: 'directions', severity: 'warning', message: 'No creative directions — execution may lack variety' });
  if (!b.messagingIntent?.trim()) issues.push({ field: 'messagingIntent', severity: 'warning', message: 'Messaging intent helps the designer land the point' });
  if (!b.platformSpec?.platform) issues.push({ field: 'platformSpec', severity: 'warning', message: 'No platform target selected' });
  return issues;
}

/** MERGE mode: overlay sparse `patch` fields onto `base` (arrays replace,
 *  scalars overlay-if-present) — the pilot pack's merge semantics. */
export function mergeBriefContent(base: BriefContentInput, patch: BriefContentInput): BriefContentInput {
  const out: BriefContentInput = { ...base };
  for (const k of Object.keys(patch) as Array<keyof BriefContentInput>) {
    const v = patch[k];
    if (v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')) out[k] = v;
  }
  return out;
}

/** EXTRACTION mode: derive a visual-brief draft from a campaign messaging
 *  kernel + channel context (deterministic projection — the AI variant rides
 *  the Creative Director agent, not this builder). */
export function extractBriefContent(input: { title?: string; assetType?: string; kernel?: { headline?: string; supportingStatement?: string; primaryCta?: string; tone?: string }; industry?: string; platform?: string }): BriefContentInput {
  const k = input.kernel ?? {};
  return {
    title: input.title ?? (k.headline ? `Visual: ${k.headline}` : 'Untitled visual brief'),
    assetType: input.assetType ?? 'image',
    sceneDescription: [k.headline, k.supportingStatement].filter(Boolean).join(' — ') || 'Scene to be defined.',
    messagingIntent: [k.headline, k.primaryCta ? `CTA: ${k.primaryCta}` : ''].filter(Boolean).join(' · '),
    ...(input.platform ? { platformSpec: { platform: input.platform } } : {}),
    directions: [
      { label: 'Product in use', rationale: 'Show the outcome the buyer wants' },
      { label: 'Before / after', rationale: 'Contrast the pain with the solution' },
    ],
    moodBoard: [],
  };
}

// Test-only.
export async function __clearCreativeBriefs(): Promise<void> {
  for (const b of await briefs.list()) await briefs.delete(`${b.tenantId}:${b.orgId}:${b.briefId}`);
  for (const v of await versions.list()) await versions.delete(`${v.tenantId}:${v.orgId}:${v.versionId}`);
}
