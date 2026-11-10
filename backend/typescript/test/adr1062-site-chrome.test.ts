/**
 * ADR 1062 — the public-site chrome additions on the server side:
 *
 *   - D2 `siteNav.featured` ({ eyebrow?, title, meta?, href? }): a title is
 *     required; `href` is a `#fragment` or a safe internal path, never an
 *     external URL; anything else is a 400, never coerced;
 *   - D2 the public nav read returns the featured card ONCE, at the top level,
 *     with the owning page's slug, and strips it from that page's row `nav`; a
 *     draft page's card never appears;
 *   - D4 the `cta` section's `split` alignment and `note`, which also reach the
 *     prerendered HTML and the markdown export.
 *
 * Sabotage witnesses: dropping `featured` from `cleanSiteNav` reds the accepts
 * case; accepting an external href reds the refuses case; returning the card
 * inside the row `nav` (or not at all) reds the route case; dropping `note`
 * from the cta validator or either prerender reds the cta case.
 *
 * Each refusal is asserted by the FIELD it names, not by code + status alone:
 * the non-object guard and the required-title guard throw the same
 * validation_error/400, so a code-only check could not tell them apart (wave 91
 * probe sc-feat-obj). The href `typeof` check is a benign double guard: a
 * non-string href stringifies and the href grammar refuses it anyway, with the
 * same field.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { cleanSiteNav, validateSection, type Section } from '../src/features/cms/cmsService.js';
import { sectionHtml } from '../src/features/publishing/sectionHtml.js';
import { sectionMarkdown } from '../src/features/publishing/sectionMarkdown.js';
import type { PublicNavFeatured, PublicNavPage } from '../src/features/publishing/publishingService.js';
import { OpenwopError } from '../src/types.js';

let BASE: string;
let server: http.Server;
let savedTtl: string | undefined;
const ADMIN = { authorization: 'Bearer dev-token', 'content-type': 'application/json' };
const SITE = '/host/openwop-app/cms/orgs/host-site';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  savedTtl = process.env.OPENWOP_PUBLIC_LIST_TTL_S;
  process.env.OPENWOP_PUBLIC_LIST_TTL_S = '0'; // the public list memo would hide the publish
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterAll(async () => {
  if (savedTtl === undefined) Reflect.deleteProperty(process.env, 'OPENWOP_PUBLIC_LIST_TTL_S'); else process.env.OPENWOP_PUBLIC_LIST_TTL_S = savedTtl;
  await new Promise<void>((res) => server.close(() => res()));
});

const admin = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const r = await fetch(`${BASE}${path}`, { method, headers: ADMIN, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};

function refusal(fn: () => unknown): OpenwopError {
  try { fn(); } catch (err) { if (err instanceof OpenwopError) return err; throw err; }
  throw new Error('expected a refusal');
}

describe('cleanSiteNav featured (ADR 1062 D2)', () => {
  it('accepts a trimmed card with a fragment or internal href, and caps its strings', () => {
    expect(cleanSiteNav({ featured: { eyebrow: ' New film ', title: ' Whose agent is it? ', meta: '3:57', href: '#whose-agent' } }))
      .toEqual({ featured: { eyebrow: 'New film', title: 'Whose agent is it?', meta: '3:57', href: '#whose-agent' } });
    expect(cleanSiteNav({ featured: { title: 'Film', href: '/p/film' } })).toEqual({ featured: { title: 'Film', href: '/p/film' } });
    expect(cleanSiteNav({ featured: { title: 'T'.repeat(200), eyebrow: 'E'.repeat(99), meta: 'M'.repeat(99) } })?.featured)
      .toEqual({ title: 'T'.repeat(60), eyebrow: 'E'.repeat(30), meta: 'M'.repeat(20) });
    // An empty href is the default (the page itself), not a refusal.
    expect(cleanSiteNav({ featured: { title: 'Film', href: '' } })).toEqual({ featured: { title: 'Film' } });
  });

  it('refuses a card with no title, a non-string field, or an off-site / unsafe href', () => {
    const bad: Array<[unknown, string]> = [
      [{ featured: 'film' }, 'siteNav.featured'],
      [{ featured: [] }, 'siteNav.featured'],
      [{ featured: {} }, 'siteNav.featured.title'],
      [{ featured: { title: '   ' } }, 'siteNav.featured.title'],
      [{ featured: { title: 'Film', meta: 357 } }, 'siteNav.featured.meta'],
      [{ featured: { title: 'Film', href: 'https://evil.example/x' } }, 'siteNav.featured.href'],
      [{ featured: { title: 'Film', href: '//evil.example/x' } }, 'siteNav.featured.href'],
      [{ featured: { title: 'Film', href: 'javascript:alert(1)' } }, 'siteNav.featured.href'],
      [{ featured: { title: 'Film', href: '#a b' } }, 'siteNav.featured.href'],
      [{ featured: { title: 'Film', href: 7 } }, 'siteNav.featured.href'],
    ];
    for (const [b, field] of bad) {
      const err = refusal(() => cleanSiteNav(b));
      expect(err.code, JSON.stringify(b)).toBe('validation_error');
      expect(err.httpStatus, JSON.stringify(b)).toBe(400);
      expect(err.details?.field, JSON.stringify(b)).toBe(field);
    }
  });
});

describe('featured card over the CMS routes + public nav read (ADR 1062 D2)', () => {
  it('returns the published card once, with its slug, and keeps it out of the row nav', async () => {
    const make = async (title: string, slug: string, siteNav: unknown): Promise<string> => {
      const created = await admin('POST', `${SITE}/pages`, { title, slug });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const pageId = String(created.body.pageId);
      const patched = await admin('PATCH', `${SITE}/pages/${pageId}`, { siteNav });
      expect(patched.status, JSON.stringify(patched.body)).toBe(200);
      return pageId;
    };
    const film = await make('Aaa film page', 'adr1062-film', { group: 'product', label: 'Film', featured: { eyebrow: 'New film', title: 'Whose agent is it?', meta: '3:57', href: '#whose-agent' } });
    // A draft page's card must never surface, even though it sorts first by title.
    await make('Aa draft page', 'adr1062-draft', { featured: { title: 'Draft card' } });
    expect((await admin('POST', `${SITE}/pages/${film}/publish`)).status).toBe(200);

    const body = (await (await fetch(`${BASE}/host/openwop-app/public/host-site/pages`)).json()) as { pages: PublicNavPage[]; featured?: PublicNavFeatured };
    expect(body.featured).toEqual({ slug: 'adr1062-film', eyebrow: 'New film', title: 'Whose agent is it?', meta: '3:57', href: '#whose-agent' });
    expect(body.pages.find((p) => p.slug === 'adr1062-film')?.nav).toEqual({ group: 'product', label: 'Film' });
    expect(body.pages.some((p) => p.slug === 'adr1062-draft')).toBe(false);
  });
});

const OPTS = { assetBase: 'https://app.example.test' };
const sec = (d: Record<string, unknown>): Section => validateSection({ sectionId: 's-cta', type: 'cta', data: d });

describe('cta split + note (ADR 1062 D4)', () => {
  it('keeps split and a note, drops an unknown alignment, and prerenders the note', () => {
    const s = sec({ heading: 'Ready?', label: 'Book a call', url: '/p/book', align: 'split', note: 'No card needed.' });
    expect(s.data).toMatchObject({ align: 'split', note: 'No card needed.' });
    expect(sec({ label: 'Go', url: '/go', align: 'sideways' }).data.align).toBeUndefined();
    expect(sectionHtml(s, OPTS)).toContain('<p><small>No card needed.</small></p>');
    expect(sectionMarkdown(s, OPTS.assetBase)).toMatch(/\[Book a call\]\(\/p\/book\)\n\nNo card needed\.$/);
    // No note, no extra paragraph.
    expect(sectionHtml(sec({ label: 'Go', url: '/go' }), OPTS)).not.toContain('<small>');
  });
});
