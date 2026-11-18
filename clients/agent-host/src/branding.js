// ADR 1136 P2b — a white-label build of the companion ships a `branding.json`
// beside this package (for example MyndHyve's): its product name and default
// host, so `pair` needs no --host and the prompts name the right product.
// Absent or unreadable, nothing changes: the stock companion asks for --host.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRANDING = join(dirname(fileURLToPath(import.meta.url)), '..', 'branding.json');

/** @returns {{ productName?: string, defaultHost?: string }} */
export function brandedDefaults(path = BRANDING) {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const out = {};
    if (typeof raw.productName === 'string' && raw.productName.trim()) out.productName = raw.productName.trim().slice(0, 80);
    if (typeof raw.defaultHost === 'string' && /^https:\/\/[^/\s]+$/i.test(raw.defaultHost.trim())) out.defaultHost = raw.defaultHost.trim();
    return out;
  } catch {
    return {};
  }
}
