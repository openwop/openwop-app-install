/**
 * Teardown-reachability RECORDED_DEBT shrink (baseline 3→2): `chatwidget:tokenidx`
 * maps the opaque public capability token → the widget's config key. It keys by
 * the TOKEN (no tenant), so the generic `purgeTenantHostExt` walk — which deletes
 * `chatwidget:config` via the row's `tenantId` — cannot reach it, and it orphaned
 * on account deletion. `deleteWidget`/`rotateWidgetToken` already keep the index
 * in step on the normal paths, so `feature.ts` registers a PARENT-RESOLVED
 * `purgeTenantHostExt` pre-hook (`purgeTenantWidgetTokens`, ADR 0590) that
 * enumerates the tenant's widgets (`listByPrefix(`${tenantId}:`)`) and drops each
 * one's token-index entry while the widgets still resolve.
 *
 * Two parts:
 *  1. TEARDOWN — seed a widget per tenant (which indexes its token), purge tenant
 *     A, and assert A's token-index ROW is gone AND tenant B's survives. The
 *     assertion checks the RAW `chatwidget:tokenidx` row, NOT `resolveWidgetByToken`
 *     — the generic walk deletes A's CONFIG regardless of the hook, so a
 *     config-based check would false-green; only the raw pointer distinguishes
 *     "the hook ran" from "the config is gone". Born-red without the hook: the
 *     token row survives the purge. B (`org:cw2`, a prefix-extension of `org:cw`)
 *     proves the `${tenantId}:` trailing-colon guard.
 *  2. WIRING — assert `feature.ts` registers the hook (comment-stripped, so a
 *     commented-out registration still fails — the "ratchet counts comments" class).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import {
  initHostExtPersistence,
  purgeTenantHostExt,
  hostExtStorage,
  registerTenantPurgeHook,
} from '../src/host/hostExtPersistence.js';
import { provisionWidget, purgeTenantWidgetTokens } from '../src/features/chat-widget/widgetService.js';

// B is a proper prefix-extension of A (`org:cw` vs `org:cw2`): the `${tenantId}:`
// trailing colon is the only thing that stops A's purge from eating B's widgets.
const A = 'org:cw';
const B = 'org:cw2';
const ORG = 'org-unit';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  // Mirror feature.ts's boot wiring so purgeTenantHostExt invokes the hook.
  registerTenantPurgeHook('chat-widget', purgeTenantWidgetTokens);
});

async function seedToken(tenant: string): Promise<string> {
  const w = await provisionWidget(tenant, ORG, 'u', { agentId: 'a1', allowedDomains: ['x.com'] });
  return w.token;
}

// Assert on the RAW token-index row (keyed by the opaque token, no tenant) — a
// live row's key contains both the namespace and the token.
async function tokenIndexRowExists(token: string): Promise<boolean> {
  const rows = await hostExtStorage().kvList('hostext:');
  return rows.some(({ key }) => key.includes('chatwidget:tokenidx') && key.includes(token));
}

describe('teardown-debt chat-widget token index — reachable via the tenant purge hook', () => {
  it('purges tenant A\'s token-index entry via its widgets; tenant B survives', async () => {
    const tA = await seedToken(A);
    const tB = await seedToken(B);
    expect(await tokenIndexRowExists(tA)).toBe(true);
    expect(await tokenIndexRowExists(tB)).toBe(true);

    await purgeTenantHostExt(A);

    // A's token-index ROW is gone — the parent-resolved hook reached it. Born-red
    // without the hook: the generic walk deletes A's config but the token pointer
    // orphans, so this row would still be present.
    expect(await tokenIndexRowExists(tA)).toBe(false);
    // B is untouched — the hook enumerated only A's widgets (listByPrefix `${A}:`).
    expect(await tokenIndexRowExists(tB)).toBe(true);
  });

  it('feature.ts wires the purge hook (comment-stripped match)', () => {
    const featureSrc = readFileSync(join(__dirname, '..', 'src', 'features', 'chat-widget', 'feature.ts'), 'utf8')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(featureSrc).toMatch(/registerTenantPurgeHook\(\s*['"]chat-widget['"]\s*,\s*purgeTenantWidgetTokens\s*\)/);
  });
});
