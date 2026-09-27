/**
 * `media` namespace — user-facing copy for the media library feature.
 * Feature-self-contained: every media string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Platform',
  title: 'Media Library',
  lede: 'Org-scoped assets + collections.',

  // Gating / empty states
  notEnabledTitle: 'Media library is not enabled',
  notEnabledBody: 'Ask an administrator to enable the Media feature for this tenant.',
  noOrgsTitle: 'No organizations',
  noOrgsBody: 'Create an organization first — media collections belong to an org.',
  noAssetsTitle: 'No assets',
  noAssetsBody: 'Upload a file to start this collection.',
  orgsFailedTitle: 'Organizations could not be loaded',
  orgsFailedBody: 'The organization read failed, so the media library cannot be opened yet.',
  collectionsFailedTitle: 'Collections could not be loaded',
  collectionsFailedBody: 'The collection read failed. This does not mean the organization has no collections.',

  // aria-labels
  orgPickerLabel: 'Organization',

  // Collections sidebar
  collectionsHeading: 'Collections',
  allAssets: 'All assets',
  uncategorized: 'Uncategorized',
  deleteCollectionLabel: 'Delete collection',
  newCollectionPlaceholder: 'New collection',

  // Assets toolbar
  searchPlaceholder: 'Search by name…',
  upload: 'Upload',
  deleteAssetLabel: 'Delete asset',
  assetResultsLabel: 'Media assets',

  // Asset-list filterbar + grid/list toggle
  filterGroup: 'Filter assets',
  filterAria: 'Filter assets by name',
  noMatchTitle: 'No matching assets',
  noMatchBody: 'No asset matches your search. Try a different term.',
  clearSearch: 'Clear search',

  // Asset usage badge ({{used}} is the locale-formatted count; {{count}} drives plural selection)
  usageCount_one: 'used {{used}}×',
  usageCount_other: 'used {{used}}×',
  unused: 'unused',

  // Toasts — success / info
  collectionCreated: 'Collection created.',
  collectionDeleted: 'Collection deleted (assets re-homed).',
  assetDeleted: '{{name}} deleted. Focus moved to the asset list.',
  uploaded: 'Uploaded {{name}}.',

  // Toasts / errors
  loadOrgsFailed: 'Failed to load organizations.',
  loadAssetsFailed: 'Failed to load assets.',
  assetsFailedTitle: 'Assets could not be loaded',
  assetsFailedBody: 'The library is unavailable right now — this is a failed read, not an empty library.',
  createFailed: 'Create failed.',
  deleteFailed: 'Delete failed.',
  uploadFailed: 'Upload failed.',
  deleteAssetConfirm: "Delete this asset? This can't be undone.",
  deleteCollectionConfirm: 'Delete collection "{{name}}"?',

  // Media picker dialog (ADR 0206 B4)
  pickerTitle: 'Choose an asset',
  pickerSearchPlaceholder: 'Search assets…',
  pickerUpload: 'Upload',
  pickerEmptyTitle: 'No assets found',
  pickerLoadFailedTitle: 'Couldn’t load your media',
  pickerLoadFailedBody: 'The library read failed — it is not empty until a successful read says so.',
  pickerEmpty: 'Upload one to get started, or adjust the search.',
  pickerChooseAria: 'Choose {{name}}',
  pickerUploaded: '"{{name}}" uploaded.',
  pickerUploadFailed: 'Upload failed.',

  // "Used by" (ADR 0206 B4 usage refs)
  usedByLabel: 'Where is this used?',
  usedByTitle: 'Used by — {{name}}',
  usedByFailed: 'Could not check where this asset is used. This is NOT confirmation that it is unused — deleting it may still break a page.',
  usedByFailedTitle: 'Usage could not be checked',
  usedByEmpty: 'Not referenced by any page.',
  usedByKindCmsPage: 'CMS page',
  usedByKindCampaign: 'Campaign',
  usedByKindCreativeBrief: 'Creative brief',
  chooseImage: "Choose image",
  replaceImage: "Replace image",
  clearImage: "Clear {{field}}",
  useImageUrl: "Use image URL",
  imageUrl: "Image URL for {{field}}",
  imageUrlPlaceholder: "https://example.com/image.jpg",
  applyUrl: "Apply",
  cancelUrl: "Cancel",

  // ADR 0363 P1 — alt text
  altEditLabel: 'Edit alt text',
  altPresentLabel: 'Has alt text',
  altMissingLabel: 'No alt text',
  altDecorativeChip: 'Decorative',
  altDialogTitle: 'Alt text — {{name}}',
  altDialogHelp: 'Alt text describes an image for screen-reader users. Write a concise description, generate one with AI, or mark the image decorative.',
  altTextLabel: 'Alt text',
  altTextPlaceholder: 'e.g. A barista pouring latte art in a sunlit café',
  altCharCount: '{{n}} / {{max}}',
  altDecorativeLabel: 'This image is decorative (no alt text)',
  altGenerate: 'Generate with AI',
  altGenerating: 'Generating…',
  altGenerated: 'Alt text suggested.',
  altGeneratedDecorative: 'The image looks decorative — marked so (no alt text).',
  altGenerateError: 'Could not generate alt text.',
  altSaveError: 'Could not save alt text.',

  // ADR 0401 — AI image generation
  generateImage: 'Generate with AI',
  generateDialogTitle: 'Generate an image',
  generateLoadFailed: 'Could not load image providers.',
  generateNoProviderTitle: 'No image provider connected',
  generateNoProviderBody: 'Add an OpenAI or Google API key to your workspace to generate images. Your key stays on the server and is never sent to the browser.',
  generateOpenProviders: 'Open Providers',
  generatePrompt: 'Prompt',
  generatePromptPlaceholder: 'Describe the image you want…',
  generateProvider: 'Provider',
  generateSize: 'Size',
  generateModel: 'Model (optional)',
  generateModelPlaceholder: 'Provider default',
  generateAction: 'Generate',
  generating: 'Generating…',
  generateFailed: 'Image generation failed.',
  generateResultAlt: 'Generated image preview',
  generateUseImage: 'Use this image',
  generateRetry: 'Regenerate',

  // ADR 0401 P3 — AI image editing
  editImageAi: 'Edit with AI',
  editDialogTitle: 'Edit image with AI',
  editOpPickerLabel: 'Edit operation',
  editOp_edit: 'Edit',
  editOp_inpaint: 'Generative fill',
  'editOp_background-remove': 'Remove background',
  editOp_upscale: 'Upscale',
  editOpUnsupported: 'Not supported by {{provider}}',
  editPromptPlaceholder: 'Describe the change…',
  editInpaintPromptPlaceholder: 'Describe what to paint into the marked region…',
  editMaskHint: 'Paint over the region to repaint.',
  editMaskClear: 'Clear mask',
  editMaskRequired: 'Paint a mask over the region to fill first.',
  editScaleLabel: 'Upscale factor',
  editApply: 'Apply',
  editApplying: 'Applying…',
  editFailed: 'Image edit failed.',
  editResultAlt: 'Edited image preview',
  editNotLibraryTitle: 'Not a library image',
  editNotLibraryBody: 'AI editing works on images from your media library. External URLs can be replaced via Generate or the picker.',

  // UXB-1 — rectangle mask mode (keyboard-accessible inpaint masking)
  maskModeLabel: 'Mask mode',
  maskModeBrush: 'Brush',
  maskModeRect: 'Rectangle',
  editMaskRectHint: 'Drag a rectangle over the region to repaint, or add one by numbers below.',
  maskRectX: 'X (%)',
  maskRectY: 'Y (%)',
  maskRectW: 'Width (%)',
  maskRectH: 'Height (%)',
  maskRectAdd: 'Add region',
  maskRectListLabel: 'Mask regions',
  maskRectItem: 'Region {{n}}: {{x}}%, {{y}}% · {{w}}×{{h}}%',
  maskRectRemove: 'Remove region {{n}}',
  editOpsSupported: '{{provider}} supports: {{ops}}',
  editOpsNone: 'no edit operations',
  generateLoadFailedTitle: "Could not check your image providers",
  generateLoadFailedBody: "The request did not complete, so we cannot tell which providers are connected. This does NOT mean none are.",
  editSourceLookupFailed: "Your media library could not be read, so this image could not be matched to a library asset.",
  retry: "Retry",
  editSourceLookupFailedTitle: "Could not read your media library",
} as const;
