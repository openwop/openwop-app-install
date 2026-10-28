/**
 * ADR 0993 D5 — the ONE tenant layer of the RFC 0028 prompt store.
 *
 * User-source templates used to live in a process-global in-memory map
 * (`promptStore.ts`), so one tenant could read, render, version and delete
 * another's, and every template vanished on a restart or on a second Cloud Run
 * instance. They now live here: durable, keyed by tenant, written by both
 * `POST`/`PUT /v1/prompts` and the ADR 0972 proposal installer (one tenant
 * layer with two writers, not two layers that can disagree).
 *
 * The namespace keeps its ADR 0972 name on purpose: prod had 0 rows when it was
 * widened, but a local database may hold some, and a rename would orphan them.
 *
 * Resolution is GLOBAL FIRST (host fixtures, packs, chain-minted), then this
 * layer (`/architect` H2). Host and pack templates already win a collision at
 * create time; the writer below also refuses those ids and the `chainmint-`
 * prefix regardless of what this instance happens to have registered, because
 * chain mints are registered lazily per instance and their ids are predictable.
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from './hostExtPersistence.js';
import { getTemplate, isGlobalTemplateId, semverCompare, type GetResult, type PromptTemplate } from './promptStore.js';

interface TenantTemplateRow {
  tenant: string;
  template: PromptTemplate;
  /** When the row was written (name kept from ADR 0972, where every row was an install). */
  installedAt: string;
}

const keyOf = (tenant: string, templateId: string, version: string): string => `${tenant}::${templateId}::${version}`;

const rows = new DurableCollection<TenantTemplateRow>(
  'proposal-installed-prompts',
  (r) => keyOf(r.tenant, r.template.templateId, r.template.version),
  undefined,
  (r) => r.tenant,
);

/** Ids the tenant layer may never hold: they belong to an immutable global layer. */
const RESERVED_PREFIXES = ['chainmint-'];

export type TenantWriteOutcome =
  | { ok: true; template: PromptTemplate; etag: string }
  | { ok: false; code: 'conflict' | 'invalid' | 'forbidden' | 'not_found'; message: string };

export function templateEtag(t: PromptTemplate): string {
  return createHash('sha256').update(JSON.stringify(t)).digest('hex');
}

function latest(list: TenantTemplateRow[]): TenantTemplateRow | undefined {
  return list.slice().sort((a, b) => semverCompare(b.template.version, a.template.version))[0];
}

async function versionsOf(tenant: string, templateId: string): Promise<TenantTemplateRow[]> {
  return (await rows.listByPrefix(`${tenant}::${templateId}::`))
    .filter((r) => r.tenant === tenant && r.template.templateId === templateId);
}

/** The RFC 0028 templateId grammar (`routes/prompts.ts` `parseStringyRef`) and a
 *  semver. Validated on every write (grade-code P61CD-4): the storage key is
 *  `tenant::id::version`, so an id or version carrying `::` could alias another
 *  row's key, and a non-semver version made `semverCompare` return NaN, which
 *  passed the "strictly greater" check. */
const TEMPLATE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function invalidReason(template: PromptTemplate): string | null {
  if (typeof template.templateId !== 'string' || !TEMPLATE_ID.test(template.templateId)) return `templateId must match ${TEMPLATE_ID.source}`;
  if (typeof template.version !== 'string' || !SEMVER.test(template.version)) return 'version must be a semantic version (e.g. 1.0.0)';
  return null;
}

/** Why `templateId` may not be written in a tenant, or null when it may. */
function reservedReason(templateId: string): string | null {
  if (isGlobalTemplateId(templateId)) return `templateId '${templateId}' collides with a host or pack template, which is read-only`;
  if (RESERVED_PREFIXES.some((p) => templateId.startsWith(p))) return `templateId '${templateId}' is in a namespace the host reserves`;
  return null;
}

/** Every template in `tenant`, latest version per templateId. */
export async function listTenantTemplates(tenant: string): Promise<PromptTemplate[]> {
  const byId = new Map<string, TenantTemplateRow[]>();
  for (const r of (await rows.listByPrefix(`${tenant}::`)).filter((x) => x.tenant === tenant)) {
    byId.set(r.template.templateId, [...(byId.get(r.template.templateId) ?? []), r]);
  }
  return [...byId.values()].map((v) => latest(v)!.template);
}

/** One template in `tenant`; `version` pins, otherwise the latest. */
export async function getTenantTemplate(tenant: string, templateId: string, version?: string): Promise<PromptTemplate | null> {
  if (version !== undefined) {
    const row = await rows.get(keyOf(tenant, templateId, version));
    return row && row.tenant === tenant && row.template.templateId === templateId && row.template.version === version ? row.template : null;
  }
  return latest(await versionsOf(tenant, templateId))?.template ?? null;
}

/**
 * THE resolver for a template reference made from inside a tenant: the global
 * layers first (immutable, collision winners), then the tenant's own. Every
 * tenant-scoped reader — the REST doors, dispatch, the prompt library — calls
 * this; none reads the tenant layer or the global layer alone.
 */
export async function resolveTenantTemplate(
  tenant: string,
  templateId: string,
  opts: { version?: string; libraryId?: string } = {},
): Promise<GetResult | null | 'ambiguous'> {
  const global = getTemplate(templateId, opts);
  if (global !== null) return global;
  if (opts.libraryId !== undefined) return null; // a libraryId names a pack; the tenant layer has none
  const t = await getTenantTemplate(tenant, templateId, opts.version);
  return t ? { template: t, etag: templateEtag(t), source: 'user' } : null;
}

/** Write one NEW version. Immutable: an existing (id, version) is a conflict, and
 *  so is a concurrent writer of the same version (`compareAndSwap(null, …)`). */
async function writeVersion(tenant: string, template: PromptTemplate): Promise<TenantWriteOutcome> {
  const invalid = invalidReason(template);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  const stamped: PromptTemplate = { ...template, meta: { ...(template.meta ?? {}), source: 'user' } };
  const row: TenantTemplateRow = { tenant, template: stamped, installedAt: new Date().toISOString() };
  if (!(await rows.compareAndSwap(null, row))) {
    return { ok: false, code: 'conflict', message: `template ${template.templateId}@${template.version} already exists` };
  }
  return { ok: true, template: stamped, etag: templateEtag(stamped) };
}

/** `POST /v1/prompts` — a first version (or another version that does not exist yet). */
export async function createTenantTemplate(tenant: string, template: PromptTemplate): Promise<TenantWriteOutcome> {
  const reserved = reservedReason(template.templateId);
  if (reserved) return { ok: false, code: 'forbidden', message: reserved };
  return writeVersion(tenant, template);
}

/** `PUT /v1/prompts/{id}` — a new version strictly greater than the stored latest. */
export async function updateTenantTemplate(tenant: string, templateId: string, template: PromptTemplate): Promise<TenantWriteOutcome> {
  if (template.templateId !== templateId) {
    return { ok: false, code: 'invalid', message: `body templateId '${template.templateId}' does not match path '${templateId}'` };
  }
  const reserved = reservedReason(templateId);
  if (reserved) return { ok: false, code: 'forbidden', message: reserved };
  const current = latest(await versionsOf(tenant, templateId));
  if (!current) return { ok: false, code: 'not_found', message: `no such template '${templateId}'` };
  const invalid = invalidReason(template);
  if (invalid) return { ok: false, code: 'invalid', message: invalid };
  if (semverCompare(template.version, current.template.version) <= 0) {
    return { ok: false, code: 'conflict', message: `submitted version '${String(template.version)}' must be strictly greater than stored '${current.template.version}'` };
  }
  return writeVersion(tenant, template);
}

/** `DELETE /v1/prompts/{id}` — every version in this tenant. */
export async function deleteTenantTemplate(tenant: string, templateId: string): Promise<{ ok: true } | { ok: false; code: 'not_found' | 'forbidden'; message: string }> {
  if (isGlobalTemplateId(templateId)) return { ok: false, code: 'forbidden', message: 'host and pack templates cannot be deleted' };
  const versions = await versionsOf(tenant, templateId);
  if (versions.length === 0) return { ok: false, code: 'not_found', message: `no such template '${templateId}'` };
  for (const v of versions) await rows.delete(keyOf(tenant, templateId, v.template.version));
  return { ok: true };
}

/** For the ADR 0972 installer: refuse a reserved id with its reason, else null. */
export function tenantTemplateReservedReason(templateId: string): string | null {
  return reservedReason(templateId);
}

/** For the ADR 0972 installer: the tenant's stored latest version, if any. */
export async function latestTenantVersion(tenant: string, templateId: string): Promise<string | null> {
  return latest(await versionsOf(tenant, templateId))?.template.version ?? null;
}

/** For the ADR 0972 installer: write one version (immutable) and return an undo. */
export async function installTenantVersion(tenant: string, template: PromptTemplate): Promise<TenantWriteOutcome & { rollback?: () => Promise<void> }> {
  const out = await writeVersion(tenant, template);
  if (!out.ok) return out;
  return { ...out, rollback: async () => { await rows.delete(keyOf(tenant, template.templateId, template.version)); } };
}
