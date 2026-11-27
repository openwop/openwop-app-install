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
 *
 * ADR 1141 follow-up (after #6248): the code goes out from the firm's own sender,
 * the link org's `senderAddress` (the one every other transactional email uses,
 * `features/email/brokeredProvider.ts`), with the org's name as the From name. The
 * env `OPENWOP_NOTIFY_EMAIL_FROM` is the fallback for an org that has none.
 *
 * The TRANSPORT stays the workspace Connection, resolved with the tenant only. A
 * code send has no acting human: it runs for an anonymous visitor. The broker
 * withholds an org Connection from a send with no acting user and then returns
 * nothing (ADR 0024 D2, `authorizedCandidates`). So passing `orgId` there would
 * leave an org that has its own Connection with no transport at all, where today
 * it uses the workspace's.
 */
import { makeEmailAdapter, resolveEmailProvider } from '../../host/emailAdapter.js';
import { emailHeaderFieldProblem, FROM_NAME_MAX } from '../../host/emailHeaderFields.js';
import { getEmailSettings } from '../email/emailService.js';
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

interface ShareCodeMailForTest {
  /** Is an email transport connected? The sender is still resolved for real. */
  ready: boolean;
  /** The transport refuses each send with this error (a provider that rejects the From). */
  refuse?: string;
  sent: Array<{ tenantId: string; orgId: string; to: string; code: string; from: string; fromName?: string }>;
}
let testMail: ShareCodeMailForTest | undefined;
/** Test seam: replace the transport with an in-memory outbox (undefined restores it). */
export function __setShareCodeMailForTest(m: ShareCodeMailForTest | undefined): void { testMail = m; }

/** The org's own sender, else the host's. Null when neither is set. */
async function fromAddress(tenantId: string, orgId: string): Promise<string | null> {
  const own = (await getEmailSettings(tenantId, orgId))?.senderAddress.trim();
  return own || process.env.OPENWOP_NOTIFY_EMAIL_FROM?.trim() || null;
}

/** The org's name as a From name: control characters become spaces, runs collapse,
 *  it is capped at the header limit. Omitted when nothing usable is left. */
function fromNameOf(orgName: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const name = orgName.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, FROM_NAME_MAX).trim();
  return name && !emailHeaderFieldProblem({ fromName: name }) ? name : undefined;
}

async function transportReady(tenantId: string): Promise<boolean> {
  if (testMail) return testMail.ready;
  return (await resolveEmailProvider({ tenantId, purpose: 'transactional' })) !== null;
}

/** Can this org send a code at all? Asked at MINT, so the owner learns it then. */
export async function shareCodeMailReady(tenantId: string, orgId: string): Promise<boolean> {
  if (!(await fromAddress(tenantId, orgId))) return false;
  return transportReady(tenantId);
}

/** Why a code did not go out. `email_*` is the adapter's own code; anything else the
 *  provider said (an unverified From domain, for one) reads `provider_refused`. */
export type ShareCodeSendFailure = 'no_sender' | 'provider_refused' | `email_${string}`;
export type ShareCodeSendResult = { sent: true } | { sent: false; reason: ShareCodeSendFailure };

function failureOf(error: string | undefined): ShareCodeSendFailure {
  const code = error?.split(':')[0]?.trim() ?? '';
  return /^email_[a-z_]+$/.test(code) ? (code as `email_${string}`) : 'provider_refused';
}

/**
 * Send one code. Never throws: the visitor's answer is the same 202 either way.
 *
 * Limitation: the From is the org's address but the transport is the workspace's
 * Connection. A provider that has not verified the org's domain can refuse the send
 * (SendGrid and Postmark do) or a receiver can flag it. A refusal comes back as a
 * typed failure, never as a sent code.
 */
export async function sendShareCode(input: { tenantId: string; orgId: string; to: string; orgName: string; code: string; idempotencyKey: string }): Promise<ShareCodeSendResult> {
  const from = await fromAddress(input.tenantId, input.orgId);
  if (!from) return { sent: false, reason: 'no_sender' };
  const fromName = fromNameOf(input.orgName);
  const m = renderTransactional<ShareCodeData>(SHARE_CODE_KIND, { orgName: input.orgName || '—', code: input.code });
  if (testMail) {
    if (!testMail.ready) return { sent: false, reason: 'email_not_connected' };
    if (testMail.refuse !== undefined) return { sent: false, reason: failureOf(testMail.refuse) };
    testMail.sent.push({ tenantId: input.tenantId, orgId: input.orgId, to: input.to, code: input.code, from, ...(fromName ? { fromName } : {}) });
    return { sent: true };
  }
  const provider = (await resolveEmailProvider({ tenantId: input.tenantId, purpose: 'transactional' })) ?? 'smtp';
  const result = await makeEmailAdapter({ storage: hostExtStorage(), tenantId: input.tenantId, runId: `share-verify:${input.idempotencyKey}` }).send({
    from, to: input.to, subject: m.subject, text: m.text,
    ...(fromName ? { fromName } : {}),
    provider, purpose: 'transactional', idempotencyKey: input.idempotencyKey,
  });
  return result.sent ? { sent: true } : { sent: false, reason: failureOf(result.error) };
}
