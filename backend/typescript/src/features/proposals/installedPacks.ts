/**
 * ADR 1033 — the RFC 0253 pack installers, and the read that serves what they
 * installed (`getInstalledPack`).
 *
 * A proposed pack is a tenant's pack, not the host's: it is written to the tenant
 * store (`host/tenantInstalledPacks.ts`), never to the process-global chain map or
 * the pack directory, so it is visible to its tenant only and identical on every
 * instance. A chain pack's chains become templates in that tenant's gallery and
 * `from-chain`; an agent pack's agents become tenant-owned agents, exactly as
 * visible and dispatchable as the tenant's user-authored ones (P2).
 *
 * The rules at apply (RFC 0253 §C–§E), each refused before anything is written:
 *   - the artifact validates against its v2 manifest schema (422);
 *   - `name` starts with `private.` (422) and the artifact carries no `signing` (422);
 *   - chain pack: the chains pass the loader's own rules for chains that are not a
 *     host pack (`validateChainDocuments`: exact pins, sub-chain cycles, composition) (422);
 *   - agent pack: no `nodes`, `runtime.language: remote`, every agent in the pack's
 *     namespace with an inline `systemPrompt` and no tarball ref, held to the
 *     user-authored agent limits (prompt length, tool-allowlist size) (422);
 *   - a name, chain id or agent id the host owns, or that another pack installed
 *     in the tenant contributes, is `409 read-only`;
 *   - an equal or higher installed version is `409 version-not-greater`.
 *
 * The artifact is stored verbatim; the host-owned field set is empty, so nothing is
 * added to it (`proposal-no-resynthesis`). `runtime.entry` is never read.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { locateRepoSchemasDir } from '../../host/_repoPath.js';
import { semverCompare } from '../../host/promptStore.js';
import { hostOwnsChainId, hostOwnsChainPackName, validateChainDocuments } from '../../host/workflowChainPackLoader.js';
import {
  getTenantInstalledPack, listTenantInstalledPacks, projectInstalledPackAgents, swapTenantInstalledPack,
  type InstalledPackKind, type TenantInstalledPack,
} from '../../host/tenantInstalledPacks.js';
import { getAgentRegistry } from '../../executor/agentRegistry.js';
import { broadcastAgentEviction } from '../../host/agentRegistryEviction.js';
import { OpenwopError } from '../../types.js';
import type { InstalledArtifact, Proposal } from './types.js';
import type { ProposalInstaller } from './proposalsService.js';

/** The user-authored agent limits (`routes/userAgents.ts`): a proposed agent gets no more. */
const SYSTEM_PROMPT_MAX_LEN = 16_000;
const TOOL_ALLOWLIST_MAX_LEN = 32;

const SCHEMA_FILE: Record<InstalledPackKind, string> = {
  'workflow-chain-pack': 'workflow-chain-pack-manifest.schema.json',
  'agent-pack': 'node-pack-manifest.schema.json',
};
const validators = new Map<InstalledPackKind, ValidateFunction>();

function manifestValidator(kind: InstalledPackKind): ValidateFunction {
  const hit = validators.get(kind);
  if (hit) return hit;
  const dir = join(locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json'), 'v2');
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  let id: string | undefined;
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.schema.json'))) {
    const schema = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { $id?: string };
    if (typeof schema.$id !== 'string' || ajv.getSchema(schema.$id)) continue;
    ajv.addSchema(schema);
    if (name === SCHEMA_FILE[kind]) id = schema.$id;
  }
  const validate = id ? ajv.getSchema(id) : undefined;
  if (!validate) throw new Error(`${SCHEMA_FILE[kind]} did not compile`);
  validators.set(kind, validate);
  return validate;
}

/** RFC 0253 is on the wire once the vendored `proposal.schema.json` names `getInstalledPack`. */
let cachedWire: boolean | undefined;
export function rfc0253WireAvailable(): boolean {
  if (cachedWire !== undefined) return cachedWire;
  try {
    const dir = join(locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json'), 'v2');
    cachedWire = readFileSync(join(dir, 'proposal.schema.json'), 'utf8').includes('getInstalledPack');
  } catch {
    cachedWire = false;
  }
  return cachedWire;
}

function invalid(message: string, details: Record<string, unknown>): OpenwopError {
  return new OpenwopError('validation_error', message, 422, { field: 'artifact', ...details });
}

function installConflict(reason: 'read-only' | 'version-not-greater', message: string, packName: string): OpenwopError {
  return new OpenwopError('proposal_install_conflict', message, 409, { reason, packName });
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Schema, then the two rules both kinds share (RFC 0253 §C, §D). */
function checkCommon(kind: InstalledPackKind, manifest: Rec): { name: string; version: string } {
  const validate = manifestValidator(kind);
  if (!validate(manifest)) {
    const first = validate.errors?.[0];
    throw invalid(`The artifact is not a valid ${kind} manifest, so it cannot be installed.`, first ? { path: first.instancePath, rule: first.keyword } : {});
  }
  const name = manifest['name'] as string;
  if (!name.startsWith('private.')) {
    throw invalid(`A proposed pack must be named under private.*; '${name}' is not.`, { path: '/name', rule: 'private-namespace' });
  }
  if ('signing' in manifest) {
    throw invalid('A proposed pack cannot carry `signing`: it has no tarball or signature to verify.', { path: '/signing', rule: 'no-signing' });
  }
  return { name, version: manifest['version'] as string };
}

/** RFC 0253 §D for an agent pack: the manifest must be the whole artifact. */
function checkAgentPack(manifest: Rec, name: string): string[] {
  if (Array.isArray(manifest['nodes']) && manifest['nodes'].length > 0) {
    throw invalid('A proposed agent pack cannot carry `nodes`: there is no code to install them from.', { path: '/nodes', rule: 'no-nodes' });
  }
  if (!isRec(manifest['runtime']) || manifest['runtime']['language'] !== 'remote') {
    throw invalid('A proposed agent pack must set `runtime.language: "remote"`.', { path: '/runtime/language', rule: 'remote-runtime' });
  }
  const agents = Array.isArray(manifest['agents']) ? manifest['agents'] : [];
  if (agents.length === 0) throw invalid('A proposed agent pack must declare at least one agent.', { path: '/agents', rule: 'agents-required' });
  const ids: string[] = [];
  agents.forEach((raw, i) => {
    const a = isRec(raw) ? raw : {};
    const at = `/agents/${i}`;
    const agentId = typeof a['agentId'] === 'string' ? a['agentId'] : '';
    if (agentId !== name && !agentId.startsWith(`${name}.`)) {
      throw invalid(`Agent '${agentId}' is outside the pack's namespace '${name}'.`, { path: `${at}/agentId`, rule: 'agent-namespace' });
    }
    if (ids.includes(agentId)) throw invalid(`Agent '${agentId}' is declared twice.`, { path: `${at}/agentId`, rule: 'agent-unique' });
    ids.push(agentId);
    for (const ref of ['systemPromptRef', 'evalSuiteRef'] as const) {
      if (ref in a) throw invalid(`Agent '${agentId}' carries \`${ref}\`, a file this proposal cannot carry.`, { path: `${at}/${ref}`, rule: 'no-file-ref' });
    }
    const handoff = isRec(a['handoff']) ? a['handoff'] : {};
    for (const ref of ['taskSchemaRef', 'returnSchemaRef'] as const) {
      if (ref in handoff) throw invalid(`Agent '${agentId}' carries \`handoff.${ref}\`, a file this proposal cannot carry.`, { path: `${at}/handoff/${ref}`, rule: 'no-file-ref' });
    }
    const prompt = a['systemPrompt'];
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw invalid(`Agent '${agentId}' needs an inline \`systemPrompt\`.`, { path: `${at}/systemPrompt`, rule: 'inline-prompt' });
    }
    if (prompt.length > SYSTEM_PROMPT_MAX_LEN) {
      throw invalid(`Agent '${agentId}' has a \`systemPrompt\` over ${SYSTEM_PROMPT_MAX_LEN} characters.`, { path: `${at}/systemPrompt`, rule: 'prompt-length' });
    }
    if (Array.isArray(a['toolAllowlist']) && a['toolAllowlist'].length > TOOL_ALLOWLIST_MAX_LEN) {
      throw invalid(`Agent '${agentId}' lists more than ${TOOL_ALLOWLIST_MAX_LEN} tools.`, { path: `${at}/toolAllowlist`, rule: 'tool-allowlist-size' });
    }
  });
  return ids;
}

/** 409 read-only when another pack (host, or another installed in this tenant) owns the name or a contributed id. */
async function checkOwnership(kind: InstalledPackKind, tenant: string, name: string, manifest: Rec): Promise<void> {
  if (hostOwnsChainPackName(name) || getAgentRegistry().list().some((a) => a.ownerTenant === undefined && a.packName === name)) {
    throw installConflict('read-only', `'${name}' is a pack this host installed, which is read-only.`, name);
  }
  const others = (await listTenantInstalledPacks(tenant)).filter((r) => r.name !== name);
  if (kind === 'workflow-chain-pack') {
    const chainIds = (manifest['chains'] as Array<{ chainId: string }>).map((c) => c.chainId);
    const hostChain = chainIds.find(hostOwnsChainId);
    if (hostChain) throw installConflict('read-only', `Chain '${hostChain}' belongs to a pack this host installed.`, name);
    for (const other of others) {
      const taken = (Array.isArray(other.manifest['chains']) ? other.manifest['chains'] as Rec[] : []).find((c) => chainIds.includes(c['chainId'] as string));
      if (taken) throw installConflict('read-only', `Chain '${String(taken['chainId'])}' belongs to the installed pack '${other.name}'.`, name);
    }
    return;
  }
  // RFC 0253 §E — an agentId already resolvable in the tenant from another pack.
  for (const agentId of (manifest['agents'] as Rec[]).map((a) => a['agentId'] as string)) {
    const resolved = await getAgentRegistry().resolve(agentId, tenant);
    if (resolved && !(resolved.ownerTenant === tenant && resolved.packName === name)) {
      throw installConflict('read-only', `Agent '${agentId}' already exists in this workspace.`, name);
    }
  }
}

/** Make the registry match `next` for this pack (null = the pack is gone), on this
 *  instance now and on the others through eviction (they re-read the store). */
async function syncAgents(previous: TenantInstalledPack | null, next: TenantInstalledPack | null, tenant: string): Promise<void> {
  const registry = getAgentRegistry();
  const before = previous ? projectInstalledPackAgents(previous) : [];
  const after = next ? projectInstalledPackAgents(next) : [];
  for (const a of before) if (!after.some((b) => b.agentId === a.agentId)) registry.remove(a.agentId, tenant);
  for (const a of after) registry.register(a);
  for (const agentId of new Set([...before, ...after].map((a) => a.agentId))) {
    await broadcastAgentEviction(tenant, agentId).catch(() => undefined);
  }
}

function installerFor(kind: InstalledPackKind): ProposalInstaller {
  return {
    async install(tenant: string, proposal: Proposal) {
      const manifest = proposal.artifact;
      const { name, version } = checkCommon(kind, manifest);
      if (kind === 'workflow-chain-pack') {
        const problem = validateChainDocuments(manifest['chains']);
        if (problem) throw invalid(`The chains cannot be installed: ${problem.message}`, { path: '/chains', rule: problem.code });
      } else {
        checkAgentPack(manifest, name);
      }
      await checkOwnership(kind, tenant, name, manifest);

      const stored = await getTenantInstalledPack(tenant, name);
      if (stored && stored.kind !== kind) throw installConflict('read-only', `'${name}' is installed as a ${stored.kind}.`, name);
      if (stored && semverCompare(version, stored.version) <= 0) {
        throw installConflict('version-not-greater', `'${name}' already has version ${stored.version}; ${version} is not greater.`, name);
      }
      const next = { tenantId: tenant, name, kind, version, manifest, proposalId: proposal.id, installedAt: new Date().toISOString() };
      const undo = await swapTenantInstalledPack(stored, next);
      if (!undo) throw installConflict('version-not-greater', `'${name}' was installed concurrently.`, name);
      const row: TenantInstalledPack = { key: `${tenant}::${name}`, ...next };
      if (kind === 'agent-pack') await syncAgents(stored, row, tenant);
      const installedArtifact: InstalledArtifact = { kind, operationId: 'getInstalledPack', id: name, version };
      return {
        installedArtifactRef: `pack:${name}@${version}`,
        installedArtifact,
        rollback: async () => {
          await undo();
          if (kind === 'agent-pack') await syncAgents(row, stored, tenant);
        },
      };
    },
  };
}

export const workflowChainPackInstaller: ProposalInstaller = installerFor('workflow-chain-pack');
export const agentPackInstaller: ProposalInstaller = installerFor('agent-pack');

/** `getInstalledPack`: the pack installed in `tenant` under `name`, verbatim, or null. */
export async function installedPackManifest(tenant: string, name: string): Promise<Record<string, unknown> | null> {
  return (await getTenantInstalledPack(tenant, name))?.manifest ?? null;
}
