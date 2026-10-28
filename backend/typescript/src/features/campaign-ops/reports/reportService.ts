/**
 * ADR 0957 P0 — report definitions and frozen client reports.
 *
 * - A definition is validated closed-world against THIS client org: every
 *   campaign it names is one of the org's marketing campaigns, every section
 *   kind is in `REPORT_SECTION_SOURCES`, and section params are the kind's own.
 *   An edit bumps `version`.
 * - A report is computed once and frozen: its snapshot is copied from the
 *   section sources and hashed (`snapshotHash`). A re-compute is a NEW report;
 *   a stored report is never edited in place. P0 reports are drafts; review
 *   and publication are P1 (the ADR 0942 gate, a CAS on `snapshotHash`).
 *
 * @see docs/adr/0957-client-reporting-and-portal.md
 */
import { createHash, randomUUID } from 'node:crypto';
import { OpenwopError } from '../../../types.js';
import { DurableCollection, hostExtStorage } from '../../../host/hostExtPersistence.js';
import { canonicalize } from '../../../host/auditChainService.js';
import { cleanString } from '../../../host/boundedStrings.js';
import { createLogger } from '../../../observability/logger.js';
import { REPORT_SECTION_SOURCES, requireReportSource, type SectionContext } from './sectionSources.js';
import {
  CLIENT_REPORT_CHAIN_ID, REPORT_SECTION_KINDS, type ClientReport, type ReportBrand, type ReportDefinition, type ReportPeriodKind, type ReportSection, type ReportSnapshot,
} from './types.js';

const log = createLogger('campaign-ops.reports');

const definitions = new DurableCollection<ReportDefinition>('campaign-ops:report-def', (d) => `${d.tenantId}::${d.orgId}::${d.definitionId}`, undefined, (d) => d.tenantId);
const reports = new DurableCollection<ClientReport>('campaign-ops:report', (r) => `${r.tenantId}::${r.orgId}::${r.reportId}`, undefined, (r) => r.tenantId);

const MAX_SECTIONS = 12;
const MAX_CAMPAIGNS = 50;
const KEY_RE = /^[a-z][a-zA-Z0-9_]{0,23}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CRON_RE = /^(\S+\s+){4}\S+$/;
const PERIODS: readonly ReportPeriodKind[] = ['month', 'week', 'custom'];
const BRANDS: readonly ReportBrand[] = ['agency', 'client', 'co-brand'];

function invalid(message: string, field?: string): OpenwopError {
  return new OpenwopError('validation_error', message, 400, { reason: 'report_definition_invalid', ...(field ? { field } : {}) });
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function validTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

async function orgCampaignIds(tenantId: string, orgId: string, ids: string[]): Promise<void> {
  await requireReportSource('campaign-orchestration', tenantId);
  const { getCampaign } = await import('../../campaign-orchestration/campaignService.js');
  for (const id of ids) {
    const c = await getCampaign(tenantId, id);
    if (!c || c.orgId !== orgId) throw invalid(`Campaign ${id} is not one of this client's campaigns.`, 'campaignIds');
  }
}

export interface DefinitionInput {
  title: string;
  campaignIds: string[] | 'all';
  sections: ReportSection[];
  period: ReportDefinition['period'];
  brand: ReportBrand;
  narrative: boolean;
  schedule?: { cron: string };
}

/** Closed-world parse of a definition body for `orgId`. */
export async function parseDefinition(tenantId: string, orgId: string, body: unknown): Promise<DefinitionInput> {
  if (!isObj(body)) throw invalid('Body must be an object.');
  for (const k of Object.keys(body)) {
    if (!['title', 'campaignIds', 'sections', 'period', 'brand', 'narrative', 'audience', 'expectedVersion', 'schedule'].includes(k)) throw invalid(`Unknown field "${k}".`, k);
  }
  if (body.narrative !== undefined && typeof body.narrative !== 'boolean') throw invalid('narrative must be a boolean.', 'narrative');
  if (body.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1)) throw invalid('expectedVersion must be a positive integer.', 'expectedVersion');
  const title = cleanString(body.title, 160);
  if (!title) throw invalid('title is required.', 'title');

  let campaignIds: string[] | 'all';
  if (body.campaignIds === undefined || body.campaignIds === 'all') campaignIds = 'all';
  else if (Array.isArray(body.campaignIds) && body.campaignIds.length > 0 && body.campaignIds.length <= MAX_CAMPAIGNS && body.campaignIds.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 128)) {
    campaignIds = [...new Set(body.campaignIds as string[])];
    await orgCampaignIds(tenantId, orgId, campaignIds);
  } else throw invalid(`campaignIds must be "all" or 1–${MAX_CAMPAIGNS} campaign ids.`, 'campaignIds');

  if (!Array.isArray(body.sections) || body.sections.length === 0 || body.sections.length > MAX_SECTIONS) throw invalid(`sections must hold 1–${MAX_SECTIONS} sections.`, 'sections');
  const keys = new Set<string>();
  const sections: ReportSection[] = [];
  for (const [i, raw] of body.sections.entries()) {
    const where = `sections[${i}]`;
    if (!isObj(raw)) throw invalid(`${where} must be an object.`, where);
    for (const field of Object.keys(raw)) if (!['kind', 'key', 'params'].includes(field)) throw invalid(`${where}.${field} is unknown.`, `${where}.${field}`);
    if (typeof raw.kind !== 'string' || !(REPORT_SECTION_KINDS as readonly string[]).includes(raw.kind)) {
      throw invalid(`${where}.kind must be one of: ${REPORT_SECTION_KINDS.join(', ')}.`, `${where}.kind`);
    }
    const kind = raw.kind as ReportSection['kind'];
    const key = raw.key === undefined ? kind : raw.key;
    if (typeof key !== 'string' || !KEY_RE.test(key) || keys.has(key)) throw invalid(`${where}.key must be a unique short identifier.`, `${where}.key`);
    keys.add(key);
    const params: Record<string, string> = {};
    const rawParams = raw.params === undefined ? {} : raw.params;
    if (!isObj(rawParams)) throw invalid(`${where}.params must be an object.`, `${where}.params`);
    for (const [p, v] of Object.entries(rawParams)) {
      if (!REPORT_SECTION_SOURCES[kind].params.includes(p)) throw invalid(`${where}.params.${p} is not a ${kind} parameter.`, `${where}.params.${p}`);
      if (typeof v !== 'string' || v.length === 0 || v.length > 128) throw invalid(`${where}.params.${p} must be a short string.`, `${where}.params.${p}`);
      params[p] = v;
    }
    if (kind === 'kpi') {
      if (params.campaignId) {
        if (campaignIds !== 'all' && !campaignIds.includes(params.campaignId)) throw invalid(`${where}.params.campaignId must be one of the report's campaigns.`, `${where}.params.campaignId`);
        await orgCampaignIds(tenantId, orgId, [params.campaignId]);
      } else if (campaignIds !== 'all') {
        // An org-wide KPI total would include campaigns the report excludes.
        throw invalid(`${where}.params.campaignId is required when the report names campaigns.`, `${where}.params.campaignId`);
      }
    }
    if (kind === 'email') {
      if (!params.emailCampaignId) throw invalid(`${where}.params.emailCampaignId is required.`, `${where}.params.emailCampaignId`);
      // Proven again at compute time (the campaign may be deleted later).
      const { getCampaign } = await import('../../email/emailService.js');
      if (!(await getCampaign(tenantId, orgId, params.emailCampaignId))) throw invalid(`${where}.params.emailCampaignId is not one of this client's email campaigns.`, `${where}.params.emailCampaignId`);
    }
    sections.push({ kind, key, params });
  }

  const period = isObj(body.period) ? body.period : {};
  for (const field of Object.keys(period)) if (!['kind', 'timezone'].includes(field)) throw invalid(`period.${field} is unknown.`, `period.${field}`);
  const pKind = typeof period.kind === 'string' && (PERIODS as readonly string[]).includes(period.kind) ? period.kind as ReportPeriodKind : null;
  const timezone = typeof period.timezone === 'string' ? period.timezone : 'UTC';
  if (!pKind) throw invalid(`period.kind must be one of: ${PERIODS.join(', ')}.`, 'period.kind');
  if (!validTimezone(timezone)) throw invalid('period.timezone must be an IANA time zone.', 'period.timezone');

  const brand = body.brand === undefined ? 'agency' : body.brand;
  if (typeof brand !== 'string' || !(BRANDS as readonly string[]).includes(brand)) throw invalid(`brand must be one of: ${BRANDS.join(', ')}.`, 'brand');
  if (body.audience !== undefined && (!Array.isArray(body.audience) || body.audience.length > 0)) {
    throw invalid('audience is not available yet; reports are internal until portal delivery ships (ADR 0957 P2).', 'audience');
  }
  let schedule: { cron: string } | undefined;
  if (body.schedule !== undefined && body.schedule !== null) {
    if (!isObj(body.schedule) || typeof body.schedule.cron !== 'string' || !CRON_RE.test(body.schedule.cron.trim())) {
      throw invalid('schedule.cron must be a five-field cron expression.', 'schedule.cron');
    }
    for (const field of Object.keys(body.schedule)) if (field !== 'cron') throw invalid(`schedule.${field} is unknown.`, `schedule.${field}`);
    schedule = { cron: body.schedule.cron.trim() };
    // The scheduler's own cadence rules, checked before anything is written.
    const { validateCadence } = await import('../../../host/schedulingService.js');
    const refusal = validateCadence(schedule.cron, timezone);
    if (refusal) throw invalid(`schedule.cron was refused: ${refusal.message}`, 'schedule.cron');
    const { getChainBackedWorkflow } = await import('../../../host/chainBackedWorkflows.js');
    if (!getChainBackedWorkflow(CLIENT_REPORT_CHAIN_ID)) {
      throw invalid('Scheduled client reports are unavailable until the reviewed report workflow is installed. Manual drafts are available.', 'schedule');
    }
  }
  return { title, campaignIds, sections, period: { kind: pKind, timezone }, brand: brand as ReportBrand, narrative: body.narrative === true, ...(schedule ? { schedule } : {}) };
}

function recordAction(action: string, tenantId: string, orgId: string, actor: string, resource: string, extra: Record<string, unknown>): void {
  const at = new Date().toISOString();
  try {
    void hostExtStorage()
      .appendAudit({ timestamp: at, principalId: actor, action: `campaign-ops.report.${action}`, resource, outcome: 'success', payload: { tenantId, orgId, ...extra } })
      .catch((err) => log.warn('report audit append failed', { action, error: err instanceof Error ? err.message : String(err) }));
  } catch { /* storage unwired (unit tests) */ }
}

export async function createDefinition(tenantId: string, orgId: string, input: DefinitionInput, actor: string): Promise<ReportDefinition> {
  const now = new Date().toISOString();
  const def: ReportDefinition = { tenantId, orgId, definitionId: `rdef_${randomUUID()}`, ...input, audience: [], version: 1, createdBy: actor, createdAt: now, updatedAt: now };
  await definitions.put(def);
  recordAction('definition.created', tenantId, orgId, actor, def.definitionId, { definitionId: def.definitionId, version: 1 });
  return def;
}

export async function getDefinition(tenantId: string, orgId: string, definitionId: string): Promise<ReportDefinition | null> {
  const d = await definitions.get(`${tenantId}::${orgId}::${definitionId}`);
  return d && d.tenantId === tenantId && d.orgId === orgId ? d : null;
}

export async function listDefinitions(tenantId: string, orgId: string): Promise<ReportDefinition[]> {
  return (await definitions.listByPrefix(`${tenantId}::${orgId}::`)).filter((d) => d.tenantId === tenantId && d.orgId === orgId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Replace a definition's content; `expectedVersion` guards a stale edit. */
export async function updateDefinition(existing: ReportDefinition, input: DefinitionInput, expectedVersion: number | undefined, actor: string): Promise<ReportDefinition> {
  if (expectedVersion !== undefined && expectedVersion !== existing.version) {
    throw new OpenwopError('conflict', 'This report definition changed since you opened it. Reload and reapply your edit.', 409, { reason: 'report_definition_stale', version: existing.version });
  }
  const { schedule: _priorSchedule, ...rest } = existing;
  const next: ReportDefinition = { ...rest, ...input, version: existing.version + 1, updatedAt: new Date().toISOString() };
  if (!(await definitions.compareAndSwap(existing, next))) {
    throw new OpenwopError('conflict', 'This report definition changed since you opened it. Reload and reapply your edit.', 409, { reason: 'report_definition_stale' });
  }
  recordAction('definition.updated', existing.tenantId, existing.orgId, actor, existing.definitionId, { definitionId: existing.definitionId, version: next.version });
  return next;
}

/** The report window for `kind`: the last complete month or week (UTC
 *  calendar dates), or the explicit dates for `custom`. */
export function resolvePeriod(kind: ReportPeriodKind, explicit: { start?: unknown; end?: unknown }, now = new Date()): { periodStart: string; periodEnd: string } {
  if (explicit.start !== undefined || explicit.end !== undefined || kind === 'custom') {
    const s = explicit.start; const e = explicit.end;
    const validDate = (value: unknown): value is string => typeof value === 'string' && DATE_RE.test(value)
      && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (!validDate(s) || !validDate(e) || s > e) {
      throw new OpenwopError('validation_error', 'periodStart and periodEnd must be dates (YYYY-MM-DD), start on or before end.', 400, { reason: 'report_period_invalid' });
    }
    return { periodStart: s, periodEnd: e };
  }
  const day = (d: Date): string => d.toISOString().slice(0, 10);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (kind === 'month') {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
    return { periodStart: day(start), periodEnd: day(end) };
  }
  // week: the last complete Monday–Sunday week.
  const dow = (today.getUTCDay() + 6) % 7; // Monday = 0
  const end = new Date(today.getTime() - (dow + 1) * 86_400_000);
  const start = new Date(end.getTime() - 6 * 86_400_000);
  return { periodStart: day(start), periodEnd: day(end) };
}

export function snapshotHashOf(snapshot: ReportSnapshot): string {
  return createHash('sha256').update(canonicalize(snapshot), 'utf8').digest('hex');
}

/** Run every section source for the definition's client and freeze the result. */
export async function computeSnapshot(def: ReportDefinition, computedAt = new Date().toISOString()): Promise<ReportSnapshot> {
  const snapshot: ReportSnapshot = { metrics: {}, tables: {} };
  const ctx: SectionContext = { tenantId: def.tenantId, orgId: def.orgId, campaignIds: def.campaignIds, computedAt };
  for (const section of def.sections) await REPORT_SECTION_SOURCES[section.kind].run(section, ctx, snapshot);
  return snapshot;
}

/** Compute and store a new draft report for `def` over the given period. */
export async function createReport(def: ReportDefinition, period: { periodStart: string; periodEnd: string }, actor: string, opts: { runId?: string } = {}): Promise<ClientReport> {
  const reportId = opts.runId
    ? `rpt_${createHash('sha256').update(canonicalize([def.tenantId, def.orgId, def.definitionId, opts.runId, period])).digest('hex')}`
    : `rpt_${randomUUID()}`;
  const key = `${def.tenantId}::${def.orgId}::${reportId}`;
  if (opts.runId) {
    const existing = await getReport(def.tenantId, def.orgId, reportId);
    if (existing) {
      if (existing.runId !== opts.runId || existing.definitionId !== def.definitionId || snapshotHashOf(existing.snapshot) !== existing.snapshotHash) {
        throw new OpenwopError('conflict', 'The recorded report could not be verified.', 409);
      }
      return existing;
    }
  }
  const generatedAt = new Date().toISOString();
  const snapshot = await computeSnapshot(def, generatedAt);
  const report: ClientReport = {
    tenantId: def.tenantId, orgId: def.orgId, reportId, definitionId: def.definitionId, definitionVersion: def.version,
    // A report computed by the client-report chain goes straight to review (the
    // ADR 0942 gate is that chain's next step); a manual compute is a draft.
    title: def.title, ...period, snapshot, snapshotHash: snapshotHashOf(snapshot), status: opts.runId ? 'in_review' : 'draft',
    ...(opts.runId ? { runId: opts.runId } : {}), generatedBy: actor, generatedAt,
  };
  if (opts.runId) {
    if (!(await reports.compareAndSwap(null, report))) {
      const winner = await reports.get(key);
      if (!winner || winner.tenantId !== def.tenantId || winner.orgId !== def.orgId) throw new OpenwopError('conflict', 'The report write could not be confirmed.', 409);
      return winner;
    }
  } else await reports.put(report);
  recordAction('computed', def.tenantId, def.orgId, actor, report.reportId, { reportId: report.reportId, definitionId: def.definitionId, definitionVersion: def.version, snapshotHash: report.snapshotHash });
  return report;
}

/**
 * D2 step 5 — publish, CAS-bound to the snapshot the reviewer approved: only an
 * `in_review` report whose `snapshotHash` equals `expectedHash` moves to
 * `published`. A report whose numbers are not the approved ones can never be
 * published under that approval. A replay of the same publish (already
 * published, same hash) returns the row unchanged.
 */
export async function publishReport(tenantId: string, orgId: string, reportId: string, expectedHash: string, actor: string): Promise<ClientReport> {
  const key = `${tenantId}::${orgId}::${reportId}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await reports.get(key);
    if (!r || r.tenantId !== tenantId || r.orgId !== orgId) throw new OpenwopError('not_found', 'Report not found.', 404, { reportId });
    if (r.snapshotHash !== expectedHash || snapshotHashOf(r.snapshot) !== r.snapshotHash) {
      throw new OpenwopError('conflict', 'This report\'s numbers are not the ones that were approved, so it cannot be published.', 409, { reason: 'report_snapshot_changed' });
    }
    if (r.status === 'published') return r;
    if (r.status !== 'in_review') {
      throw new OpenwopError('conflict', `Only a report in review can be published (this one is ${r.status}).`, 409, { reason: 'report_not_in_review', status: r.status });
    }
    const next: ClientReport = { ...r, status: 'published', publishedAt: new Date().toISOString(), publishedBy: actor };
    if (await reports.compareAndSwap(r, next)) {
      recordAction('published', tenantId, orgId, actor, reportId, { reportId, definitionId: r.definitionId, snapshotHash: r.snapshotHash });
      return next;
    }
  }
  throw new OpenwopError('conflict', 'The report changed while publishing. Try again.', 409, { reason: 'report_publish_contended' });
}

export async function getReport(tenantId: string, orgId: string, reportId: string): Promise<ClientReport | null> {
  const r = await reports.get(`${tenantId}::${orgId}::${reportId}`);
  return r && r.tenantId === tenantId && r.orgId === orgId ? r : null;
}

export async function listReports(tenantId: string, orgId: string, definitionId?: string): Promise<ClientReport[]> {
  return (await reports.listByPrefix(`${tenantId}::${orgId}::`))
    .filter((r) => r.tenantId === tenantId && r.orgId === orgId && (!definitionId || r.definitionId === definitionId))
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

/** Subject erasure: definitions and reports are the agency's record for a
 *  client and are kept; the person's `createdBy` / `generatedBy` is tombstoned. */
export async function eraseReportActors(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let n = 0;
  for (const d of await definitions.listForTenantIndexed(tenantId)) {
    if (d.tenantId !== tenantId) continue;
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await getDefinition(tenantId, d.orgId, d.definitionId);
      if (!current || !forms.has(current.createdBy)) break;
      if (await definitions.compareAndSwap(current, { ...current, createdBy: tombstone })) { n++; break; }
      if (attempt === 5) throw new Error('Report definition author erasure could not be confirmed.');
    }
  }
  for (const r of await reports.listForTenantIndexed(tenantId)) {
    if (r.tenantId !== tenantId) continue;
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await getReport(tenantId, r.orgId, r.reportId);
      if (!current || !(forms.has(current.generatedBy) || (current.publishedBy !== undefined && forms.has(current.publishedBy)))) break;
      const next = { ...current, generatedBy: forms.has(current.generatedBy) ? tombstone : current.generatedBy, ...(current.publishedBy !== undefined ? { publishedBy: forms.has(current.publishedBy) ? tombstone : current.publishedBy } : {}) };
      if (await reports.compareAndSwap(current, next)) { n++; break; }
      if (attempt === 5) throw new Error('Report actor erasure could not be confirmed.');
    }
  }
  return n;
}
