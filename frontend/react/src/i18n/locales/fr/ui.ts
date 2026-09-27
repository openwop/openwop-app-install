/**
 * `ui` namespace — core cross-cutting strings for the app ui surface.
 * Populated as strings are externalized (ADR 0065 Phase 2).
 */
export const messages = {

  // OrgSelectionState (HG-4) — the ONE noun + the ONE branch order.
  orgStateFailedTitle: 'Impossible de charger vos organisations',
  // « compte vide » désignait la FACTURATION, pas cette collection — cf. le catalogue en.
  orgStateFailedBody: 'Il s’agit d’une lecture en échec, pas d’une liste d’organisations vide.',
  orgStateFailedBodyWith: '{{what}}. Il s’agit d’une lecture en échec, pas d’une liste d’organisations vide.',
  orgStateEmptyTitle: 'Aucune organisation',
  // Ni instruction (c’est le CTA qui la porte) ni substantif (c’est la clause qui
  // le porte) : « Créez d’abord une organisation — … appartiennent à une
  // organisation. » le nommait deux fois. Cf. le catalogue en.
  orgStateEmptyBody: '{{what}}.',
  orgStateEmptyAction: 'Créer une organisation',
  orgStateEmptyAskAdmin: 'Demandez à un administrateur d’en créer une.',
  orgStateInlineSentence: '{{title}}. {{body}}',
  orgStateRetry: 'Réessayer',
  orgPickerLabel: 'Organisation',
  orgPickerGroupLabel: 'Organisations',
  orgPickerLoading: 'Chargement des organisations…',
  // CommandPalette
  cmdkLabel: 'Palette de commandes',
  cmdkPlaceholder: 'Accéder à une page ou une action…',
  cmdkSearchLabel: 'Rechercher des commandes',
  cmdkEsc: 'échap',
  cmdkNoMatches: 'Aucun résultat pour « {{query}} ».',
  cmdkListLabel: 'Commandes',
  cmdkFootNavigate: 'naviguer',
  cmdkFootOpen: 'ouvrir',
  cmdkFootOpenStay: 'ouvrir · rester',
  cmdkFootToggle: 'basculer',
  cmdkActionsGroup: 'Actions',
  // CommandPalette quick actions
  cmdkActNewRunLabel: 'Créer une exécution',
  cmdkActNewRunHint: 'Soumettre un workflow sur cet hôte',
  cmdkActNewAgentLabel: 'Nouvel agent',
  cmdkActNewAgentHint: 'Créer un collègue IA nommé',
  cmdkActCompareLabel: 'Comparer des exécutions',
  cmdkActCompareHint: 'Comparer deux exécutions',
  cmdkActReseedLabel: 'Réinitialiser les données d’exemple',
  cmdkActReseedHint: 'Réinitialiser la liste d’exemple intégrée',
  // Toast
  toastDismiss: 'Ignorer',
  toastDismissAll: 'Tout ignorer ({{count}})',
  toastRegionLabel: 'Notifications',
  // ErrorBoundary
  errorTitle: 'Une erreur est survenue',
  errorBodyRegion: 'La zone {{region}} a rencontré une erreur inattendue. ',
  errorBodyGeneric: 'Cette vue a rencontré une erreur inattendue. ',
  errorBodyRecover: 'Vous pouvez recharger pour récupérer.',
  errorReload: 'Recharger',
  // ThemeToggle
  themeGroupLabel: 'Thème',
  themeSystem: 'Thème du système',
  themeLight: 'Thème clair',
  themeDark: 'Thème sombre',
  // DataTable
  tableBulkActionsLabel: 'Actions groupées',
  tableSelectedCount: '{{n}} sélectionné(s)',
  tableClear: 'Effacer',
  tableNoFilterMatches: 'Aucune ligne ne correspond à « {{query}} ».',
  tableFilterMatches_one: '{{n}} ligne correspond.',
  tableFilterMatches_other: '{{n}} lignes correspondent.',
  tableSelectHeader: 'Sélectionner',
  tableSelectAll: 'Tout sélectionner',
  tableDeselectAll: 'Tout désélectionner',
  tableSelectRow: 'Sélectionner la ligne',
  tableSortBy: 'Trier par {{column}}',
  // MarkdownEditor toolbar
  mdToolbarLabel: 'Mise en forme',
  mdBold: 'Gras',
  mdItalic: 'Italique',
  mdHeading: 'Titre',
  mdLink: 'Lien',
  mdBulletedList: 'Liste à puces',
  mdNumberedList: 'Liste numérotée',
  mdChecklist: 'Liste de cases à cocher',
  mdQuote: 'Citation',
  mdInlineCode: 'Code en ligne',
  mdCodeBlock: 'Bloc de code',
  // MarkdownEditor controls
  mdWrite: 'Rédiger',
  mdPreview: 'Aperçu',
  mdDraftSaved: 'Brouillon enregistré',
  mdDraftFound: 'Un brouillon non enregistré a été trouvé.',
  mdRestoreDraft: 'Restaurer le brouillon',
  mdDiscard: 'Abandonner',
  mdNothingToPreview: 'Rien à prévisualiser pour le moment.',
  mdMarkdownSupported: 'Markdown pris en charge',
  mdCharCount_one: '{{formatted}} caractère',
  mdCharCount_other: '{{formatted}} caractères',
  mdCharCountMax: '{{n}} / {{max}}',
  mdOverWarning: 'Au-delà des {{max}} caractères suggérés — envisagez de raccourcir.',
  // IllustrativeBadge
  illustrativeLabel: 'Illustratif',
  illustrativeDetail: 'Données d’exemple illustratives — non issues d’enregistrements réels',
  // KeyFigureBand
  keyFiguresLabel: 'Chiffres clés',
  // ViewToggle (grid/list collection switch)
  viewToggleLabel: 'Afficher en grille ou en liste',
  viewGrid: 'Grille',
  viewList: 'Liste',
  colorSwatches: "Couleurs du th\u00e8me",
  colorAccent: "Accent",
  colorText: "Texte",
  colorMuted: "Att\u00e9nu\u00e9",
  colorSuccess: "Succ\u00e8s",
  colorWarn: "Avertissement",
  colorDanger: "Danger",
  colorInfo: "Info",
  colorNone: "Aucun",
  colorRecent: "Couleur r\u00e9cente {{value}}",
  colorHexPlaceholder: "#rrggbb ou une couleur CSS",
  colorPickFromScreen: "Choisir une couleur \u00e0 l\u2019\u00e9cran",

  cmdkLocked: 'Verrouillé — déverrouillez-le dans la boutique de fonctionnalités',

  // FORM-UX-2 (ADR 0584) — la protection IN-APP contre la perte de modifications.
  unsavedLeaveTitle: 'Quitter sans enregistrer ?',
  unsavedLeaveBody: 'Les modifications non enregistrées de cette page seront abandonnées. Enregistrez d’abord pour les conserver.',
  unsavedLeaveConfirm: 'Abandonner les modifications',
} as const;
