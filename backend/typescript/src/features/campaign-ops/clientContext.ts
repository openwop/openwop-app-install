/**
 * ADR 0944 D5 — the per-client context block: ONE fenced block per client run,
 * the same on every read of that run and on every fork of it.
 *
 * What a client's agents see beside the task: the client's brand voice, the
 * knowledge collections the client designated for campaign work, a performance
 * summary and the latest approved decisions. Each section names its source and
 * the version it was read at, so a reviewer sees what the agent saw.
 *
 * Determinism (the P2 architect review). Brand rows have no revisions and
 * performance records are rewritten in place, so a "version stamped at run
 * start" could not be read back later. And the rendered content must not sit on
 * the run row, where any run reader would see a client's brand and decisions.
 * So the run-start contributor stamps only a REFERENCE,
 * `metadata.clientContext = {orgId, snapshotId}` (pure: it reads nothing and
 * writes nothing). The provider materializes the snapshot on the run's first
 * read with an insert-if-absent, and every later read, and every `:fork` (which
 * copies the stamp verbatim), serves that row. The snapshot is frozen at first
 * use, which for an agent run is the first moment it can matter.
 *
 * The provider re-checks the run's client binding and the person behind the run
 * (`resolveRunMemoryClient`) on every read, so a fork by someone who lost the
 * client reads nothing. The stamp's `orgId` must equal the run's client stamp.
 *
 * Cross-feature reads gate on the SOURCE feature (ADR 0820 G11): a section whose
 * feature is off or not in the plan is left out and says so, never shown empty.
 *
 * @see docs/adr/0944-client-scoped-agent-memory.md §D5
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection, hostExtStorage } from '../../host/hostExtPersistence.js';
import type { RunStartContext } from '../../host/runStartContext.js';
import type { RunContextRequest } from '../../host/runContextProviders.js';
import { resolveRunMemoryClient, runClientStamp } from '../../host/runClientOrg.js';
import { fenceUntrustedItems, neutralizeUntrusted } from '../../host/untrustedContent.js';
import { degradationNotice } from '../../host/agentKnowledgeComposition.js';
import { featureAccessRefusal } from '../../host/workflowFeatureGate.js';
import { getOrg } from '../../host/accessControlService.js';
import { OpenwopError } from '../../types.js';
import { levelSatisfies, type SubjectCaller } from '../../host/subjectAccess.js';
import { listBrands, resolveEffectiveBrandRules } from '../brand/brandService.js';
import { resolveVoice } from '../brand/scoring.js';
import { getCollection } from '../kb/kbService.js';
import { kpiSummary, listRecords } from '../campaign-connectors/performanceService.js';
import { topBottomPerformers } from '../campaign-intel/budgetPlanner.js';
import { getProject, listVisibleProjects, resolveProjectAccess } from '../projects/projectsService.js';
import { currentState, getLedger } from '../team-intent-ledger/ledgerStore.js';
import { canReadDocument, getDocument } from '../documents/documentsService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('feature.campaign-ops.client-context');

/** The reserved run-metadata key (`runDispatch.ts` RESERVED_RUN_METADATA_KEYS). */
export const CLIENT_CONTEXT_STAMP_KEY = 'clientContext';
/** ≈ 3 000 tokens (ADR 0944 D5). */
export const CLIENT_CONTEXT_MAX_CHARS = 12_000;
const MAX_DECISIONS = 10;
const DECISIONS_PER_PROJECT = 5;
const MAX_SOURCES = 20;

export interface ClientContextStamp { orgId: string; snapshotId: string }

export type ClientContextSectionKind = 'brand' | 'knowledge' | 'performance' | 'decisions';
export interface ClientContextSource {
  kind: ClientContextSectionKind; id: string; version: string;
  /** Decision context retains authority references, never an access grant. */
  projectId?: string;
  documentIds?: string[];
}

export interface ClientContextSnapshot {
  tenantId: string;
  orgId: string;
  snapshotId: string;
  createdAt: string;
  sources: ClientContextSource[];
  /** The client's designated knowledge collections, as frozen for this run. */
  collectionIds: string[];
  /** Sections left out to fit the budget, in the order they were cut. */
  omitted: ClientContextSectionKind[];
  block: string;
}

const snapshots = new DurableCollection<ClientContextSnapshot>(
  'campaign-ops:client-context-snapshot',
  (s) => `${s.tenantId}::${s.orgId}::${s.snapshotId}`,
  undefined,
  (s) => s.tenantId,
);

// ── Designated knowledge sources (ADR 0944 Q5: an explicit list, per client) ──

export interface ClientContextSources { tenantId: string; orgId: string; collectionIds: string[]; updatedAt: string; updatedBy: string }

const sourcesStore = new DurableCollection<ClientContextSources>(
  'campaign-ops:client-context-sources',
  (s) => `${s.tenantId}::${s.orgId}`,
  undefined,
  (s) => s.tenantId,
);

export async function getClientContextSources(tenantId: string, orgId: string): Promise<string[]> {
  const row = await sourcesStore.get(`${tenantId}::${orgId}`);
  return row && row.tenantId === tenantId && row.orgId === orgId ? row.collectionIds : [];
}

/** Replace the client's designated collections. Every id must be a collection
 *  of THIS client org: a collection of another client is "not found" (D7 test 6). */
export async function setClientContextSources(tenantId: string, orgId: string, collectionIds: unknown, updatedBy: string): Promise<string[]> {
  if (!Array.isArray(collectionIds) || collectionIds.length > MAX_SOURCES || !collectionIds.every((v) => typeof v === 'string' && v.length > 0)) {
    throw new OpenwopError('validation_error', `\`collectionIds\` MUST be an array of at most ${MAX_SOURCES} collection ids.`, 400, { field: 'collectionIds' });
  }
  const ids = [...new Set(collectionIds as string[])];
  for (const id of ids) {
    if (!(await getCollection(tenantId, orgId, id, { subject: updatedBy }))) {
      throw new OpenwopError('not_found', 'Knowledge collection not found for this client.', 404, { collectionId: id });
    }
  }
  await sourcesStore.put({ tenantId, orgId, collectionIds: ids, updatedAt: new Date().toISOString(), updatedBy });
  return ids;
}

/** DSAR (ADR 0464 ledger): the designation is the client's; who set it goes. */
export async function eraseClientContextSourceEditors(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  let touched = 0;
  for (const row of await sourcesStore.listForTenantIndexed(tenantId)) {
    if (row.tenantId !== tenantId) continue;
    for (let attempt = 0; attempt < 6; attempt++) {
      const current = await sourcesStore.get(`${tenantId}::${row.orgId}`);
      if (!current || current.tenantId !== tenantId || !forms.has(current.updatedBy)) break;
      if (await sourcesStore.compareAndSwap(current, { ...current, updatedBy: tombstone })) { touched += 1; break; }
      if (attempt === 5) throw new Error('Client context source editor erasure could not be confirmed.');
    }
  }
  return touched;
}

// ── The stamp ──

export function readClientContextStamp(metadata: Record<string, unknown> | undefined): ClientContextStamp | undefined {
  const v = metadata?.[CLIENT_CONTEXT_STAMP_KEY];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const { orgId, snapshotId } = v as Record<string, unknown>;
  return typeof orgId === 'string' && orgId.trim() && orgId.length <= 200
    && typeof snapshotId === 'string' && /^ccs_[a-f0-9-]{36}$/.test(snapshotId) ? { orgId, snapshotId } : undefined;
}

/** Run-start contributor: a client run gets a snapshot REFERENCE. Pure — it
 *  reads only the metadata it is handed and writes nothing. A fork (or a
 *  redrive) keeps the copied reference, so it serves the same snapshot. */
export async function clientContextRunStartContributor(ctx: RunStartContext): Promise<Record<string, unknown>> {
  if (ctx.derivedFromRun) return {};
  const client = runClientStamp(ctx.metadata as Record<string, unknown> | undefined);
  if (!client || !('orgId' in client)) return {};
  return { [CLIENT_CONTEXT_STAMP_KEY]: { orgId: client.orgId, snapshotId: `ccs_${randomUUID()}` } satisfies ClientContextStamp };
}

// ── Rendering ──

interface Section { kind: ClientContextSectionKind; text: string }

function unavailable(label: string, why: 'toggle' | 'plan' | 'unresolved'): string {
  const reason = why === 'plan' ? 'not in this workspace plan' : why === 'unresolved' ? 'could not be checked' : 'turned off';
  return `## ${label}\n(Not included: ${reason}.)`;
}

async function brandSection(tenantId: string, orgId: string, sources: ClientContextSource[]): Promise<Section | null> {
  const refusal = await featureAccessRefusal('brand', tenantId);
  if (refusal) return { kind: 'brand', text: unavailable('Brand voice', refusal) };
  const brand = (await listBrands(tenantId, orgId)).find((b) => b.status === 'active');
  if (!brand) return null;
  const rules = await resolveEffectiveBrandRules(tenantId, brand.id);
  sources.push({ kind: 'brand', id: brand.id, version: brand.updatedAt });
  // `resolveVoice` writes the ADR 0891 frame line and the <UNTRUSTED> fence itself.
  return { kind: 'brand', text: `## Brand voice (source: brand ${brand.id}, revision ${brand.updatedAt})\n${resolveVoice(brand, rules ? { extraBannedPhrases: rules.bannedPhrases } : {})}` };
}

async function knowledgeSection(tenantId: string, orgId: string, sources: ClientContextSource[], kept: string[], caller: SubjectCaller): Promise<Section | null> {
  const refusal = await featureAccessRefusal('kb', tenantId);
  if (refusal) return { kind: 'knowledge', text: unavailable('Client knowledge', refusal) };
  const names: string[] = [];
  for (const id of await getClientContextSources(tenantId, orgId)) {
    // Re-checked at freeze time: a collection that moved or was deleted is dropped.
    const c = await getCollection(tenantId, orgId, id, caller);
    if (!c) continue;
    kept.push(id);
    sources.push({ kind: 'knowledge', id, version: c.updatedAt });
    names.push(`- ${neutralizeUntrusted(c.name)} (collection ${id})`);
  }
  if (names.length === 0) return null;
  return {
    kind: 'knowledge',
    text: `## Client knowledge (searched with your task; source: designated collections)\n${fenceUntrustedItems(names)}`,
  };
}

const money = (n: number | null | undefined): string => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : 'n/a');

async function performanceSection(tenantId: string, orgId: string, sources: ClientContextSource[]): Promise<Section | null> {
  const refusal = await featureAccessRefusal('campaign-connectors', tenantId);
  if (refusal) return { kind: 'performance', text: unavailable('Past performance', refusal) };
  const records = await listRecords(tenantId, orgId);
  if (records.length === 0) return null;
  const kpi = await kpiSummary(tenantId, orgId);
  const { top, bottom } = topBottomPerformers(records, { limit: 3 });
  const range = kpi.dateRange ? `${kpi.dateRange.start}..${kpi.dateRange.end}` : 'unknown';
  sources.push({ kind: 'performance', id: `records:${kpi.recordCount}`, version: range });
  const t = kpi.totals;
  const items = [
    `- Totals (${kpi.currency}, ${kpi.recordCount} records, ${range}): spend ${money(t.spend)}, ROAS ${money(t.roas)}, CPA ${money(t.cpa)}`,
    ...top.map((p) => `- Strong: ${neutralizeUntrusted(p.campaignName)} on ${neutralizeUntrusted(p.platform)} — ROAS ${money(p.roas)} on spend ${money(p.spend)}`),
    ...bottom.map((p) => `- Weak: ${neutralizeUntrusted(p.campaignName)} on ${neutralizeUntrusted(p.platform)} — ROAS ${money(p.roas)} on spend ${money(p.spend)}`),
  ];
  return { kind: 'performance', text: `## Past performance (source: imported campaign records, ${range})\n${fenceUntrustedItems(items)}` };
}

async function decisionsSection(tenantId: string, orgId: string, sources: ClientContextSource[], caller: SubjectCaller): Promise<Section | null> {
  for (const featureId of ['team-intent-ledger', 'projects', 'documents']) {
    const refusal = await featureAccessRefusal(featureId, tenantId);
    if (refusal) return { kind: 'decisions', text: unavailable('Approved decisions', refusal) };
  }
  const lines: string[] = [];
  for (const { project } of (await listVisibleProjects(tenantId, caller.subject)).filter((p) => p.project.orgId === orgId)) {
    const ledger = await getLedger(tenantId, project.id);
    if (!ledger) continue;
    const ids = currentState(ledger, project).decisionDocumentIds.slice(-DECISIONS_PER_PROJECT);
    if (ids.length === 0) continue;
    const documentIds: string[] = [];
    for (const id of ids) {
      const doc = await getDocument(tenantId, orgId, id);
      if (doc && await canReadDocument(tenantId, doc, caller.subject)) {
        documentIds.push(doc.documentId);
        lines.push(`- ${neutralizeUntrusted(doc.title)} (project ${neutralizeUntrusted(project.name)}, ledger v${ledger.version})`);
      }
    }
    if (documentIds.length) sources.push({ kind: 'decisions', id: ledger.ledgerId, version: String(ledger.version), projectId: project.id, documentIds });
  }
  if (lines.length === 0) return null;
  return { kind: 'decisions', text: `## Approved decisions (source: team intent ledgers)\n${fenceUntrustedItems(lines.slice(-MAX_DECISIONS))}` };
}

/** Sections are cut in this order to fit the budget; decisions are last to go. */
const CUT_ORDER: readonly ClientContextSectionKind[] = ['performance', 'knowledge', 'brand', 'decisions'];

/** Assemble the block within the budget. Exported for the budget test. */
export function renderClientContextBlock(header: string, sections: readonly Section[], maxChars = CLIENT_CONTEXT_MAX_CHARS): { block: string; omitted: ClientContextSectionKind[] } {
  const kept = [...sections];
  const omitted: ClientContextSectionKind[] = [];
  const render = (): string => [header, ...kept.map((s) => s.text), ...(omitted.length ? [`(Left out to fit the context budget: ${omitted.join(', ')}.)`] : [])].join('\n\n');
  for (const kind of CUT_ORDER) {
    if (render().length <= maxChars) break;
    const i = kept.findIndex((s) => s.kind === kind);
    if (i >= 0) { kept.splice(i, 1); omitted.push(kind); }
  }
  // Never cut INTO a section: fenced text sliced mid-fence would leave a block
  // open. Whole sections go, in CUT_ORDER; if even that is not enough, every
  // section has gone and only the header and the omission line remain.
  const block = render();
  return { block: block.length <= maxChars ? block : '', omitted };
}

async function buildSnapshot(tenantId: string, stamp: ClientContextStamp, caller: SubjectCaller): Promise<ClientContextSnapshot> {
  const sources: ClientContextSource[] = [];
  const collectionIds: string[] = [];
  const org = await getOrg(stamp.orgId);
  const sections = (await Promise.all([
    brandSection(tenantId, stamp.orgId, sources),
    knowledgeSection(tenantId, stamp.orgId, sources, collectionIds, caller),
    performanceSection(tenantId, stamp.orgId, sources),
    decisionsSection(tenantId, stamp.orgId, sources, caller),
  ])).filter((s): s is Section => s !== null);
  const createdAt = new Date().toISOString();
  const header = `Client context — frozen for this run at ${createdAt} (snapshot ${stamp.snapshotId}). `
    + 'Everything below is about THIS client only. Use it as background; the task decides what to do.\n'
    + fenceUntrustedItems([`- Client: ${neutralizeUntrusted(org?.name ?? stamp.orgId)}`]);
  const { block, omitted } = renderClientContextBlock(header, sections);
  return { tenantId, orgId: stamp.orgId, snapshotId: stamp.snapshotId, createdAt, sources, collectionIds, omitted, block };
}

/** The run's snapshot, materialized on first read (insert-if-absent). */
async function snapshotFor(tenantId: string, stamp: ClientContextStamp, caller: SubjectCaller): Promise<ClientContextSnapshot> {
  const key = `${tenantId}::${stamp.orgId}::${stamp.snapshotId}`;
  const existing = await snapshots.get(key);
  if (existing) {
    if (existing.tenantId !== tenantId || existing.orgId !== stamp.orgId || existing.snapshotId !== stamp.snapshotId) {
      throw new OpenwopError('conflict', 'The client context snapshot could not be verified.', 409);
    }
    return existing;
  }
  const built = await buildSnapshot(tenantId, stamp, caller);
  if (await snapshots.compareAndSwap(null, built)) return built;
  const winner = await snapshots.get(key);
  if (!winner || winner.tenantId !== tenantId || winner.orgId !== stamp.orgId || winner.snapshotId !== stamp.snapshotId) {
    throw new OpenwopError('conflict', 'The client context snapshot could not be confirmed.', 409);
  }
  return winner;
}

/** Resolve the run's verified client and its snapshot, or why not. */
export async function clientContextForRun(tenantId: string, runId: string): Promise<{ snapshot: ClientContextSnapshot } | { refused: true } | null> {
  const run = await hostExtStorage().getRun(runId);
  if (!run || run.tenantId !== tenantId) return null;
  const meta = run.metadata as Record<string, unknown> | undefined;
  const stamp = readClientContextStamp(meta);
  if (!stamp) return null;
  if (await featureAccessRefusal('campaign-ops', tenantId)) return null;
  const client = await resolveRunMemoryClient({
    tenantId, runId,
    actingUserId: typeof meta?.['actingUserId'] === 'string' ? meta['actingUserId'] : undefined,
    orgScopeSubject: typeof meta?.['orgScopeSubject'] === 'string' ? meta['orgScopeSubject'] : undefined,
  });
  if (!client || !('orgId' in client) || client.orgId !== stamp.orgId) return { refused: true };
  // The actual actor is authority for subject-bound KB; a causing member never grants it.
  const caller: SubjectCaller = typeof meta?.['actingUserId'] === 'string' ? { subject: meta['actingUserId'] } : {};
  const snapshot = await snapshotFor(tenantId, stamp, caller);
  // A frozen read is never authority to use a feature disabled since first use.
  const features: Record<ClientContextSectionKind, readonly string[]> = {
    brand: ['brand'], knowledge: ['kb'], performance: ['campaign-connectors'],
    decisions: ['team-intent-ledger', 'projects', 'documents'],
  };
  for (const featureId of new Set(snapshot.sources.flatMap((source) => features[source.kind]))) {
    if (await featureAccessRefusal(featureId, tenantId)) return { refused: true };
  }
  for (const id of snapshot.collectionIds) {
    if (!(await getCollection(tenantId, stamp.orgId, id, caller))) return { refused: true };
  }
  for (const source of snapshot.sources.filter((s) => s.kind === 'decisions')) {
    // Legacy snapshots lack the references needed to prove current authority.
    if (!source.projectId || !source.documentIds?.length) return { refused: true };
    const project = await getProject(tenantId, source.projectId);
    if (!project || project.orgId !== stamp.orgId || !levelSatisfies(await resolveProjectAccess(tenantId, project.id, caller.subject), 'read')) return { refused: true };
    for (const id of source.documentIds) {
      const doc = await getDocument(tenantId, stamp.orgId, id);
      if (!doc || !(await canReadDocument(tenantId, doc, caller.subject))) return { refused: true };
    }
  }
  return { snapshot };
}

/** `registerRunContextProvider('campaign-client-context', …)`. */
export async function clientContextProvider(req: RunContextRequest): Promise<string | undefined> {
  try {
    const out = await clientContextForRun(req.tenantId, req.runId);
    if (!out) return undefined;
    if ('refused' in out) return degradationNotice(["this client's context (brand, knowledge, performance, decisions)"]);
    return out.snapshot.block;
  } catch (err) {
    log.warn('client_context_failed', { tenantId: req.tenantId, runId: req.runId, error: err instanceof Error ? err.message : String(err) });
    return degradationNotice(["this client's context (brand, knowledge, performance, decisions)"]);
  }
}

/** The host seam for run-lane knowledge (`host/runClientKnowledge.ts`): the
 *  client's collections AS FROZEN in this run's snapshot. */
export async function clientKnowledgeForRun(tenantId: string, runId: string): Promise<string[]> {
  const out = await clientContextForRun(tenantId, runId);
  return out && 'snapshot' in out ? out.snapshot.collectionIds : [];
}

/** ADR 0944 D8 — off-boarding: every frozen snapshot and the designation of one
 *  client. Returns the rows removed. */
export async function deleteClientContextRows(tenantId: string, orgId: string): Promise<{ snapshots: number; sources: number }> {
  let n = 0;
  for (const row of await snapshots.listForTenantIndexed(tenantId)) {
    if (row.tenantId !== tenantId || row.orgId !== orgId) continue;
    if (await snapshots.delete(`${row.tenantId}::${row.orgId}::${row.snapshotId}`)) n += 1;
  }
  const sources = (await sourcesStore.delete(`${tenantId}::${orgId}`)) ? 1 : 0;
  return { snapshots: n, sources };
}
