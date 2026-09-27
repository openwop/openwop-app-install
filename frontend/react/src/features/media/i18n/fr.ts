/**
 * `media` namespace — user-facing copy for the media library feature.
 * Feature-self-contained: every media string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Plateforme',
  title: 'Médiathèque',
  lede: 'Ressources et collections rattachées à l’organisation.',

  // Gating / empty states
  notEnabledTitle: 'La médiathèque n’est pas activée',
  notEnabledBody: 'Demandez à un administrateur d’activer la fonctionnalité Média pour ce locataire.',
  noOrgsTitle: 'Aucune organisation',
  noOrgsBody: 'Créez d’abord une organisation — les collections de médias appartiennent à une organisation.',
  noAssetsTitle: 'Aucune ressource',
  noAssetsBody: 'Téléversez un fichier pour démarrer cette collection.',
  orgsFailedTitle: 'Impossible de charger les organisations',
  orgsFailedBody: 'La lecture des organisations a échoué ; la médiathèque ne peut pas encore être ouverte.',
  collectionsFailedTitle: 'Impossible de charger les collections',
  collectionsFailedBody: 'La lecture des collections a échoué. Cela ne signifie pas que l’organisation n’en possède aucune.',

  // aria-labels
  orgPickerLabel: 'Organisation',

  // Collections sidebar
  collectionsHeading: 'Collections',
  allAssets: 'Toutes les ressources',
  uncategorized: 'Non catégorisé',
  deleteCollectionLabel: 'Supprimer la collection',
  newCollectionPlaceholder: 'Nouvelle collection',

  // Assets toolbar
  searchPlaceholder: 'Rechercher par nom…',
  upload: 'Téléverser',
  deleteAssetLabel: 'Supprimer la ressource',
  assetResultsLabel: 'Ressources multimédias',

  // Asset-list filterbar + grid/list toggle
  filterGroup: 'Filtrer les ressources',
  filterAria: 'Filtrer les ressources par nom',
  noMatchTitle: 'Aucune ressource correspondante',
  noMatchBody: 'Aucune ressource ne correspond à votre recherche. Essayez un autre terme.',
  clearSearch: 'Effacer la recherche',

  // Asset usage badge ({{used}} is the locale-formatted count; {{count}} drives plural selection)
  usageCount_one: 'utilisé {{used}}×',
  usageCount_other: 'utilisé {{used}}×',
  unused: 'inutilisé',

  // Toasts — success / info
  collectionCreated: 'Collection créée.',
  collectionDeleted: 'Collection supprimée (ressources réaffectées).',
  assetDeleted: '{{name}} supprimé. Le focus a été déplacé vers la liste des ressources.',
  uploaded: '{{name}} téléversé.',

  // Toasts / errors
  loadOrgsFailed: 'Échec du chargement des organisations.',
  loadAssetsFailed: 'Échec du chargement des ressources.',
  assetsFailedTitle: 'Impossible de charger les ressources',
  assetsFailedBody: 'La bibliothèque est indisponible pour le moment — lecture en échec, pas une bibliothèque vide.',
  createFailed: 'Échec de la création.',
  deleteFailed: 'Échec de la suppression.',
  uploadFailed: 'Échec du téléversement.',
  deleteAssetConfirm: 'Supprimer cette ressource ? Cette action est irréversible.',
  deleteCollectionConfirm: 'Supprimer la collection « {{name}} » ?',

  // Media picker dialog (ADR 0206 B4)
  pickerTitle: 'Choisir une ressource',
  pickerSearchPlaceholder: 'Rechercher des ressources…',
  pickerUpload: 'Téléverser',
  pickerEmptyTitle: 'Aucune ressource trouvée',
  pickerLoadFailedTitle: 'Impossible de charger vos médias',
  pickerLoadFailedBody: 'La lecture de la bibliothèque a échoué — elle n’est pas vide tant qu’une lecture réussie ne le confirme pas.',
  pickerEmpty: 'Téléversez-en une pour commencer, ou ajustez la recherche.',
  pickerChooseAria: 'Choisir {{name}}',
  pickerUploaded: '« {{name}} » téléversé.',
  pickerUploadFailed: 'Échec du téléversement.',

  // "Used by" (ADR 0206 B4 usage refs)
  usedByLabel: 'Où est-ce utilisé ?',
  usedByTitle: 'Utilisé par — {{name}}',
  usedByFailed: 'Impossible de vérifier où ce média est utilisé. Ce n’est PAS une confirmation qu’il est inutilisé — le supprimer pourrait tout de même casser une page.',
  usedByFailedTitle: 'Impossible de vérifier l’utilisation',
  usedByEmpty: 'Référencé par aucune page.',
  usedByKindCmsPage: 'Page du CMS',
  usedByKindCampaign: 'Campagne',
  usedByKindCreativeBrief: 'Brief créatif',
  chooseImage: "Choisir une image",
  replaceImage: "Remplacer l’image",
  clearImage: "Effacer {{field}}",
  useImageUrl: "Utiliser une URL d’image",
  imageUrl: "URL de l’image pour {{field}}",
  imageUrlPlaceholder: "https://exemple.com/image.jpg",
  applyUrl: "Appliquer",
  cancelUrl: "Annuler",

  // ADR 0363 P1 — texte alternatif
  altEditLabel: 'Modifier le texte alternatif',
  altPresentLabel: 'Avec texte alternatif',
  altMissingLabel: 'Sans texte alternatif',
  altDecorativeChip: 'Décorative',
  altDialogTitle: 'Texte alternatif — {{name}}',
  altDialogHelp: 'Le texte alternatif décrit une image pour les utilisateurs de lecteurs d’écran. Rédigez une description concise, générez-la avec l’IA ou marquez l’image comme décorative.',
  altTextLabel: 'Texte alternatif',
  altTextPlaceholder: 'p. ex. Un barista versant un latte art dans un café ensoleillé',
  altCharCount: '{{n}} / {{max}}',
  altDecorativeLabel: 'Cette image est décorative (sans texte alternatif)',
  altGenerate: 'Générer avec l’IA',
  altGenerating: 'Génération…',
  altGenerated: 'Texte alternatif suggéré.',
  altGeneratedDecorative: 'L’image semble décorative — marquée ainsi (sans texte alternatif).',
  altGenerateError: 'Impossible de générer le texte alternatif.',
  altSaveError: 'Impossible d’enregistrer le texte alternatif.',

  // ADR 0401 — AI image generation
  generateImage: 'Générer avec l\u2019IA',
  generateDialogTitle: 'Générer une image',
  generateLoadFailed: 'Impossible de charger les fournisseurs d\u2019images.',
  generateNoProviderTitle: 'Aucun fournisseur d\u2019images connecté',
  generateNoProviderBody: 'Ajoutez une clé API OpenAI ou Google à votre espace de travail pour générer des images. Votre clé reste sur le serveur et n\u2019est jamais envoyée au navigateur.',
  generateOpenProviders: 'Ouvrir Fournisseurs',
  generatePrompt: 'Prompt',
  generatePromptPlaceholder: 'Décrivez l\u2019image souhaitée…',
  generateProvider: 'Fournisseur',
  generateSize: 'Taille',
  generateModel: 'Modèle (facultatif)',
  generateModelPlaceholder: 'Défaut du fournisseur',
  generateAction: 'Générer',
  generating: 'Génération…',
  generateFailed: 'La génération de l\u2019image a échoué.',
  generateResultAlt: 'Aperçu de l\u2019image générée',
  generateUseImage: 'Utiliser cette image',
  generateRetry: 'Régénérer',

  // ADR 0401 P3 — AI image editing
  editImageAi: 'Modifier avec l\u2019IA',
  editDialogTitle: 'Modifier l\u2019image avec l\u2019IA',
  editOpPickerLabel: 'Opération d\u2019édition',
  editOp_edit: 'Modifier',
  editOp_inpaint: 'Remplissage génératif',
  'editOp_background-remove': 'Supprimer le fond',
  editOp_upscale: 'Agrandir',
  editOpUnsupported: 'Non pris en charge par {{provider}}',
  editPromptPlaceholder: 'Décrivez la modification…',
  editInpaintPromptPlaceholder: 'Décrivez ce qu\u2019il faut peindre dans la zone marquée…',
  editMaskHint: 'Peignez la zone à repeindre.',
  editMaskClear: 'Effacer le masque',
  editMaskRequired: 'Peignez d\u2019abord un masque sur la zone à remplir.',
  editScaleLabel: 'Facteur d\u2019agrandissement',
  editApply: 'Appliquer',
  editApplying: 'Application…',
  editFailed: 'La modification de l\u2019image a échoué.',
  editResultAlt: 'Aperçu de l\u2019image modifiée',
  editNotLibraryTitle: 'Pas une image de la médiathèque',
  editNotLibraryBody: 'L\u2019édition IA fonctionne avec les images de votre médiathèque. Les URL externes peuvent être remplacées via Générer ou le sélecteur.',

  // UXB-1 — rectangle mask mode (keyboard-accessible inpaint masking)
  maskModeLabel: 'Mode de masque',
  maskModeBrush: 'Pinceau',
  maskModeRect: 'Rectangle',
  editMaskRectHint: 'Tracez un rectangle sur la zone à repeindre, ou ajoutez-en un par valeurs ci-dessous.',
  maskRectX: 'X (%)',
  maskRectY: 'Y (%)',
  maskRectW: 'Largeur (%)',
  maskRectH: 'Hauteur (%)',
  maskRectAdd: 'Ajouter une zone',
  maskRectListLabel: 'Zones du masque',
  maskRectItem: 'Zone {{n}} : {{x}} %, {{y}} % · {{w}}×{{h}} %',
  maskRectRemove: 'Retirer la zone {{n}}',
  editOpsSupported: '{{provider}} prend en charge : {{ops}}',
  editOpsNone: 'aucune opération d\u2019édition',
  generateLoadFailedTitle: "Impossible de vérifier vos fournisseurs d'images",
  generateLoadFailedBody: "La requête n'a pas abouti : nous ne pouvons pas dire quels fournisseurs sont connectés. Cela ne signifie PAS qu'il n'y en a aucun.",
  editSourceLookupFailed: "Votre médiathèque n'a pas pu être lue ; cette image n'a pas pu être associée à un élément.",
  retry: "Réessayer",
  editSourceLookupFailedTitle: "Impossible de lire votre médiathèque",
} as const;
