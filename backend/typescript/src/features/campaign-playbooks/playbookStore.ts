/**
 * ADR 0959 D1 — playbook drafts and IMMUTABLE published versions.
 *
 * - A draft is one row per (tenant, playbook), CAS-updated.
 * - Publishing freezes the draft into a version row written put-if-absent: a version that
 *   exists is refused (`playbook_version_exists`), never overwritten, and a version must be
 *   newer than the latest (`playbook_version_not_newer`).
 * - Chains are validated by the loader's own rules (`validateChainDocuments`: the manifest
 *   schema, cycles, RFC 0133 composition, the node-pin rule). A draft keeps them as authored;
 *   a version stores them pin-normalized, exactly as the loader stores a pack's chains. There
 *   is no second chain schema.
 * - Sub-chains resolve per version (D2, `playbookResolver.ts`); publishing refuses a version
 *   whose refs do not resolve exactly (`sub_chain_unresolved`). Slots (D3) are declared refs of
 *   the entry chain a layer may rebind.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { validateChainDocuments, type WorkflowChain } from '../../host/workflowChainPackLoader.js';
import { normalizeChainPins, EXACT_SEMVER_RE } from '../../host/chainPinRule.js';
import { semverCompare } from '../../util/semver.js';
import { OpenwopError } from '../../types.js';
import { redactRows } from './redactRows.js';
import { createHash } from 'node:crypto';
import { canonicalJSON } from '../../host/jcs.js';
import type { PlaybookBody, PlaybookContentItem, PlaybookDraft, PlaybookSlot, PlaybookVersion } from './types.js';
import { getPlaybookContentAdapter } from '../../host/playbookContentAdapters.js';
import { firstUnresolvedRef, playbookResolution, subChainRefsOf } from './playbookResolver.js';

const drafts = new DurableCollection<PlaybookDraft>('campaign-playbooks:draft', (d) => d.key, undefined, (d) => d.tenantId);
const versions = new DurableCollection<PlaybookVersion>('campaign-playbooks:version', (v) => v.key, undefined, (v) => v.tenantId);

/** sha256 over RFC 8785 canonical JSON — the same content always hashes the same. */
export function playbookHashOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJSON(value)).digest('hex')}`;
}

export const PLAYBOOK_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
const MAX_CHAINS = 20;

const draftKey = (tenantId: string, playbookId: string): string => `${tenantId}::${playbookId}`;
const versionKey = (tenantId: string, playbookId: string, version: string): string => `${tenantId}::${playbookId}::${version}`;

function invalid(message: string, details: Record<string, unknown> = {}): OpenwopError {
  return new OpenwopError('validation_error', message, 400, details);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Parameter names the entry chain declares. */
export function chainParamNames(chain: WorkflowChain): string[] {
  const props = (chain.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  return isRecord(props) ? Object.keys(props) : [];
}

/** Parse + validate a draft body. Throws a typed 400/422; returns the normalized body. */
export function parsePlaybookBody(raw: unknown): PlaybookBody {
  if (!isRecord(raw)) throw invalid('A playbook body is required.');
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title || title.length > 120) throw invalid('A title (1–120 characters) is required.', { field: 'title' });
  if (!Array.isArray(raw.chains) || raw.chains.length === 0 || raw.chains.length > MAX_CHAINS) {
    throw invalid(`A playbook holds 1–${MAX_CHAINS} workflow chains.`, { field: 'chains' });
  }
  const problem = validateChainDocuments(raw.chains);
  if (problem) throw new OpenwopError('validation_error', `The playbook's chains are invalid: ${problem.message}`, 422, { field: 'chains', code: problem.code });
  // A draft keeps the AUTHORED chains (what the author edits and what re-validates);
  // publishing stores them pin-normalized, exactly as the loader stores a pack's.
  const chains = raw.chains as WorkflowChain[];
  const ids = new Set(chains.map((c) => c.chainId));
  if (ids.size !== chains.length) throw invalid('Two chains share a chainId.', { field: 'chains' });
  const entryChainId = typeof raw.entryChainId === 'string' ? raw.entryChainId : '';
  const entry = chains.find((c) => c.chainId === entryChainId);
  if (!entry) throw invalid('entryChainId must name one of the playbook\'s chains.', { field: 'entryChainId' });
  const params = new Set(chainParamNames(entry));
  const defaultsRaw = isRecord(raw.defaults) && isRecord(raw.defaults.params) ? raw.defaults.params : {};
  for (const k of Object.keys(defaultsRaw)) {
    if (!params.has(k)) throw invalid(`Default "${k}" is not a parameter of the entry chain.`, { field: 'defaults', key: k });
  }
  const overridableRaw = isRecord(raw.overridable) && Array.isArray(raw.overridable.params) ? raw.overridable.params : [];
  const overridable: string[] = [];
  for (const k of overridableRaw) {
    if (typeof k !== 'string' || !params.has(k)) throw invalid(`Overridable "${String(k)}" is not a parameter of the entry chain.`, { field: 'overridable', key: k });
    if (!overridable.includes(k)) overridable.push(k);
  }
  // D3 — slots: refs the ENTRY chain uses, each declared in its subChains[].
  const entryRefs = new Set(subChainRefsOf(entry));
  const slotsRaw = Array.isArray(raw.slots) ? raw.slots : [];
  const slots: PlaybookSlot[] = [];
  for (const s of slotsRaw) {
    const ref = isRecord(s) && typeof s.ref === 'string' ? s.ref : '';
    const label = isRecord(s) && typeof s.label === 'string' ? s.label.trim().slice(0, 120) : '';
    if (!ref || !entryRefs.has(ref)) throw invalid(`Slot "${ref}" is not a sub-chain the entry chain uses.`, { field: 'slots', ref });
    if (!label) throw invalid(`Slot "${ref}" needs a label.`, { field: 'slots', ref });
    if (!slots.some((x) => x.ref === ref)) slots.push({ ref, label });
  }
  const slotRefs = new Set(slots.map((x) => x.ref));
  const overridableSlotsRaw = isRecord(raw.overridable) && Array.isArray(raw.overridable.slots) ? raw.overridable.slots : [];
  const overridableSlots: string[] = [];
  for (const k of overridableSlotsRaw) {
    if (typeof k !== 'string' || !slotRefs.has(k)) throw invalid(`Overridable slot "${String(k)}" is not a declared slot.`, { field: 'overridable', key: k });
    if (!overridableSlots.includes(k)) overridableSlots.push(k);
  }
  // D5 — content items, each validated by the adapter of the feature that owns its kind.
  const contentRaw = Array.isArray(raw.content) ? raw.content : [];
  if (contentRaw.length > 50) throw invalid('A playbook holds at most 50 content items.', { field: 'content' });
  const content: PlaybookContentItem[] = [];
  for (const c of contentRaw) {
    const slot = isRecord(c) && typeof c.slot === 'string' ? c.slot : '';
    const kind = isRecord(c) && typeof c.kind === 'string' ? c.kind : '';
    if (!PLAYBOOK_ID_RE.test(slot)) throw invalid('Each content item needs a slot (a lowercase slug).', { field: 'content', slot });
    if (content.some((x) => x.slot === slot)) throw invalid(`Two content items share the slot "${slot}".`, { field: 'content', slot });
    const adapter = getPlaybookContentAdapter(kind);
    if (!adapter) throw new OpenwopError('validation_error', `No feature on this host provides "${kind}" content.`, 422, { field: 'content', code: 'content_kind_unknown', kind });
    content.push({ slot, kind, payload: adapter.parse(isRecord(c) ? c.payload : undefined) });
  }
  const changelog = typeof raw.changelog === 'string' ? raw.changelog.slice(0, 4000) : '';
  return { title, chains, entryChainId, defaults: { params: { ...defaultsRaw } }, overridable: { params: overridable.sort(), slots: overridableSlots.sort() }, slots, content, changelog };
}

export async function saveDraft(tenantId: string, playbookId: string, raw: unknown, by: string): Promise<PlaybookDraft> {
  if (!PLAYBOOK_ID_RE.test(playbookId)) throw invalid('playbookId must be a lowercase slug (letters, digits and dashes).', { field: 'playbookId' });
  const body = parsePlaybookBody(raw);
  const key = draftKey(tenantId, playbookId);
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await drafts.get(key);
    const next: PlaybookDraft = { ...body, key, tenantId, playbookId, updatedBy: by, updatedAt: new Date().toISOString() };
    if (await drafts.compareAndSwap(cur && cur.tenantId === tenantId ? cur : null, next)) return next;
  }
  throw new OpenwopError('conflict', 'The draft changed while it was being saved. Reload and try again.', 409, { playbookId });
}

export async function getDraft(tenantId: string, playbookId: string): Promise<PlaybookDraft | null> {
  const d = await drafts.get(draftKey(tenantId, playbookId));
  return d && d.tenantId === tenantId ? d : null;
}

export async function listVersions(tenantId: string, playbookId: string): Promise<PlaybookVersion[]> {
  const rows = (await versions.listByPrefix(`${tenantId}::${playbookId}::`)).filter((v) => v.tenantId === tenantId && v.playbookId === playbookId);
  return rows.sort((a, b) => semverCompare(b.version, a.version));
}

export async function getVersion(tenantId: string, playbookId: string, version: string): Promise<PlaybookVersion | null> {
  const v = await versions.get(versionKey(tenantId, playbookId, version));
  return v && v.tenantId === tenantId ? v : null;
}

/** Every playbook's newest version in the tenant (one bounded tenant-slice read). */
export async function listPlaybooks(tenantId: string): Promise<PlaybookVersion[]> {
  const latest = new Map<string, PlaybookVersion>();
  for (const v of await versions.listForTenant(tenantId)) {
    if (v.tenantId !== tenantId) continue;
    const cur = latest.get(v.playbookId);
    if (!cur || semverCompare(v.version, cur.version) > 0) latest.set(v.playbookId, v);
  }
  return [...latest.values()].sort((a, b) => a.playbookId.localeCompare(b.playbookId));
}

/** Freeze the draft as `version`. Immutable: an existing version is refused, never replaced. */
export async function publishVersion(tenantId: string, playbookId: string, version: string, by: string): Promise<PlaybookVersion> {
  if (!EXACT_SEMVER_RE.test(version)) throw invalid('version must be an exact SemVer (for example 1.0.0).', { field: 'version' });
  const draft = await getDraft(tenantId, playbookId);
  if (!draft) throw new OpenwopError('not_found', 'Playbook draft not found.', 404, { playbookId });
  // Re-validate at publish: a draft saved before a node pack changed must not freeze stale.
  const body = parsePlaybookBody(draft);
  const prior = (await listVersions(tenantId, playbookId))[0];
  if (prior && prior.version === version) throw new OpenwopError('conflict', `Version ${version} is already published. A published version never changes; publish a new one.`, 409, { playbookId, version, reason: 'playbook_version_exists' });
  if (prior && semverCompare(version, prior.version) <= 0) throw new OpenwopError('conflict', `Version ${version} is not newer than ${prior.version}.`, 409, { playbookId, version, latest: prior.version, reason: 'playbook_version_not_newer' });
  const normalizedChains = body.chains.map((authored) => {
    const normalized = normalizeChainPins(authored);
    return Object.keys(normalized.nodePins).length > 0 ? { ...normalized.chain, nodePins: normalized.nodePins } : normalized.chain;
  });
  const row: PlaybookVersion = {
    ...body,
    chains: normalizedChains,
    key: versionKey(tenantId, playbookId, version),
    tenantId,
    playbookId,
    version,
    contentHash: playbookHashOf(body),
    publishedBy: by,
    publishedAt: new Date().toISOString(),
    ...(prior ? { supersedes: prior.version } : {}),
  };
  // D2 — every sub-chain ref must resolve, exactly, today (immutable playbook versions stay
  // resolvable; a host pack can still vanish later, and the install re-resolves and refuses).
  const entry = row.chains.find((c) => c.chainId === row.entryChainId);
  const unresolved = entry ? await firstUnresolvedRef(playbookResolution(tenantId, row), entry) : null;
  if (unresolved) throw new OpenwopError('validation_error', `Sub-chain "${unresolved}" does not resolve to an exact version this workspace or host has.`, 422, { field: 'chains', code: 'sub_chain_unresolved', ref: unresolved });
  if (!(await versions.putIfAbsent(row))) {
    throw new OpenwopError('conflict', `Version ${version} is already published. A published version never changes; publish a new one.`, 409, { playbookId, version, reason: 'playbook_version_exists' });
  }
  return row;
}

/** ADR 0464 — a person's erasure tombstones who drafted and published; the method stays. */
export async function erasePlaybookAuthors(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  return (await redactRows(drafts, tenantId, (d) => forms.has(d.updatedBy) ? { ...d, updatedBy: tombstone } : null))
    + (await redactRows(versions, tenantId, (v) => forms.has(v.publishedBy) ? { ...v, publishedBy: tombstone } : null));
}
