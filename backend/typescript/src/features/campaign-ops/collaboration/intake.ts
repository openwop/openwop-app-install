/**
 * ADR 0958 D5 / P3 — vendor asset intake: files a collaborator sends in, held
 * inert until an agency member accepts them into the client's media library.
 *
 * WHERE THE GUARD SITS (ADR 0818: at the exit, not only the writer). A pending
 * file is NOT a media asset. Its bytes live in this module's own store, which no
 * serve route reads: there is no capability token, no library row, no picker
 * entry and no lineage until accept. So every door that serves or selects media
 * (the public token route, the library list/get/select, the media picker, a
 * destination adapter's token lookup, a creative pipeline) cannot reach it, by
 * absence rather than by a check each consumer must remember. The only read of
 * pending bytes is the agency review download, for members who may accept
 * (`workspace:write`), sent as an attachment under a sandbox CSP.
 *
 * At accept the bytes become an ordinary library asset (`createAsset`), served
 * by the one token route with the ADR 0818 headers, carrying the write-once
 * `lineage.suppliedBy` and the accepted rights summary in `rightsNote`.
 *
 * THE WRITER'S CHECKS (the other half): a narrow type allowlist (raster
 * images, PDF, MP4/WebM video; never markup, SVG, archives or executables),
 * every type proven by its magic bytes (a mislabelled image is relabelled,
 * anything else that is not what it claims is refused), byte caps, a per-grant
 * quota, `contentHash` dedupe within the grant, and the scan port
 * (`host/uploadScan.ts`): infected or a scanner fault refuses the upload; with
 * no scanner the allowlist is the guard (ADR 0958 Q2 stays open). A file stored
 * before a scanner existed is scanned at accept.
 *
 * ISOLATION. Tenant and org come from the GRANT on the vendor side and from the
 * authorized path org on the agency side; every row read asserts both, and every
 * miss is the same 404. A vendor sees only intakes sent through their own grant.
 *
 * @see docs/adr/0958-vendor-and-guest-collaboration.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { OpenwopError } from '../../../types.js';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { cleanString } from '../../../host/boundedStrings.js';
import { declarePiiFields } from '../../../host/dataClassification.js';
import { appendAudit, AUDIT_KIND_GOVERNANCE_DECISION } from '../../../host/auditChainService.js';
import { storableContentType } from '../../../host/allowedUploadMime.js';
import { scanUpload, scannerRequiredButMissing, type UploadScanVerdict } from '../../../host/uploadScan.js';
import { registerDefaultWindowSweep, type PurgeOutcome } from '../../../host/retentionPurger.js';
import { getRetentionHold } from '../../../host/retentionHold.js';
import { emitHostEvent } from '../../../host/hostEventDispatcher.js';
import type { GrantUse } from '../../../host/externalCollaborators.js';
import { assertOrgCapacity, createAsset, deleteAsset, eraseSupplierDetails, findAssetByContentHash, listAssets, withOrgCapacity, type MediaAsset } from '../../media/mediaService.js';
import { autonomyToggleOn } from '../../../host/autonomyPolicy/service.js';
import { resolveEffectivePolicy } from '../../../host/autonomyPolicy/store.js';
import { emitAutonomyNotice, resolveCampaignAction, type Decision } from '../../../host/autonomyPolicy/index.js';
import { isEligibleApprover } from '../../../host/approverResolution.js';
import * as mediaStorage from '../../media/mediaStorage.js';
import { createLogger } from '../../../observability/logger.js';

const log = createLogger('campaign-ops.intake');

export const INTAKE_LICENSES = ['work-for-hire', 'licensed-perpetual', 'licensed-term', 'client-owned', 'stock'] as const;
export type IntakeLicense = (typeof INTAKE_LICENSES)[number];
export type IntakeStatus = 'submitted' | 'accepted' | 'rejected' | 'withdrawn';

export interface IntakeRights {
  license: IntakeLicense;
  /** Required for `licensed-term`: the date the licence ends (YYYY-MM-DD). */
  termEndsAt?: string;
  credit?: string;
  modelReleases: boolean;
  /** Server time of the vendor's attestation. */
  attestedAt: string;
}

export interface IntakeFile {
  fileId: string;
  name: string;
  contentType: string;
  bytes: number;
  contentHash: string;
  /** The scan verdict at upload (`clean` or `not_configured`; nothing else is stored). */
  scan: 'clean' | 'not_configured';
  /** Set at accept: the library asset these bytes became. */
  mediaAssetId?: string;
  /** Set when the held bytes were deleted (accept, withdraw, or the reject purge). */
  bytesPurgedAt?: string;
}

export interface AssetIntake {
  /** `${tenantId}::${orgId}::${intakeId}` */
  key: string;
  intakeId: string;
  tenantId: string;
  orgId: string;
  campaignId: string;
  grantId: string;
  collaboratorId: string;
  files: IntakeFile[];
  rights: IntakeRights;
  note?: string;
  status: IntakeStatus;
  submittedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reason?: string;
  /** A reject starts the 30-day purge clock. */
  rejectedAt?: string;
  /** An in-flight accept (see `acceptIntake`). */
  acceptClaim?: { by: string; at: string };
  /** ADR 0958 P5: the supplier was erased; the person's text is gone from this
   *  row and from the library assets it produced. */
  supplierErasedAt?: string;
  updatedAt: string;
}

interface HeldBytes { key: string; tenantId: string; orgId: string; intakeId: string; contentBase64: string }

declarePiiFields('campaignOps.intake', ['rights.credit', 'note', 'files.name']);

const keyOf = (tenantId: string, orgId: string, id: string): string => `${tenantId}::${orgId}::${id}`;
const intakes = new DurableCollection<AssetIntake>('campaign-ops:intake', (r) => r.key, undefined, (r) => r.tenantId);
/** The held bytes of a PENDING (or rejected, until purged) file. No route serves
 *  this store except the agency review download. */
const heldBytes = new DurableCollection<HeldBytes>('campaign-ops:intake-bytes', (r) => r.key, undefined, (r) => r.tenantId);

const MiB = 1024 * 1024;
/** One request: ≤ 5 files, ≤ 8 MiB decoded (the scoped body parser admits 12 MB of JSON). */
export const INTAKE_MAX_FILES = 5;
export const INTAKE_MAX_REQUEST_BYTES = 8 * MiB;
/** Per grant: live (submitted or accepted) intakes, and bytes held (submitted or rejected-unpurged). */
const PER_GRANT_INTAKES = 50;
const PER_GRANT_HELD_BYTES = 200 * MiB;
/** Per client org, across every grant and collaborator: bytes waiting for review. */
const PER_ORG_HELD_BYTES = 1024 * MiB;
export const REJECT_PURGE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACCEPT_CLAIM_STALE_MS = 2 * 60 * 1000;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ADR 0958 Q2 — the refusal while the deployment has no file scanner. */
const scannerRequired = (): OpenwopError => new OpenwopError('service_unavailable', 'File uploads are not available yet: no file scanner is set up for this workspace.', 503, { reason: 'scanner_required' });

const notFound = (): OpenwopError => new OpenwopError('not_found', 'Not found.', 404, {});
const nowIso = (): string => new Date().toISOString();

/** v1 intake types. Every one is proven by its bytes (`intakeContentType`). */
export const INTAKE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm'];
const VIDEO_SIGNATURES: Readonly<Record<string, (b: Buffer) => boolean>> = {
  // ISO base media: a box size, then `ftyp` at offset 4.
  'video/mp4': (b) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp',
  // Matroska/WebM: the EBML magic.
  'video/webm': (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
};

/** The type to store for these bytes, or null to refuse. Images are relabelled to
 *  what they are (the media library rule); PDF and video must carry their magic. */
export function intakeContentType(declared: string, bytes: Buffer): string | null {
  if (!INTAKE_TYPES.includes(declared)) return null;
  if (declared.startsWith('video/')) return VIDEO_SIGNATURES[declared]!(bytes) ? declared : null;
  const stored = storableContentType(declared, bytes);
  return stored && INTAKE_TYPES.includes(stored) ? stored : null;
}

function audit(tenantId: string, payload: Record<string, unknown>): void {
  // Ids only (ADR 0958 D7).
  void appendAudit(tenantId, AUDIT_KIND_GOVERNANCE_DECISION, { domain: 'external-collaboration', ...payload })
    .catch((err: unknown) => log.warn('intake_audit_failed', { tenantId, error: err instanceof Error ? err.message : String(err) }));
}

function invalid(field: string, message: string, status = 400, extra: Record<string, unknown> = {}): OpenwopError {
  return new OpenwopError('validation_error', message, status, { field, ...extra });
}

function parseRights(raw: unknown, now: Date): IntakeRights {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  if (typeof r.license !== 'string' || !(INTAKE_LICENSES as readonly string[]).includes(r.license)) {
    throw invalid('rights.license', `\`rights.license\` must be one of: ${INTAKE_LICENSES.join(', ')}.`);
  }
  if (typeof r.modelReleases !== 'boolean') throw invalid('rights.modelReleases', '`rights.modelReleases` must be true or false.');
  if (r.attest !== true) throw invalid('rights.attest', 'Confirm that you have the right to supply these files on these terms (`rights.attest: true`).');
  const out: IntakeRights = { license: r.license as IntakeLicense, modelReleases: r.modelReleases, attestedAt: now.toISOString() };
  if (out.license === 'licensed-term') {
    const end = typeof r.termEndsAt === 'string' ? r.termEndsAt.trim() : '';
    if (!DATE_RE.test(end) || Number.isNaN(Date.parse(`${end}T00:00:00Z`)) || Date.parse(`${end}T23:59:59Z`) < now.getTime()) {
      throw invalid('rights.termEndsAt', 'A term licence needs `rights.termEndsAt`, a future date (YYYY-MM-DD).');
    }
    out.termEndsAt = end;
  }
  const credit = r.credit === undefined ? '' : cleanString(r.credit, 200, '').trim();
  if (credit) out.credit = credit;
  return out;
}

/** The accepted rights summary written to the asset's `rightsNote` (≤ 400). */
export function rightsSummary(r: IntakeRights): string {
  const parts = [`Licence: ${r.license}${r.termEndsAt ? ` until ${r.termEndsAt}` : ''}`, `model releases: ${r.modelReleases ? 'yes' : 'no'}`];
  if (r.credit) parts.push(`credit: ${r.credit}`);
  parts.push('supplied by an external collaborator (vendor intake)');
  return parts.join('; ').slice(0, 400);
}

interface ParsedFile { name: string; contentType: string; buf: Buffer; contentBase64: string; contentHash: string }

function parseFiles(raw: unknown): ParsedFile[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > INTAKE_MAX_FILES) throw invalid('files', `\`files\` must hold 1–${INTAKE_MAX_FILES} files.`);
  let total = 0;
  const out: ParsedFile[] = [];
  for (const [i, item] of raw.entries()) {
    const f = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const name = cleanString(f.name, 120, '').trim();
    if (!name) throw invalid(`files[${i}].name`, 'Each file needs a `name`.');
    const b64 = typeof f.contentBase64 === 'string' ? f.contentBase64 : '';
    if (!b64 || !BASE64_RE.test(b64) || b64.length % 4 !== 0) throw invalid(`files[${i}].contentBase64`, 'Each file needs valid base64 `contentBase64`.');
    const buf = Buffer.from(b64, 'base64');
    total += buf.length;
    if (total > INTAKE_MAX_REQUEST_BYTES) throw invalid('files', `Files may total at most ${INTAKE_MAX_REQUEST_BYTES / MiB} MiB per upload.`, 413);
    const declared = typeof f.contentType === 'string' ? f.contentType.trim().toLowerCase() : '';
    const contentType = intakeContentType(declared, buf);
    if (!contentType) {
      throw invalid(`files[${i}].contentType`, `"${name}" is not an accepted file. Send PNG, JPEG, GIF or WebP images, PDF, or MP4/WebM video, and the file must really be that type.`, 415, { accepted: INTAKE_TYPES });
    }
    const contentHash = createHash('sha256').update(buf).digest('hex');
    if (out.some((o) => o.contentHash === contentHash)) throw invalid(`files[${i}]`, `"${name}" is the same file as another in this upload.`, 409, { reason: 'duplicate_file' });
    out.push({ name, contentType, buf, contentBase64: b64, contentHash });
  }
  return out;
}

async function listOrgIntakes(tenantId: string, orgId: string): Promise<AssetIntake[]> {
  return (await intakes.listByPrefix(`${tenantId}::${orgId}::`)).filter((r) => r.tenantId === tenantId && r.orgId === orgId);
}

export async function getIntake(tenantId: string, orgId: string, intakeId: string): Promise<AssetIntake | null> {
  const r = await intakes.get(keyOf(tenantId, orgId, intakeId));
  return r && r.tenantId === tenantId && r.orgId === orgId ? r : null;
}

/** The agency's list for one client, newest first. */
export async function listIntakes(tenantId: string, orgId: string, status?: IntakeStatus): Promise<AssetIntake[]> {
  return (await listOrgIntakes(tenantId, orgId))
    .filter((r) => !status || r.status === status)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

/** The vendor's own intakes through ONE grant (never another grant's, even the same person's). */
export async function listIntakesForGrant(use: GrantUse): Promise<AssetIntake[]> {
  return (await listOrgIntakes(use.tenantId, use.orgId))
    .filter((r) => r.grantId === use.grant.grantId && r.collaboratorId === use.collaborator.collaboratorId)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

const heldBytesOf = (r: AssetIntake): number => r.files.reduce((n, f) => n + (f.bytesPurgedAt ? 0 : f.bytes), 0);

/**
 * The vendor submits files with their rights. `use` is a checked `upload` use of a
 * `campaign` grant (the route ran `checkGrantUse`); tenant, org and campaign come
 * from it, never from the request.
 */
export async function submitIntake(use: GrantUse, body: { files?: unknown; rights?: unknown; note?: unknown }, now: Date = new Date()): Promise<AssetIntake> {
  if (use.grant.resource.kind !== 'campaign') throw notFound();
  const rights = parseRights(body.rights, now);
  const files = parseFiles(body.files);
  const note = body.note === undefined ? '' : cleanString(body.note, 1000, '').trim();
  const mine = await listIntakesForGrant(use);
  const live = mine.filter((r) => r.status === 'submitted' || r.status === 'accepted');
  if (live.length >= PER_GRANT_INTAKES) {
    throw new OpenwopError('rate_limited', `This grant has reached its limit of ${PER_GRANT_INTAKES} submissions. Ask the agency to review or reject some first.`, 429, { reason: 'intake_quota' });
  }
  const held = mine.reduce((n, r) => n + heldBytesOf(r), 0);
  const adding = files.reduce((n, f) => n + f.buf.length, 0);
  if (held + adding > PER_GRANT_HELD_BYTES) {
    throw new OpenwopError('rate_limited', `This grant holds at most ${PER_GRANT_HELD_BYTES / MiB} MiB of files awaiting review.`, 429, { reason: 'intake_quota' });
  }
  // The org-wide bound: grants are minted only by agency members, but many grants
  // must not add up to unbounded unreviewed storage for one client.
  const orgHeld = (await listOrgIntakes(use.tenantId, use.orgId)).reduce((n, r) => n + heldBytesOf(r), 0);
  if (orgHeld + adding > PER_ORG_HELD_BYTES) {
    throw new OpenwopError('rate_limited', 'This client has too many files waiting for review. Ask the agency to review some first.', 429, { reason: 'intake_quota' });
  }
  for (const f of files) {
    if (live.some((r) => r.files.some((x) => x.contentHash === f.contentHash))) {
      throw new OpenwopError('conflict', `"${f.name}" was already sent through this grant.`, 409, { reason: 'duplicate_file' });
    }
  }
  // ADR 0958 Q2 — no scanner, no outsider uploads (unless the dev waiver is set).
  if (scannerRequiredButMissing()) throw scannerRequired();
  // Scan every file BEFORE anything is stored: a refusal stores nothing.
  const verdicts: UploadScanVerdict[] = [];
  for (const f of files) {
    const v = await scanUpload({ tenantId: use.tenantId, contentType: f.contentType, bytes: f.buf });
    if (v === 'infected') throw new OpenwopError('validation_error', `"${f.name}" was refused by the file scanner.`, 422, { reason: 'scan_infected' });
    if (v === 'error') throw new OpenwopError('service_unavailable', 'Files cannot be checked right now, so nothing was uploaded. Try again later.', 503, { reason: 'scan_unavailable' });
    verdicts.push(v);
  }
  const intakeId = `intk_${randomUUID()}`;
  const ts = now.toISOString();
  const stored: IntakeFile[] = [];
  for (const [i, f] of files.entries()) {
    const fileId = `ifl_${randomUUID()}`;
    await heldBytes.put({ key: keyOf(use.tenantId, use.orgId, fileId), tenantId: use.tenantId, orgId: use.orgId, intakeId, contentBase64: f.contentBase64 });
    stored.push({ fileId, name: f.name, contentType: f.contentType, bytes: f.buf.length, contentHash: f.contentHash, scan: verdicts[i] === 'clean' ? 'clean' : 'not_configured' });
  }
  const row: AssetIntake = {
    key: keyOf(use.tenantId, use.orgId, intakeId),
    intakeId, tenantId: use.tenantId, orgId: use.orgId,
    campaignId: use.grant.resource.id, grantId: use.grant.grantId, collaboratorId: use.collaborator.collaboratorId,
    files: stored, rights, ...(note ? { note } : {}),
    status: 'submitted', submittedAt: ts, updatedAt: ts,
  };
  if (!(await intakes.compareAndSwap(null, row))) {
    for (const f of stored) await heldBytes.delete(keyOf(use.tenantId, use.orgId, f.fileId)).catch(() => undefined);
    throw new OpenwopError('conflict', 'Try again.', 409, {});
  }
  audit(use.tenantId, { action: 'intake.submit', intakeId, grantId: use.grant.grantId, collaboratorId: use.collaborator.collaboratorId, orgId: use.orgId, files: stored.length });
  return row;
}

async function dropHeldBytes(r: AssetIntake): Promise<void> {
  for (const f of r.files) await heldBytes.delete(keyOf(r.tenantId, r.orgId, f.fileId)).catch(() => undefined);
}

/** An accept whose process died after writing an asset but before the intake
 *  became `accepted` cannot run its own rollback. When that intake is then
 *  rejected or withdrawn, the library assets it left (found by
 *  `lineage.suppliedBy.intakeId`) are removed, so a file that was never accepted
 *  is never usable. Returns how many were removed. */
async function removeUnacceptedAssets(r: AssetIntake): Promise<number> {
  let n = 0;
  for (const a of await listAssets(r.tenantId, r.orgId)) {
    if (a.lineage?.suppliedBy?.intakeId !== r.intakeId) continue;
    try { if (await deleteAsset(r.tenantId, r.orgId, a.assetId)) n += 1; }
    catch (err) { log.error('intake_orphan_asset_delete_failed', { intakeId: r.intakeId, assetId: a.assetId, error: err instanceof Error ? err.message : String(err) }); }
  }
  return n;
}

/** The vendor withdraws a submission the agency has not decided. The held bytes go at once. */
export async function withdrawIntake(use: GrantUse, intakeId: string): Promise<AssetIntake> {
  const cur = await getIntake(use.tenantId, use.orgId, intakeId);
  if (!cur || cur.grantId !== use.grant.grantId || cur.collaboratorId !== use.collaborator.collaboratorId) throw notFound();
  if (cur.status !== 'submitted' || cur.acceptClaim) {
    throw new OpenwopError('conflict', 'Only a submission awaiting review can be withdrawn.', 409, { reason: 'intake_decided', status: cur.status });
  }
  const ts = nowIso();
  const next: AssetIntake = { ...cur, status: 'withdrawn', files: cur.files.map((f) => ({ ...f, bytesPurgedAt: ts })), updatedAt: ts };
  if (!(await intakes.compareAndSwap(cur, next))) throw new OpenwopError('conflict', 'The submission changed. Reload and try again.', 409, { reason: 'intake_changed' });
  await dropHeldBytes(cur);
  await removeUnacceptedAssets(cur);
  audit(use.tenantId, { action: 'intake.withdraw', intakeId, grantId: use.grant.grantId, collaboratorId: use.collaborator.collaboratorId, orgId: use.orgId });
  return next;
}

/** The agency review download's bytes. Only a submitted intake's held bytes. */
export async function readHeldFile(tenantId: string, orgId: string, intakeId: string, fileId: string): Promise<{ file: IntakeFile; bytes: Buffer } | null> {
  const r = await getIntake(tenantId, orgId, intakeId);
  const file = r?.status === 'submitted' ? r.files.find((f) => f.fileId === fileId) : undefined;
  if (!r || !file || file.bytesPurgedAt) return null;
  const held = await heldBytes.get(keyOf(tenantId, orgId, fileId));
  if (!held || held.tenantId !== tenantId || held.orgId !== orgId || held.intakeId !== intakeId) return null;
  return { file, bytes: Buffer.from(held.contentBase64, 'base64') };
}

/**
 * ADR 0942 D1 — the campaign's autonomy rule for `asset.accept-vendor`, applied to
 * the human accept. With autonomy off for the tenant there is no rule, and the
 * route's `workspace:write` is the bar. With it on:
 *  - `blocked` refuses;
 *  - `approve` admits only an approver the rule names, resolved on the client org
 *    (the one ADR 0075 authority). A rule that needs more than one approver, or a
 *    client approver, needs the review queue (owed: the `asset-intake-accept`
 *    PendingApproval kind) and is refused rather than satisfied by one click;
 *  - `auto` and `notify-after` proceed; notify-after sends its notice after.
 * Returns the decision so the caller can notify after the effect.
 */
async function acceptPolicy(r: AssetIntake, by: string): Promise<Decision | null> {
  if (!(await autonomyToggleOn(r.tenantId))) return null;
  const { policy } = await resolveEffectivePolicy(r.tenantId, r.orgId, r.campaignId);
  const { decision } = resolveCampaignAction({ policy, actionClass: 'asset.accept-vendor', facts: {} });
  if (decision.outcome === 'blocked') {
    throw new OpenwopError('forbidden_scope', 'This campaign\'s autonomy policy blocks accepting vendor files.', 403, { reason: 'autonomy_blocked' });
  }
  if (decision.outcome === 'approve') {
    const a = decision.approver;
    if (a.requiredApprovals > 1 || a.clientApprover || (a.perParty?.length ?? 0) > 0) {
      throw new OpenwopError('conflict', 'This campaign\'s autonomy policy needs more than one approver to accept vendor files, which this screen cannot collect yet.', 409, { reason: 'autonomy_quorum_unsupported' });
    }
    const refs = {
      ...(a.roleRefs?.length ? { approverRoleRefs: a.roleRefs } : {}),
      ...(a.groupRefs?.length ? { approverGroupRefs: a.groupRefs } : {}),
      ...(a.subjectRefs?.length ? { approverRefs: a.subjectRefs } : {}),
    };
    if (!(await isEligibleApprover(by, refs, { tenantId: r.tenantId, orgId: r.orgId })).eligible) {
      throw new OpenwopError('forbidden_scope', 'This campaign\'s autonomy policy names who may accept vendor files, and you are not one of them.', 403, { reason: 'autonomy_approver_required' });
    }
  }
  return decision;
}

function assertDecidable(r: AssetIntake, now: number): void {
  if (r.status !== 'submitted') throw new OpenwopError('conflict', `This submission is already ${r.status}.`, 409, { reason: 'intake_decided', status: r.status });
  if (r.acceptClaim && now - Date.parse(r.acceptClaim.at) < ACCEPT_CLAIM_STALE_MS) {
    throw new OpenwopError('conflict', 'This submission is being accepted right now.', 409, { reason: 'intake_busy' });
  }
}

/**
 * The agency accepts: every file becomes a library asset in the client org with
 * `lineage.suppliedBy` and the rights summary, then the intake is `accepted`.
 * The route authorized `workspace:write` on the org.
 *
 * Crash- and race-safe in two steps: a CAS CLAIM on the submitted row (a second
 * accept is refused `intake_busy` until the claim is 2 minutes stale), then the
 * asset writes, then the CAS to `accepted`. A retry after a crash re-takes the
 * stale claim; a file whose bytes already reached the library (same hash) is
 * linked, not copied. Bytes the agency's library already held are linked to the
 * existing asset and its provenance is left alone.
 */
export async function acceptIntake(tenantId: string, orgId: string, intakeId: string, by: string): Promise<{ intake: AssetIntake; assets: MediaAsset[] }> {
  const cur = await getIntake(tenantId, orgId, intakeId);
  if (!cur) throw notFound();
  assertDecidable(cur, Date.now());
  const decision = await acceptPolicy(cur, by);
  const claimed: AssetIntake = { ...cur, acceptClaim: { by, at: nowIso() }, updatedAt: nowIso() };
  if (!(await intakes.compareAndSwap(cur, claimed))) throw new OpenwopError('conflict', 'The submission changed. Reload and try again.', 409, { reason: 'intake_changed' });
  const release = async (): Promise<void> => {
    const now = await getIntake(tenantId, orgId, intakeId);
    if (now && now.acceptClaim?.at === claimed.acceptClaim!.at) {
      const { acceptClaim: _c, ...rest } = now;
      await intakes.compareAndSwap(now, { ...rest, updatedAt: nowIso() }).catch(() => undefined);
    }
  };
  // Assets THIS attempt created. A failure after any of them removes them again, so
  // an intake that is not accepted never leaves a usable library asset behind.
  const created: MediaAsset[] = [];
  try {
    // Re-scan anything stored before a scanner existed. Fail closed.
    const held: Array<{ file: IntakeFile; contentBase64: string }> = [];
    for (const f of cur.files) {
      const row = await heldBytes.get(keyOf(tenantId, orgId, f.fileId));
      if (!row || row.tenantId !== tenantId || row.orgId !== orgId || row.intakeId !== intakeId) {
        throw new OpenwopError('conflict', 'A file of this submission is missing; reject it and ask for a new upload.', 409, { reason: 'intake_bytes_missing' });
      }
      if (f.scan !== 'clean') {
        // A file stored unscanned (under the dev waiver) is scanned now, and never
        // accepted unscanned once the waiver is gone.
        if (scannerRequiredButMissing()) throw scannerRequired();
        const v = await scanUpload({ tenantId, contentType: f.contentType, bytes: Buffer.from(row.contentBase64, 'base64') });
        if (v === 'infected') throw new OpenwopError('conflict', `"${f.name}" was refused by the file scanner; reject this submission.`, 409, { reason: 'scan_infected' });
        if (v === 'error') throw new OpenwopError('service_unavailable', 'Files cannot be checked right now. Try again later.', 503, { reason: 'scan_unavailable' });
      }
      held.push({ file: f, contentBase64: row.contentBase64 });
    }
    const rightsNote = rightsSummary(cur.rights);
    const assets: MediaAsset[] = [];
    const files: IntakeFile[] = [];
    // Room for every new file BEFORE the first write, so a full library refuses
    // the whole accept instead of half of it. (Per-file capacity still applies
    // below, for a concurrent upload that takes the room meanwhile.)
    const existingByHash = new Map<string, MediaAsset>();
    for (const { file } of held) {
      const hit = await findAssetByContentHash(tenantId, orgId, file.contentHash);
      if (hit) existingByHash.set(file.contentHash, hit);
    }
    await assertOrgCapacity(tenantId, orgId, held.filter(({ file }) => !existingByHash.has(file.contentHash)).reduce((n, { file }) => n + file.bytes, 0));
    for (const { file, contentBase64 } of held) {
      const existing = existingByHash.get(file.contentHash);
      const asset = existing ?? await withOrgCapacity(tenantId, orgId, file.bytes, async () => {
        const stored = await mediaStorage.put(tenantId, { contentBase64, contentType: file.contentType });
        return createAsset({
          tenantId, orgId, name: file.name, contentType: file.contentType,
          sizeBytes: stored.sizeBytes, storageRef: stored.storageRef, serveToken: stored.serveToken,
          tags: ['vendor-supplied'], uploadedBy: by, contentHash: file.contentHash,
          lineage: { rightsNote },
          suppliedBy: { kind: 'vendor', collaboratorId: cur.collaboratorId, grantId: cur.grantId, intakeId },
        });
      });
      if (!existing) created.push(asset);
      assets.push(asset);
      files.push({ ...file, mediaAssetId: asset.assetId, bytesPurgedAt: nowIso() });
    }
    const latest = await getIntake(tenantId, orgId, intakeId);
    if (!latest || latest.status !== 'submitted' || latest.acceptClaim?.at !== claimed.acceptClaim!.at) {
      throw new OpenwopError('conflict', 'The submission changed while it was being accepted. Reload and try again.', 409, { reason: 'intake_changed' });
    }
    const ts = nowIso();
    const { acceptClaim: _claim, ...rest } = latest;
    const next: AssetIntake = { ...rest, status: 'accepted', files, reviewedBy: by, reviewedAt: ts, updatedAt: ts };
    if (!(await intakes.compareAndSwap(latest, next))) throw new OpenwopError('conflict', 'The submission changed. Reload and try again.', 409, { reason: 'intake_changed' });
    await dropHeldBytes(cur);
    audit(tenantId, { action: 'intake.accept', intakeId, grantId: cur.grantId, collaboratorId: cur.collaboratorId, orgId, assetIds: assets.map((a) => a.assetId) });
    void emitHostEvent({
      type: 'host.campaign.asset.accepted', tenantId,
      payload: { orgId, campaignId: cur.campaignId, intakeId, collaboratorId: cur.collaboratorId, assetIds: assets.map((a) => a.assetId) },
    });
    if (decision?.outcome === 'notify-after') {
      await emitAutonomyNotice({
        tenantId, orgId, campaignId: cur.campaignId, notify: decision.notify, actionClass: 'asset.accept-vendor',
        summary: `Vendor files accepted into the media library (${assets.length})`,
      }).catch((err: unknown) => log.warn('intake_accept_notice_failed', { intakeId, error: err instanceof Error ? err.message : String(err) }));
    }
    return { intake: next, assets };
  } catch (err) {
    for (const a of created) {
      await deleteAsset(tenantId, orgId, a.assetId).catch((e: unknown) => log.error('intake_accept_rollback_failed', { intakeId, assetId: a.assetId, error: e instanceof Error ? e.message : String(e) }));
    }
    await release();
    throw err;
  }
}

/** The agency rejects. The bytes are kept for {@link REJECT_PURGE_DAYS} days, then purged. */
export async function rejectIntake(tenantId: string, orgId: string, intakeId: string, by: string, reason: unknown): Promise<AssetIntake> {
  const cur = await getIntake(tenantId, orgId, intakeId);
  if (!cur) throw notFound();
  assertDecidable(cur, Date.now());
  const why = cleanString(reason, 500, '').trim();
  if (!why) throw invalid('reason', 'Say why the files are rejected; the vendor sees this.');
  const ts = nowIso();
  const { acceptClaim: _c, ...rest } = cur;
  const next: AssetIntake = { ...rest, status: 'rejected', reason: why, reviewedBy: by, reviewedAt: ts, rejectedAt: ts, updatedAt: ts };
  if (!(await intakes.compareAndSwap(cur, next))) throw new OpenwopError('conflict', 'The submission changed. Reload and try again.', 409, { reason: 'intake_changed' });
  await removeUnacceptedAssets(cur);
  audit(tenantId, { action: 'intake.reject', intakeId, grantId: cur.grantId, collaboratorId: cur.collaboratorId, orgId });
  return next;
}

/**
 * ADR 0958 D5 — a rejected intake's bytes are purged {@link REJECT_PURGE_DAYS}
 * days after the reject, on every posture (the default-window lane, not the
 * opt-in governance sweep). The intake row stays as the record; only the bytes
 * go. A tenant under legal hold keeps everything.
 */
export async function sweepRejectedIntakeBytes(nowMs: number = Date.now()): Promise<PurgeOutcome> {
  const cutoff = nowMs - REJECT_PURGE_DAYS * DAY_MS;
  const due = (await intakes.list()).filter((r) => r.status === 'rejected' && r.rejectedAt && Date.parse(r.rejectedAt) < cutoff && r.files.some((f) => !f.bytesPurgedAt));
  let deleted = 0;
  let failed = 0;
  const held = new Map<string, boolean>();
  for (const r of due) {
    if (!held.has(r.tenantId)) held.set(r.tenantId, Boolean(await getRetentionHold(r.tenantId)));
    if (held.get(r.tenantId)) continue;
    try {
      for (const f of r.files) {
        if (!f.bytesPurgedAt && await heldBytes.delete(keyOf(r.tenantId, r.orgId, f.fileId))) deleted += 1;
      }
      const ts = new Date(nowMs).toISOString();
      await intakes.compareAndSwap(r, { ...r, files: r.files.map((f) => (f.bytesPurgedAt ? f : { ...f, bytesPurgedAt: ts })), updatedAt: ts });
    } catch (err) {
      failed += 1;
      log.warn('intake_reject_purge_failed', { intakeId: r.intakeId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { deleted, failed };
}
registerDefaultWindowSweep({ feature: 'campaign-ops-intake-rejected', sweep: sweepRejectedIntakeBytes });

/** The neutral name an erased supplier's file takes (its extension kept). */
function erasedFileName(name: string, i: number): string {
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0] ?? '';
  return `vendor-file-${i + 1}${ext}`;
}

/** Delete an intake that was never accepted, with its held bytes and any
 *  library asset a dead accept left. A submission still awaiting review is
 *  first closed to `withdrawn` by CAS (claim dropped), so a concurrent accept
 *  fails its final CAS and rolls itself back. An accept that won the race makes
 *  this CAS fail, and the caller's retry then sees an accepted intake. */
async function deleteUnacceptedIntake(r: AssetIntake): Promise<number> {
  let n = 0;
  if (r.status === 'submitted') {
    const ts = nowIso();
    const { acceptClaim: _claim, ...open } = r;
    const closed: AssetIntake = { ...open, status: 'withdrawn', files: r.files.map((f) => (f.bytesPurgedAt ? f : { ...f, bytesPurgedAt: ts })), updatedAt: ts };
    if (!(await intakes.compareAndSwap(r, closed))) throw new Error(`intake ${r.intakeId} changed during removal`);
  }
  await dropHeldBytes(r);
  n += await removeUnacceptedAssets(r);
  if (await intakes.delete(r.key)) n += 1;
  return n;
}

/**
 * ADR 0958 P5 — the intake half of erasing one collaborator (registered as a
 * collaborator erase hook, so it runs before the record is deleted).
 *
 * - An ACCEPTED intake is the agency's record of files it took, with their
 *   rights, so it is kept, and so are its library assets. The person goes: the
 *   note, the credit line and the vendor's file names are removed from the row,
 *   and each asset's rights summary (and its name, while it is still the
 *   vendor's file name) is rewritten without them.
 * - Anything else (awaiting review, rejected, withdrawn) was never taken: its
 *   held bytes, any library asset a dead accept left behind, and the row go.
 *   It is first closed by CAS, so an accept in flight fails and rolls back.
 */
export async function eraseIntakesOfCollaborator(c: { tenantId: string; orgId: string; collaboratorId: string }): Promise<number> {
  let n = 0;
  for (const r of await listOrgIntakes(c.tenantId, c.orgId)) {
    if (r.collaboratorId !== c.collaboratorId) continue;
    if (r.status !== 'accepted') {
      n += await deleteUnacceptedIntake(r);
      continue;
    }
    if (r.supplierErasedAt) continue;
    const { credit: _credit, ...rights } = r.rights;
    const rightsNote = rightsSummary(rights);
    for (const [i, f] of r.files.entries()) {
      if (f.mediaAssetId && await eraseSupplierDetails(r.tenantId, r.orgId, f.mediaAssetId, { intakeId: r.intakeId, rightsNote, vendorFileName: f.name, replacementName: erasedFileName(f.name, i) })) n += 1;
    }
    const ts = nowIso();
    const { note: _note, ...rest } = r;
    const next: AssetIntake = { ...rest, rights, files: r.files.map((f, i) => ({ ...f, name: erasedFileName(f.name, i) })), supplierErasedAt: ts, updatedAt: ts };
    if (!(await intakes.compareAndSwap(r, next))) throw new Error(`intake ${r.intakeId} changed during erasure`);
    n += 1;
  }
  return n;
}

/**
 * ADR 0958 P5 — org teardown: delete every intake row of one client org
 * (`match` narrows it to one collaborator's). Unlike erasure, an ACCEPTED
 * intake goes too, because the org goes with it. The library assets an accept
 * made belong to the media library and are not touched here; their
 * `suppliedBy` ids then resolve to nothing. A never-accepted intake goes with
 * its held bytes, as on erasure.
 */
export async function purgeIntakesForOrg(tenantId: string, orgId: string, match: (r: AssetIntake) => boolean = () => true): Promise<number> {
  let n = 0;
  for (const r of await listOrgIntakes(tenantId, orgId)) {
    if (!match(r)) continue;
    if (r.status !== 'accepted') { n += await deleteUnacceptedIntake(r); continue; }
    if (await intakes.delete(r.key)) n += 1;
  }
  return n;
}

/** Test seam: does the held-bytes store still hold this file? */
export async function __heldBytesExistForTests(tenantId: string, orgId: string, fileId: string): Promise<boolean> {
  return (await heldBytes.get(keyOf(tenantId, orgId, fileId))) !== null;
}
