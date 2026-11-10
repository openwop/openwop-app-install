/**
 * ADR 1044 — the ONE typed refusal for SKILL.md import. Every refusal is
 * `skill_import_refused` with a closed `reason`, so a caller (and a test) can
 * branch on the reason, and nothing is ever reported as success-with-empty.
 */

import { OpenwopError } from '../../../types.js';

export const SKILL_IMPORT_REASONS = [
  'source_missing',
  'source_ambiguous',
  'bundle_invalid',
  'bundle_too_large',
  'bundle_path_unsafe',
  'skill_md_missing',
  'frontmatter_invalid',
  'frontmatter_unknown_key',
  'name_invalid',
  'description_missing',
  'empty_instructions',
  'instructions_too_large',
  'scripts_refused',
  'hooks_refused',
  'install_lure',
  'installer_refused',
  'requirement_unmet',
  'tool_unknown',
  'tool_unavailable',
  'tool_not_grantable',
  'manifest_invalid',
  'persona_exists',
  'warnings_unacknowledged',
  'source_changed',
] as const;
export type SkillImportReason = (typeof SKILL_IMPORT_REASONS)[number];

export function refuse(
  reason: SkillImportReason,
  message: string,
  details: Record<string, unknown> = {},
  status = 422,
): OpenwopError {
  return new OpenwopError('skill_import_refused', message, status, { reason, ...details });
}
