/**
 * `consent` namespace — user-facing copy for the Consent feature (ADR 0020).
 * Feature-self-contained: every consent string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  orgsEmptyClause: 'La politique de consentement appartient à une organisation',
  orgsFailedClause: 'La politique de consentement n’a jamais été demandée',
  // Page chrome
  eyebrow: 'Espace de travail',
  title: 'Consentement',
  lede: 'Politique de consentement adaptée à la région + outils relatifs aux personnes concernées (RGPD).',

  // Gating / empty states
  notEnabledTitle: 'Le consentement n’est pas activé',
  notEnabledBody: 'Tant que le consentement est désactivé, le consentement marketing n’est pas appliqué — seules la suppression et l’effacement le sont. Demandez à un administrateur d’activer la fonctionnalité Consentement pour ce locataire.',

  // aria-labels
  orgPickerLabel: 'Organisation',

  // Policy form
  regulatedRegionsLabel: 'Régions réglementées (séparées par des virgules)',
  regulatedRegionsNotEnforced: 'Informatif uniquement — aucune voie d’application ne lit cette liste. L’application repose sur le mode par défaut et le consentement enregistré de chaque sujet.',
  channel_email: 'E-mail',
  channel_sms: 'SMS',
  channel_push: 'Push',
  channel_whatsapp: 'WhatsApp',
  sourceLine: 'Capturé via {{source}}',
  legalBasisLine: 'Base : {{basis}}',
  purposesLine: 'Finalités : {{purposes}}',
  receiptFailedFeatures: 'Systèmes en échec : {{features}}.',
  regulatedRegionsPlaceholder: 'UE, CA',
  defaultModeLabel: 'Mode par défaut',
  defaultModeOptInLabel: 'consentement explicite (refus par défaut)',
  defaultModeOptOutLabel: 'désinscription',
  savePolicy: 'Enregistrer la politique',

  // Data subject (GDPR)
  dataSubjectTitle: 'Personne concernée (RGPD)',
  subjectKeyLabel: 'Clé du sujet',
  subjectKeyPlaceholder: 'cookie visiteur / id utilisateur',
  lookup: 'Rechercher',
  erase: 'Effacer',
  eraseConfirm: 'Effacer toutes les données du sujet "{{subjectKey}}" ? Suppression de la personne concernée (RGPD) — irréversible.',
  lookupNoRecord: 'Aucun enregistrement de consentement pour ce sujet — les données en aval (le cas échéant) sont tout de même effacées.',

  legalHoldTitle: 'Cet espace de travail est sous conservation l\u00e9gale',
  legalHoldBody: "L'effacement est bloqu\u00e9 tant que la conservation est en vigueur : une action en justice ou une obligation de conservation prime sur le droit \u00e0 l'effacement. Motif : {{reason}}. En vigueur depuis {{since}}. Un superadministrateur doit lever la conservation avant qu'une suppression de personne concern\u00e9e puisse s'ex\u00e9cuter.",
  legalHoldEraseDisabled: "L'effacement est bloqu\u00e9 par une conservation l\u00e9gale sur cet espace de travail.",
  eraseFailedHeld: "Effacement refus\u00e9 : cet espace de travail est sous conservation l\u00e9gale.",
  retryErasure: 'Relancer l\u2019effacement',
  lookupResultFor: 'Consentement de \u00ab {{subjectKey}} \u00bb',
  lookupFailedTitle: 'Impossible de lire le consentement de cette personne',
  lookupFailedBody: 'La lecture de \u00ab {{subjectKey}} \u00bb a \u00e9chou\u00e9 : rien n\u2019est encore connu \u00e0 son sujet. Ce n\u2019est pas la m\u00eame chose que l\u2019absence d\u2019enregistrement de consentement \u2014 relancez avant de conclure quoi que ce soit.',
  // Category chips
  categoryAnalytics: 'analytique',
  categoryMarketing: 'marketing',
  categoryNecessaryOnly: 'strictement nécessaire',

  // Consent records
  recordsTitle: 'Enregistrements de consentement',
  noRecords: 'Aucun enregistrement de consentement pour l’instant.',

  // Toasts — success
  policySaved: 'Politique enregistrée',
  eraseConfirmBody: "Tous les magasins de fonctionnalit\u00e9s enregistr\u00e9s sont parcourus, sur l'ensemble des cl\u00e9s d'identit\u00e9 li\u00e9es de cette personne. Tout n'est pas d\u00e9truit : ses propres donn\u00e9es sont SUPPRIM\u00c9ES ; les lignes dont l'espace de travail a encore besoin (appartenances d'acc\u00e8s, versions de documents, t\u00e2ches planifi\u00e9es) sont ANONYMIS\u00c9ES sur place \u2014 la ligne subsiste, identifiants et textes r\u00e9dig\u00e9s par la personne \u00e9tant \u00e9cras\u00e9s ; et les enregistrements que la loi impose de conserver, comme les commandes et les factures, sont CONSERV\u00c9S avec les \u00e9l\u00e9ments personnels caviard\u00e9s (montants, identifiants et r\u00e9gion approximative sont maintenus). L’effacement bloque aussi définitivement les envois marketing et toute réinscription publique de cette personne jusqu’à ce qu’un administrateur la réadmette. Action irr\u00e9versible.",
  receiptOk: 'Effacement termin\u00e9 pour \u00ab {{subjectKey}} \u00bb sur {{keys}} cl\u00e9(s) d\u2019identit\u00e9 li\u00e9e(s) ; les {{total}} magasin(s) ont signal\u00e9 une r\u00e9ussite \u2014 donn\u00e9es supprim\u00e9es ou anonymis\u00e9es sur place, les enregistrements \u00e0 conservation l\u00e9gale (commandes, factures) \u00e9tant conserv\u00e9s sous forme caviard\u00e9e. Les envois marketing et toute réinscription publique de cette personne sont désormais bloqués définitivement jusqu’à ce qu’un administrateur la réadmette.',
  receiptPartial: 'Effacement partiel de « {{subjectKey}} » : {{failed}} étape(s) d’effacement ont échoué (sur {{total}} magasins + la résolution des liens d’identité) — les données de cette personne PEUVENT subsister.',
  receiptFoundNothing: 'L’effacement de « {{subjectKey}} » s’est exécuté sans erreur mais n’a RIEN trouvé à effacer dans cet espace de travail ({{keys}} clé(s) d’identité liée(s) vérifiées sur {{total}} magasins). L’effacement n’atteint que les données de cet espace de travail — si cette personne existe ailleurs, ses données personnelles peuvent se trouver dans son espace de travail personnel ; lancez aussi l’effacement là-bas. Les envois marketing et toute réinscription publique de cette personne sont désormais bloqués ici définitivement jusqu’à ce qu’un administrateur la réadmette.',
  receiptHadRecord: "Un enregistrement de consentement était présent et a été supprimé.",
  receiptNoRecord: "Aucun enregistrement de consentement n'était présent.",
  receiptRetry: "L'effacement est idempotent — relancez-le ; s'il échoue encore, escaladez avant de déclarer la demande traitée.",
  receiptMissing: 'Attendus mais non enregistrés sur cet hôte : {{features}}.',
  receiptRowsTouched: '{{count}} ligne(s) supprimée(s) ou nettoyée(s).',
  eraseRefusedHeldTitle: 'Effacement refusé — conservation légale',
  eraseRefusedHeldBody: 'L’effacement de « {{subjectKey}} » a été refusé : cet espace de travail est sous conservation légale. Rien n’a été supprimé. Un superadministrateur de l’espace de travail doit lever la conservation avant que cette demande puisse s’exécuter.',
  readmitButton: 'Réadmettre la personne',
  readmitHintAfterErasure: 'Si cette personne demande plus tard à revenir, un administrateur peut la réadmettre. Cela lève uniquement le blocage : aucun consentement n’est accordé tant qu’elle n’a pas de nouveau donné son accord.',
  readmitHintNoRecord: 'Si cette personne a été effacée et a demandé à revenir, un administrateur peut la réadmettre. Cela lève uniquement le blocage : aucun consentement n’est accordé tant qu’elle n’a pas de nouveau donné son accord.',
  readmitDialogTitle: 'Réadmettre « {{subjectKey}} » ?',
  readmitDialogBody: 'Cela lève le blocage d’effacement sur les envois marketing et la réinscription publique de cette personne. En soi, cela n’accorde rien : aucun consentement n’est enregistré ; c’est son prochain accord explicite qui le rétablit. Votre déclaration ci-dessous atteste que la personne a demandé à revenir ; elle est inscrite au journal d’audit.',
  readmitAttestationLabel: 'Votre déclaration que cette personne a demandé à revenir',
  readmitAttestationPlaceholder: 'p. ex. A demandé par e-mail le 11 sept. à recevoir de nouveau notre lettre ; ticket n° 4821.',
  readmitAttestationHint: '{{count}} caractères sur {{min}} au minimum',
  readmitConfirm: 'Réadmettre',
  readmitDone: '« {{subjectKey}} » a été réadmis(e). Aucun consentement n’a été accordé — son prochain accord explicite le rétablit.',
  readmitNotErased: '« {{subjectKey}} » n’est pas effacé(e) sur cet hôte — il n’y avait aucun blocage à lever.',
  readmitFailed: 'La réadmission a échoué.',
  readmitForbidden: 'Seul un administrateur de l’espace de travail peut réadmettre une personne.',
  readmitAttestationTooShort: 'La déclaration doit comporter au moins {{min}} caractères.',

  // Toasts / errors
  loadPolicyFailed: 'Échec du chargement de la politique.',
  policyLoadRetry: 'Réessayer',
  policyLoadFailedTitle: 'Impossible de charger la politique de consentement',
  saveFailed: 'Échec de l’enregistrement.',
  lookupFailed: 'Échec de la recherche.',
  eraseFailed: 'Échec de l’effacement.',
  // §4.5 collection kit — records filtering + designed empty/zero-match states
  recordsFilterGroup: 'Filtrer',
  recordsSearchPlaceholder: 'Rechercher par sujet…',
  recordsSearchAria: 'Rechercher des enregistrements de consentement par sujet',
  categoryFacetAria: 'Filtrer par catégorie',
  categoryAll: 'Toutes les catégories',
  regionFacetAria: 'Filtrer par région',
  regionAll: 'Toutes les régions',
  noRecordsTitle: 'Aucun enregistrement de consentement pour le moment',
  recordsLoadFailedTitle: 'Impossible de charger les enregistrements de consentement',
  recordsLoadFailedBody: 'La lecture des enregistrements a échoué — cette liste n’est PAS vide tant qu’une lecture réussie ne le confirme pas.',
  unsavedChanges: 'Modifications non enregistrées',
  nothingToSave: 'Aucune modification à enregistrer',
  discardEditsTitle: 'Abandonner les modifications de politique non enregistrées ?',
  discardEditsBody: 'Changer d’espace de travail abandonnera vos modifications non enregistrées de la politique de consentement.',
  discardEditsConfirm: 'Abandonner et changer',
  recordsNoMatchTitle: 'Aucune correspondance',
  recordsNoMatchBody: 'Aucun enregistrement de consentement ne correspond aux filtres actuels.',
  recordsClearFilters: 'Effacer les filtres',
} as const;
