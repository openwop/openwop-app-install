/**
 * RFC 0028 §A reference implementation — in-memory PromptStore backing
 * the `/v1/prompts*` REST surface.
 *
 * Splits templates into two layers:
 *   - **host** — immutable, loaded from
 *     `conformance-fixtures/prompt-templates/`
 *     at boot. These satisfy `listPromptTemplates` + `getPromptTemplate`
 *     against the host's built-in catalog. Carry `meta.source: 'host'`.
 *     Cannot be deleted or updated via the REST surface (403).
 *   - **user** — mutable, created at run time via `POST /v1/prompts`.
 *     Carry `meta.source: 'user'`. Mutable iff
 *     `capabilities.prompts.mutableLibrary: true`.
 *
 * Pack-sourced templates (`meta.source: 'pack'`) require the pack-
 * install flow per RFC 0028 §B — that's a separate slice; this module
 * leaves a `packTemplates` slot that the pack-install path can populate.
 *
 * ADR 0993 D5 — the `user` layer is NOT here any more. It was a process-global
 * map, so tenants shared it and it vanished on restart; user templates now live
 * in `tenantPromptTemplates.ts` (durable, tenant-keyed). This module keeps only
 * the GLOBAL, immutable layers (host fixtures, packs, chain-minted), which is
 * why `getTemplate` can stay synchronous.
 *
 * Persistence (global layers): in-memory only. State wipes on process restart, matching
 * the workflow-engine sample's "non-durable" posture for every host
 * surface (see ARCHITECTURE.md §"Path to real backends"). Production
 * hosts swap this module for a storage-adapter-backed implementation.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { locateRepoDir } from './_repoPath.js';

/** Mirror of PromptKind from schemas/prompt-kind.schema.json. */
export type PromptKind = 'system' | 'user' | 'few-shot' | 'schema-hint';

/** Mirror of PromptTemplate from schemas/prompt-template.schema.json. */
export interface PromptTemplate {
  templateId: string;
  version: string;
  kind: PromptKind;
  text: string;
  name?: string;
  description?: string;
  variables?: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    required: boolean;
    source?: 'input' | 'variable' | 'secret' | 'context';
    extractPath?: string;
    defaultValue?: unknown;
    description?: string;
    /** RFC 0124 §Security — secret-class marking carried from a chain param's
     *  `x-openwop-sensitive` hint through the G3 inline-body lift. A `sensitive`
     *  variable redacts to `[REDACTED:<id>]` in `prompt.composed` (SR-1). */
    sensitive?: boolean;
  }>;
  modelHints?: {
    modelClass?: string;
    temperature?: number;
    maxTokens?: number;
    envelopeType?: string;
  };
  tags?: string[];
  meta?: {
    author?: string;
    createdAt?: string;
    updatedAt?: string;
    source?: 'host' | 'pack' | 'user';
    packName?: string;
    packVersion?: string;
  };
}

interface StoredTemplate {
  template: PromptTemplate;
  /** SHA-256 of the canonical body — used for ETag generation. */
  etag: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// Locate the `conformance-fixtures/prompt-templates/`
// dir under both source-tree and esbuild-bundled layouts. The prior
// `join(__filename, '..' × 5, 'conformance-fixtures', 'prompt-templates')`
// pattern resolved correctly under the source tree but landed at
// `apps/conformance-fixtures/prompt-templates` under the bundled tree
// (which doesn't exist), so `existsSync(FIXTURES_DIR)` returned false,
// templates never loaded, and `getTemplate()` returned undefined for
// every host-built-in template — silently breaking all `prompt.composed`
// event emission for the conformance fixtures that target host templates.
// See commit d09d99c + the prompt-composed gap close-out (2026-05-23).
const FIXTURES_DIR = join(
  locateRepoDir(
    __dirname,
    'conformance-fixtures',
    'prompt-templates/conformance-prompt-writer-system.json',
  ),
  'prompt-templates',
);

// Layered storage (global only — ADR 0993 D5). Lookup precedence: pack → host.
const hostTemplates = new Map<string, StoredTemplate>();
const packTemplates = new Map<string, StoredTemplate>();

let initialized = false;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function buildStored(template: PromptTemplate): StoredTemplate {
  return { template, etag: sha256(JSON.stringify(template)) };
}

/** Boot-time loader. Reads every JSON fixture under
 *  `conformance-fixtures/prompt-templates/` and registers it as a
 *  host-source template. Idempotent. */
export function ensurePromptStoreInitialized(): void {
  if (initialized) return;
  initialized = true;
  if (!existsSync(FIXTURES_DIR)) return;
  for (const f of readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'))) {
    const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, f), 'utf8')) as PromptTemplate;
    // Force meta.source: 'host' regardless of what the fixture
    // declares — the fixtures live in the host's library.
    const template: PromptTemplate = {
      ...raw,
      meta: { ...(raw.meta ?? {}), source: 'host' },
    };
    hostTemplates.set(template.templateId, buildStored(template));
  }
}

export interface ListFilter {
  kind?: PromptKind;
  tag?: string;
  modelClass?: string;
  source?: 'host' | 'pack' | 'user';
}

/** List the GLOBAL templates matching the supplied filter (tenant templates: `tenantPromptTemplates`). */
export function listTemplates(filter: ListFilter = {}): PromptTemplate[] {
  ensurePromptStoreInitialized();
  const candidates: PromptTemplate[] = [];
  for (const entry of packTemplates.values()) candidates.push(entry.template);
  for (const entry of hostTemplates.values()) candidates.push(entry.template);
  return candidates.filter((t) => applyFilter(t, filter));
}

/** Exported for the RFC 0249 installed layer, which lists through the same filter (ADR 0972 D4). */
export function applyFilter(t: PromptTemplate, f: ListFilter): boolean {
  if (f.kind && t.kind !== f.kind) return false;
  if (f.tag && !(t.tags ?? []).includes(f.tag)) return false;
  if (f.modelClass && t.modelHints?.modelClass !== f.modelClass) return false;
  if (f.source && t.meta?.source !== f.source) return false;
  return true;
}

export function semverCompare(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}


export interface GetResult {
  template: PromptTemplate;
  etag: string;
  source: 'host' | 'pack' | 'user';
}

/** Fetch a single GLOBAL template by templateId (host fixtures, chain mints,
 *  packs). A reference made from inside a tenant resolves through
 *  `tenantPromptTemplates.resolveTenantTemplate`, never this alone. Optional `version` pins;
 *  optional `libraryId` disambiguates when multiple installed packs
 *  ship the same templateId. Returns `null` when not found,
 *  `'ambiguous'` when multiple matches require disambiguation. */
export function getTemplate(
  templateId: string,
  opts: { version?: string; libraryId?: string } = {},
): GetResult | null | 'ambiguous' {
  ensurePromptStoreInitialized();
  // Pack layer first — multiple packs MAY ship the same templateId;
  // libraryId disambiguates.
  const packMatches: StoredTemplate[] = [];
  for (const entry of packTemplates.values()) {
    if (entry.template.templateId !== templateId) continue;
    if (opts.version && entry.template.version !== opts.version) continue;
    if (opts.libraryId && entry.template.meta?.packName !== opts.libraryId) continue;
    packMatches.push(entry);
  }
  if (packMatches.length > 1) return 'ambiguous';
  if (packMatches.length === 1) {
    const e = packMatches[0]!;
    return { template: e.template, etag: e.etag, source: 'pack' };
  }
  // Host layer last.
  const host = hostTemplates.get(templateId);
  if (host) {
    if (opts.version && host.template.version !== opts.version) return null;
    return { template: host.template, etag: host.etag, source: 'host' };
  }
  return null;
}

/**
 * RFC 0124 G3 — register a host-resident PromptTemplate MINTED at chain expansion
 * (the inline-prompt-body lift: an inline `config.systemPrompt` carrying a
 * `{{params.x}}` is lifted into a template whose `text` holds a `{{varName}}` slot,
 * and the node points a `*PromptRef` at it). Idempotent + deterministic: the
 * template id is derived from (chainId, expansionId, node, kind), so re-expanding
 * the same chain+params re-mints byte-identically — a second call with the same id
 * is a no-op rather than a duplicate/conflict. Host layer (not user/pack): the
 * minted template is host-owned, matching how `getTemplate` resolves a `prompt:<id>`
 * ref. Returns true if newly registered, false if the id already existed.
 */
export function registerMintedTemplate(template: PromptTemplate): boolean {
  ensurePromptStoreInitialized();
  if (hostTemplates.has(template.templateId)) return false; // deterministic re-mint → no-op
  hostTemplates.set(template.templateId, buildStored({
    ...template,
    meta: { ...(template.meta ?? {}), source: 'host' },
  }));
  return true;
}

/**
 * RFC 0124 G3 — re-register the PromptTemplates a deferred-mode workflow carries on
 * `metadata.mintedPromptTemplates` (self-containment) into the host store. The mint
 * at `from-chain` time only populated the EXPANDING instance's in-memory Map; a run
 * may execute on a different instance (Cloud Run is multi-instance) or after a
 * restart, so run-start MUST re-register them or the lifted `*PromptRef` resolves to
 * nothing and the prompt body composes empty. Idempotent per templateId. Tolerant of
 * a malformed/absent field (returns silently) so it is safe to call for every run.
 */
export function ensureMintedTemplatesRegistered(metadata: unknown): void {
  const minted = (metadata as { mintedPromptTemplates?: unknown } | null | undefined)?.mintedPromptTemplates;
  if (!Array.isArray(minted)) return;
  for (const t of minted) {
    if (t && typeof t === 'object' && typeof (t as PromptTemplate).templateId === 'string') {
      registerMintedTemplate(t as PromptTemplate);
    }
  }
}

/** Is `templateId` owned by an immutable GLOBAL layer (host fixture, chain mint
 *  or pack)? The tenant writer refuses these ids (ADR 0993 D5). */
export function isGlobalTemplateId(templateId: string): boolean {
  ensurePromptStoreInitialized();
  return hostTemplates.has(templateId) || packMatchesId(templateId);
}

function packMatchesId(templateId: string): boolean {
  for (const entry of packTemplates.values()) {
    if (entry.template.templateId === templateId) return true;
  }
  return false;
}

/** Pack-install hook (used by the future RFC 0028 §B install flow).
 *  Validates that templates the pack ships don't already exist as
 *  host-source (host-built-ins win that namespace collision). Caller
 *  supplies the pack metadata stamps (packName, packVersion) so each
 *  template's `meta.source: 'pack'` provenance is correctly populated. */
export function installPackTemplates(
  templates: PromptTemplate[],
  packName: string,
  packVersion: string,
): { installed: number; rejected: string[] } {
  ensurePromptStoreInitialized();
  const rejected: string[] = [];
  let installed = 0;
  for (const t of templates) {
    if (hostTemplates.has(t.templateId)) {
      rejected.push(`${t.templateId} (collides with host built-in)`);
      continue;
    }
    const stamped: PromptTemplate = {
      ...t,
      meta: {
        ...(t.meta ?? {}),
        source: 'pack',
        packName,
        packVersion,
      },
    };
    // Pack-source key uses `<packName>:<templateId>@<version>` so two
    // packs MAY ship the same templateId without colliding.
    packTemplates.set(`${packName}:${t.templateId}@${t.version}`, buildStored(stamped));
    installed++;
  }
  return { installed, rejected };
}
