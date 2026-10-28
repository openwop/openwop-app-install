/**
 * Prompt library (ADR 0116, ADR 0993) — a curated, RBAC-gated, shareable CATALOG
 * of prompt entries. An entry has exactly one source:
 * - a BINDING (`promptRef`) to a template in the prompt store, resolved for the
 *   entry's own tenant (ADR 0993 D5), or
 * - a PUBLISHED body (`bodyVersion`), pinned, in `prompts:entry-version`.
 *
 * CORRECTED (ADR 0993 D4): this header said "the catalog never copies the prompt
 * body … no parallel prompt store". A published body IS stored here, on purpose:
 * its ACL is the entry's (a private entry's text is its owner's), and the RFC 0028
 * store is readable tenant-wide, so a private body there leaked through every
 * template read. Org-scoped + tenant-isolated; a dangling `promptRef` is rejected.
 *
 * @see docs/adr/0116-prompt-library.md
 * @see docs/adr/0993-prompt-library-owner-lanes-and-tenant-templates.md
 */
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../observability/logger.js';
import { userIdFor } from '../users/usersService.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { resolveTenantTemplate } from '../../host/tenantPromptTemplates.js';
import { semverCompare, type PromptKind, type PromptTemplate } from '../../host/promptStore.js';
import { getPromptsHostConfig } from '../../host/promptHostConfig.js';
import { subjectKeyForms, ERASED } from '../../host/subjectErasureRedaction.js';
import type { SubjectEraseReport } from '../../host/subjectErasure.js';

export type PromptVisibility = 'private' | 'org' | 'shared';

export interface PromptLibraryEntry {
  entryId: string;
  tenantId: string;
  orgId: string;
  name: string;
  description?: string;
  tags: string[];
  /** A BINDING to a prompt-store template (`<templateId>[@version]`), resolved for
   *  the entry's own tenant. Exactly one of `promptRef` / `bodyVersion` is set. */
  promptRef?: string;
  /** ADR 0993 D4 — a PUBLISHED body: the pinned version in `prompts:entry-version`,
   *  a store only this entry's lanes read. Exactly one of `promptRef` / `bodyVersion`. */
  bodyVersion?: string;
  visibility: PromptVisibility;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  /** ADR 0993 D3 — incremented by every write; absent on a pre-0993 row (reads as 1). */
  revision?: number;
}

/** One published body version. Holds no subject id on purpose: a private body is
 *  erased WITH its entry (the D4 cascade), an org body is org content. */
interface EntryBodyVersion {
  tenantId: string;
  orgId: string;
  entryId: string;
  version: string;
  kind: PromptKind;
  text: string;
  variables?: PromptTemplate['variables'];
  createdAt: string;
}

/** What a reader gets back: the row plus what it can do with it. */
export interface PromptEntryView extends PromptLibraryEntry {
  /** ADR 0993 D4 — false when the entry's template or body no longer resolves. */
  available: boolean;
  ownedByCaller: boolean;
  /** The resolved prompt, when available. */
  body?: { kind: PromptKind; text: string; variables?: PromptTemplate['variables']; version: string };
}

const entryKey = (tenantId: string, orgId: string, entryId: string): string => `${tenantId}:${orgId}:${entryId}`;
const entries = new DurableCollection<PromptLibraryEntry>('prompts:entry', (e) => entryKey(e.tenantId, e.orgId, e.entryId), undefined, (e) => e.tenantId);
const bodies = new DurableCollection<EntryBodyVersion>(
  'prompts:entry-version',
  (b) => `${entryKey(b.tenantId, b.orgId, b.entryId)}:${b.version}`,
  undefined,
  (b) => b.tenantId,
);

const MAX_NAME = 200;
const MAX_DESC = 2_000;
const MAX_TAGS = 24;
const KINDS: ReadonlySet<string> = new Set<PromptKind>(['system', 'user', 'few-shot', 'schema-hint']);
/** The ONE visibility allowlist. Exported (ADR 0694 D3b) so the portability
 *  import validates against the same set the service writes — a second copy
 *  would be a place for the two to disagree about what `shared` means. */
export const VALID_VISIBILITY: ReadonlySet<string> = new Set<PromptVisibility>(['private', 'org', 'shared']);
/** Chain-minted templates are per-workflow artifacts whose presence varies by
 *  instance (`/architect` H2); an entry never binds one. */
const UNBINDABLE_PREFIXES = ['chainmint-'];

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
 *  template as `<templateId>[@version]` (a `prompt:` prefix, when present, is
 *  stripped). Split on the LAST `@` so a template id that itself contains `@` keeps
 *  it; an empty version (`foo@`) is treated as unpinned. */
function parsePromptRef(promptRef: string): { templateId: string; version?: string } {
  const ref = promptRef.startsWith('prompt:') ? promptRef.slice('prompt:'.length) : promptRef;
  const at = ref.lastIndexOf('@');
  if (at <= 0) return { templateId: ref };                       // no '@' (or leading) → unpinned
  if (at === ref.length - 1) return { templateId: ref.slice(0, at) }; // trailing '@' → strip, unpinned
  return { templateId: ref.slice(0, at), version: ref.slice(at + 1) };
}

type ResolvedBody = NonNullable<PromptEntryView['body']>;

/** Resolve a `promptRef` FOR A TENANT, honouring its `@version` pin (PLC-2), through
 *  the ONE tenant resolver (ADR 0993 D5): global layers, then the tenant's own. */
async function resolveRef(tenantId: string, promptRef: string): Promise<ResolvedBody | null> {
  const { templateId, version } = parsePromptRef(promptRef);
  if (UNBINDABLE_PREFIXES.some((p) => templateId.startsWith(p))) return null;
  const res = await resolveTenantTemplate(tenantId, templateId, version ? { version } : {});
  if (!res || res === 'ambiguous') return null;
  const t = res.template;
  return { kind: t.kind, text: t.text, ...(t.variables ? { variables: t.variables } : {}), version: t.version };
}

/** ADR 0993 D4 — THE resolver for what an entry says. Every reader calls it: the
 *  render route, `ctx.prompts`, the share `load`, the list's `available` flag. */
export async function resolveEntryBody(entry: PromptLibraryEntry): Promise<ResolvedBody | null> {
  if (entry.bodyVersion !== undefined) {
    const b = await bodies.get(`${entryKey(entry.tenantId, entry.orgId, entry.entryId)}:${entry.bodyVersion}`);
    if (!b || b.tenantId !== entry.tenantId || b.entryId !== entry.entryId) return null;
    return { kind: b.kind, text: b.text, ...(b.variables ? { variables: b.variables } : {}), version: b.version };
  }
  return entry.promptRef ? resolveRef(entry.tenantId, entry.promptRef) : null;
}

/** Reject a `promptRef` that doesn't resolve for this tenant (no dangling or
 *  foreign references — the catalog must point at something renderable). */
async function assertPromptRef(tenantId: string, promptRef: string): Promise<void> {
  if (!(await resolveRef(tenantId, promptRef))) {
    throw new OpenwopError('validation_error', `\`promptRef\` "${promptRef}" does not resolve to a prompt template.`, 400, { field: 'promptRef' });
  }
}

/** Validate a published body (`template` on create, `text` on update). */
function cleanBody(v: unknown, prior?: Pick<EntryBodyVersion, 'kind' | 'variables'>): Pick<EntryBodyVersion, 'kind' | 'text' | 'variables'> {
  const o = (v && typeof v === 'object' ? v : {}) as { kind?: unknown; text?: unknown; variables?: unknown };
  const kind = o.kind === undefined && prior ? prior.kind : o.kind;
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    throw new OpenwopError('validation_error', 'Field `template.kind` must be one of system, user, few-shot, schema-hint.', 400, { field: 'template.kind' });
  }
  if (typeof o.text !== 'string' || o.text.trim().length === 0) {
    throw new OpenwopError('validation_error', 'Field `template.text` is required.', 400, { field: 'template.text' });
  }
  if (Buffer.byteLength(o.text, 'utf8') > getPromptsHostConfig().maxTemplateBytes) {
    throw new OpenwopError('validation_error', 'The prompt text is too long.', 400, { field: 'template.text' });
  }
  let variables = prior?.variables;
  if (o.variables !== undefined) {
    if (!Array.isArray(o.variables) || !o.variables.every((x) => x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string')) {
      throw new OpenwopError('validation_error', 'Field `template.variables` must be a list of `{ name, … }`.', 400, { field: 'template.variables' });
    }
    variables = o.variables as PromptTemplate['variables'];
  }
  return { kind: kind as PromptKind, text: o.text, ...(variables ? { variables } : {}) };
}

const log = createLogger('features.prompts');

/** The next body version: one minor above the HIGHEST version this entry has ever
 *  written, not above the pinned one. A version written by an edit that then lost
 *  its entry CAS stays behind (insert-only), and deriving from the pin would
 *  recompute that same version on every later edit and 409 forever (grade-code
 *  P61CD-1, reproduced by a probe). */
async function nextBodyVersion(e: Pick<PromptLibraryEntry, 'tenantId' | 'orgId' | 'entryId'>): Promise<string> {
  const top = (await bodiesOf(e)).map((b) => b.version).sort((x, y) => semverCompare(y, x))[0] ?? '1.0.0';
  const [maj, min] = top.split('.').map((n) => Number(n) || 0);
  return `${maj ?? 1}.${(min ?? 0) + 1}.0`;
}

async function bodiesOf(e: Pick<PromptLibraryEntry, 'tenantId' | 'orgId' | 'entryId'>): Promise<EntryBodyVersion[]> {
  return (await bodies.listByPrefix(`${entryKey(e.tenantId, e.orgId, e.entryId)}:`))
    .filter((b) => b.tenantId === e.tenantId && b.orgId === e.orgId && b.entryId === e.entryId);
}

async function writeBodyVersion(e: Pick<PromptLibraryEntry, 'tenantId' | 'orgId' | 'entryId'>, version: string, body: Pick<EntryBodyVersion, 'kind' | 'text' | 'variables'>): Promise<void> {
  const row: EntryBodyVersion = { tenantId: e.tenantId, orgId: e.orgId, entryId: e.entryId, version, ...body, createdAt: new Date().toISOString() };
  if (!(await bodies.compareAndSwap(null, row))) {
    throw new OpenwopError('conflict', 'This prompt was edited at the same time. Reload it and try again.', 409, { entryId: e.entryId });
  }
}

export interface PromptEntryInput {
  name?: unknown;
  description?: unknown;
  tags?: unknown;
  /** Bind an existing template (create), or re-bind (update a binding entry). */
  promptRef?: unknown;
  /** ADR 0993 D4 — publish a body: `{ kind, text, variables? }` (create only). */
  template?: unknown;
  /** ADR 0993 D4 — a new body version (update a published entry). */
  text?: unknown;
  /** ADR 0993 D4 — new variable declarations, with or without `text`. */
  variables?: unknown;
  /** ADR 0993 D4 — the body kind, accepted on update only to repair a body whose
   *  pinned row is gone (it has no kind left to inherit). */
  kind?: unknown;
  visibility?: unknown;
  /** ADR 0993 D3 — the revision the editor read; a stale one is a 409. */
  expectedRevision?: unknown;
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
  const visibility: PromptVisibility = VALID_VISIBILITY.has(input.visibility as string) ? (input.visibility as PromptVisibility) : 'private';
  const now = new Date().toISOString();
  const entryId = randomUUID();
  // Exactly one source (ADR 0993 D4): a published body, or a binding.
  let source: Pick<PromptLibraryEntry, 'promptRef' | 'bodyVersion'>;
  if (input.template !== undefined) {
    if (input.promptRef !== undefined) {
      throw new OpenwopError('validation_error', 'Send `template` to publish a prompt or `promptRef` to bind one, not both.', 400, { field: 'template' });
    }
    await writeBodyVersion({ tenantId, orgId, entryId }, '1.0.0', cleanBody(input.template));
    source = { bodyVersion: '1.0.0' };
  } else {
    const promptRef = clean(input.promptRef, 256, 'promptRef');
    await assertPromptRef(tenantId, promptRef);
    source = { promptRef };
  }
  const entry: PromptLibraryEntry = {
    entryId,
    tenantId,
    orgId,
    name,
    ...(typeof input.description === 'string' && input.description.trim() ? { description: input.description.trim().slice(0, MAX_DESC) } : {}),
    tags: cleanTags(input.tags),
    ...source,
    visibility,
    createdBy: actor,
    updatedBy: actor,
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
  await entries.put(entry);
  return entry;
}

/** PLC-1 — is this entry READABLE by `caller`? `org`/`shared` are org-visible (the
 *  route gates org membership); `private` is owner-only. A missing caller (a
 *  system/non-user context) fails closed — it sees org/shared but never anyone's
 *  private.
 *
 *  The ONE visibility predicate for a prompt entry, and since ADR 0993 D2 also the
 *  WRITE predicate: a private entry is its owner's on every lane. Exported so the
 *  ADR 0013 sharing resolver composes it rather than restating it (ADR 0644 D1). */
export function readableBy(e: PromptLibraryEntry, caller: string | undefined): boolean {
  return e.visibility !== 'private' || e.createdBy === caller;
}

/** ALL entries in the org, NO visibility filter. For INTERNAL consumers whose own
 *  contract is the authorization (the sharing service's read hooks, where a minted
 *  link IS the grant). NOT for the catalog routes/surface or the export. */
export async function listEntriesUnfiltered(tenantId: string, orgId: string): Promise<PromptLibraryEntry[]> {
  // Prefix read, not a cross-tenant `list()` scan. Tenant ids contain `:`, so the
  // prefix can over-match; the field filter is the authority.
  return (await entries.listByPrefix(`${tenantId}:${orgId}:`))
    .filter((e) => e.tenantId === tenantId && e.orgId === orgId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Raw single-entry read, NO visibility filter (same internal-consumer rule). */
export async function getEntryUnfiltered(tenantId: string, orgId: string, entryId: string): Promise<PromptLibraryEntry | null> {
  const e = await entries.get(entryKey(tenantId, orgId, entryId));
  return e && e.tenantId === tenantId && e.orgId === orgId ? e : null;
}

/** Per-request memo for resolving many entries (grade-code P61CD-3): one body
 *  prefix read per org, and one template resolve per distinct `promptRef`, instead
 *  of a storage round trip per entry. */
interface ResolveMemo { bodies: Map<string, EntryBodyVersion>; refs: Map<string, Promise<ResolvedBody | null>> }

async function memoFor(tenantId: string, orgId: string): Promise<ResolveMemo> {
  const rows = (await bodies.listByPrefix(`${tenantId}:${orgId}:`)).filter((b) => b.tenantId === tenantId && b.orgId === orgId);
  return { bodies: new Map(rows.map((b) => [`${b.entryId}:${b.version}`, b])), refs: new Map() };
}

async function resolveWithMemo(e: PromptLibraryEntry, memo: ResolveMemo): Promise<ResolvedBody | null> {
  if (e.bodyVersion !== undefined) {
    const b = memo.bodies.get(`${e.entryId}:${e.bodyVersion}`);
    return b ? { kind: b.kind, text: b.text, ...(b.variables ? { variables: b.variables } : {}), version: b.version } : null;
  }
  if (!e.promptRef) return null;
  let r = memo.refs.get(e.promptRef);
  if (!r) { r = resolveRef(e.tenantId, e.promptRef); memo.refs.set(e.promptRef, r); }
  return r;
}

function toView(e: PromptLibraryEntry, caller: string | undefined, body: ResolvedBody | null): PromptEntryView {
  return { ...e, revision: e.revision ?? 1, available: body !== null, ownedByCaller: caller !== undefined && e.createdBy === caller, ...(body ? { body } : {}) };
}

async function viewOf(e: PromptLibraryEntry, caller: string | undefined): Promise<PromptEntryView> {
  return toView(e, caller, await resolveEntryBody(e));
}

export async function listEntries(tenantId: string, orgId: string, caller: string | undefined): Promise<PromptEntryView[]> {
  const readable = (await listEntriesUnfiltered(tenantId, orgId)).filter((e) => readableBy(e, caller));
  if (readable.length === 0) return [];
  const memo = await memoFor(tenantId, orgId);
  return Promise.all(readable.map(async (e) => toView(e, caller, await resolveWithMemo(e, memo))));
}

export async function getEntry(tenantId: string, orgId: string, entryId: string, caller: string | undefined): Promise<PromptEntryView | null> {
  const e = await getEntryUnfiltered(tenantId, orgId, entryId);
  // A private entry the caller can't read folds to the SAME absence as a missing
  // one (no existence leak) — matching the tenant/org isolation contract.
  return e && readableBy(e, caller) ? viewOf(e, caller) : null;
}

/** The raw row a caller may act on, or a uniform 404 (no existence leak across
 *  tenant / org / visibility). ADR 0993 D2: writes use THIS, not the unfiltered
 *  read — a member who cannot read a private entry cannot edit or delete it. */
async function mustGetReadable(tenantId: string, orgId: string, entryId: string, caller: string | undefined): Promise<PromptLibraryEntry> {
  const e = await getEntryUnfiltered(tenantId, orgId, entryId);
  if (!e || !readableBy(e, caller)) throw new OpenwopError('not_found', 'Prompt entry not found.', 404, { entryId });
  return e;
}

/** ADR 0116 Phase 2/4 — render an entry: resolve it (`resolveEntryBody`; a removed
 *  template or body is a 404) and substitute `{{var}}` from `variables` (a missing
 *  binding stays literal). The single render for BOTH the render route and the
 *  `ctx.prompts` surface.
 *
 *  CORRECTED (ADR 0993 D9): this is a plain substitution, NOT
 *  `composePromptTemplate`, and bindings are NOT fenced. That is deliberate for
 *  its callers — the result is text a person reviews in their own composer (D1),
 *  or text a workflow author chose to fetch — but the route comment that said
 *  "untrusted bindings are fenced by the composer" was false. */
export async function renderEntry(
  tenantId: string, orgId: string, entryId: string, variables: Record<string, unknown>, caller: string | undefined,
): Promise<{ composed: string; templateId: string }> {
  const entry = await mustGetReadable(tenantId, orgId, entryId, caller);
  const resolved = await resolveEntryBody(entry);
  if (!resolved) {
    throw new OpenwopError('not_found', 'This prompt\'s template is no longer available.', 404, { entryId });
  }
  const composed = resolved.text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : m);
  return { composed, templateId: entry.promptRef ?? `entry:${entry.entryId}@${resolved.version}` };
}

export async function updateEntry(tenantId: string, orgId: string, entryId: string, actor: string, input: PromptEntryInput): Promise<PromptEntryView> {
  // ADR 0993 D2 — the write lane uses the READ predicate. ADR 0694 leg 4 kept
  // ordinary fields org-writable on a private entry; that let a member who could
  // not read the entry repoint it, which decides what its owner sends. A body
  // edit is the same grant ADR 0694 D1 refused for a visibility change.
  const read = await mustGetReadable(tenantId, orgId, entryId, actor);
  // ADR 0993 D3 — `compareAndSwap` compares BYTES against the stored value, so the
  // row as read is the `expected` and is never mutated; `next` is a new object.
  const currentRevision = read.revision ?? 1;
  if (input.expectedRevision !== undefined && (typeof input.expectedRevision !== 'number' || !Number.isInteger(input.expectedRevision))) {
    throw new OpenwopError('validation_error', 'Field `expectedRevision` must be an integer.', 400, { field: 'expectedRevision' });
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
    throw new OpenwopError('conflict', 'This prompt changed since you opened it. Reload it to see the latest version.', 409, { entryId, currentRevision });
  }
  const next: PromptLibraryEntry = { ...read, tags: [...read.tags] };
  let writtenVersion: string | undefined;
  if (input.name !== undefined) next.name = clean(input.name, MAX_NAME, 'name');
  if (input.description !== undefined) {
    if (typeof input.description === 'string' && input.description.trim()) next.description = input.description.trim().slice(0, MAX_DESC);
    else delete next.description;
  }
  if (input.tags !== undefined) next.tags = cleanTags(input.tags);
  if (input.promptRef !== undefined) {
    if (read.bodyVersion !== undefined) {
      throw new OpenwopError('validation_error', 'This prompt was published with its own text. Edit the text instead of binding a template.', 400, { field: 'promptRef' });
    }
    const r = clean(input.promptRef, 256, 'promptRef');
    await assertPromptRef(tenantId, r);
    next.promptRef = r;
  }
  if (input.text !== undefined || input.variables !== undefined) {
    if (read.bodyVersion === undefined) {
      throw new OpenwopError('validation_error', 'This prompt binds a template. Edit the template, or publish your own text as a new prompt.', 400, { field: 'text' });
    }
    const prior = await bodies.get(`${entryKey(tenantId, orgId, entryId)}:${read.bodyVersion}`);
    // A body whose pinned row is gone can still be repaired: `kind` may come from
    // the input (grade-code P61CD-7), else from the prior row.
    const kind = input.kind ?? prior?.kind;
    const body = cleanBody({ kind, text: input.text ?? prior?.text, variables: input.variables }, prior ?? undefined);
    // `/architect` H1 — the version FIRST (immutable, insert-only), THEN the pin.
    // A lost entry CAS below must never become a live change a "conflict" answer
    // denied, so the version written here is removed again on that path.
    writtenVersion = await nextBodyVersion(read);
    await writeBodyVersion(read, writtenVersion, body);
    next.bodyVersion = writtenVersion;
  }
  if (input.visibility !== undefined && VALID_VISIBILITY.has(input.visibility as string) && input.visibility !== read.visibility) {
    // Visibility IS the ACL, in both directions (grade-code P61CD-6): widening is
    // a grant (ADR 0694 D1) and narrowing takes the entry away from the whole org.
    // Only the owner decides it. (A private entry already reached here only for
    // its owner, through `mustGetReadable`.)
    if (read.createdBy !== actor) {
      throw new OpenwopError('forbidden', 'Only the person who published this prompt can change who can use it.', 403, { entryId, field: 'visibility' });
    }
    next.visibility = input.visibility as PromptVisibility;
  }
  next.updatedBy = actor;
  next.updatedAt = new Date().toISOString();
  next.revision = currentRevision + 1;
  if (!(await entries.compareAndSwap(read, next))) {
    if (writtenVersion) await bodies.delete(`${entryKey(tenantId, orgId, entryId)}:${writtenVersion}`).catch(() => undefined);
    const now = await getEntryUnfiltered(tenantId, orgId, entryId);
    throw new OpenwopError('conflict', 'This prompt changed since you opened it. Reload it to see the latest version.', 409, { entryId, ...(now ? { currentRevision: now.revision ?? 1 } : {}) });
  }
  return viewOf(next, actor);
}

/** Delete the entry, then its share links, then its body versions (ADR 0993 D4).
 *
 *  The ROW goes first, by compare-and-delete: if a concurrent edit wins, nothing
 *  has been destroyed and the caller gets a 409 (grade-code P61CD-2 / code-review
 *  P61CR-6 — the old order purged links and bodies first, so a lost race left a
 *  live entry with no text). After the row is gone nothing serves the links or the
 *  bodies, and an edit racing this delete loses its own CAS and removes the version
 *  it wrote, so no private body outlives its entry. */
async function cascadeDelete(e: PromptLibraryEntry): Promise<boolean> {
  if (!(await entries.compareAndDelete(e))) return false;
  const { purgeLinksForResource } = await import('../sharing/sharingService.js'); // sharing imports THIS module; a static edge would cycle
  await purgeLinksForResource(e.tenantId, 'prompt', e.entryId);
  for (const b of await bodiesOf(e)) await bodies.delete(`${entryKey(b.tenantId, b.orgId, b.entryId)}:${b.version}`);
  return true;
}

export async function deleteEntry(tenantId: string, orgId: string, entryId: string, actor: string | undefined): Promise<void> {
  const e = await mustGetReadable(tenantId, orgId, entryId, actor); // ADR 0993 D2
  if (!(await cascadeDelete(e))) {
    throw new OpenwopError('conflict', 'This prompt changed while it was being deleted. Try again.', 409, { entryId });
  }
}

/**
 * ADR 0993 D6 — DSAR. A PRIVATE entry the subject created is their own data and
 * is DELETED (with its body versions and share links). On every other entry the
 * subject's attribution is ANONYMIZED: the entry is the org's. Matches every
 * spelling `subjectKeyForms` produces, the doubled `user:user:` one included
 * (DSAR-DBL). Tenant-indexed; idempotent.
 */
export async function eraseSubjectPromptEntries(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  const forms = subjectKeyForms(subjectKey).forms;
  let rowsTouched = 0;
  for (const listed of await entries.listForTenant(tenantId)) {
    if (listed.tenantId !== tenantId) continue;
    // A concurrent edit makes the CAS lose; re-read and retry, bounded, and say so
    // if it never lands (grade-code P61CD-11) rather than skip the row silently.
    let e: PromptLibraryEntry | null = listed;
    let done = false;
    for (let attempt = 0; attempt < 3 && e && !done; attempt++) {
      if (e.visibility === 'private' && forms.has(e.createdBy)) {
        done = await cascadeDelete(e);
      } else if (forms.has(e.createdBy) || forms.has(e.updatedBy)) {
        const next: PromptLibraryEntry = {
          ...e,
          tags: [...e.tags],
          createdBy: forms.has(e.createdBy) ? ERASED : e.createdBy,
          updatedBy: forms.has(e.updatedBy) ? ERASED : e.updatedBy,
          revision: (e.revision ?? 1) + 1,
        };
        done = await entries.compareAndSwap(e, next);
      } else {
        break; // not this subject's (any more)
      }
      if (done) rowsTouched += 1;
      else e = await getEntryUnfiltered(listed.tenantId, listed.orgId, listed.entryId);
    }
    if (!done && e && (forms.has(e.createdBy) || forms.has(e.updatedBy))) {
      log.warn('prompt_erasure_cas_lost', { tenantId, entryId: listed.entryId });
    }
  }
  return { rowsTouched };
}

/** For the export (ADR 0993 D7): a published body's pinned text, or null. */
export async function publishedBodyOf(e: PromptLibraryEntry): Promise<Pick<EntryBodyVersion, 'kind' | 'text' | 'variables'> | null> {
  if (e.bodyVersion === undefined) return null;
  const b = await resolveEntryBody(e);
  return b ? { kind: b.kind, text: b.text, ...(b.variables ? { variables: b.variables } : {}) } : null;
}
