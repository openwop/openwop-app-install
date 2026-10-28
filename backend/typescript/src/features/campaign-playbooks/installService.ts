/**
 * ADR 0959 D4 — install a published playbook version for ONE client: one owned,
 * builder-editable workflow per (tenant, client org, playbook).
 *
 * - Config is layered (D3): layer 0 = the version's defaults, layer 2 = the client's values,
 *   per-key last-layer-wins. A client value may only set a key the version lists as
 *   overridable (`playbook_key_not_overridable`), and the merged values must satisfy the entry
 *   chain's own `parameters` schema (`playbook_params_invalid`). P1 adds layer 1 (agency) and
 *   widens overrides to policy, bindings and slots.
 * - The workflow is made by the ONE instantiation path (`instantiateOwnedChain`) from the
 *   VERSION ROW's chain — never `getChain(id)`, which holds one version host-wide (P-G1).
 * - A durable `installing` claim reserves one random workflow copy id before writes.
 *   Retries of the same version and configuration reuse it; an unknown legacy claim
 *   fails closed instead of guessing whether its workflow write happened.
 */
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { instantiateOwnedChain } from '../../host/chainInstantiation.js';
import { revisionHashOf } from '../../host/definitionHash.js';
import { OpenwopError } from '../../types.js';
import { redactRows } from './redactRows.js';
import { createLogger } from '../../observability/logger.js';
import { getVersion, listVersions, playbookHashOf, PLAYBOOK_ID_RE } from './playbookStore.js';
import { EXACT_SEMVER_RE } from '../../host/chainPinRule.js';
import { getOwned, WORKFLOW_SUBJECT_PATTERN } from '../../host/workflowOwnership.js';
import { copyWorkflowId, workflowIdOrigin } from '../../host/workflowId.js';
import { getRegisteredWorkflowAsync } from '../../host/workflowsRegistry.js';
import { firstUnresolvedRef, playbookResolution, type PlaybookResolution } from './playbookResolver.js';
import { applyContent, type ContentApplyResult } from './contentService.js';
import type { WorkflowChain } from '../../host/workflowChainPackLoader.js';
import type { ConfigLayer, InstallationDrift, PlaybookAgencyLayer, PlaybookInstallation, PlaybookRing, PlaybookVersion, PlaybookWorkflowIndex, SlotBinding } from './types.js';

const log = createLogger('features.campaign-playbooks.install');

const installs = new DurableCollection<PlaybookInstallation>('campaign-playbooks:install', (i) => i.key, undefined, (i) => i.tenantId);
const byWorkflow = new DurableCollection<PlaybookWorkflowIndex>('campaign-playbooks:install-by-workflow', (i) => i.key, undefined, (i) => i.tenantId);

const installKey = (tenantId: string, orgId: string, playbookId: string): string => `${tenantId}::${orgId}::${playbookId}`;
const indexKey = (tenantId: string, workflowId: string): string => `${tenantId}::${workflowId}`;

const ajv = new Ajv2020({ allErrors: true, strict: false });
const paramValidators = new Map<string, ValidateFunction>();
function paramValidator(v: PlaybookVersion): ValidateFunction | null {
  const entry = v.chains.find((c) => c.chainId === v.entryChainId);
  if (!entry?.parameters) return null;
  const key = `${v.contentHash}::${v.entryChainId}`;
  let fn = paramValidators.get(key);
  if (!fn) { fn = ajv.compile(entry.parameters as object); paramValidators.set(key, fn); }
  return fn;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * D3 — parse one layer (agency or client) and keep it inside the version's override policy:
 * parameter keys from `overridable.params`, slot refs from `overridable.slots`, each slot bound
 * to an exact playbook version of this tenant.
 */
export function parseLayer(raw: unknown, version: PlaybookVersion, field: 'clientLayer' | 'agencyLayer'): ConfigLayer {
  const who = field === 'clientLayer' ? 'a client' : 'the agency';
  const params = isRecord(raw) && isRecord(raw.params) ? raw.params : {};
  const allowed = new Set(version.overridable.params);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) {
      throw new OpenwopError('validation_error', `"${k}" cannot be set for ${who}: the playbook does not list it as overridable.`, 400, { field, key: k, reason: 'playbook_key_not_overridable' });
    }
  }
  const slotsRaw = isRecord(raw) && isRecord(raw.slots) ? raw.slots : {};
  const allowedSlots = new Set(version.overridable.slots ?? []);
  const slots: Record<string, SlotBinding> = {};
  for (const [ref, b] of Object.entries(slotsRaw)) {
    if (!allowedSlots.has(ref)) {
      throw new OpenwopError('validation_error', `Slot "${ref}" cannot be rebound for ${who}: the playbook does not list it as overridable.`, 400, { field, key: ref, reason: 'playbook_key_not_overridable' });
    }
    const playbookId = isRecord(b) && typeof b.playbookId === 'string' ? b.playbookId : '';
    const v = isRecord(b) && typeof b.version === 'string' ? b.version : '';
    const chainId = isRecord(b) && typeof b.chainId === 'string' ? b.chainId : '';
    if (!PLAYBOOK_ID_RE.test(playbookId) || !EXACT_SEMVER_RE.test(v) || !chainId) {
      throw new OpenwopError('validation_error', `Slot "${ref}" must name a playbook, an exact version and a chain.`, 400, { field, key: ref });
    }
    slots[ref] = { playbookId, version: v, chainId };
  }
  return { params: { ...params }, ...(Object.keys(slots).length ? { slots } : {}) };
}

/** P0 name kept for the client layer. */
export function parseClientLayer(raw: unknown, version: PlaybookVersion): ConfigLayer {
  return parseLayer(raw, version, 'clientLayer');
}

/** D3 — the effective parameter values: layer 0, then 1 (agency), then 2 (client), per key. */
export function mergeLayers(version: PlaybookVersion, client: ConfigLayer | undefined, agency?: ConfigLayer): Record<string, unknown> {
  return { ...version.defaults.params, ...(agency?.params ?? {}), ...(client?.params ?? {}) };
}

/** D3 — the effective slot bindings: agency, then client, per slot. */
export function mergeSlots(client: ConfigLayer | undefined, agency?: ConfigLayer): Record<string, SlotBinding> {
  return { ...(agency?.slots ?? {}), ...(client?.slots ?? {}) };
}

// ── D3 layer 1 — the agency's values per playbook ─────────────────────────────
const agencyLayers = new DurableCollection<PlaybookAgencyLayer>('campaign-playbooks:agency-layer', (a) => a.key, undefined, (a) => a.tenantId);

export async function getAgencyLayer(tenantId: string, playbookId: string): Promise<PlaybookAgencyLayer | null> {
  const row = await agencyLayers.get(`${tenantId}::${playbookId}`);
  return row && row.tenantId === tenantId ? row : null;
}

/** Validated against the playbook's NEWEST version; an upgrade re-validates (P2 conflicts). */
export async function setAgencyLayer(tenantId: string, playbookId: string, raw: unknown, by: string): Promise<PlaybookAgencyLayer> {
  const latest = (await listVersions(tenantId, playbookId))[0];
  if (!latest) throw new OpenwopError('not_found', 'Publish a version of this playbook first.', 404, { playbookId });
  const layer = parseLayer(raw, latest, 'agencyLayer');
  const row: PlaybookAgencyLayer = { ...layer, key: `${tenantId}::${playbookId}`, tenantId, playbookId, updatedBy: by, updatedAt: new Date().toISOString() };
  await agencyLayers.put(row);
  return row;
}

/** D3 — is the installed workflow still what the install wrote? */
export async function installationDrift(row: PlaybookInstallation): Promise<InstallationDrift> {
  if (!row.workflowId || !row.expectedRevision) return 'missing';
  const owned = await getOwned(row.tenantId, row.workflowId);
  const def = owned ? await getRegisteredWorkflowAsync(row.workflowId) : null;
  if (!owned || !def || owned.archivedAt) return 'missing';
  return revisionHashOf(def) === row.expectedRevision ? 'none' : 'edited';
}

export async function getInstallation(tenantId: string, orgId: string, playbookId: string): Promise<PlaybookInstallation | null> {
  const row = await installs.get(installKey(tenantId, orgId, playbookId));
  return row && row.tenantId === tenantId && row.orgId === orgId ? row : null;
}

/** The installations for one client (a bounded prefix read, ADR 0959 P-G5). */
export async function listInstallations(tenantId: string, orgId: string): Promise<PlaybookInstallation[]> {
  return (await installs.listByPrefix(`${tenantId}::${orgId}::`)).filter((r) => r.tenantId === tenantId && r.orgId === orgId && r.status === 'installed');
}

/** The installation a workflow came from, or null. A point read for the run stamp. */
export async function installationForWorkflow(tenantId: string, workflowId: string): Promise<PlaybookInstallation | null> {
  const idx = await byWorkflow.get(indexKey(tenantId, workflowId));
  if (!idx || idx.tenantId !== tenantId) return null;
  const row = await getInstallation(tenantId, idx.orgId, idx.playbookId);
  if (row?.pendingUpgrade || row?.status === 'installing') throw new OpenwopError('conflict', 'Finish the pending playbook installation before starting this workflow.', 409, { reason: 'playbook_install_in_progress' });
  return row && row.status === 'installed' && row.workflowId === workflowId ? row : null;
}

async function claim(tenantId: string, orgId: string, playbookId: string, version: PlaybookVersion, by: string, now: Date, layersHash: string): Promise<PlaybookInstallation> {
  const key = installKey(tenantId, orgId, playbookId);
  const fresh: PlaybookInstallation = {
    key, tenantId, orgId, playbookId, status: 'installing', claimedAt: now.toISOString(),
    pinnedVersion: version.version, contentHash: version.contentHash, layers: {}, installedBy: by, history: [],
    workflowId: copyWorkflowId(version.entryChainId), layersHash,
  };
  if (await installs.putIfAbsent(fresh)) return fresh;
  const cur = await installs.get(key);
  // Retry only the SAME operation and its already-reserved random copy id.
  // A legacy claim with no id cannot prove what it wrote and needs review.
  if (cur?.status === 'installing' && cur.tenantId === tenantId && cur.contentHash === version.contentHash && cur.layersHash === layersHash
    && cur.workflowId && workflowIdOrigin(cur.workflowId) === 'copy') return cur;
  throw new OpenwopError('conflict', 'This playbook is already installed for this client. Upgrading an installation is a rollout.', 409, {
    orgId, playbookId, reason: cur?.status === 'installing' ? 'playbook_install_in_progress' : 'playbook_already_installed',
    ...(cur?.pinnedVersion ? { installedVersion: cur.pinnedVersion } : {}),
  });
}

export interface PreparedInstall {
  client: ConfigLayer;
  agency: ConfigLayer | undefined;
  params: Record<string, unknown>;
  slots: Record<string, SlotBinding>;
  resolve: PlaybookResolution;
  entry: WorkflowChain;
}

/**
 * Everything an install (or an upgrade, or a rollback) of `version` needs, validated, with NO
 * writes: the layers inside the version's policy, the merged values against its parameter
 * schema, and every sub-chain and slot binding resolved exactly. Throws the typed refusal a
 * rollout plan reports as a conflict.
 */
export async function prepareInstall(tenantId: string, version: PlaybookVersion, rawClient: unknown, agencyRow: ConfigLayer | null | undefined): Promise<PreparedInstall> {
  const client = parseClientLayer(rawClient, version);
  // Layer 1 is re-validated against THIS version (it was written against the newest).
  const agency = agencyRow ? parseLayer(agencyRow, version, 'agencyLayer') : undefined;
  const params = mergeLayers(version, client, agency);
  const validate = paramValidator(version);
  if (validate && !validate(params)) {
    throw new OpenwopError('validation_error', 'The playbook\'s values for this client do not satisfy its parameters.', 400, { reason: 'playbook_params_invalid', errors: (validate.errors ?? []).map((e) => ({ path: e.instancePath, message: e.message })) });
  }
  const entry = version.chains.find((c) => c.chainId === version.entryChainId);
  if (!entry) throw new OpenwopError('internal_error', 'The playbook version has no entry chain.', 500, { playbookId: version.playbookId });
  // D2 — resolve every sub-chain (and slot binding) exactly, before anything is written.
  const slots = mergeSlots(client, agency);
  const resolve = playbookResolution(tenantId, version, slots);
  const unresolved = await firstUnresolvedRef(resolve, entry);
  if (unresolved) throw new OpenwopError('validation_error', `Sub-chain "${unresolved}" does not resolve to an exact version this workspace or host has.`, 422, { code: 'sub_chain_unresolved', ref: unresolved });
  return { client, agency, params, slots, resolve, entry };
}

/**
 * D6.4/D6.5 — move an installation to `version` IN PLACE: the same workflowId, a new revision
 * (ADR 0474), the install row CAS'd with a history entry that records the layers it ran with
 * (so a rollback restores exactly them). `expectHead` is the head the caller planned against:
 * a head that moved since is `workflow_head_moved` (never clobber an edit nobody approved);
 * pass `null` to overwrite a detached copy the person chose to replace.
 */
export async function upgradeInstallation(input: {
  install: PlaybookInstallation; version: PlaybookVersion; prepared: PreparedInstall; expectHead: string | null; by: string; rolloutId?: string;
}): Promise<PlaybookInstallation> {
  const { install, version, prepared, by } = input;
  if (!install.workflowId) throw new OpenwopError('conflict', 'This installation has no workflow.', 409, { reason: 'playbook_install_missing' });
  const layers = {
    ...(prepared.agency && (Object.keys(prepared.agency.params).length || prepared.agency.slots) ? { agency: prepared.agency } : {}),
    ...(Object.keys(prepared.client.params).length || prepared.client.slots ? { client: prepared.client } : {}),
  };
  const layersHash = playbookHashOf({ params: prepared.params, slots: prepared.slots });
  const operationId = playbookHashOf({ key: install.key, from: install.expectedRevision, fromVersion: install.pinnedVersion,
    version: version.version, contentHash: version.contentHash, layersHash, expectHead: input.expectHead, rolloutId: input.rolloutId ?? null });
  const changed = (): OpenwopError => new OpenwopError('conflict', 'This installation changed while it was being upgraded. Retry the same operation after reloading.', 409, { reason: 'playbook_install_changed' });
  const made = await instantiateOwnedChain({
    tenantId: install.tenantId, chain: prepared.entry, params: prepared.params, createdBy: install.pendingUpgrade?.by ?? by, resolve: prepared.resolve,
    into: { workflowId: install.workflowId, expectHead: input.expectHead, resumeIdentical: true,
      beforeCommit: async (revision) => {
        for (let attempt = 0; attempt < 6; attempt++) {
          const cur = await installs.get(install.key);
          if (!cur || cur.tenantId !== install.tenantId || cur.status !== 'installed') throw changed();
          if (cur.history.some((h) => h.operationId === operationId)) throw changed();
          if (cur.pendingUpgrade) {
            if (cur.pendingUpgrade.operationId !== operationId || cur.pendingUpgrade.revision !== revision) throw changed();
            return;
          }
          if (cur.expectedRevision !== install.expectedRevision || cur.pinnedVersion !== install.pinnedVersion || cur.contentHash !== install.contentHash || cur.layersHash !== install.layersHash) throw changed();
          const pendingUpgrade = { operationId, version: version.version, contentHash: version.contentHash, layersHash, revision,
            expectHead: input.expectHead, layers, by, at: new Date().toISOString(), ...(input.rolloutId ? { rolloutId: input.rolloutId } : {}) };
          if (await installs.compareAndSwap(cur, { ...cur, pendingUpgrade })) return;
        }
        throw changed();
      },
    },
  });
  const revision = revisionHashOf(made.def);
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await installs.get(install.key);
    if (!cur || cur.tenantId !== install.tenantId) throw changed();
    if (cur.history.some((h) => h.operationId === operationId && h.revision === revision)) return cur;
    const pending = cur.pendingUpgrade;
    if (!pending || pending.operationId !== operationId || pending.revision !== revision) throw changed();
    const { pendingUpgrade: _pending, ...stable } = cur;
    const next: PlaybookInstallation = { ...stable, pinnedVersion: version.version, contentHash: version.contentHash,
      expectedRevision: revision, layers, layersHash,
      history: [...cur.history, { version: version.version, revision, at: pending.at, by: pending.by, layers, operationId,
        ...(pending.rolloutId ? { rolloutId: pending.rolloutId } : {}) }],
    };
    if (await installs.compareAndSwap(cur, next)) return next;
  }
  throw changed();
}

export async function installPlaybook(input: {
  tenantId: string; orgId: string; playbookId: string; version: string; clientLayer?: unknown; by: string;
}): Promise<PlaybookInstallation & { content: ContentApplyResult }> {
  const { tenantId, orgId, playbookId, by } = input;
  const version = await getVersion(tenantId, playbookId, input.version);
  if (!version) throw new OpenwopError('not_found', 'Playbook version not found.', 404, { playbookId, version: input.version });
  const { client, agency, params, slots, resolve, entry } = await prepareInstall(tenantId, version, input.clientLayer, await getAgencyLayer(tenantId, playbookId));

  const claimed = await claim(tenantId, orgId, playbookId, version, by, new Date(), playbookHashOf({ params, slots }));
  await byWorkflow.put({ key: indexKey(tenantId, claimed.workflowId!), tenantId, workflowId: claimed.workflowId!, orgId, playbookId });
  const subject = `campaign-playbooks:${orgId}:${playbookId}`;
  let made;
  try {
    made = await instantiateOwnedChain({
      tenantId,
      chain: entry,
      params,
      createdBy: by,
      reservedCopyId: claimed.workflowId,
      resolve,
      ...(WORKFLOW_SUBJECT_PATTERN.test(subject) ? { subject } : {}),
    });
  } catch (err) {
    // Keep the reserved id: a failed acknowledgement is not proof of no write.
    throw err;
  }
  const expectedRevision = revisionHashOf(made.def);
  await byWorkflow.put({ key: indexKey(tenantId, made.workflowId), tenantId, workflowId: made.workflowId, orgId, playbookId });
  const at = claimed.claimedAt;
  let installed: PlaybookInstallation = {
    ...claimed,
    status: 'installed',
    workflowId: made.workflowId,
    expectedRevision,
    layers: {
      ...(agency && (Object.keys(agency.params).length || agency.slots) ? { agency } : {}),
      ...(Object.keys(client.params).length || client.slots ? { client } : {}),
    },
    layersHash: playbookHashOf({ params, slots }),
    history: [{ version: version.version, revision: expectedRevision, at, by, layers: {
      ...(agency && (Object.keys(agency.params).length || agency.slots) ? { agency } : {}),
      ...(Object.keys(client.params).length || client.slots ? { client } : {}),
    } }],
  };
  let confirmed = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await installs.get(claimed.key);
    if (!cur || cur.tenantId !== tenantId || cur.workflowId !== made.workflowId || cur.contentHash !== version.contentHash || cur.layersHash !== installed.layersHash) break;
    if (cur.status === 'installed') { installed = cur; confirmed = true; break; }
    const next: PlaybookInstallation = { ...cur, status: 'installed', expectedRevision, layers: installed.layers,
      history: [{ version: version.version, revision: expectedRevision, at, by: cur.installedBy, layers: installed.layers }],
    };
    if (await installs.compareAndSwap(cur, next)) { installed = next; confirmed = true; break; }
  }
  if (!confirmed) {
    log.warn('playbook_install_claim_lost', { tenantId, orgId, playbookId, workflowId: made.workflowId });
    throw new OpenwopError('conflict', 'The installation changed; retry the same version and configuration to finish it.', 409, { orgId, playbookId, reason: 'playbook_install_in_progress' });
  }
  // D5 — content after the workflow; the installation stays installed either way, and a failed
  // item is retried idempotently through the content route.
  const content = await applyContent(installed, version, by);
  return { ...installed, content };
}

/** D6.3 — put a client in a rollout ring (or hold it). CAS on the installation row. */
export async function setInstallationRing(tenantId: string, orgId: string, playbookId: string, ring: unknown): Promise<PlaybookInstallation> {
  if (ring !== 'canary' && ring !== 'early' && ring !== 'general' && ring !== 'held') {
    throw new OpenwopError('validation_error', 'ring must be canary, early, general or held.', 400, { field: 'ring' });
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const cur = await getInstallation(tenantId, orgId, playbookId);
    if (!cur || cur.status !== 'installed') throw new OpenwopError('not_found', 'Installation not found.', 404, { orgId, playbookId });
    const next: PlaybookInstallation = { ...cur, ring };
    if (await installs.compareAndSwap(cur, next)) return next;
  }
  throw new OpenwopError('conflict', 'The installation changed; try again.', 409, { reason: 'playbook_install_changed' });
}

/** Every installed client of a playbook (one bounded tenant-slice read). */
export async function listPlaybookInstallations(tenantId: string, playbookId: string): Promise<PlaybookInstallation[]> {
  return (await installs.listForTenant(tenantId)).filter((r) => r.tenantId === tenantId && r.playbookId === playbookId && r.status === 'installed');
}

export const ringOf = (row: PlaybookInstallation): PlaybookRing => row.ring ?? 'general';

/** ADR 0464 — a person's erasure tombstones who installed; the installation stays. */
export async function eraseInstallers(tenantId: string, forms: ReadonlySet<string>, tombstone: string): Promise<number> {
  return (await redactRows(installs, tenantId, (r) => {
    const touches = forms.has(r.installedBy) || r.history.some((h) => forms.has(h.by)) || (r.pendingUpgrade !== undefined && forms.has(r.pendingUpgrade.by));
    return touches ? { ...r, ...(r.pendingUpgrade && forms.has(r.pendingUpgrade.by) ? { pendingUpgrade: { ...r.pendingUpgrade, by: tombstone } } : {}), installedBy: forms.has(r.installedBy) ? tombstone : r.installedBy, history: r.history.map((h) => (forms.has(h.by) ? { ...h, by: tombstone } : h)) } : null;
  })) + (await redactRows(agencyLayers, tenantId, (a) => forms.has(a.updatedBy) ? { ...a, updatedBy: tombstone } : null));
}
