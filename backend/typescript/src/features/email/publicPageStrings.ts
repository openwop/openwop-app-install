/**
 * CMPUX-16 — localized strings for the PUBLIC email pages (unsubscribe + the
 * preference center). Server-rendered, self-contained HTML opened from the
 * recipient's mail client, so the locale is negotiated from the request's
 * `Accept-Language` at CLICK time (the recipient's real browser preference) —
 * NOT stored on the token (no recipient-locale field exists; the browser signal
 * is more accurate than a campaign-composed language anyway).
 *
 * Feature-LOCAL catalog (ADR 0001): these are email-feature UI strings, so they
 * live here, not in core `host/i18n` (which stays negotiation + error-envelope
 * only, "imports nothing under features/"). Mirrors the `errorMessages.ts`
 * `key → locale → string` catalog pattern. English is the guaranteed fallback.
 */
import { negotiateLocale, hostSupportedLocales, hostDefaultLocale } from '../../host/i18n/index.js';

export type PublicPageKey =
  | 'unsubscribeTitle'
  | 'unsubscribedStatus'
  | 'changedYourMind'
  | 'managePreferences'
  | 'unsubscribePrompt'
  | 'unsubscribePromptOnly'
  | 'chooseMessages'
  | 'insteadSuffix'
  | 'linkProblemTitle'
  | 'linkProblemNextStep'
  | 'unknownUnsubscribeLink'
  | 'unknownPreferencesLink'
  | 'crossOriginRejected'
  | 'unsubscribeButton'
  | 'unsubscribeFailedStatus'
  | 'unsubscribeRetryButton'
  | 'preferencesTitle'
  | 'preferencesLede'
  | 'preferencesSaved'
  | 'preferencesPartial'
  | 'preferencesRefusedStale'
  | 'preferencesRefusedSuppressed'
  | 'preferencesRefusedErased'
  | 'preferencesRefusedNextStep'
  | 'savePreferences'
  | 'marketingTypesLegend'
  | 'channel_email'
  | 'channel_sms'
  | 'channel_push';

/** The locales this catalog ships. English is always present + the fallback. */
const PUBLIC_PAGE_LOCALES = ['en', 'es', 'fr', 'pt-BR'] as const;

const STRINGS: Record<PublicPageKey, Record<string, string>> = {
  unsubscribeTitle: {
    en: 'Unsubscribe', es: 'Cancelar suscripción', fr: 'Se désabonner', 'pt-BR': 'Cancelar inscrição',
  },
  unsubscribedStatus: {
    en: 'You are unsubscribed. No further marketing email will be sent to this address.',
    es: 'Has cancelado la suscripción. No se enviarán más correos de marketing a esta dirección.',
    fr: 'Vous êtes désabonné. Aucun autre e-mail marketing ne sera envoyé à cette adresse.',
    'pt-BR': 'Sua inscrição foi cancelada. Nenhum outro e-mail de marketing será enviado para este endereço.',
  },
  changedYourMind: {
    en: 'Changed your mind?', es: '¿Cambiaste de opinión?', fr: 'Vous avez changé d\'avis ?', 'pt-BR': 'Mudou de ideia?',
  },
  managePreferences: {
    en: 'Manage your preferences', es: 'Gestiona tus preferencias', fr: 'Gérer vos préférences', 'pt-BR': 'Gerenciar suas preferências',
  },
  unsubscribePrompt: {
    en: 'Unsubscribe this address from all marketing email? You can also',
    es: '¿Cancelar la suscripción de esta dirección a todos los correos de marketing? También puedes',
    fr: 'Désabonner cette adresse de tous les e-mails marketing ? Vous pouvez aussi',
    'pt-BR': 'Cancelar a inscrição deste endereço em todos os e-mails de marketing? Você também pode',
  },
  // EM-UX-2: used when no sibling preferences token exists, so the page offers
  // no per-channel link at all rather than a dead one.
  unsubscribePromptOnly: {
    en: 'Unsubscribe this address from all marketing email?',
    es: '¿Cancelar la suscripción de esta dirección a todos los correos de marketing?',
    fr: 'Désabonner cette adresse de tous les e-mails marketing ?',
    'pt-BR': 'Cancelar a inscrição deste endereço em todos os e-mails de marketing?',
  },
  // EM-UX-2: the public lane's refusals, localized and styled like every other
  // page on this surface instead of a bare `text/plain` sentence.
  linkProblemTitle: {
    en: 'This link did not work', es: 'Este enlace no funcionó', fr: 'Ce lien n\'a pas fonctionné', 'pt-BR': 'Este link não funcionou',
  },
  linkProblemNextStep: {
    en: 'Open the most recent email you received from this sender and use the unsubscribe link there. If it keeps failing, reply to that email and ask to be removed — the sender is required to honour it.',
    es: 'Abre el correo más reciente que recibiste de este remitente y usa el enlace de baja que contiene. Si sigue fallando, responde a ese correo y pide que te eliminen: el remitente está obligado a cumplirlo.',
    fr: 'Ouvrez l\'e-mail le plus récent reçu de cet expéditeur et utilisez son lien de désabonnement. Si cela échoue toujours, répondez à cet e-mail et demandez votre retrait — l\'expéditeur est tenu d\'y donner suite.',
    'pt-BR': 'Abra o e-mail mais recente que você recebeu deste remetente e use o link de cancelamento nele. Se continuar falhando, responda a esse e-mail e peça para ser removido — o remetente é obrigado a atender.',
  },
  unknownUnsubscribeLink: {
    en: 'We do not recognise this unsubscribe link. It may have been truncated by your mail client, or it may belong to a message that is no longer active.',
    es: 'No reconocemos este enlace de baja. Puede que tu cliente de correo lo haya truncado, o que pertenezca a un mensaje que ya no está activo.',
    fr: 'Nous ne reconnaissons pas ce lien de désabonnement. Il a peut-être été tronqué par votre messagerie, ou il appartient à un message qui n\'est plus actif.',
    'pt-BR': 'Não reconhecemos este link de cancelamento. Ele pode ter sido truncado pelo seu cliente de e-mail, ou pertencer a uma mensagem que não está mais ativa.',
  },
  unknownPreferencesLink: {
    en: 'We do not recognise this preferences link. It may have been truncated by your mail client, or it may belong to a message that is no longer active.',
    es: 'No reconocemos este enlace de preferencias. Puede que tu cliente de correo lo haya truncado, o que pertenezca a un mensaje que ya no está activo.',
    fr: 'Nous ne reconnaissons pas ce lien de préférences. Il a peut-être été tronqué par votre messagerie, ou il appartient à un message qui n\'est plus actif.',
    'pt-BR': 'Não reconhecemos este link de preferências. Ele pode ter sido truncado pelo seu cliente de e-mail, ou pertencer a uma mensagem que não está mais ativa.',
  },
  crossOriginRejected: {
    en: 'This request did not come from a page we serve, so we did not act on it. Open the link from your email directly.',
    es: 'Esta solicitud no provino de una página que servimos, así que no la procesamos. Abre el enlace directamente desde tu correo.',
    fr: 'Cette requête ne provient pas d\'une page que nous servons, nous ne l\'avons donc pas traitée. Ouvrez le lien directement depuis votre e-mail.',
    'pt-BR': 'Esta solicitação não veio de uma página que servimos, então não a processamos. Abra o link diretamente do seu e-mail.',
  },
  chooseMessages: {
    en: 'choose which messages to receive', es: 'elegir qué mensajes recibir', fr: 'choisir les messages à recevoir', 'pt-BR': 'escolher quais mensagens receber',
  },
  insteadSuffix: {
    en: 'instead.', es: 'en su lugar.', fr: 'à la place.', 'pt-BR': 'em vez disso.',
  },
  unsubscribeButton: {
    en: 'Unsubscribe', es: 'Cancelar suscripción', fr: 'Se désabonner', 'pt-BR': 'Cancelar inscrição',
  },
  // EM-2/EM-UX-1: the honest failure state. It must NOT imply the recipient is
  // off the list — the whole defect was a page that said they were when they
  // were not — and it must point at the retry the page now offers.
  unsubscribeFailedStatus: {
    en: 'We could not complete your unsubscribe. You have NOT been removed from this list yet — please try again.',
    es: 'No pudimos completar la cancelación de tu suscripción. Todavía NO se te ha eliminado de esta lista; inténtalo de nuevo.',
    fr: 'Nous n\'avons pas pu finaliser votre désabonnement. Vous n\'avez PAS encore été retiré de cette liste — veuillez réessayer.',
    'pt-BR': 'Não conseguimos concluir o cancelamento da sua inscrição. Você ainda NÃO foi removido desta lista — tente novamente.',
  },
  unsubscribeRetryButton: {
    en: 'Try again', es: 'Intentar de nuevo', fr: 'Réessayer', 'pt-BR': 'Tentar novamente',
  },
  preferencesTitle: {
    en: 'Communication preferences', es: 'Preferencias de comunicación', fr: 'Préférences de communication', 'pt-BR': 'Preferências de comunicação',
  },
  preferencesLede: {
    en: 'Choose which kinds of marketing messages you want to receive. Unchecking everything unsubscribes you completely.',
    es: 'Elige qué tipos de mensajes de marketing quieres recibir. Al desmarcar todo, cancelas la suscripción por completo.',
    fr: 'Choisissez les types de messages marketing que vous souhaitez recevoir. Tout décocher vous désabonne complètement.',
    'pt-BR': 'Escolha quais tipos de mensagens de marketing você deseja receber. Desmarcar tudo cancela sua inscrição completamente.',
  },
  preferencesSaved: {
    en: 'Your preferences have been saved.', es: 'Tus preferencias se han guardado.', fr: 'Vos préférences ont été enregistrées.', 'pt-BR': 'Suas preferências foram salvas.',
  },
  // EM-2: the all-off (full opt-out) path whose suppression overlay did not
  // persist. The channel choices ARE recorded; the complete opt-out is not.
  preferencesPartial: {
    en: 'Your choices were recorded, but we could not complete the full opt-out. Please save again to make sure it takes effect.',
    es: 'Tus opciones se registraron, pero no pudimos completar la baja total. Guarda de nuevo para asegurarte de que se aplique.',
    fr: 'Vos choix ont été enregistrés, mais nous n\'avons pas pu finaliser le désabonnement complet. Enregistrez à nouveau pour qu\'il prenne effet.',
    'pt-BR': 'Suas escolhas foram registradas, mas não conseguimos concluir o cancelamento total. Salve novamente para garantir que tenha efeito.',
  },
  // ADR 0655 D3 / EM-UX-24 — a re-grant this link cannot make. Narrowing always
  // works; widening needs a FRESH link and an address not on a do-not-send list.
  // These never say "saved" over a choice that did not take effect (EM-UX-23).
  preferencesRefusedStale: {
    en: 'This link is too old to turn messages back on. Your other choices were not changed.',
    es: 'Este enlace es demasiado antiguo para volver a activar mensajes. Tus otras opciones no se han modificado.',
    fr: 'Ce lien est trop ancien pour réactiver des messages. Vos autres choix n\'ont pas été modifiés.',
    'pt-BR': 'Este link é antigo demais para reativar mensagens. Suas outras escolhas não foram alteradas.',
  },
  preferencesRefusedSuppressed: {
    en: 'Messages to this address cannot be turned back on from this link. Your other choices were not changed.',
    es: 'No es posible volver a activar mensajes para esta dirección desde este enlace. Tus otras opciones no se han modificado.',
    fr: 'Les messages vers cette adresse ne peuvent pas être réactivés depuis ce lien. Vos autres choix n\'ont pas été modifiés.',
    'pt-BR': 'Não é possível reativar mensagens para este endereço a partir deste link. Suas outras escolhas não foram alteradas.',
  },
  preferencesRefusedErased: {
    en: 'Your details were removed at your request, so there is nothing here to manage and messages cannot be turned back on from any link. If you want to hear from this sender again, they will need to re-admit you.',
    es: 'Tus datos se eliminaron a petición tuya, así que aquí no hay nada que gestionar y los mensajes no pueden reactivarse desde ningún enlace. Si quieres volver a recibir mensajes de este remitente, tendrá que readmitirte.',
    fr: 'Vos données ont été supprimées à votre demande : il n\'y a donc rien à gérer ici et les messages ne peuvent être réactivés depuis aucun lien. Pour recevoir à nouveau des messages de cet expéditeur, il devra vous réadmettre.',
    'pt-BR': 'Seus dados foram removidos a seu pedido, então não há nada para gerenciar aqui e as mensagens não podem ser reativadas por nenhum link. Se quiser voltar a receber mensagens deste remetente, ele precisará readmitir você.',
  },
  preferencesRefusedNextStep: {
    en: 'To receive messages again, reply to the sender and ask to be re-subscribed.',
    es: 'Para volver a recibir mensajes, responde al remitente y pide que te vuelvan a suscribir.',
    fr: 'Pour recevoir à nouveau des messages, répondez à l\'expéditeur et demandez à être réabonné.',
    'pt-BR': 'Para voltar a receber mensagens, responda ao remetente e peça para ser reinscrito.',
  },
  savePreferences: {
    en: 'Save preferences', es: 'Guardar preferencias', fr: 'Enregistrer les préférences', 'pt-BR': 'Salvar preferências',
  },
  marketingTypesLegend: {
    en: 'Marketing message types', es: 'Tipos de mensajes de marketing', fr: 'Types de messages marketing', 'pt-BR': 'Tipos de mensagens de marketing',
  },
  channel_email: {
    en: 'Email — campaign and lifecycle email',
    es: 'Correo electrónico — correos de campañas y de ciclo de vida',
    fr: 'E-mail — e-mails de campagne et de cycle de vie',
    'pt-BR': 'E-mail — e-mails de campanha e de ciclo de vida',
  },
  channel_sms: {
    en: 'SMS — text messages', es: 'SMS — mensajes de texto', fr: 'SMS — messages texte', 'pt-BR': 'SMS — mensagens de texto',
  },
  channel_push: {
    en: 'Push — app notifications', es: 'Push — notificaciones de la app', fr: 'Push — notifications de l\'application', 'pt-BR': 'Push — notificações do aplicativo',
  },
};

/** A locale-bound lookup: the requested locale's string, else English. */
export type PublicPageT = (key: PublicPageKey) => string;

export function publicPageBundle(locale: string): PublicPageT {
  return (key) => STRINGS[key][locale] ?? STRINGS[key].en;
}

/**
 * Resolve the public-page locale. `tokenLocale` is a forward hook (always
 * undefined today — no recipient-locale field exists): if a future feature
 * stores the email's composed language on the token, it wins as the explicit
 * signal; otherwise we negotiate from the recipient's `Accept-Language`.
 * The negotiation `supported` set is the catalog's locales ∩ what the operator
 * advertised (`hostSupportedLocales()`) — so an unconfigured host stays English
 * (the same honesty gate as the rest of host i18n), never half-translated.
 */
export function resolvePublicLocale(acceptLanguage: string | undefined, tokenLocale?: string): string {
  if (tokenLocale && (PUBLIC_PAGE_LOCALES as readonly string[]).includes(tokenLocale)) return tokenLocale;
  const advertised = new Set(hostSupportedLocales());
  const supported = (PUBLIC_PAGE_LOCALES as readonly string[]).filter((l) => advertised.has(l));
  const fallback = hostDefaultLocale();
  return negotiateLocale(acceptLanguage, supported, (PUBLIC_PAGE_LOCALES as readonly string[]).includes(fallback) ? fallback : 'en');
}
