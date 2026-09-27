import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Deep-link guard (ADR 0336 §2 / §4). Every notification `actionUrl` MUST resolve
 * to the SPECIFIC entity — a query param or an interpolated id path segment —
 * never a bare multi-entity parent tab (which drops the id and dumps the user on
 * a list to re-scan). This scans every emit site so a NEW entity notification
 * that regresses to `actionUrl: '/commerce'` fails the build.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

// Bare paths to these multi-entity tabs lose the entity id. Resolver / landing
// pages (`/inbox`, `/assistant/briefing`) are intentionally NOT here — their
// context is inline or single-purpose (ADR 0336 §2).
// MAINTENANCE: when a new top-level multi-entity tab/section is added to the SPA
// nav, append its path here so a bare actionUrl to it is caught (the guard is a
// denylist — it can only flag tabs it knows about). This is a floor, not a
// ceiling: `/commerce?tab=orders` (a query but no id) passes but is still weak —
// static analysis can't verify a specific entity is named.
const PARENT_TABS = new Set([
  '/commerce', '/campaigns', '/boards', '/crm', '/agents', '/workforces',
  '/territories', '/dealers', '/kb', '/media', '/documents', '/notebooks',
  '/marketplace', '/production', '/strategy', '/priority-matrix', '/funnels', '/forms',
]);

// Known, tracked exceptions — remove each when its follow-on lands (ADR 0336 "Deferred").
// (Empty: the Phase-2b UCP-buyer purchases surface shipped, so those notifications
// now deep-link to /commerce/purchases/:id and the guard enforces them.)
const PENDING = new Set<string>([]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Extract every `actionUrl: '<str>'` / `actionUrl: \`<str>\`` literal value. */
function extractActionUrls(src: string): string[] {
  const out: string[] = [];
  const re = /actionUrl:\s*(['`])((?:\\.|(?!\1).)*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[2] ?? '');
  return out;
}

describe('notification deep-link guard (ADR 0336)', () => {
  it('no notification actionUrl is a bare multi-entity parent tab', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('actionUrl:')) continue;
      for (const url of extractActionUrls(src)) {
        // An interpolated id (`${`) or a query string (`?`) is entity-specific.
        if (url.includes('${') || url.includes('?')) continue;
        if (!PARENT_TABS.has(url)) continue;
        if (PENDING.has(`${basename(file)}::${url}`)) continue;
        offenders.push(`${file.slice(SRC.length + 1)}: actionUrl '${url}'`);
      }
    }
    expect(
      offenders,
      `Bare parent-tab actionUrl(s) drop the entity id — point at the specific entity `
        + `(a ?param=<id> or /<entity>/<id>), per ADR 0336 §2:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
