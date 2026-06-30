/**
 * `profile-memory` namespace — user-facing copy for the personal Memory (ADR 0041)
 * and personal Knowledge (ADR 0042) profile tabs. Both tabs and their clients share
 * this one catalog. Generic actions/states are reused from `common` via `t('common:…')`.
 */
export const messages = {
  // Knowledge tab (ProfileKnowledgeTab) — <Trans> intro with <strong> markup
  knowledgeIntro:
    'Joignez des <0>documents</0> à votre profil — des sources citées sur lesquelles votre jumeau numérique peut s\'appuyer, aux côtés des faits de votre onglet Mémoire. Privés, réservés à vous.',
  knowledgeEmptyBody: 'Créez une source ci-dessus, puis ajoutez des documents que votre jumeau peut citer.',
  knowledgeSearchTitle: 'Rechercher dans vos connaissances',
  knowledgeSearchPlaceholder: 'Que se rappellerait votre jumeau ?',

  // Memory tab (ProfileMemoryTab) — <Trans> intro with <strong> markup
  memoryIntro:
    'Entraînez votre profil avec des mémoires personnelles — faits, préférences et contexte sur votre façon de travailler. Au fil du temps, cela devient un <0>jumeau numérique</0> de vous. Durable et privé, réservé à vous.',
  memoryAddPlaceholder: 'Je préfère les mises à jour asynchrones aux réunions ; mes heures de concentration sont de 9 h à 11 h.',
  memoryEmptyBody: 'Commencez à entraîner votre jumeau : ajoutez un fait ou une préférence sur votre façon de travailler.',

  // Consentement à l’extraction automatique (ADR 0120)
  consentLabel: 'Apprendre automatiquement des faits durables à partir de mes discussions',
  consentHint: 'Lorsque c’est activé, votre assistant peut enregistrer comme mémoires les faits durables qu’il apprend pendant les discussions — que vous pouvez consulter et supprimer à tout moment. Désactivé par défaut.',
  consentError: 'Impossible de mettre à jour le paramètre d’apprentissage de la mémoire.',
} as const;
