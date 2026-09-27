/**
 * ADR 0256 — a `format: 'markdown'` template renders the safe-Markdown HTML part
 * at send; `text` (default) keeps the ADR 0242 escape-first render. The safe
 * renderer itself is exhaustively XSS-tested in email-safe-markdown.test.ts; this
 * covers the template round-trip + the send-path branch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import {
  __resetEmailStore, createTemplate, updateTemplate, getTemplate, createCampaign, sendCampaign, setSenderAddress,
} from '../src/features/email/emailService.js';
import { createContact, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { __resetConsentStore } from '../src/features/consent/consentService.js';

const T = 'tMarkdownBody';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_EMAIL_LINK_BASE_URL = 'https://app.example';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
});
afterAll(() => { delete process.env.OPENWOP_EMAIL_LINK_BASE_URL; });

describe('ADR 0256 — markdown email body', () => {
  beforeEach(async () => { await __resetEmailStore(); await __resetCrmStore(); await __resetConsentStore(); await setSenderAddress(T, 'o1', 'sender@acme.test', 'u1'); });

  it('persists the format on create and update (default is text)', async () => {
    const plain = await createTemplate({ tenantId: T, orgId: 'o1', name: 'P', subject: 'S', body: 'B', createdBy: 'u1' });
    expect(plain.format).toBeUndefined(); // absent ⇒ text (back-compat)

    const md = await createTemplate({ tenantId: T, orgId: 'o1', name: 'M', subject: 'S', body: '**hi**', format: 'markdown', createdBy: 'u1' });
    expect(md.format).toBe('markdown');
    expect((await getTemplate(T, 'o1', md.templateId))?.format).toBe('markdown');

    const back = await updateTemplate(T, 'o1', md.templateId, { format: 'text' });
    expect(back?.format).toBe('text');
  });

  async function sendWith(format: 'text' | 'markdown', body: string): Promise<{ html?: string; text: string }> {
    await createContact({ tenantId: T, name: 'Ada', email: 'ada@x.com', stage: 'lead' });
    const tpl = await createTemplate({ tenantId: T, orgId: 'o1', name: 'T', subject: 'S', body, format, createdBy: 'u1' });
    const cmp = await createCampaign({ tenantId: T, orgId: 'o1', templateId: tpl.templateId, createdBy: 'u1' });
    let captured: { html?: string; body: string } | undefined;
    const provider = { id: 'capture', send: async (m: { body: string; html?: string }) => { captured = { body: m.body, ...(m.html ? { html: m.html } : {}) }; } };
    await sendCampaign(T, 'o1', cmp.campaignId, { provider });
    return { text: captured?.body ?? '', ...(captured?.html ? { html: captured.html } : {}) };
  }

  it('a markdown template renders formatting into the HTML part', async () => {
    const { html } = await sendWith('markdown', 'Hello **Ada** — [reserve](https://shop.example/r)');
    expect(html).toBeDefined();
    expect(html!).toContain('<strong>Ada</strong>');
    // the markdown link URL was link-tracked by instrumentBody, then rendered as an anchor.
    expect(html!).toContain('<a href="https://app.example/host/openwop-app/public-email/c/');
    expect(html!).not.toContain('**Ada**'); // markdown consumed, not literal
  });

  it('a text template keeps the escape-first render (markdown syntax stays literal)', async () => {
    const { html } = await sendWith('text', 'Hello **Ada**');
    expect(html).toBeDefined();
    expect(html!).toContain('**Ada**'); // literal — no markdown parsing in text mode
    expect(html!).not.toContain('<strong>');
  });
});
