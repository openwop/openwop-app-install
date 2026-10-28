/**
 * `profile-memory` namespace — user-facing copy for the personal Memory (ADR 0041)
 * and personal Knowledge (ADR 0042) profile tabs. Both tabs and their clients share
 * this one catalog. Generic actions/states are reused from `common` via `t('common:…')`.
 */
export const messages = {
  // Knowledge tab (ProfileKnowledgeTab) — <Trans> intro with <strong> markup
  knowledgeIntro:
    'Joignez des <0>documents</0> à votre profil — des sources sur lesquelles votre jumeau numérique peut s’appuyer, aux côtés des faits de votre onglet Mémoire.',
  knowledgeAudience:
    'Les documents résident dans votre espace de travail, pas dans un stockage privé : toute personne pouvant lire cet espace peut les ouvrir. Les notes de votre Mémoire sont différentes — celles-là restent les vôtres.',
  knowledgeEmptyBody: 'Créez une source ci-dessus, puis ajoutez des documents que votre jumeau peut citer.',
  knowledgeSearchTitle: 'Rechercher dans vos connaissances',
  knowledgeSearchPlaceholder: 'Que se rappellerait votre jumeau ?',

  // Memory tab (ProfileMemoryTab) — <Trans> intro with <strong> markup
  memoryIntro:
    'Entraînez votre profil avec des mémoires personnelles — faits, préférences et contexte sur votre façon de travailler. Au fil du temps, cela devient un <0>jumeau numérique</0> de vous. Durable et à vous seul, sauf si vous autorisez un agent à s’en souvenir.',
  memoryAddPlaceholder: 'Je préfère les mises à jour asynchrones aux réunions ; mes heures de concentration sont de 9 h à 11 h.',
  memoryEmptyBody: 'Commencez à entraîner votre jumeau : ajoutez un fait ou une préférence sur votre façon de travailler.',

  // Consentement à l’extraction automatique (ADR 0120)
  consentLabel: 'Apprendre automatiquement des faits durables à partir de mes discussions',
  consentHint: 'Lorsque c’est activé, chaque fois que vous démarrez une nouvelle discussion, votre assistant relit celle que vous venez de quitter et enregistre les faits durables que vous avez indiqués sur vous-même. Il ne lit que vos propres messages, et seulement les discussions de votre espace de travail personnel. Les faits appris figurent ci-dessous, marqués « Apprise automatiquement », et les assistants les traitent comme non vérifiés. En supprimer un empêche aussi qu’il soit appris de nouveau dans les mêmes termes. Désactiver cette option arrête l’apprentissage futur, mais ne supprime pas ce qui a déjà été appris. Désactivé par défaut.',
  consentUnavailable: 'Apprendre des discussions nécessite un espace de travail personnel, et ce compte n’en a pas.',
  consentSignIn: 'Connectez-vous pour que votre assistant apprenne des faits durables à partir de vos discussions.',
  consentTurnOff: 'Désactiver',
  removeLearnedConfirmBody: 'Supprimer ce fait appris ? Il ne sera plus rappelé, et il ne sera pas appris de nouveau dans les mêmes termes.',
  erasureScopeNote: 'La suppression des données de votre compte efface votre mémoire personnelle. Elle n’atteint pas ce qu’un agent partagé de l’espace de travail retient de vos échanges avec lui — cette mémoire appartient à l’espace de travail. Demandez à un administrateur d’effacer la mémoire de l’agent depuis son onglet Mémoire.',
  consentError: 'Impossible de mettre à jour le paramètre d’apprentissage de la mémoire.',
  consentLoadFailed: 'Impossible de savoir si l’apprentissage de mémoire est activé. Il peut être ACTIVÉ — ceci ne confirme pas qu’il est désactivé.',
  consentRetry: 'Réessayer',
} as const;
