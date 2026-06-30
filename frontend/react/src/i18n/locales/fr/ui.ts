/**
 * `ui` namespace — core cross-cutting strings for the app ui surface.
 * Populated as strings are externalized (ADR 0065 Phase 2).
 */
export const messages = {
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
  cmdkActReseedLabel: 'Réinitialiser les données d\'exemple',
  cmdkActReseedHint: 'Réinitialiser la liste d\'exemple intégrée',
  // Toast
  toastDismiss: 'Ignorer',
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
  tableSelectHeader: 'Sélectionner',
  tableSelectAll: 'Tout sélectionner',
  tableDeselectAll: 'Tout désélectionner',
  tableSelectRow: 'Sélectionner la ligne',
  tableSortBy: 'Trier par {{column}}',
  tableDensityLabel: 'Densité des lignes',
  tableDensityComfortable: 'Confortable',
  tableDensityCompact: 'Compacte',
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
  illustrativeDetail: 'Données d\'exemple illustratives — non issues d\'enregistrements réels',
  // KeyFigureBand
  keyFiguresLabel: 'Chiffres clés',
  // ViewToggle (grid/list collection switch)
  viewToggleLabel: 'Afficher en grille ou en liste',
  viewGrid: 'Grille',
  viewList: 'Liste',
} as const;
