/**
 * Code-export orchestrator (ADR 0173 Phase 1). Reads a `canvas.app-builder` state,
 * generates framework-native source (`./generators.ts`), applies the export-security
 * discipline (secret scrub + file/size caps — the MyndHyve `exportSecurity` posture),
 * zips server-side, and stores the ZIP as a **Media asset** (bytes never leave the
 * host byte-store; the caller gets an unguessable capability token served by the
 * existing `/assets/:token`). NOT a run — a synchronous host-extension transform.
 *
 * @see docs/adr/0173-code-export-multi-framework.md
 */

import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../../types.js';
import { storeMediaAsset } from '../../../host/inMemorySurfaces.js';
import { scrubSecretShaped } from '../../../host/redactSecrets.js';
import { generate, EXPORT_TARGETS, type ExportTarget, type AppModel, type ComponentNode } from './generators.js';
import { preflightExport, type PreflightNote } from './preflight.js';
import { generateOpenApi } from './openapiGen.js';
import { generateBackend } from './backendGen.js';

// Export-security caps (parity with MyndHyve exportSecurity: 500 files / 50 MB, tightened
// for the reference host). A generated bundle over the caps fails closed.
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024; // 5 MiB of generated source
const EXPORT_TTL_SECONDS = 60 * 60; // 1h — a download handle, not durable storage

export interface ExportResult {
  assetToken: string;
  serveUrl: string;
  fileName: string;
  fileCount: number;
  sizeBytes: number;
  warnings: string[];
  /** ADR 0348 6b — what this target will NOT carry from the design. */
  preflight: PreflightNote[];
  /** ADR 0348 6c — sha256 of the ZIP (the durable lineage identity). */
  hash: string;
}

export function isExportTarget(v: unknown): v is ExportTarget {
  return typeof v === 'string' && (EXPORT_TARGETS as readonly string[]).includes(v);
}

/** Coerce an opaque canvas `state` into the generator's AppModel, validating the
 *  minimal shape (name + at least one screen). Rejects a non-app-builder canvas. */
function toAppModel(state: unknown): AppModel {
  const s = (state ?? {}) as Record<string, unknown>;
  const name = typeof s.name === 'string' && s.name.trim() ? s.name.trim() : '';
  const screensRaw = Array.isArray(s.screens) ? s.screens : [];
  if (!name || screensRaw.length === 0) {
    throw new OpenwopError('invalid_request', 'This canvas is not an exportable app design (needs `name` + at least one screen).', 422);
  }
  const screens = screensRaw.map((raw, i) => {
    const sc = (raw ?? {}) as Record<string, unknown>;
    return {
      id: typeof sc.id === 'string' && sc.id ? sc.id : `screen-${i + 1}`,
      name: typeof sc.name === 'string' && sc.name ? sc.name : `Screen ${i + 1}`,
      ...(typeof sc.route === 'string' ? { route: sc.route } : {}),
      ...(sc.isInitial === true ? { isInitial: true } : {}),
      components: Array.isArray(sc.components) ? (sc.components as ComponentNode[]) : [],
    };
  });
  // Grade data-F2: pass data sources + theme colors through — the generators
  // read both (expandBindings / themeCss), so dropping them here silently
  // divorced every export from the preview (mustache text + stock theme).
  const HEX = /^#[0-9a-fA-F]{6}$/;
  const tc = (s.themeColors ?? {}) as Record<string, unknown>;
  const themeColors = {
    ...(typeof tc.primary === 'string' && HEX.test(tc.primary) ? { primary: tc.primary } : {}),
    ...(typeof tc.secondary === 'string' && HEX.test(tc.secondary) ? { secondary: tc.secondary } : {}),
  };
  const dataSources = (Array.isArray(s.dataSources) ? s.dataSources : []).slice(0, 20).flatMap((raw) => {
    const d = (raw ?? {}) as Record<string, unknown>;
    if (typeof d.id !== 'string' || !d.id) return [];
    return [{
      id: d.id,
      name: typeof d.name === 'string' && d.name ? d.name : d.id,
      ...(Array.isArray(d.fields) ? { fields: d.fields.filter((f): f is string => typeof f === 'string').slice(0, 20) } : {}),
      ...(Array.isArray(d.rows) ? { rows: d.rows.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object').slice(0, 10) } : {}),
    }];
  });
  return {
    name,
    ...(typeof s.description === 'string' ? { description: s.description } : {}),
    ...(s.theme === 'light' || s.theme === 'dark' || s.theme === 'default' ? { theme: s.theme } : {}),
    ...(Object.keys(themeColors).length ? { themeColors } : {}),
    ...(dataSources.length ? { dataSources } : {}),
    screens,
  };
}

/**
 * Generate + scrub + cap a canvas's source (ADR 0305 Phase G extraction) — the
 * ONE export-security step shared by the ZIP export (below) and the GitHub
 * publish (`../publishService.ts`), so the scrub/caps can never diverge between
 * the two delivery paths. Fails closed on the file/size caps.
 */
export function generateScrubbed(state: unknown, target: ExportTarget): { app: AppModel; files: { path: string; content: string }[]; warnings: string[]; preflight: PreflightNote[] } {
  const app = toAppModel(state);
  const { files, warnings } = generate(target, app);
  // ADR 0348 6d — the design's API contract ships WITH the code when declared.
  const openapi = generateOpenApi((state ?? {}) as Record<string, unknown>);
  if (openapi) files.push({ path: 'openapi.json', content: JSON.stringify(openapi, null, 2) + '\n' });
  // ADR 0423 (6e, DECIDE-2 ratified) — the generated backend ships WITH the
  // code when operations are declared, same rule as the contract above.
  files.push(...generateBackend((state ?? {}) as Record<string, unknown>));
  // ADR 0348 6b — what this target drops, stated up front (never silently).
  const preflight = preflightExport((state ?? {}) as Record<string, unknown>, target);
  if (files.length > MAX_FILES) {
    throw new OpenwopError('validation_error', `Export exceeds the ${MAX_FILES}-file cap.`, 413, { fileCount: files.length, max: MAX_FILES });
  }
  let total = 0;
  const scrubbedFiles = files.map((f) => {
    // Scrub any secret-shaped token a user typed into a text prop before it lands in
    // downloadable/pushed source (the export-security invariant); then account + cap size.
    const scrubbed = scrubSecretShaped(f.content);
    total += Buffer.byteLength(scrubbed, 'utf8');
    if (total > MAX_TOTAL_BYTES) {
      throw new OpenwopError('validation_error', `Generated source exceeds the ${Math.floor(MAX_TOTAL_BYTES / (1024 * 1024))} MiB cap.`, 413, { max: MAX_TOTAL_BYTES });
    }
    return { path: sanitizePath(f.path), content: scrubbed };
  });
  return { app, files: scrubbedFiles, warnings, preflight };
}

/**
 * Generate + scrub + zip a canvas into a downloadable Media asset. Returns the
 * capability token (served by `/assets/:token`) + a warnings list (unmapped
 * components etc.). Fails closed on the file/size caps.
 */
export async function exportCanvas(tenantId: string, state: unknown, target: ExportTarget, opts?: { strict?: boolean }): Promise<ExportResult> {
  const { app, files, warnings, preflight } = generateScrubbed(state, target);
  // ADR 0348 6b — explicit strict mode: refuse to generate output that drops
  // declared design semantics (the default stays warn-and-generate).
  if (opts?.strict && preflight.length) {
    throw new OpenwopError('validation_error', `Strict export: ${preflight[0]!.message}`, 422, { preflight });
  }
  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.content);
  const contentBase64 = await zip.generateAsync({ type: 'base64' });
  const hash = createHash('sha256').update(Buffer.from(contentBase64, 'base64')).digest('hex');
  const stored = await storeMediaAsset(tenantId, { contentBase64, contentType: 'application/zip', ttlSeconds: EXPORT_TTL_SECONDS });
  return {
    assetToken: stored.token,
    serveUrl: stored.url,
    fileName: `${slug(app.name)}-${target}.zip`,
    fileCount: files.length,
    sizeBytes: stored.bytes,
    warnings,
    preflight,
    hash,
  };
}

/** Defensive path sanitization — the generators produce known paths, but never let a
 *  path escape the zip root (no absolute / traversal), matching MyndHyve's filename guard. */
function sanitizePath(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter((seg) => seg && seg !== '.' && seg !== '..').join('/') || 'file.txt';
}
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'app';
}
