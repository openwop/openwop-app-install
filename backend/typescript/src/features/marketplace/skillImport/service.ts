/**
 * ADR 1044 — SKILL.md import: read → scan → convert → validate → (install).
 *
 * Preview and install run the SAME pipeline; install additionally requires the
 * caller to name the source hash the preview returned and to acknowledge any
 * warnings, so an admin approves exactly the bytes they reviewed (D3).
 *
 * Install writes a tenant-owned user agent through `ensureUserAgentRegistered`
 * — the path the Agents tab create form's rows load through — never a pack
 * (D1/D2). Nothing in an import is executed.
 */

import type { Storage } from '../../../storage/storage.js';
import type { UserAgentRecord } from '../../../types.js';
import { builtinAgentToolIds } from '../../../host/agentToolProvider.js';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { alignHead } from '../../../host/userAgentRevisions.js';
import { ensureUserAgentRegistered } from '../../../routes/userAgents.js';
import { createLogger } from '../../../observability/logger.js';
import { isScriptFile, readSkillSource, type SkillImportInput, type SkillSource, type SourceFormat } from './bundle.js';
import { convertFrontmatter, type SkillManifest } from './convert.js';
import { parseFrontmatter, splitSkillMd } from './frontmatter.js';
import { refuse } from './refusal.js';
import { ruleReason, scanText, type ScanFinding } from './scan.js';

const log = createLogger('features.marketplace.skillImport');

/** The user-agent row's limits (routes/userAgents.ts). */
const ROW_DESCRIPTION_MAX = 280;
const ROW_PROMPT_MAX = 16_000;

export interface SkillPreview {
  sourceSha256: string;
  format: SourceFormat;
  /** The runtime id the install will create. */
  agentId: string;
  persona: string;
  description: string;
  toolAllowlist: string[];
  /** The portable, schema-validated Skill manifest. */
  manifest: SkillManifest;
  /** Never true: an imported skill has no publisher signature (ADR 1044 D3). */
  verified: false;
  warnings: ScanFinding[];
  ignored: string[];
  /** Bundled files that were scanned but are not installed. */
  notInstalled: string[];
}

/** Provenance of one installed import. No actor field: who imported it is in the
 *  audit log and in the agent's revision 0 (ADR 1014 D8). */
export interface ImportedSkillRow {
  id: string;
  tenantId: string;
  agentId: string;
  sourceSha256: string;
  format: SourceFormat;
  verified: false;
  role: 'skill';
  manifest: SkillManifest;
  ignored: string[];
  notInstalled: string[];
  acknowledgedWarnings: Array<Pick<ScanFinding, 'rule' | 'file' | 'line'>>;
  provenance: Record<string, string>;
  importedAt: string;
}

const imported = new DurableCollection<ImportedSkillRow>('marketplace:imported-skill', (r) => r.id, undefined, (r) => r.tenantId);
const rowId = (tenantId: string, agentId: string): string => `${tenantId}:${agentId}`;

/** The full pipeline, no writes. Throws `skill_import_refused` on any refusal. */
export async function analyseSkillImport(input: SkillImportInput, registeredTools: readonly string[] = builtinAgentToolIds()): Promise<SkillPreview & { provenance: Record<string, string> }> {
  const source: SkillSource = await readSkillSource(input);
  // A leading byte-order mark is an encoding marker, not hidden text.
  const skillMd = source.skillMd.replace(/^﻿/, '');

  // CHAN-P5-2 — scripts are refused before anything else is read from them.
  for (const f of source.others) {
    const why = isScriptFile(f);
    if (why) throw refuse('scripts_refused', `Bundled file "${f.path}" is refused because ${why}. Skills with scripts cannot be imported.`, { path: f.path });
  }

  // D4 — scan every text file. Any blocking finding refuses the import.
  const findings: ScanFinding[] = [];
  scanText('SKILL.md', skillMd, findings);
  for (const f of source.others) if (f.text !== undefined) scanText(f.path, f.text, findings);
  const blocking = findings.filter((f) => f.severity === 'block');
  if (blocking.length > 0) {
    const first = blocking[0]!;
    throw refuse('install_lure',
      `Refused: ${first.file} line ${first.line} ${ruleReason(first.rule)}. Imported skills may not ask anyone to download or run software.`,
      { findings: blocking });
  }

  const { yaml, yamlStartLine, body } = splitSkillMd(skillMd);
  const conversion = convertFrontmatter(parseFrontmatter(yaml, yamlStartLine), body, registeredTools);
  if (conversion.manifest.systemPrompt.length > ROW_PROMPT_MAX) {
    throw refuse('instructions_too_large', `The instructions are ${conversion.manifest.systemPrompt.length} characters; at most ${ROW_PROMPT_MAX} are allowed. They are never cut.`, { length: conversion.manifest.systemPrompt.length });
  }

  const notInstalled = source.others.map((f) => f.path).sort();
  const warnings = findings.filter((f) => f.severity === 'warn');
  if (notInstalled.length > 0) {
    warnings.push({ severity: 'warn', rule: 'bundled-files-not-installed', file: notInstalled[0]!, line: 0,
      excerpt: `${notInstalled.length} bundled file(s) are not installed; the agent cannot read them.` });
  }
  return {
    sourceSha256: source.sha256,
    format: source.format,
    agentId: `user.${conversion.name}`,
    persona: conversion.name,
    description: conversion.manifest.description,
    toolAllowlist: conversion.manifest.toolAllowlist,
    manifest: conversion.manifest,
    verified: false,
    warnings,
    ignored: conversion.ignored,
    notInstalled,
    provenance: conversion.provenance,
  };
}

export async function previewSkillImport(input: SkillImportInput): Promise<SkillPreview> {
  const { provenance: _provenance, ...preview } = await analyseSkillImport(input);
  return preview;
}

export interface InstallOptions {
  tenantId: string;
  userId: string;
  storage: Storage;
  expectedSha256: unknown;
  acknowledgeWarnings: unknown;
}

function cut(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Re-run the pipeline, check the approval, then write the tenant-owned agent. */
export async function installSkillImport(input: SkillImportInput, opts: InstallOptions): Promise<{ preview: SkillPreview; row: ImportedSkillRow }> {
  if (typeof opts.expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(opts.expectedSha256)) {
    throw refuse('source_changed', '`expectedSha256` is required: send the `sourceSha256` the preview returned.', {}, 400);
  }
  const analysed = await analyseSkillImport(input);
  const { provenance, ...preview } = analysed;
  if (preview.sourceSha256 !== opts.expectedSha256) {
    throw refuse('source_changed', 'The source differs from the one that was previewed. Preview it again.', { sourceSha256: preview.sourceSha256 }, 409);
  }
  if (preview.warnings.length > 0 && opts.acknowledgeWarnings !== true) {
    throw refuse('warnings_unacknowledged', `The preview had ${preview.warnings.length} warning(s). Review them and send \`acknowledgeWarnings: true\`.`, { warnings: preview.warnings }, 409);
  }
  if (await opts.storage.getUserAgent(opts.tenantId, preview.agentId)) {
    throw refuse('persona_exists', `An agent named "${preview.persona}" already exists in this workspace. Delete or rename it first.`, { agentId: preview.agentId }, 409);
  }

  const now = new Date().toISOString();
  const record: UserAgentRecord = {
    agentId: preview.agentId,
    tenantId: opts.tenantId,
    persona: preview.persona,
    label: preview.manifest.label,
    description: cut(preview.description, ROW_DESCRIPTION_MAX),
    modelClass: 'chat', // the user-agent enum; the portable manifest says 'general'
    systemPrompt: preview.manifest.systemPrompt,
    toolAllowlist: preview.toolAllowlist,
    memoryShape: { scratchpad: true, conversation: false, longTerm: false },
    createdAt: now,
  };
  await ensureUserAgentRegistered(opts.storage, record);
  await alignHead(record, opts.userId).catch((err: unknown) => {
    log.warn('skill_import_revision_failed', { agentId: record.agentId, error: err instanceof Error ? err.message : String(err) });
  });

  const row: ImportedSkillRow = {
    id: rowId(opts.tenantId, preview.agentId),
    tenantId: opts.tenantId,
    agentId: preview.agentId,
    sourceSha256: preview.sourceSha256,
    format: preview.format,
    verified: false,
    role: 'skill',
    manifest: preview.manifest,
    ignored: preview.ignored,
    notInstalled: preview.notInstalled,
    acknowledgedWarnings: preview.warnings.map((w) => ({ rule: w.rule, file: w.file, line: w.line })),
    provenance,
    importedAt: now,
  };
  await imported.put(row);
  await opts.storage.appendAudit({
    timestamp: now,
    principalId: opts.userId,
    action: 'marketplace.skill.imported',
    resource: `agent:${preview.agentId}`,
    outcome: 'success',
    payload: { tenantId: opts.tenantId, sourceSha256: preview.sourceSha256, format: preview.format, tools: preview.toolAllowlist, acknowledgedWarnings: row.acknowledgedWarnings.length, verified: false },
  }).catch((err: unknown) => log.error('skill_import_audit_failed', { agentId: preview.agentId, error: err instanceof Error ? err.message : String(err) }));
  log.info('skill_import_installed', { agentId: preview.agentId, format: preview.format });
  return { preview, row };
}

/** This tenant's imports whose agent still exists (a deleted agent's row is dropped). */
export async function listImportedSkills(tenantId: string, storage: Storage): Promise<ImportedSkillRow[]> {
  const rows = (await imported.listForTenant(tenantId)).filter((r) => r.tenantId === tenantId);
  const live: ImportedSkillRow[] = [];
  for (const r of rows) {
    if (await storage.getUserAgent(tenantId, r.agentId)) live.push(r);
    else await imported.delete(r.id).catch(() => undefined);
  }
  return live.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}
