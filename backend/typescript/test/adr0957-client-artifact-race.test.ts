/** ADR 0957 P1b: losing concurrent mints must delete in the creating client.
 * The barrier only schedules two real CAS calls; it does not choose their
 * results. Reverting cleanup to the tenant root must leave two assets and fail.
 *
 * Sabotage witnesses (w103; src/host/runArtifactStore.ts mintAndLink/mintMedia,
 * src/features/media/mediaService.ts deleteAsset): passing the tenant root
 * instead of `minted.orgId` to deleteAsset, skipping the CAS-loss branch, minting
 * into the tenant root instead of `artifactOrg(input)`, or leaving the loser's
 * bytes in the store each red this case on both backends.
 */
import { describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { clientRunStamp } from '../src/host/runClientOrg.js';
import { getRunArtifact, persistRunArtifact } from '../src/host/runArtifactStore.js';
import { listAssetsForTenant } from '../src/features/media/mediaService.js';
import { resolveMediaAsset } from '../src/host/inMemorySurfaces.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** The bookkeeping row `mintAndLink` CASes in (`RunArtifactRecord`'s fields this test reads). */
interface BookkeepingRow { tenantId: string; linkedArtifactId: string }

describe('client-scoped losing media mint cleanup', () => {
  it.each(['memory', 'sqlite'] as const)('keeps only the winning asset and bytes using real %s CAS', async (backend) => {
    const storage = backend === 'memory' ? await openStorage('memory://') : openSqliteStorage(':memory:');
    initHostExtPersistence(storage);
    const compare = storage.kvCompareAndSwap.bind(storage);
    let release = (): void => {};
    const bothArrived = new Promise<void>((resolve) => { release = resolve; });
    let arrivals = 0;
    const mintedIds: string[] = [];
    let mintedTokens: string[] = [];
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, next) => {
      if (key === 'hostext:runartifact:client-race:preview') {
        const row: BookkeepingRow = JSON.parse(next);
        mintedIds.push(row.linkedArtifactId);
        arrivals++;
        if (arrivals === 2) {
          // Both real media writes have finished, before either bookkeeping CAS.
          mintedTokens = (await listAssetsForTenant(row.tenantId)).map((asset) => asset.serveToken);
          release();
        }
        await bothArrived;
      }
      return compare(key, expected, next);
    });
    try {
      const { tenantId } = await createWorkspace({ name: 'Media race', ownerSubject: 'owner' });
      const org = await createOrg({ tenantId, name: 'Report client', createdBy: 'owner' });
      const now = new Date().toISOString();
      await storage.insertRun({ runId: 'client-race', tenantId, workflowId: 'client-report', status: 'running',
        inputs: {}, configurable: {}, metadata: clientRunStamp(org.orgId), createdAt: now, updatedAt: now });
      const input = { tenantId, runId: 'client-race', nodeId: 'preview', role: 'gate-preview' as const,
        now, output: { contentBase64: PNG_B64, contentType: 'image/png' } };
      const [first, second] = await Promise.all([persistRunArtifact(input), persistRunArtifact(input)]);
      expect(arrivals).toBe(2);
      expect(new Set(mintedIds).size).toBe(2);
      expect(mintedTokens).toHaveLength(2);
      expect(first).not.toBeNull();
      expect(second).toEqual(first);
      const remaining = await listAssetsForTenant(tenantId);
      expect(remaining).toHaveLength(1);
      const winner = remaining[0]!;
      expect(winner.orgId).toBe(org.orgId);
      expect(first?.artifactId).toBe(`media:${winner.assetId}`);
      expect((await getRunArtifact('client-race:preview'))?.linkedArtifactId).toBe(first?.artifactId);
      // The winner's bytes still serve; the loser's bytes are gone with its row.
      expect(mintedTokens).toContain(winner.serveToken);
      const losers = mintedTokens.filter((token) => token !== winner.serveToken);
      expect(losers).toHaveLength(1);
      expect((await resolveMediaAsset(winner.serveToken))?.contentBase64).toBe(PNG_B64);
      expect(await resolveMediaAsset(losers[0]!)).toBeNull();
    } finally { release(); spy.mockRestore(); await storage.close(); }
  });
});
