/**
 * Prompt library (ADR 0116 Phase 1) — a curated, RBAC-gated, shareable CATALOG of
 * prompt entries. Each `PromptLibraryEntry` REFERENCES an existing prompt-store
 * template (`promptRef` → `PromptTemplate.templateId`); the catalog never copies
 * the prompt body — the store stays the single source of truth (no parallel prompt
 * store). Org-scoped + tenant-isolated; a dangling `promptRef` is rejected.
 *
 * @see docs/adr/0116-prompt-library.md
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { getTemplate } from '../../host/promptStore.js';

export type PromptVisibility = 'private' | 'org' | 'shared';

export interface PromptLibraryEntry {
  entryId: string;
  tenantId: string;
  orgId: string;
  name: string;
  description?: string;
  tags: string[];
  /** The referenced prompt-store template id (validated against `promptStore`). */
  promptRef: string;
  visibility: PromptVisibility;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

const entries = new DurableCollection<PromptLibraryEntry>('prompts:entry', (e) => `${e.tenantId}:${e.orgId}:${e.entryId}`);

const MAX_NAME = 200;
const MAX_DESC = 2_000;
const MAX_TAGS = 24;
const VALID_VISIBILITY: ReadonlySet<string> = new Set<PromptVisibility>(['private', 'org', 'shared']);

function clean(v: unknown, max: number, field: string): string {
  if (typeof v !== 'string' || v.trim().length === 0) {
    throw new OpenwopError('validation_error', `Field \`${field}\` is required.`, 400, { field });
  }
  return v.trim().slice(0, max);
}

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim().slice(0, 48)).slice(0, MAX_TAGS);
}

/** Reject a `promptRef` that doesn't resolve to a real prompt-store template
 *  (no dangling references — the catalog must point at something renderable). */
function assertPromptRef(promptRef: string): void {
  const res = getTemplate(promptRef);
  if (!res || res === 'ambiguous') {
    throw new OpenwopError('validation_error', `\`promptRef\` "${promptRef}" does not resolve to a prompt template.`, 400, { field: 'promptRef' });
  }
}

export interface PromptEntryInput {
  name?: unknown;
  description?: unknown;
  tags?: unknown;
  promptRef?: unknown;
  visibility?: unknown;
}

export async function createEntry(tenantId: string, orgId: string, actor: string, input: PromptEntryInput): Promise<PromptLibraryEntry> {
  const name = clean(input.name, MAX_NAME, 'name');
  const promptRef = clean(input.promptRef, 256, 'promptRef');
  assertPromptRef(promptRef);
  const visibility: PromptVisibility = VALID_VISIBILITY.has(input.visibility as string) ? (input.visibility as PromptVisibility) : 'private';
  const now = new Date().toISOString();
  const entry: PromptLibraryEntry = {
    entryId: randomUUID(),
    tenantId,
    orgId,
    name,
    ...(typeof input.description === 'string' && input.description.trim() ? { description: input.description.trim().slice(0, MAX_DESC) } : {}),
    tags: cleanTags(input.tags),
    promptRef,
    visibility,
    createdBy: actor,
    updatedBy: actor,
    createdAt: now,
    updatedAt: now,
  };
  await entries.put(entry);
  return entry;
}

export async function listEntries(tenantId: string, orgId: string): Promise<PromptLibraryEntry[]> {
  return (await entries.list())
    .filter((e) => e.tenantId === tenantId && e.orgId === orgId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function getEntry(tenantId: string, orgId: string, entryId: string): Promise<PromptLibraryEntry | null> {
  return (await entries.get(`${tenantId}:${orgId}:${entryId}`)) ?? null;
}

/** Get-or-404 (uniform absence — no existence leak across tenant/org). */
async function mustGet(tenantId: string, orgId: string, entryId: string): Promise<PromptLibraryEntry> {
  const e = await getEntry(tenantId, orgId, entryId);
  if (!e) throw new OpenwopError('not_found', 'Prompt entry not found.', 404, { entryId });
  return e;
}

/** ADR 0116 Phase 2/4 — render an entry: resolve its `promptRef` against the SAME
 *  prompt store it validated against (a removed template 404s) and substitute
 *  `{{var}}` from `variables` (a missing binding stays literal). The single source for
 *  BOTH the render route AND the `ctx.prompts` workflow surface (no duplicated render). */
export async function renderEntry(
  tenantId: string, orgId: string, entryId: string, variables: Record<string, unknown>,
): Promise<{ composed: string; templateId: string }> {
  const entry = await mustGet(tenantId, orgId, entryId);
  const resolved = getTemplate(entry.promptRef);
  if (!resolved || resolved === 'ambiguous') {
    throw new OpenwopError('not_found', `Prompt template "${entry.promptRef}" is unavailable.`, 404, { promptRef: entry.promptRef });
  }
  const composed = resolved.template.text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : m);
  return { composed, templateId: entry.promptRef };
}

export async function updateEntry(tenantId: string, orgId: string, entryId: string, actor: string, input: PromptEntryInput): Promise<PromptLibraryEntry> {
  const e = await mustGet(tenantId, orgId, entryId);
  if (input.name !== undefined) e.name = clean(input.name, MAX_NAME, 'name');
  if (input.description !== undefined) e.description = typeof input.description === 'string' ? input.description.trim().slice(0, MAX_DESC) : undefined;
  if (input.tags !== undefined) e.tags = cleanTags(input.tags);
  if (input.promptRef !== undefined) { const r = clean(input.promptRef, 256, 'promptRef'); assertPromptRef(r); e.promptRef = r; }
  if (input.visibility !== undefined && VALID_VISIBILITY.has(input.visibility as string)) e.visibility = input.visibility as PromptVisibility;
  e.updatedBy = actor;
  e.updatedAt = new Date().toISOString();
  await entries.put(e);
  return e;
}

export async function deleteEntry(tenantId: string, orgId: string, entryId: string): Promise<void> {
  await mustGet(tenantId, orgId, entryId);
  await entries.delete(`${tenantId}:${orgId}:${entryId}`);
}
