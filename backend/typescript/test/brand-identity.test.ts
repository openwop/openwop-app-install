/**
 * Brand identity facet (ADR 0170 Phase 1) — sanitization is exercised through the
 * public service API (createBrand/updateBrand/getBrand). The validators double as
 * CSS-injection controls because Phase 5 inlines these values into a `:root`
 * `<style>` block: colors/fonts must be free of CSS metacharacters, and asset
 * URLs must reject dangerous schemes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { createBrand, updateBrand, getBrand, __clearBrands } from '../src/features/brand/brandService.js';

const TENANT = 'tenant-brand-id';
const ORG = 'org-1';

describe('brand identity facet (ADR 0170) — sanitization', () => {
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __clearBrands();
  });

  it('stores a valid identity facet field-for-field', async () => {
    const b = await createBrand(TENANT, ORG, 'u1', {
      name: 'Acme',
      identity: {
        productName: 'Acme Ops',
        wordmark: { pre: 'Acme', emphasis: 'Ops', sub: 'platform' },
        instanceName: 'Acme',
        logo: { markSrc: '/acme.svg', faviconSrc: "data:image/svg+xml;utf8,<svg/>" },
        colors: { accent: 'oklch(58% 0.13 250)', paper: '#f4f1ea', themeColor: '#101014' },
        typography: { serif: 'Fraunces, Georgia, serif', sans: 'Inter, system-ui, sans-serif' },
        theme: { defaultMode: 'dark' },
        domains: { homeUrl: 'https://acme.example/', primaryDomain: 'flow.acme.example' },
        chromePolicy: { showPoweredBy: false, customCopyright: '© Acme' },
      },
    });
    expect(b.identity?.productName).toBe('Acme Ops');
    expect(b.identity?.wordmark).toEqual({ pre: 'Acme', emphasis: 'Ops', sub: 'platform' });
    expect(b.identity?.colors).toEqual({ accent: 'oklch(58% 0.13 250)', paper: '#f4f1ea', themeColor: '#101014' });
    expect(b.identity?.logo).toEqual({ markSrc: '/acme.svg', faviconSrc: "data:image/svg+xml;utf8,<svg/>" });
    expect(b.identity?.typography?.serif).toBe('Fraunces, Georgia, serif');
    expect(b.identity?.theme?.defaultMode).toBe('dark');
    expect(b.identity?.chromePolicy?.showPoweredBy).toBe(false);
  });

  it('stores the generative theme inputs + enum-clamps the scalars (ADR 0171)', async () => {
    const b = await createBrand(TENANT, ORG, 'u1', {
      name: 'Seeded',
      identity: {
        theme: {
          defaultMode: 'system',
          accentSeed: 'oklch(58% 0.13 250)',
          neutralSeed: '#6a6f7a',
          contrastLevel: 'high',
          radius: 'lg',
          density: 'compact',
        },
      },
    });
    expect(b.identity?.theme).toEqual({
      defaultMode: 'system',
      accentSeed: 'oklch(58% 0.13 250)',
      neutralSeed: '#6a6f7a',
      contrastLevel: 'high',
      radius: 'lg',
      density: 'compact',
    });
  });

  it('drops invalid theme seeds + out-of-enum scalars', async () => {
    const b = await createBrand(TENANT, ORG, 'u1', {
      name: 'Bad',
      identity: {
        theme: {
          accentSeed: 'red;}body{display:none}', // injection → dropped
          contrastLevel: 'ultra', // not an enum → dropped
          radius: 'huge', // not an enum → dropped
        },
      },
    });
    expect(b.identity?.theme).toBeUndefined(); // nothing valid survived → no theme
  });

  it('advanced override: keeps allowlisted tokens with safe colors, drops the rest (ADR 0171)', async () => {
    const b = await createBrand(TENANT, ORG, 'u1', {
      name: 'Override',
      identity: {
        theme: {
          accentSeed: 'oklch(58% 0.13 40)',
          override: {
            light: {
              '--clay': 'oklch(60% 0.12 30)', // allowlisted + safe → kept
              '--color-danger': '#cc2222', // allowlisted + safe → kept
              '--evil-prop': 'oklch(50% 0 0)', // NOT allowlisted → dropped
              '--paper': 'red;}x{y:1', // allowlisted but injection → dropped
            },
            dark: { '--clay': '#0a84ff' },
          },
        },
      },
    });
    expect(b.identity?.theme?.override?.light).toEqual({ '--clay': 'oklch(60% 0.12 30)', '--color-danger': '#cc2222' });
    expect(b.identity?.theme?.override?.dark).toEqual({ '--clay': '#0a84ff' });
  });

  it('rejects CSS-injection in color and font values (drops them)', async () => {
    const b = await createBrand(TENANT, ORG, 'u1', {
      name: 'Evil',
      identity: {
        colors: { accent: 'red;}body{display:none}', paper: '#fff', ink: 'url(http://x)' },
        typography: { serif: 'Geist;}x{color:red', sans: 'Inter, sans-serif' },
      },
    });
    // injection vectors dropped; clean values kept
    expect(b.identity?.colors).toEqual({ paper: '#fff' });
    expect(b.identity?.typography).toEqual({ sans: 'Inter, sans-serif' });
  });

  it('rejects dangerous asset schemes; allows https / relative / data:image', async () => {
    const b = await createBrand(TENANT, ORG, 'u1', {
      name: 'Assets',
      identity: {
        logo: {
          markSrc: 'javascript:alert(1)',
          lockupSrc: 'https://cdn.example/lockup.png',
          faviconSrc: 'data:text/html,<script>alert(1)</script>',
        },
      },
    });
    expect(b.identity?.logo?.markSrc).toBeUndefined(); // javascript: dropped
    expect(b.identity?.logo?.lockupSrc).toBe('https://cdn.example/lockup.png');
    expect(b.identity?.logo?.faviconSrc).toBeUndefined(); // non-image data: dropped
  });

  it('drops unknown color keys (closed key set) and invalid theme enum', async () => {
    const b = await createBrand(TENANT, ORG, 'u1', {
      name: 'Closed',
      // `BrandInput.identity` is `unknown` — invalid shapes need no cast.
      identity: {
        colors: { accent: '#abc', danger: '#f00', notAToken: '#0f0' },
        theme: { defaultMode: 'neon' },
      },
    });
    expect(b.identity?.colors).toEqual({ accent: '#abc' }); // danger/notAToken dropped
    expect(b.identity?.theme).toBeUndefined(); // invalid enum → omitted
  });

  it('omits the facet entirely when absent or fully empty', async () => {
    const none = await createBrand(TENANT, ORG, 'u1', { name: 'NoId' });
    expect(none.identity).toBeUndefined();
    const empty = await createBrand(TENANT, ORG, 'u1', { name: 'EmptyId', identity: { colors: { accent: 'nope;' } } });
    expect(empty.identity).toBeUndefined(); // every field invalid → no husk stored
  });

  it('update replaces identity when provided and preserves it when omitted', async () => {
    const b = await createBrand(TENANT, ORG, 'u1', {
      name: 'Up',
      identity: { productName: 'V1', colors: { accent: '#111' } },
    });
    // omit identity → preserved
    const v2 = await updateBrand(TENANT, b.id, { description: 'touch' });
    expect(v2?.identity?.productName).toBe('V1');
    // provide identity → whole-field replace
    const v3 = await updateBrand(TENANT, b.id, { identity: { productName: 'V2' } });
    expect(v3?.identity?.productName).toBe('V2');
    expect(v3?.identity?.colors).toBeUndefined();
    // provide an all-invalid identity → clears the facet
    const v4 = await updateBrand(TENANT, b.id, { identity: { colors: { accent: 'bad;' } } });
    expect(v4?.identity).toBeUndefined();
    expect((await getBrand(TENANT, b.id))?.identity).toBeUndefined();
  });
});
