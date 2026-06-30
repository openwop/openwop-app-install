/**
 * `cms` namespace — user-facing strings for the CMS + Page Builder feature
 * (ADR 0009 / ADR 0027). Flat camelCase keys; generic actions/states reuse the
 * `common` namespace via `t('common:…')`.
 */
export const messages = {
  // Page header
  headerEyebrow: 'Plataforma',
  headerTitle: 'CMS · Editor de páginas',
  headerLede: 'Páginas de organización con un editor de secciones + flujo de trabajo editorial.',

  // Org picker
  organizationLabel: 'Organización',

  // Access / empty states
  disabledTitle: 'El CMS no está habilitado',
  disabledBody: 'Pida a un administrador que habilite la función de CMS para este inquilino.',
  noOrgsTitle: 'Sin organizaciones',
  noOrgsBody: 'Cree primero una organización: las páginas pertenecen a una organización.',
  selectPageTitle: 'Seleccione una página',
  selectPageBody: 'Elija una página a la izquierda o cree una.',

  // Page list
  pagesHeading: 'Páginas',
  noPagesYet: 'Aún no hay páginas.',
  deletePageTitle: 'Eliminar',
  newPageTitlePlaceholder: 'Título de la nueva página',

  // Editor
  titleLabel: 'Título',
  sectionsHeading: 'Secciones',
  saveAction: 'Guardar',
  previewHeading: 'Vista previa',
  previewEmpty: 'Añada una sección para ver la vista previa.',

  // Toasts
  pageCreated: 'Página creada.',
  pageSaved: 'Guardado.',
  pageStatusChanged: 'Página {{status}}.',
  loadPagesFailed: 'No se han podido cargar las páginas.',
  openFailed: 'No se ha podido abrir.',
  createFailed: 'No se ha podido crear.',
  saveFailed: 'No se ha podido guardar.',
  deleteFailed: 'No se ha podido eliminar.',
  actionFailed: '{{action}} ha fallado.',

  // Section renderer
  optionalBadge: 'Opcional',
  noImage: '(sin imagen)',
  unknownSection: 'Sección desconocida.',

  // Sections editor — section controls
  moveUp: 'Subir',
  moveDown: 'Bajar',
  removeSection: 'Quitar sección',
  addSectionPlaceholder: '+ Añadir sección…',
  addSectionAria: 'Añadir sección',

  // Sections editor — media token field
  mediaTokenLabel: '{{label}} (token de medios)',
  mediaTokenCurrent: '(token actual)',
  mediaTokenPlaceholder: 'Pegue un token de medios',

  // Sections editor — head fields
  eyebrowLabel: 'Antetítulo (etiqueta pequeña en mono)',
  eyebrowPlaceholder: 'La plataforma',
  headingLabel: 'Encabezado',

  // Sections editor — hero
  heroEyebrowLabel: 'Antetítulo',
  heroEyebrowPlaceholder: 'Protocolo abierto · v1.1',
  heroSubheadingLabel: 'Subtítulo (admite **markdown**)',
  heroPrimaryLabelPlaceholder: 'Etiqueta del botón principal',
  heroPrimaryUrlPlaceholder: '/agents o https://…',
  heroSecondaryLabelPlaceholder: 'Etiqueta del botón secundario',
  heroSecondaryUrlPlaceholder: 'https://…',
  heroImageLabel: 'Imagen principal',

  // Sections editor — richText
  richTextLabel: 'Texto (markdown: **negrita**, *cursiva*, `código`, [enlace](url))',

  // Sections editor — image
  imageLabel: 'Imagen',
  altTextLabel: 'Texto alternativo',
  captionLabel: 'Pie de foto',

  // Sections editor — cta
  ctaSubheadingLabel: 'Subtítulo',
  ctaButtonLabelLabel: 'Etiqueta del botón',
  ctaButtonUrlLabel: 'URL del botón',
  ctaButtonUrlPlaceholder: '/agents o https://…',

  // Sections editor — columns
  layoutLabel: 'Diseño',
  layoutCards: 'Tarjetas (cuadrícula de funciones)',
  layoutSteps: 'Pasos (numerados)',
  layoutStats: 'Estadísticas (valor + etiqueta)',
  columnTitlePlaceholder: 'Título del elemento {{n}} / valor de estadística',
  columnTextPlaceholder: 'Cuerpo / etiqueta',
  removeItem: 'Quitar',
  addItem: 'Añadir elemento',

  // Sections editor — locale tabs + overlay (ADR 0064)
  sectionLocalesAria: 'Idiomas de la sección',
  localeBaseTag: 'base',
  localeTabBase: '{{locale}} (idioma base)',
  localeTabTranslated: '{{locale}} (traducido)',
  localeTabNotTranslated: '{{locale}} (sin traducir)',
  overlayNote: 'Anulación para <1>{{locale}}</1>: los campos vacíos heredan la base.',
  copyFromBase: 'Copiar de la base',
  addBaseContentFirst: 'Añada primero contenido base',
  translatingLabel: 'Traduciendo…',
  translateFromBase: 'Traducir desde la base',
  clearOverlay: 'Borrar',
  translateEmpty: 'La traducción no devolvió nada: edite la traducción manualmente.',
  translateUnavailable: 'Traducción no disponible: edite manualmente.',

  // ── Content language settings (CmsLanguageSettings) ─────────────────────
  langLoading: 'Cargando los ajustes de idioma…',
  langSaveFailed: 'No se ha podido guardar.',
  langNotEnabled: 'La localización de contenido no está habilitada para este inquilino. Pida a un administrador que active la “localización de contenido del CMS”.',
  langEnterTag: 'Introduzca una etiqueta BCP-47 como “es” o “pt-BR”.',
  langAlreadyConfigured: '“{{loc}}” ya está configurado.',
  langBaseLocale: 'Idioma base',
  langBaseLocaleHint: '— la fuente del idioma predeterminado; los campos base de las secciones se escriben en él.',
  langTranslationsLabel: 'Traducciones (idiomas redactados · se excluye la base)',
  langNoTranslations: 'Aún no hay traducciones: añada un idioma para empezar a traducir secciones.',
  langRemoveLocale: 'Quitar {{loc}}',
  langNewLocalePlaceholder: 'p. ej. es, pt-BR, fr',
  langNewLocaleAria: 'Nuevo idioma (BCP-47)',
  langAdd: 'Añadir',
  langAutoTranslate: 'Traducir secciones automáticamente al publicar (una sugerencia; efectiva una vez habilitada la traducción por IA)',
} as const;
