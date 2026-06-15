/**
 * Agent-platform portability (RFC 0098) — host-sample types.
 *
 * Wire shape mirrors `spec/v1/export-bundle.schema.json` (Active since PR #698).
 * An ExportBundle is **refs-only** — it carries entity references, never secret
 * values (`export-bundle-no-credential-material`). Import refuses any bundle
 * whose item payload carries a literal credential value, BEFORE applying.
 */

export type ExportKind = 'agent' | 'pack' | 'prompt-template' | 'connection-ref' | 'schedule' | 'roster' | 'org-chart';

export const EXPORT_KINDS: readonly ExportKind[] = [
  'agent',
  'pack',
  'prompt-template',
  'connection-ref',
  'schedule',
  'roster',
  'org-chart',
];

export interface ExportItem {
  kind: ExportKind;
  ref: string;
  dependsOn?: string[];
  payload: Record<string, unknown>;
}

export interface ExportBundle {
  bundleVersion: '1';
  source: { origin: string; exportedAt?: string; originPrincipal?: string | null };
  items: ExportItem[];
}

/** Dry-run plan — what an apply WOULD do; makes zero writes. */
export interface ImportPlan {
  dryRun: true;
  itemCount: number;
  byKind: Record<string, number>;
  order: string[]; // refs in dependency order
}

export interface ImportResult {
  dryRun: false;
  imported: number;
  refs: string[];
}
