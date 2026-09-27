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
import { userIdFor } from '../users/usersService.js';
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
/** The ONE visibility allowlist. Exported (ADR 0694 D3b) so the portability
 *  import validates against the same set the service writes — a second copy
 *  would be a place for the two to disagree about what `shared` means. */
export const VALID_VISIBILITY: ReadonlySet<string> = new Set<PromptVisibility>(['private', 'org', 'shared']);

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

/** PLC-2 — split a `promptRef` into `{ templateId, version? }`. ADR 0116 references a
 *  template as `<templateId>[@version]` (a `prompt:` prefix, when present, stays part
 *  of the id — `getTemplate` resolves it). Split on the LAST `@` so a template id that
 *  itself contains `@` keeps it; an empty version (`foo@`) is treated as unpinned. */
function parsePromptRef(promptRef: string): { templateId: string; version?: string } {
  const at = promptRef.lastIndexOf('@');
  if (at <= 0) return { templateId: promptRef };                       // no '@' (or leading) → unpinned
  if (at === promptRef.length - 1) return { templateId: promptRef.slice(0, at) }; // trailing '@' → strip, unpinned
  return { templateId: promptRef.slice(0, at), version: promptRef.slice(at + 1) };
}

/** Resolve a `promptRef` HONORING its `@version` pin (PLC-2 — the pin used to be
 *  dropped: the whole ref went to `getTemplate` as a bare id, so a pinned ref read as
 *  dangling and an unpinned one always rendered LATEST). Exported so the sharing
 *  service resolves a shared prompt's body the same way (same pin honesty). */
export function resolvePromptRef(promptRef: string): ReturnType<typeof getTemplate> {
  const { templateId, version } = parsePromptRef(promptRef);
  return getTemplate(templateId, version ? { version } : {});
}

/** Reject a `promptRef` that doesn't resolve to a real prompt-store template
 *  (no dangling references — the catalog must point at something renderable). */
function assertPromptRef(promptRef: string): void {
  const res = resolvePromptRef(promptRef);
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

/** Canonicalize a raw request/run subject into the id space `createEntry` stamps as
 *  `createdBy` — the space every read compares against via `readableBy`.
 *
 *  This rule lives HERE, beside `createEntry`, because it is a fact about THIS
 *  collection's key space: whoever writes a `createdBy` must land in the same space
 *  the reads use, and the definition of that space is `createEntry`'s `actor`
 *  parameter. It used to exist only as an inline expression in `promptSurface.ts`,
 *  which is why the portability importer (ADR 0694 D3a / `PLC-7`) never got it and
 *  minted rows owned by ids no read could produce.
 *
 *  A raw subject arrives as `oidc:<sub>` / a bearer principal for an unbound caller,
 *  while a bound browser/org-tenant caller is already `user:`-prefixed and canonical
 *  — pass those through unchanged so they keep matching. */
export function canonicalPromptActor(tenantId: string, raw: string): string {
  return raw.startsWith('user:') ? raw : userIdFor(tenantId, raw);
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

/** PLC-1 — is this entry READABLE by `caller`? The `visibility` field (stored,
 *  validated, defaulted `private`) used to gate NO read path, so a `private` entry
 *  leaked to every org member. `org`/`shared` stay org-visible (the route already
 *  gates org membership); `private` is owner-only. A missing caller (a system/non-user
 *  context) fails closed — it sees org/shared but never anyone's private. */
/** The ONE visibility predicate for a prompt entry. Exported so the ADR 0013
 *  sharing resolver's `validate` hook can COMPOSE it rather than restate it
 *  (ADR 0644 D1) — a second copy of this rule is how the two drift. */
export function readableBy(e: PromptLibraryEntry, caller: string | undefined): boolean {
  return e.visibility !== 'private' || e.createdBy === caller;
}

/** ALL entries in the org, NO visibility filter. For INTERNAL consumers whose own
 *  contract is the authorization — the sharing service (a minted public link IS the
 *  grant) and portability export/dedup (whose export-scope gap is the separate
 *  `CPC-16`, not this catalog-read fix). NOT for the catalog routes/surface. */
export async function listEntriesUnfiltered(tenantId: string, orgId: string): Promise<PromptLibraryEntry[]> {
  return (await entries.list())
    .filter((e) => e.tenantId === tenantId && e.orgId === orgId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Raw single-entry read, NO visibility filter (same internal-consumer rule as
 *  `listEntriesUnfiltered`). */
export async function getEntryUnfiltered(tenantId: string, orgId: string, entryId: string): Promise<PromptLibraryEntry | null> {
  return (await entries.get(`${tenantId}:${orgId}:${entryId}`)) ?? null;
}

export async function listEntries(tenantId: string, orgId: string, caller: string | undefined): Promise<PromptLibraryEntry[]> {
  return (await listEntriesUnfiltered(tenantId, orgId)).filter((e) => readableBy(e, caller));
}

export async function getEntry(tenantId: string, orgId: string, entryId: string, caller: string | undefined): Promise<PromptLibraryEntry | null> {
  const e = await getEntryUnfiltered(tenantId, orgId, entryId);
  // A private entry the caller can't read folds to the SAME absence as a missing
  // one (no existence leak) — matching the tenant/org isolation contract.
  return e && readableBy(e, caller) ? e : null;
}

/** Get-or-404 (uniform absence — no existence leak across tenant/org/visibility). */
async function mustGet(tenantId: string, orgId: string, entryId: string, caller: string | undefined): Promise<PromptLibraryEntry> {
  const e = await getEntry(tenantId, orgId, entryId, caller);
  if (!e) throw new OpenwopError('not_found', 'Prompt entry not found.', 404, { entryId });
  return e;
}

/** ADR 0116 Phase 2/4 — render an entry: resolve its `promptRef` against the SAME
 *  prompt store it validated against (a removed template 404s) and substitute
 *  `{{var}}` from `variables` (a missing binding stays literal). The single source for
 *  BOTH the render route AND the `ctx.prompts` workflow surface (no duplicated render). */
export async function renderEntry(
  tenantId: string, orgId: string, entryId: string, variables: Record<string, unknown>, caller: string | undefined,
): Promise<{ composed: string; templateId: string }> {
  const entry = await mustGet(tenantId, orgId, entryId, caller);
  const resolved = resolvePromptRef(entry.promptRef); // PLC-2 — honor the `@version` pin
  if (!resolved || resolved === 'ambiguous') {
    throw new OpenwopError('not_found', `Prompt template "${entry.promptRef}" is unavailable.`, 404, { promptRef: entry.promptRef });
  }
  const composed = resolved.template.text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : m);
  return { composed, templateId: entry.promptRef };
}

export async function updateEntry(tenantId: string, orgId: string, entryId: string, actor: string, input: PromptEntryInput): Promise<PromptLibraryEntry> {
  // WRITE authority stays org-scoped (unchanged) — PLC-1 gates the READ paths, not
  // who may edit. Use the unfiltered get so an org writer keeps managing any entry.
  const e = await getEntryUnfiltered(tenantId, orgId, entryId);
  if (!e) throw new OpenwopError('not_found', 'Prompt entry not found.', 404, { entryId });
  if (input.name !== undefined) e.name = clean(input.name, MAX_NAME, 'name');
  if (input.description !== undefined) e.description = typeof input.description === 'string' ? input.description.trim().slice(0, MAX_DESC) : undefined;
  if (input.tags !== undefined) e.tags = cleanTags(input.tags);
  if (input.promptRef !== undefined) { const r = clean(input.promptRef, 256, 'promptRef'); assertPromptRef(r); e.promptRef = r; }
  // PLC-6 (ADR 0694 D1a) — `visibility` is NOT an ordinary field: it IS the read
  // ACL `readableBy` consults. Org-scoped write authority over name/description/
  // tags/promptRef is the deliberate choice above and is unchanged, but letting any
  // `workspace:write` member flip a co-member's `private` entry to `org`/`shared`
  // makes PLC-1's guarantee only as strong as `workspace:write` — a GRANT wearing
  // the costume of an edit. This is the same lane ADR 0644 D1 closed on the sharing
  // MINT path (`sharing/sharingService.ts:394-401`: the "a minted link IS the grant"
  // rationale is CIRCULAR where whether the actor was entitled to grant is the open
  // question). The reasoning transfers verbatim; it had never been applied here.
  //
  // 403 and not 404: an org writer can already see the entry exists through this
  // very lane, so hiding it here would be a lie — unlike the READ lane, where the
  // 404 fold at `getEntry` is correct precisely because they cannot.
  if (input.visibility !== undefined && VALID_VISIBILITY.has(input.visibility as string)) {
    if (!readableBy(e, actor)) {
      throw new OpenwopError('forbidden', "Only the owner may change a private prompt's visibility.", 403, { entryId });
    }
    e.visibility = input.visibility as PromptVisibility;
  }
  e.updatedBy = actor;
  e.updatedAt = new Date().toISOString();
  await entries.put(e);
  return e;
}

export async function deleteEntry(tenantId: string, orgId: string, entryId: string): Promise<void> {
  // WRITE authority stays org-scoped (PLC-1 gates reads, not deletes).
  if (!(await getEntryUnfiltered(tenantId, orgId, entryId))) {
    throw new OpenwopError('not_found', 'Prompt entry not found.', 404, { entryId });
  }
  await entries.delete(`${tenantId}:${orgId}:${entryId}`);
  // WF-SHARE-4 — cascade the public share links that referenced this prompt entry.
  // Dynamic import: sharing imports THIS module for its resolver, so a static
  // edge back would cycle (the crm/signService precedent). Best-effort — a
  // cascade failure must not fail the delete, and the link would 404 anyway;
  // what it must not do is leave a row that reports "in use externally".
  try {
    const { purgeLinksForResource } = await import('../sharing/sharingService.js');
    await purgeLinksForResource(tenantId, 'prompt', entryId);
  } catch { /* best-effort cascade — the link resolves 404 regardless */ }

}
