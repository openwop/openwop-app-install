/**
 * Brand workflow surface (ADR 0155 Phase 3 / ADR 0014) — `ctx.features.brand`.
 * Tenant-trusted reads + the pure deterministic scorer + the voice resolver
 * (the LLM compliance leg stays in the node). Verifies tenant isolation: a brand
 * in another tenant is invisible to this scope.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createBrand, __clearBrands } from '../src/features/brand/brandService.js';
import { buildBrandSurface } from '../src/features/brand/surface.js';

const TENANT = 'tenant-brand-surf';
function as<T>(v: unknown): T { return JSON.parse(JSON.stringify(v)); }
interface ListOut { brands: Array<{ id: string; name: string }> }
interface VoiceOut { voice: string | null }
interface ReportOut { report: { deterministicScore: number; hasBannedPhrase: boolean } | null }

describe('brand surface (ctx.features.brand)', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __clearBrands();
  });

  it('lists the tenant brands and isolates other tenants', async () => {
    const mine = await createBrand(TENANT, 'org-1', 'u1', { name: 'FlashPick' });
    await createBrand('other-tenant', 'org-1', 'u1', { name: 'Foreign' });
    const surface = buildBrandSurface({ tenantId: TENANT });
    const ids = as<ListOut>(await surface.listBrands({})).brands.map((b) => b.id);
    expect(ids).toEqual([mine.id]); // foreign tenant excluded
  });

  it('getBrand returns null for a foreign-tenant id', async () => {
    const foreign = await createBrand('other-tenant', 'org-1', 'u1', { name: 'Foreign' });
    const surface = buildBrandSurface({ tenantId: TENANT });
    const got = as<{ brand: unknown }>(await surface.getBrand({ brandId: foreign.id }));
    expect(got.brand).toBeNull();
  });

  it('getAppIdentity returns the reserved app brand identity (ADR 0170)', async () => {
    const { editAppBrand, __resetSystemBrand } = await import('../src/host/systemBrand.js');
    __resetSystemBrand();
    await editAppBrand({ identity: { productName: 'Acme Ops', colors: { accent: '#abc' } } }, 'super:1');
    const surface = buildBrandSurface({ tenantId: TENANT });
    const out = as<{ identity: { productName?: string } }>(await surface.getAppIdentity({}));
    expect(out.identity.productName).toBe('Acme Ops'); // host-global; any tenant scope reads it
  });

  it('resolveVoice renders the brand voice; null for a missing brand', async () => {
    const b = await createBrand(TENANT, 'org-1', 'u1', {
      name: 'FlashPick',
      voiceProfile: { voice: 'confident', formalityLevel: 4 },
      keyPhrases: { bannedPhrases: ['cheap'] },
    });
    const surface = buildBrandSurface({ tenantId: TENANT });
    const ok = as<VoiceOut>(await surface.resolveVoice({ brandId: b.id }));
    expect(ok.voice).toContain('confident');
    expect(ok.voice).toContain('NEVER use (banned): cheap');
    const missing = as<VoiceOut>(await surface.resolveVoice({ brandId: 'nope' }));
    expect(missing.voice).toBeNull();
  });

  it('checkComplianceDeterministic flags a banned phrase', async () => {
    const b = await createBrand(TENANT, 'org-1', 'u1', { name: 'FlashPick', keyPhrases: { bannedPhrases: ['revolutionary'] } });
    const surface = buildBrandSurface({ tenantId: TENANT });
    const out = as<ReportOut>(await surface.checkComplianceDeterministic({ brandId: b.id, content: 'A revolutionary tool.' }));
    expect(out.report?.hasBannedPhrase).toBe(true);
    expect(out.report?.deterministicScore).toBeLessThanOrEqual(30);
  });
});
