/**
 * ADR 0958 D5 — the upload scan port: a malware/virus scanner for bytes an
 * OUTSIDER sends in (vendor asset intake). A port with a "not configured"
 * default, because choosing and paying for a scanner is an open user decision
 * (ADR 0958 Q2).
 *
 * The verdicts, and what a caller must do with each:
 *  - `clean`          — the scanner looked and found nothing.
 *  - `infected`       — refuse the upload. Never store it.
 *  - `error`          — the scanner was configured and failed: refuse (fail
 *                       closed). A scan that did not happen is never a pass.
 *  - `not_configured` — no scanner. Since ADR 0958 Q2 was decided, an outsider
 *                       upload REFUSES this (`scannerRequiredButMissing`) unless
 *                       the development waiver is set; under the waiver the
 *                       caller's narrow type allowlist is the only guard, and it
 *                       MUST stay narrow (raster images, PDF, video; no archives,
 *                       executables, markup).
 *
 * Host layer: it imports no feature. A deployment registers a scanner at boot.
 *
 * @see docs/adr/0958-vendor-and-guest-collaboration.md
 */
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.uploadScan');

export type UploadScanVerdict = 'clean' | 'infected' | 'not_configured' | 'error';

export interface UploadScanner {
  /** Scan these bytes. Resolve `clean` or `infected`; throw on any failure. */
  scan(input: { tenantId: string; contentType: string; bytes: Buffer }): Promise<'clean' | 'infected'>;
}

let scanner: UploadScanner | null = null;

/** Boot seam: register the deployment's scanner (`null` clears it, for tests). */
export function registerUploadScanner(s: UploadScanner | null): void {
  scanner = s;
}

export function isUploadScannerConfigured(): boolean {
  return scanner !== null;
}

/**
 * ADR 0958 Q2 (decided 2026-10-26: a self-hosted ClamAV, required before any real
 * tenant takes outsider uploads). A caller that takes outsider bytes refuses them
 * while no scanner is configured, UNLESS this explicit waiver is set. The waiver is
 * for development and tests only: never set it where real vendors upload.
 */
export function unscannedUploadsWaived(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENWOP_UPLOAD_SCAN_OPTIONAL === 'true';
}

/** Whether an outsider upload may proceed with no scanner (the waiver), else refuse. */
export function scannerRequiredButMissing(env: NodeJS.ProcessEnv = process.env): boolean {
  return scanner === null && !unscannedUploadsWaived(env);
}

/** Scan once. Never throws: a scanner fault is the `error` verdict. */
export async function scanUpload(input: { tenantId: string; contentType: string; bytes: Buffer }): Promise<UploadScanVerdict> {
  if (!scanner) return 'not_configured';
  try {
    const v = await scanner.scan(input);
    return v === 'clean' ? 'clean' : 'infected';
  } catch (err) {
    log.warn('upload_scan_failed', { tenantId: input.tenantId, error: err instanceof Error ? err.message : String(err) });
    return 'error';
  }
}
