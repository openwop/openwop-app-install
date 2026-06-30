/**
 * Documents & Templates API client (ADR 0053). Authed org-scoped surface under
 * /v1/host/openwop-app/documents/orgs/:orgId — documents + immutable versions +
 * a template library + the assemble (validate/render) floor.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }

export type DocFormat = 'markdown' | 'pdf' | 'slides' | 'diagram' | 'sheet' | 'doc';
export type DocStatus = 'draft' | 'in-review' | 'approved' | 'final';
export const DOC_STATUSES: readonly DocStatus[] = ['draft', 'in-review', 'approved', 'final'];
export const SEEDED_KINDS = ['sow', 'prd', 'rfp', 'epic-brief', 'board-agenda', 'status-report', 'doc'] as const;

export interface DocumentRecord {
  documentId: string;
  orgId: string;
  ownerSubject?: { kind: string; id: string };
  kind: string;
  format: DocFormat;
  title: string;
  status: DocStatus;
  currentVersionId?: string;
  templateId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersion {
  versionId: string;
  documentId: string;
  version: number;
  content: string;
  renderedMediaToken?: string;
  createdAt: string;
}

export interface DocumentTemplate {
  templateId: string;
  orgId: string;
  name: string;
  kind: string;
  outputFormat: DocFormat;
  promptBody: string;
  promptRef?: string;
  parameters: { required: string[]; properties: Record<string, { type?: string; description?: string }> };
  outputSchema?: Record<string, unknown>;
  artifactTypeId?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface AssembleResult {
  augmentedPrompt: string;
  outputFormat: DocFormat;
  outputSchema?: Record<string, unknown>;
  artifactTypeId?: string;
  templateId: string;
  templateVersion: number;
}

const root = `${config.baseUrl}/v1/host/openwop-app`;
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

const base = (orgId: string): string => `${root}/documents/orgs/${encodeURIComponent(orgId)}`;

// ── documents ────────────────────────────────────────────────────────────────
export async function listDocuments(orgId: string, filter?: { kind?: string; status?: DocStatus }): Promise<DocumentRecord[]> {
  const q = new URLSearchParams();
  if (filter?.kind) q.set('kind', filter.kind);
  if (filter?.status) q.set('status', filter.status);
  const qs = q.toString() ? `?${q.toString()}` : '';
  const res = await fetch(`${base(orgId)}/documents${qs}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ documents: DocumentRecord[] }>(res, 'listDocuments')).documents;
}

export async function getDocument(orgId: string, documentId: string): Promise<DocumentRecord & { currentVersion: DocumentVersion | null }> {
  const res = await fetch(`${base(orgId)}/documents/${encodeURIComponent(documentId)}`, fetchOpts({ headers: authedHeaders() }));
  return asJson(res, 'getDocument');
}

export async function createDocument(orgId: string, input: { title: string; kind: string; format?: DocFormat }): Promise<DocumentRecord> {
  const res = await fetch(`${base(orgId)}/documents`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson(res, 'createDocument');
}

export async function patchDocument(orgId: string, documentId: string, patch: { title?: string; status?: DocStatus }): Promise<DocumentRecord> {
  const res = await fetch(`${base(orgId)}/documents/${encodeURIComponent(documentId)}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return asJson(res, 'patchDocument');
}

export async function deleteDocument(orgId: string, documentId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/documents/${encodeURIComponent(documentId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) await asJson(res, 'deleteDocument');
}

export async function listVersions(orgId: string, documentId: string): Promise<DocumentVersion[]> {
  const res = await fetch(`${base(orgId)}/documents/${encodeURIComponent(documentId)}/versions`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ versions: DocumentVersion[] }>(res, 'listVersions')).versions;
}

export async function addVersion(orgId: string, documentId: string, content: string): Promise<DocumentVersion> {
  const res = await fetch(`${base(orgId)}/documents/${encodeURIComponent(documentId)}/versions`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ content }) }));
  return asJson(res, 'addVersion');
}

// ── templates ────────────────────────────────────────────────────────────────
export async function listTemplates(orgId: string): Promise<DocumentTemplate[]> {
  const res = await fetch(`${base(orgId)}/templates`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ templates: DocumentTemplate[] }>(res, 'listTemplates')).templates;
}

export async function createTemplate(orgId: string, input: {
  name: string; kind: string; promptBody: string; outputFormat?: DocFormat;
  parameters?: DocumentTemplate['parameters']; outputSchema?: Record<string, unknown>; artifactTypeId?: string;
}): Promise<DocumentTemplate> {
  const res = await fetch(`${base(orgId)}/templates`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson(res, 'createTemplate');
}

export async function deleteTemplate(orgId: string, templateId: string): Promise<void> {
  const res = await fetch(`${base(orgId)}/templates/${encodeURIComponent(templateId)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok && res.status !== 204) await asJson(res, 'deleteTemplate');
}

export async function assembleTemplate(orgId: string, templateId: string, params: Record<string, unknown>): Promise<AssembleResult> {
  const res = await fetch(`${base(orgId)}/templates/${encodeURIComponent(templateId)}/assemble`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ params }) }));
  return asJson(res, 'assembleTemplate');
}

// ── starter catalog (built-in, read-only) ──────────────────────────────────────
export interface SeedTemplate {
  catalogId: string;
  name: string;
  kind: string;
  outputFormat: DocFormat;
  promptBody: string;
  parameters: DocumentTemplate['parameters'];
}

export async function listCatalog(orgId: string): Promise<SeedTemplate[]> {
  const res = await fetch(`${base(orgId)}/templates/catalog`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ catalog: SeedTemplate[] }>(res, 'listCatalog')).catalog;
}

export async function instantiateFromCatalog(orgId: string, catalogId: string): Promise<DocumentTemplate> {
  const res = await fetch(`${base(orgId)}/templates/from-catalog/${encodeURIComponent(catalogId)}`, fetchOpts({ method: 'POST', headers: jsonHeaders() }));
  return asJson(res, 'instantiateFromCatalog');
}

// ── rendering (ADR 0057) ───────────────────────────────────────────────────────
export interface RenderResult { versionId: string; renderedMediaToken: string; url: string; downloadUrl: string; sizeBytes: number; }

export async function renderDocument(orgId: string, documentId: string, format: 'pdf' | 'slides' | 'sheet' = 'pdf'): Promise<RenderResult> {
  const res = await fetch(`${base(orgId)}/documents/${encodeURIComponent(documentId)}/render`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ format }) }));
  const r = await asJson<Omit<RenderResult, 'downloadUrl'>>(res, 'renderDocument');
  return { ...r, downloadUrl: `${config.baseUrl}${r.url}` };
}

// ── materialize from a canvas (ADR 0056) ───────────────────────────────────────
export async function materializeFromCanvas(orgId: string, canvasId: string): Promise<{ documentId: string; versionId: string; created: boolean }> {
  const res = await fetch(`${base(orgId)}/documents/from-canvas`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ canvasId }) }));
  return asJson(res, 'materializeFromCanvas');
}
