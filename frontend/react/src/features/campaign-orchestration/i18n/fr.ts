/**
 * `campaign-studio` namespace (ADR 0158) — fr. Texte pour la page Campagnes.
 */
export const messages = {
  eyebrow: 'Marketing',
  title: 'Campagnes',
  lede: 'Lancez une campagne multicanal à partir d’un brief — le Stratège de campagne génère le noyau de message, chaque canal et un contrôle de cohérence, puis finalise la campagne ici.',
  notEnabledTitle: 'Campaign Studio n’est pas activé',
  notEnabledBody: 'Demandez à un administrateur de l’espace de travail d’activer la fonctionnalité Campaign Studio.',

  loading: 'Chargement des campagnes…',
  emptyTitle: 'Aucune campagne',
  emptyBody: 'Finalisez un brief confirmé en campagne, ou lancez-en une de bout en bout avec le Stratège de campagne.',
  runWithStrategist: 'Lancer avec le Stratège',
  finalizeBrief: 'Finaliser un brief',
  hasKernel: 'Noyau',
  channelsCount_one: '{{count}} canal',
  channelsCount_other: '{{count}} canaux',
  deleteTitle: 'Supprimer cette campagne ?',
  deleteBody: 'La campagne est supprimée. Le brief d’origine n’est pas touché. Action irréversible.',

  status_draft: 'Brouillon',
  status_active: 'Active',
  status_paused: 'En pause',
  status_completed: 'Terminée',
  status_archived: 'Archivée',

  finalizeHint: 'Choisissez un brief confirmé — une campagne en est créée (ou mise à jour). Une campagne par brief.',
  fieldOrg: 'Organisation',
  allOrgs: 'Toutes les organisations',
  fieldBrief: 'Brief',
  noBriefs: 'Aucun brief trouvé',
  finalize: 'Finaliser',

  backToCampaigns: 'Campagnes',
  statusLabel: 'Statut',
  kernelTitle: 'Noyau de message',
  kernelCta: 'CTA',
  kernelTone: 'Ton',
  noKernel: 'Cette campagne n’a pas encore de noyau de message.',
  channelsTitle: 'Canaux',
  noChannels: 'Aucun canal activé.',

  channel_landing_page: 'Page de destination',
  channel_ad_variants: 'Variantes d’annonce',
  channel_email_sequence: 'Séquence d’e-mails',
  channel_creative_briefs: 'Briefs créatifs',
  channel_social_posts: 'Publications sociales',
} as const;
