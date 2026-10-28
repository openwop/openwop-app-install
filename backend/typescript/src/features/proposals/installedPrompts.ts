/**
 * ADR 0972 D4/D5 — the `prompt-template` installer for RFC 0249 phase 1, and the
 * tenant-scoped layer it installs into.
 *
 * `host/promptStore.ts` is in-memory and process-global, so a template installed
 * there would be served to every tenant, and on a second Cloud Run instance to
 * nobody (ADR 0938 boundaries audit). Installed templates therefore live in a
 * durable layer keyed by tenant: since ADR 0993 D5 that is the ONE tenant layer of
 * the prompt store (`host/tenantPromptTemplates.ts`), which `POST /v1/prompts` also
 * writes and every tenant-scoped reader (REST, dispatch, the library) resolves.
 *
 * The installer writes `proposal.artifact` verbatim; the only host-owned addition is
 * `meta.source`, and `meta` is the one field RFC 0249 §D excludes from the
 * byte-match. Nothing here can synthesize or rewrite an artifact
 * (`proposal-no-resynthesis`).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { locateRepoSchemasDir } from '../../host/_repoPath.js';
import { semverCompare, type PromptTemplate } from '../../host/promptStore.js';
import { installTenantVersion, latestTenantVersion, tenantTemplateReservedReason } from '../../host/tenantPromptTemplates.js';
import { OpenwopError } from '../../types.js';
import type { InstalledArtifact, Proposal } from './types.js';
import type { ProposalInstaller } from './proposalsService.js';

// ADR 0993 D5 — the tenant layer this installer writes is now THE tenant layer of
// the prompt store (`host/tenantPromptTemplates.ts`), shared with `POST`/`PUT
// /v1/prompts`. It used to be a collection declared here and read only by the
// REST doors, so an installed template was listed but never usable at dispatch.

// ── the installer (ADR 0972 D5) ──────────────────────────────────────────────

let validator: ValidateFunction | null = null;

function templateValidator(): ValidateFunction {
  if (validator) return validator;
  const dir = join(locateRepoSchemasDir(dirname(fileURLToPath(import.meta.url)), 'ai-envelope.schema.json'), 'v2');
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  // Every v2 schema by its `$id`, so `prompt-template`'s cross-file refs
  // (`ids.schema.json#/$defs/templateId`, `prompt-kind`, …) resolve.
  let templateId: string | undefined;
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.schema.json'))) {
    const schema = JSON.parse(readFileSync(join(dir, name), 'utf8')) as { $id?: string };
    if (typeof schema.$id !== 'string' || ajv.getSchema(schema.$id)) continue;
    ajv.addSchema(schema);
    if (name === 'prompt-template.schema.json') templateId = schema.$id;
  }
  validator = templateId ? ajv.getSchema(templateId) ?? null : null;
  if (!validator) throw new Error('prompt-template.schema.json did not compile');
  return validator;
}

function installConflict(reason: 'read-only' | 'version-not-greater', message: string, templateId: string): OpenwopError {
  return new OpenwopError('proposal_install_conflict', message, 409, { reason, templateId });
}

export const promptTemplateInstaller: ProposalInstaller = {
  async install(tenant: string, proposal: Proposal) {
    const validate = templateValidator();
    if (!validate(proposal.artifact)) {
      const first = validate.errors?.[0];
      throw new OpenwopError('validation_error', 'The artifact is not a valid prompt template, so it cannot be installed.', 422, {
        field: 'artifact', ...(first ? { path: first.instancePath, rule: first.keyword } : {}),
      });
    }
    const template = proposal.artifact as unknown as PromptTemplate;
    const { templateId, version } = template;

    const reserved = tenantTemplateReservedReason(templateId);
    if (reserved) throw installConflict('read-only', `'${templateId}' is a host or pack template, which is read-only.`, templateId);
    const stored = await latestTenantVersion(tenant, templateId);
    if (stored !== null && semverCompare(version, stored) <= 0) {
      throw installConflict('version-not-greater', `'${templateId}' already has version ${stored}; ${version} is not greater.`, templateId);
    }
    const out = await installTenantVersion(tenant, template);
    if (!out.ok) {
      throw installConflict('version-not-greater', `'${templateId}@${version}' was installed concurrently.`, templateId);
    }
    const { rollback } = out;
    const installedArtifact: InstalledArtifact = { kind: 'prompt-template', operationId: 'getPromptTemplate', id: templateId, version };
    return {
      installedArtifactRef: `prompt:${templateId}@${version}`,
      installedArtifact,
      rollback: async () => { await rollback?.(); },
    };
  },
};

// ADR 0972 D9 — the wire check lives in `host/rfc0249Wire.ts` (the scope list reads it too).
export { rfc0249WireAvailable, resetRfc0249WireCache } from '../../host/rfc0249Wire.js';
