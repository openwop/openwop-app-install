/**
 * `media` namespace — user-facing copy for the media library feature.
 * Feature-self-contained: every media string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Page chrome
  eyebrow: 'Plataforma',
  title: 'Biblioteca multimedia',
  lede: 'Recursos y colecciones con ámbito de organización.',

  // Gating / empty states
  notEnabledTitle: 'La biblioteca multimedia no está activada',
  notEnabledBody: 'Solicite a un administrador que active la función Multimedia para este inquilino.',
  noOrgsTitle: 'Sin organizaciones',
  noOrgsBody: 'Cree primero una organización: las colecciones multimedia pertenecen a una organización.',
  noAssetsTitle: 'Sin recursos',
  noAssetsBody: 'Suba un archivo para iniciar esta colección.',
  orgsFailedTitle: 'No se pudieron cargar las organizaciones',
  orgsFailedBody: 'Falló la lectura de organizaciones, por lo que la biblioteca multimedia aún no se puede abrir.',
  collectionsFailedTitle: 'No se pudieron cargar las colecciones',
  collectionsFailedBody: 'Falló la lectura de colecciones. Esto no significa que la organización no tenga colecciones.',

  // aria-labels
  orgPickerLabel: 'Organización',

  // Collections sidebar
  collectionsHeading: 'Colecciones',
  allAssets: 'Todos los recursos',
  uncategorized: 'Sin categoría',
  deleteCollectionLabel: 'Eliminar colección',
  newCollectionPlaceholder: 'Nueva colección',

  // Assets toolbar
  searchPlaceholder: 'Buscar por nombre…',
  upload: 'Subir',
  deleteAssetLabel: 'Eliminar recurso',
  assetResultsLabel: 'Recursos multimedia',

  // Asset-list filterbar + grid/list toggle
  filterGroup: 'Filtrar recursos',
  filterAria: 'Filtrar recursos por nombre',
  noMatchTitle: 'No hay recursos que coincidan',
  noMatchBody: 'Ningún recurso coincide con tu búsqueda. Prueba con otro término.',
  clearSearch: 'Borrar búsqueda',

  // Asset usage badge ({{used}} is the locale-formatted count; {{count}} drives plural selection)
  usageCount_one: 'utilizado {{used}}×',
  usageCount_other: 'utilizado {{used}}×',
  unused: 'sin utilizar',

  // Toasts — success / info
  collectionCreated: 'Colección creada.',
  collectionDeleted: 'Colección eliminada (recursos reubicados).',
  assetDeleted: '{{name}} eliminado. El foco se movió a la lista de recursos.',
  uploaded: 'Se ha subido {{name}}.',

  // Toasts / errors
  loadOrgsFailed: 'No se han podido cargar las organizaciones.',
  loadAssetsFailed: 'No se han podido cargar los recursos.',
  assetsFailedTitle: 'No se pudieron cargar los recursos',
  assetsFailedBody: 'La biblioteca no está disponible ahora — es una lectura fallida, no una biblioteca vacía.',
  createFailed: 'No se ha podido crear.',
  deleteFailed: 'No se ha podido eliminar.',
  uploadFailed: 'No se ha podido subir.',
  deleteAssetConfirm: '¿Eliminar este recurso? Esta acción no se puede deshacer.',
  deleteCollectionConfirm: '¿Eliminar la colección "{{name}}"?',

  // Media picker dialog (ADR 0206 B4)
  pickerTitle: 'Elegir un recurso',
  pickerSearchPlaceholder: 'Buscar recursos…',
  pickerUpload: 'Subir',
  pickerEmptyTitle: 'No se encontraron recursos',
  pickerLoadFailedTitle: 'No se pudieron cargar tus medios',
  pickerLoadFailedBody: 'La lectura de la biblioteca falló: no está vacía hasta que una lectura exitosa lo confirme.',
  pickerEmpty: 'Sube uno para empezar o ajusta la búsqueda.',
  pickerChooseAria: 'Elegir {{name}}',
  pickerUploaded: '"{{name}}" subido.',
  pickerUploadFailed: 'No se ha podido subir.',

  // "Used by" (ADR 0206 B4 usage refs)
  usedByLabel: '¿Dónde se usa?',
  usedByTitle: 'Usado por — {{name}}',
  usedByFailed: 'No se pudo comprobar dónde se usa este recurso. Esto NO confirma que no se use: eliminarlo aún podría romper una página.',
  usedByFailedTitle: 'No se pudo comprobar el uso',
  usedByEmpty: 'No está referenciado por ninguna página.',
  usedByKindCmsPage: 'Página del CMS',
  usedByKindCampaign: 'Campaña',
  usedByKindCreativeBrief: 'Brief creativo',
  chooseImage: "Elegir imagen",
  replaceImage: "Reemplazar imagen",
  clearImage: "Quitar {{field}}",
  useImageUrl: "Usar URL de imagen",
  imageUrl: "URL de la imagen para {{field}}",
  imageUrlPlaceholder: "https://ejemplo.com/imagen.jpg",
  applyUrl: "Aplicar",
  cancelUrl: "Cancelar",

  // ADR 0363 P1 — texto alternativo
  altEditLabel: 'Editar texto alternativo',
  altPresentLabel: 'Con texto alternativo',
  altMissingLabel: 'Sin texto alternativo',
  altDecorativeChip: 'Decorativa',
  altDialogTitle: 'Texto alternativo — {{name}}',
  altDialogHelp: 'El texto alternativo describe una imagen para usuarios de lectores de pantalla. Escribe una descripción concisa, genérala con IA o marca la imagen como decorativa.',
  altTextLabel: 'Texto alternativo',
  altTextPlaceholder: 'p. ej. Un barista sirviendo arte latte en una cafetería soleada',
  altCharCount: '{{n}} / {{max}}',
  altDecorativeLabel: 'Esta imagen es decorativa (sin texto alternativo)',
  altGenerate: 'Generar con IA',
  altGenerating: 'Generando…',
  altGenerated: 'Texto alternativo sugerido.',
  altGeneratedDecorative: 'La imagen parece decorativa — marcada así (sin texto alternativo).',
  altGenerateError: 'No se pudo generar el texto alternativo.',
  altSaveError: 'No se pudo guardar el texto alternativo.',

  // ADR 0401 — AI image generation
  generateImage: 'Generar con IA',
  generateDialogTitle: 'Generar una imagen',
  generateLoadFailed: 'No se pudieron cargar los proveedores de imágenes.',
  generateNoProviderTitle: 'Ningún proveedor de imágenes conectado',
  generateNoProviderBody: 'Añade una clave de API de OpenAI o Google a tu espacio de trabajo para generar imágenes. Tu clave permanece en el servidor y nunca se envía al navegador.',
  generateOpenProviders: 'Abrir Proveedores',
  generatePrompt: 'Prompt',
  generatePromptPlaceholder: 'Describe la imagen que quieres…',
  generateProvider: 'Proveedor',
  generateSize: 'Tamaño',
  generateModel: 'Modelo (opcional)',
  generateModelPlaceholder: 'Predeterminado del proveedor',
  generateAction: 'Generar',
  generating: 'Generando…',
  generateFailed: 'La generación de la imagen falló.',
  generateResultAlt: 'Vista previa de la imagen generada',
  generateUseImage: 'Usar esta imagen',
  generateRetry: 'Regenerar',

  // ADR 0401 P3 — AI image editing
  editImageAi: 'Editar con IA',
  editDialogTitle: 'Editar imagen con IA',
  editOpPickerLabel: 'Operación de edición',
  editOp_edit: 'Editar',
  editOp_inpaint: 'Relleno generativo',
  'editOp_background-remove': 'Quitar fondo',
  editOp_upscale: 'Ampliar',
  editOpUnsupported: 'No compatible con {{provider}}',
  editPromptPlaceholder: 'Describe el cambio…',
  editInpaintPromptPlaceholder: 'Describe qué pintar en la región marcada…',
  editMaskHint: 'Pinta sobre la región a repintar.',
  editMaskClear: 'Borrar máscara',
  editMaskRequired: 'Primero pinta una máscara sobre la región a rellenar.',
  editScaleLabel: 'Factor de ampliación',
  editApply: 'Aplicar',
  editApplying: 'Aplicando…',
  editFailed: 'La edición de la imagen falló.',
  editResultAlt: 'Vista previa de la imagen editada',
  editNotLibraryTitle: 'No es una imagen de la biblioteca',
  editNotLibraryBody: 'La edición con IA funciona con imágenes de tu biblioteca de medios. Las URL externas pueden reemplazarse con Generar o el selector.',

  // UXB-1 — rectangle mask mode (keyboard-accessible inpaint masking)
  maskModeLabel: 'Modo de máscara',
  maskModeBrush: 'Pincel',
  maskModeRect: 'Rectángulo',
  editMaskRectHint: 'Arrastra un rectángulo sobre la región a repintar, o añade uno con números abajo.',
  maskRectX: 'X (%)',
  maskRectY: 'Y (%)',
  maskRectW: 'Ancho (%)',
  maskRectH: 'Alto (%)',
  maskRectAdd: 'Añadir región',
  maskRectListLabel: 'Regiones de la máscara',
  maskRectItem: 'Región {{n}}: {{x}}%, {{y}}% · {{w}}×{{h}}%',
  maskRectRemove: 'Quitar región {{n}}',
  editOpsSupported: '{{provider}} admite: {{ops}}',
  editOpsNone: 'ninguna operación de edición',
  generateLoadFailedTitle: "No se pudieron comprobar tus proveedores de imágenes",
  generateLoadFailedBody: "La solicitud no se completó, así que no podemos saber qué proveedores están conectados. Esto NO significa que no haya ninguno.",
  editSourceLookupFailed: "No se pudo leer tu biblioteca multimedia, así que esta imagen no pudo asociarse a un recurso.",
  retry: "Reintentar",
  editSourceLookupFailedTitle: "No se pudo leer tu biblioteca multimedia",
} as const;
