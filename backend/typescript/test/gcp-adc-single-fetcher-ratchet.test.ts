/**
 * ADR 0904 P1b (D12, architect X1) — the single-fetcher ratchet. Four files used to
 * fetch the GCP metadata server independently (gcsBlob, certificationEvidence — the only
 * one that cached — the app-builder deploy adapter, runtime-posture); they now all go
 * through `host/gcpAdc.ts`. A fifth fails here. Sabotage: restore any caller's own
 * `computeMetadata/` URL ⇒ red.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Shrink-only. Each entry names the follow-up that removes it. */
const ALLOWLIST = new Set(['host/edgeCertificates/gcpCertificateManager.ts']);

describe('gcpAdc — the single-fetcher ratchet', () => {
  it('no src file other than host/gcpAdc.ts addresses the metadata server', () => {
    const root = join(__dirname, '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!/\.(ts|mts|js|mjs)$/.test(name)) continue;
        const rel = relative(root, p).split('\\').join('/');
        if (rel === 'host/gcpAdc.ts') continue;
        // TODO(ADR 0906 gcpAdc follow-up): the edge-certificate adapter (ADR 0906 P1, #4930)
        // landed with its own metadata fetch; build-0906-domains moves it onto gcpAdc in a
        // follow-up and REMOVES this entry. Shrink-only: no other path may be added here.
        if (ALLOWLIST.has(rel)) continue;
        // `computeMetadata/` is the API path; the bare hostname legitimately
        // appears in SSRF blocklists, so it is not the signal.
        if (readFileSync(p, 'utf8').includes('computeMetadata/')) offenders.push(rel);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
