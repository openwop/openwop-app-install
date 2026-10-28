/**
 * ADR 0923 D1–D3 — change requests. One row per request holding its CURRENT
 * version; earlier versions are kept in `previous` (bounded) so an edit is a new
 * version, never an overwrite. Every state change is a CAS on the row.
 *
 * As built, versus ADR 0923 D1: the ADR described one row per version plus a
 * head pointer. One row with a bounded history gives the same guarantees (a
 * change set names `requestVersion`; a superseded version can never be
 * approved, ADR 0924 D2) with one CAS instead of two.
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { cleanString } from '../../host/boundedStrings.js';
import { OpenwopError } from '../../types.js';
import { assertCampaignRef } from '../../host/campaignRefs.js';
import { contentHashOf } from './contentHash.js';
import { getAsset } from './assetService.js';
import { getClient } from './clientService.js';
import type { Answer, ChangeRequest, Intent, Interpretation, RequestStatus } from './types.js';

export interface StoredRequest extends ChangeRequest {
  previous: Array<{ version: number; text: string; status: RequestStatus; changeSetId?: string; createdAt: string }>;
}

const requests = new DurableCollection<StoredRequest>(
  'campaign-ops:request',
  (r) => `${r.tenantId}::${r.orgId}::${r.requestId}`,
  undefined,
  (r) => r.tenantId,
);

export const MAX_REQUEST_TEXT = 2000;
export const MAX_ASSETS_PER_REQUEST = 10;
const MAX_HISTORY = 20;
const TEXT_DUPLICATE_WINDOW_MS = 24 * 3600_000;
const FINGERPRINT_DUPLICATE_WINDOW_MS = 7 * 24 * 3600_000;
const nowIso = (): string => new Date().toISOString();

/** Statuses that make a request "live" for duplicate detection. */
const LIVE: ReadonlySet<RequestStatus> = new Set(['interpreting', 'needs_facts', 'proposing', 'proposed']);

export async function getRequest(tenantId: string, orgId: string, requestId: string): Promise<StoredRequest | null> {
  const r = await requests.get(`${tenantId}::${orgId}::${requestId}`);
  return r && r.tenantId === tenantId && r.orgId === orgId ? r : null;
}

export async function listRequests(tenantId: string, orgId: string): Promise<StoredRequest[]> {
  return (await requests.listForTenantIndexed(tenantId))
    .filter((r) => r.tenantId === tenantId && r.orgId === orgId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

const normalizeText = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** ADR 0923 D3 — the fingerprint of what the request asks for, once interpreted. */
export function fingerprintOf(orgId: string, campaignId: string | undefined, intents: readonly Intent[], assetIds: readonly string[]): string {
  const norm = intents
    .map((i) => (i.kind === 'set_field_value'
      ? { k: i.kind, s: i.subject.toLowerCase().trim(), v: i.value.trim() }
      : { k: i.kind, f: i.find.trim(), r: i.replace.trim() }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  // The assets are part of WHAT is asked: the same change to a different page is a different request.
  return contentHashOf({ orgId, campaignId: campaignId ?? null, assetIds: [...assetIds].sort(), intents: norm });
}

async function cas(cur: StoredRequest, next: StoredRequest): Promise<StoredRequest> {
  if (!(await requests.compareAndSwap(cur, next))) {
    throw new OpenwopError('conflict', 'The request changed while this was being saved. Reload it and try again.', 409, { reason: 'request_changed' });
  }
  return next;
}

async function validateAssetIds(tenantId: string, orgId: string, raw: unknown): Promise<string[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ASSETS_PER_REQUEST) {
    throw new OpenwopError('validation_error', `Pick 1–${MAX_ASSETS_PER_REQUEST} assets this change may touch.`, 400, { field: 'assetIds' });
  }
  const ids = [...new Set(raw.map(String))];
  for (const id of ids) {
    if (!(await getAsset(tenantId, orgId, id))) throw new OpenwopError('not_found', 'Asset not found.', 404, { assetId: id, reason: 'wrong_client_or_missing' });
  }
  return ids;
}

function cleanText(raw: unknown): string {
  const text = cleanString(raw, MAX_REQUEST_TEXT, '').trim();
  if (!text) throw new OpenwopError('validation_error', 'Describe the change.', 400, { field: 'text' });
  return text;
}

/** ADR 0923 D1 + D3 (the text pre-check). A duplicate is stored as `duplicate`
 *  and NOT executed, unless the operator overrides with a reason. */
export async function createRequest(input: {
  tenantId: string; orgId: string; text: unknown; assetIds: unknown; campaignId?: string;
  createdBy: string; overrideDuplicate?: { reason: string };
  /** ADR 0962 D6 — the request came from an outside agent. */
  via?: { protocol: 'mcp'; runId?: string };
}): Promise<StoredRequest> {
  const client = await getClient(input.tenantId, input.orgId);
  if (!client) throw new OpenwopError('not_found', 'Client not found.', 404, { orgId: input.orgId });
  if (client.status !== 'active') throw new OpenwopError('validation_error', 'This client is not active.', 409, { reason: 'client_inactive' });
  const text = cleanText(input.text);
  const assetIds = await validateAssetIds(input.tenantId, input.orgId, input.assetIds);
  // ADR 0941 P2 — the campaign must exist in THIS client org (uniform 404 otherwise).
  const campaignId = input.campaignId ? (await assertCampaignRef(input.tenantId, input.orgId, input.campaignId)).campaignId : undefined;
  const now = nowIso();
  let duplicateOf: string | undefined;
  if (!input.overrideDuplicate) {
    const cutoff = Date.now() - TEXT_DUPLICATE_WINDOW_MS;
    const twin = (await listRequests(input.tenantId, input.orgId)).find((r) =>
      LIVE.has(r.status) && Date.parse(r.createdAt) >= cutoff && normalizeText(r.text) === normalizeText(text));
    duplicateOf = twin?.requestId;
  }
  const row: StoredRequest = {
    tenantId: input.tenantId,
    orgId: input.orgId,
    requestId: `creq:${randomUUID()}`,
    version: 1,
    text,
    ...(campaignId ? { campaignId } : {}),
    assetIds,
    answers: [],
    status: duplicateOf ? 'duplicate' : 'interpreting',
    ...(duplicateOf ? { duplicateOf } : {}),
    ...(input.overrideDuplicate ? { duplicateOverride: { reason: cleanString(input.overrideDuplicate.reason, 500, ''), by: input.createdBy, at: now } } : {}),
    runIds: [],
    previous: [],
    createdBy: input.createdBy,
    ...(input.via ? { via: input.via } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await requests.put(row);
  return row;
}

/** ADR 0923 D1 — an edit writes version N+1; version N is superseded, and any
 *  change set built from it is marked stale by the caller (changeSetService). */
export async function editRequest(tenantId: string, orgId: string, requestId: string, patch: { text: unknown; assetIds?: unknown }, by: string): Promise<{ before: StoredRequest; after: StoredRequest }> {
  const cur = await getRequest(tenantId, orgId, requestId);
  if (!cur) throw new OpenwopError('not_found', 'Request not found.', 404, { requestId });
  const text = cleanText(patch.text);
  const assetIds = patch.assetIds === undefined ? cur.assetIds : await validateAssetIds(tenantId, orgId, patch.assetIds);
  const now = nowIso();
  const next: StoredRequest = {
    ...cur,
    version: cur.version + 1,
    text,
    assetIds,
    answers: [],
    status: 'interpreting',
    previous: [{ version: cur.version, text: cur.text, status: 'superseded' as const, ...(cur.changeSetId ? { changeSetId: cur.changeSetId } : {}), createdAt: cur.updatedAt }, ...cur.previous].slice(0, MAX_HISTORY),
    updatedAt: now,
  };
  delete next.interpretation; delete next.changeSetId; delete next.failure; delete next.fingerprint; delete next.duplicateOf;
  void by;
  return { before: cur, after: await cas(cur, next) };
}

/** Answers to the planner's questions are appended to the CURRENT version. */
export async function answerQuestions(tenantId: string, orgId: string, requestId: string, raw: unknown, by: string): Promise<StoredRequest> {
  const cur = await getRequest(tenantId, orgId, requestId);
  if (!cur) throw new OpenwopError('not_found', 'Request not found.', 404, { requestId });
  if (cur.status !== 'needs_facts' || !cur.interpretation) {
    throw new OpenwopError('validation_error', 'This request is not waiting for answers.', 409, { reason: 'not_waiting_for_answers', status: cur.status });
  }
  const asked = new Set(cur.interpretation.questions.map((q) => q.id));
  if (!Array.isArray(raw) || raw.length === 0) throw new OpenwopError('validation_error', 'Answer at least one question.', 400, { field: 'answers' });
  const now = nowIso();
  const answers: Answer[] = [];
  for (const a of raw) {
    const qid = a && typeof a === 'object' ? (a as { questionId?: unknown }).questionId : undefined;
    const value = a && typeof a === 'object' ? (a as { value?: unknown }).value : undefined;
    if (typeof qid !== 'string' || !asked.has(qid) || typeof value !== 'string' || !value.trim() || value.length > 1000) {
      throw new OpenwopError('validation_error', 'Each answer needs a question id from this request and a value.', 400, { field: 'answers' });
    }
    answers.push({ questionId: qid, value: value.trim(), answeredBy: by, answeredAt: now });
  }
  const next: StoredRequest = { ...cur, answers: [...cur.answers, ...answers], status: 'interpreting', updatedAt: now };
  delete next.interpretation;
  return cas(cur, next);
}

/** The operator's own words: the request text plus every answer (URL provenance). */
export const requestSourceOf = (r: Pick<ChangeRequest, 'text' | 'answers'>): { text: string; answers: string[] } =>
  ({ text: r.text, answers: r.answers.map((a) => a.value) });

/** Record a run against the current version (one row update, CAS). */
export async function attachRun(tenantId: string, orgId: string, requestId: string, version: number, runId: string): Promise<void> {
  const cur = await getRequest(tenantId, orgId, requestId);
  if (!cur || cur.version !== version) return;
  await cas(cur, { ...cur, runIds: [...cur.runIds, runId].slice(-20), updatedAt: nowIso() });
}

/** ADR 0923 D2/D3 — store a VALIDATED interpretation for `version`. Idempotent:
 *  a replayed record of the same version returns the row as it is. A second
 *  request with the same fingerprint inside the window is marked `duplicate`. */
export async function recordInterpretation(
  tenantId: string, orgId: string, requestId: string, version: number, value: Interpretation,
): Promise<StoredRequest> {
  const cur = await getRequest(tenantId, orgId, requestId);
  if (!cur) throw new OpenwopError('not_found', 'Request not found.', 404, { requestId });
  if (cur.version !== version) throw new OpenwopError('conflict', 'This request was edited; the old version is no longer worked on.', 409, { reason: 'request_changed' });
  if (cur.status !== 'interpreting') return cur;
  const now = nowIso();
  if (value.questions.length > 0) {
    return cas(cur, { ...cur, interpretation: value, status: 'needs_facts', updatedAt: now });
  }
  const fingerprint = fingerprintOf(orgId, cur.campaignId, value.intents, cur.assetIds);
  let duplicateOf: string | undefined;
  if (!cur.duplicateOverride) {
    const cutoff = Date.now() - FINGERPRINT_DUPLICATE_WINDOW_MS;
    duplicateOf = (await listRequests(tenantId, orgId)).find((r) => r.requestId !== requestId && r.fingerprint === fingerprint
      && (LIVE.has(r.status) || r.status === 'no_changes') && Date.parse(r.updatedAt) >= cutoff)?.requestId;
  }
  return cas(cur, {
    ...cur, interpretation: value, fingerprint,
    status: duplicateOf ? 'duplicate' : 'proposing',
    ...(duplicateOf ? { duplicateOf } : {}),
    updatedAt: now,
  });
}

export async function failRequest(tenantId: string, orgId: string, requestId: string, version: number, failure: { code: string; message: string }): Promise<StoredRequest | null> {
  const cur = await getRequest(tenantId, orgId, requestId);
  if (!cur || cur.version !== version || (cur.status !== 'interpreting' && cur.status !== 'proposing')) return cur;
  return cas(cur, { ...cur, status: 'failed', failure: { code: cleanString(failure.code, 60, 'failed'), message: cleanString(failure.message, 500, '') }, updatedAt: nowIso() });
}

/** Called by changeSetService once the change set for `version` exists (or none was needed). */
export async function markProposed(tenantId: string, orgId: string, requestId: string, version: number, changeSetId: string | null): Promise<StoredRequest | null> {
  const cur = await getRequest(tenantId, orgId, requestId);
  if (!cur || cur.version !== version) return cur;
  if (cur.status === 'proposed' || cur.status === 'no_changes') return cur;
  const next: StoredRequest = { ...cur, status: changeSetId ? 'proposed' : 'no_changes', updatedAt: nowIso() };
  if (changeSetId) next.changeSetId = changeSetId;
  return cas(cur, next);
}

/** Remove every change request of one client. */
export async function purgeRequestsForOrg(tenantId: string, orgId: string): Promise<number> {
  let n = 0;
  for (const r of await listRequests(tenantId, orgId)) if (await requests.delete(`${tenantId}::${orgId}::${r.requestId}`)) n++;
  return n;
}
