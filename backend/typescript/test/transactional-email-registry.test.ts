/**
 * ADR 0905 P3 (D6) — the ONE transactional email seam, `host/transactionalEmail.ts`
 * (hoisted from `features/commerce/transactionalEmail.ts`), and its template registry.
 *
 *  - no recipient / no transport is the honest no-op, never a throw;
 *  - a kind must ship all four product locales with the same keys, or it refuses to
 *    register; a duplicate kind throws; the white-label override replaces a kind;
 *  - data reaches a message only through the filler: a CRLF in data can never start a
 *    second header line in the subject, text loses control characters, and a missing
 *    `{{var}}` is a render error, never a blank;
 *  - the email feature owns the transport, and commerce no longer imports email.
 *
 * Per-kind 4-locale goldens live with each sender's PR (commerce: `commerce-order-confirmed-email.test.ts`).
 *
 * Sabotage-witnessed (grade-tests wave 64 follow-up, 8f W6): the locale-parity
 * check, the missing-variable throw, the duplicate and override guards, the locale
 * fallback, the recipient check and the text control strip each red their case
 * when removed. Two cases rest on more than one guard, so removing one alone is
 * green:
 *  - the subject is cleaned THREE times — `clean.subject` in the filler, the C0
 *    strip in `renderTransactional`, and its `\s+` collapse; the injection case
 *    reds only with all three gone;
 *  - a missing transport is caught twice — the early `no_transport` return, and the
 *    `catch` around calling it; the no-op case reds only with both gone.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  registerTransactionalTemplate, overrideTransactionalTemplate, renderTransactional, sendTransactional, sendTransactionalEmail,
  setTransactionalEmailTransport, __resetTransactionalEmail,
  type TransactionalEmail, type TransactionalTemplate, type TransactionalCatalog, type TransactionalLocale,
} from '../src/host/transactionalEmail.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** A catalog built per locale (`each(locale)` returns that locale's strings). */
const catalogOf = (each: (l: TransactionalLocale) => Record<string, string>): TransactionalCatalog =>
  ({ en: each('en'), es: each('es'), fr: each('fr'), 'pt-BR': each('pt-BR') });

interface Greeting { name: string; url?: string }
const greeting: TransactionalTemplate<Greeting> = {
  kind: 'test.greeting',
  catalog: catalogOf((l) => ({ subject: `[${l}] Hello {{name}}`, body: `[${l}] Welcome, {{name}}.`, link: `[${l}] Open: {{url}}` })),
  compose: (f, d) => ({
    subject: f.subject('subject', { name: d.name }),
    text: d.url ? `${f.text('body', { name: d.name })}\n\n${f.text('link', { url: d.url })}` : f.text('body', { name: d.name }),
  }),
};
registerTransactionalTemplate(greeting);

describe('the send seam', () => {
  it('no recipient or no transport is the honest no-op; a wired transport sends', async () => {
    __resetTransactionalEmail();
    expect(await sendTransactionalEmail({ to: 'not-an-email', subject: 's', text: 't' })).toEqual({ sent: false, reason: 'no_recipient' });
    expect(await sendTransactionalEmail({ to: 'a@b.test', subject: 's', text: 't' })).toEqual({ sent: false, reason: 'no_transport' });
    const sent: TransactionalEmail[] = [];
    setTransactionalEmailTransport(async (e) => { sent.push(e); return true; });
    try {
      expect(await sendTransactional<Greeting>('test.greeting', { to: 'a@b.test', data: { name: 'Ana' }, locale: 'fr' })).toEqual({ sent: true });
      expect(sent[0]).toMatchObject({ to: 'a@b.test', subject: '[fr] Hello Ana', text: '[fr] Welcome, Ana.' });
    } finally { __resetTransactionalEmail(); }
  });
});

describe('locale resolution', () => {
  it('each of the four locales renders; an unknown locale falls back to the host default', () => {
    for (const l of ['en', 'es', 'fr', 'pt-BR'] as const) expect(renderTransactional('test.greeting', { name: 'X' }, { locale: l }).subject).toBe(`[${l}] Hello X`);
    expect(renderTransactional('test.greeting', { name: 'X' }, { locale: 'de' }).locale).toBe('en');
  });
});

describe('escaping by construction', () => {
  it('a CRLF in data cannot add a header line to the subject; text loses control characters', () => {
    const r = renderTransactional<Greeting>('test.greeting', { name: 'x\r\nBcc: evil@x.test', url: 'https://a/\u0007b' }, { locale: 'en' });
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.subject).toBe('[en] Hello x Bcc: evil@x.test');
    expect(r.text).not.toContain('\u0007');
  });
  it('a missing variable is a render error, never a blank', () => {
    registerTransactionalTemplate<Record<string, never>>({
      kind: 'test.missing-var',
      catalog: catalogOf(() => ({ subject: 'Hi {{name}}', body: 'b' })),
      compose: (f) => ({ subject: f.subject('subject'), text: f.text('body') }),
    });
    expect(() => renderTransactional('test.missing-var', {})).toThrow(/no value for \{\{name\}\}/);
  });
});

describe('registration rules', () => {
  const base = (kind: string): TransactionalTemplate<Record<string, never>> => ({
    kind,
    catalog: catalogOf((l) => ({ subject: `S ${l}`, body: `B ${l}` })),
    compose: (f) => ({ subject: f.subject('subject'), text: f.text('body') }),
  });
  it('a kind missing a locale or a key refuses to register', () => {
    const d = base('test.no-fr');
    const { fr: _fr, ...rest } = d.catalog;
    expect(() => registerTransactionalTemplate({ ...d, catalog: { ...rest, fr: {} } })).toThrow(/locale 'fr'/);
    const e = base('test.short-es');
    expect(() => registerTransactionalTemplate({ ...e, catalog: { ...e.catalog, es: { subject: 'S' } } })).toThrow(/locale 'es'/);
  });
  it('a duplicate kind throws; the same definition again is a no-op; the override replaces it', () => {
    const d = base('test.dup');
    registerTransactionalTemplate(d);
    registerTransactionalTemplate(d);
    expect(() => registerTransactionalTemplate(base('test.dup'))).toThrow(/already registered/);
    overrideTransactionalTemplate({ ...base('test.dup'), catalog: catalogOf((l) => ({ subject: `White-label ${l}`, body: 'b' })) });
    expect(renderTransactional('test.dup', {}, { locale: 'en' }).subject).toBe('White-label en');
    expect(() => overrideTransactionalTemplate(base('test.never-registered'))).toThrow(/not registered/);
  });
});

describe('ownership', () => {
  it('commerce no longer imports the email feature; email owns the transport', () => {
    const commerce = readFileSync(join(SRC, 'features', 'commerce', 'feature.ts'), 'utf8');
    expect(commerce).not.toMatch(/from '\.\.\/email\//);
    const email = readFileSync(join(SRC, 'features', 'email', 'feature.ts'), 'utf8');
    expect(email).toContain('setTransactionalEmailTransport(');
  });
});
