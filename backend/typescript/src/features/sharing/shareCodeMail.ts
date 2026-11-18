/**
 * ADR 1141 D3 — the one email a recipient-bound share link sends: its one-time code.
 *
 * It rides the host's transactional lane the approval email uses
 * (`host/emailApprovalDelivery.ts`): the registered kind (four locales, escaped
 * fills), then `makeEmailAdapter(...).send({ purpose: 'transactional' })` on the
 * first WORKSPACE-scoped email Connection. The adapter's floor still applies
 * (erasure, bounces, complaints and manual holds block it). Not
 * `features/email` `activeProvider()`: that is the console stub on this host, so
 * a send there reports success and delivers nothing.
 */
import { makeEmailAdapter, resolveEmailProvider } from '../../host/emailAdapter.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { registerTransactionalTemplate, renderTransactional, type TransactionalTemplate } from '../../host/transactionalEmail.js';

export const SHARE_CODE_KIND = 'sharing.verification-code';

interface ShareCodeData { orgName: string; code: string }

const shareCodeTemplate: TransactionalTemplate<ShareCodeData> = {
  kind: SHARE_CODE_KIND,
  catalog: {
    en: {
      subject: 'Your code for {{orgName}}',
      lead: 'Your verification code is {{code}}.',
      ttl: 'It expires in 10 minutes and works once.',
      ignore: "If you didn't ask for it, you can ignore this email. Nobody can open the link without it.",
    },
    es: {
      subject: 'Tu código para {{orgName}}',
      lead: 'Tu código de verificación es {{code}}.',
      ttl: 'Caduca en 10 minutos y solo sirve una vez.',
      ignore: 'Si no lo pediste, puedes ignorar este correo. Nadie puede abrir el enlace sin él.',
    },
    fr: {
      subject: 'Votre code pour {{orgName}}',
      lead: 'Votre code de vérification est {{code}}.',
      ttl: "Il expire dans 10 minutes et ne sert qu'une fois.",
      ignore: "Si vous ne l'avez pas demandé, ignorez cet e-mail. Personne ne peut ouvrir le lien sans lui.",
    },
    'pt-BR': {
      subject: 'Seu código para {{orgName}}',
      lead: 'Seu código de verificação é {{code}}.',
      ttl: 'Ele expira em 10 minutos e só funciona uma vez.',
      ignore: 'Se você não pediu, pode ignorar este e-mail. Ninguém consegue abrir o link sem ele.',
    },
  },
  compose: (f, d) => ({
    subject: f.subject('subject', { orgName: d.orgName }),
    text: [f.text('lead', { code: d.code }), f.text('ttl'), '', f.text('ignore')].join('\n'),
  }),
};

export function registerShareCodeTemplate(): void {
  registerTransactionalTemplate(shareCodeTemplate);
}

interface ShareCodeMailForTest { ready: boolean; sent: Array<{ tenantId: string; to: string; code: string }> }
let testMail: ShareCodeMailForTest | undefined;
/** Test seam: replace the mail lane with an in-memory outbox (undefined restores it). */
export function __setShareCodeMailForTest(m: ShareCodeMailForTest | undefined): void { testMail = m; }

function fromAddress(): string | null {
  return process.env.OPENWOP_NOTIFY_EMAIL_FROM?.trim() || null;
}

/** Can this workspace send a code at all? Asked at MINT, so the owner learns it then. */
export async function shareCodeMailReady(tenantId: string): Promise<boolean> {
  if (testMail) return testMail.ready;
  if (!fromAddress()) return false;
  return (await resolveEmailProvider({ tenantId, purpose: 'transactional' })) !== null;
}

/** Send one code. Never throws: the visitor's answer is the same 202 either way. */
export async function sendShareCode(input: { tenantId: string; to: string; orgName: string; code: string; idempotencyKey: string }): Promise<boolean> {
  if (testMail) {
    renderTransactional<ShareCodeData>(SHARE_CODE_KIND, { orgName: input.orgName || '—', code: input.code }); // the kind must render
    testMail.sent.push({ tenantId: input.tenantId, to: input.to, code: input.code });
    return true;
  }
  const from = fromAddress();
  if (!from) return false;
  const m = renderTransactional<ShareCodeData>(SHARE_CODE_KIND, { orgName: input.orgName || '—', code: input.code });
  const provider = (await resolveEmailProvider({ tenantId: input.tenantId, purpose: 'transactional' })) ?? 'smtp';
  const result = await makeEmailAdapter({ storage: hostExtStorage(), tenantId: input.tenantId, runId: `share-verify:${input.idempotencyKey}` }).send({
    from, to: input.to, subject: m.subject, text: m.text,
    provider, purpose: 'transactional', idempotencyKey: input.idempotencyKey,
  });
  return result.sent;
}
