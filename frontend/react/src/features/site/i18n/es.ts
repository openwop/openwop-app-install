/**
 * `site` namespace — user-facing copy for the site front page.
 * Feature-self-contained: every site string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Default hero section
  heroEyebrow: 'Un estándar abierto para agentes y flujos de trabajo de IA',
  heroHeading: 'Compañeros de IA que hacen trabajo real, y siguen siendo suyos.',
  heroSubheading: 'Cree agentes de IA y flujos de trabajo automatizados que gestionan tareas reales y, después, ejecútelos en cualquier lugar, porque lo que crea es portátil, no está atado a un único proveedor.',
  heroCtaLabel: 'Iniciar la aplicación',
  heroCtaLabel2: 'Ver el estándar abierto',

  // Default "how it works" columns section
  columnsEyebrow: 'Cómo funciona',
  columnsHeading: 'Créelo. Ejecútelo. Mantenga el control.',
  columnBuildTitle: 'Crear',
  columnBuildText: 'Diseñe un agente o un flujo de trabajo en un lienzo visual, o empiece desde una plantilla lista para usar.',
  columnRunTitle: 'Ejecutar',
  columnRunText: 'Véalo trabajar en tiempo real. Cada ejecución es repetible y revisable.',
  columnControlTitle: 'Mantenga el control',
  columnControlText: 'Usted decide qué se ejecuta por su cuenta y qué necesita su aprobación, con sus propias claves para las aplicaciones conectadas.',

  // Default "open standard" rich-text section (markdown emphasis + link)
  introEyebrow: 'El estándar abierto',
  introHeading: 'Créelo una vez. Ejecútelo en cualquier lugar.',
  introText: 'OpenWOP es un **estándar abierto** —como el correo electrónico o la web— que cualquier proveedor puede admitir, de modo que los agentes y flujos de trabajo que cree no estén atados a un único proveedor. Lea el estándar completo en [openwop.dev](https://openwop.dev).',

  // Default closing CTA section
  ctaHeading: 'Compruébelo usted mismo.',
  ctaLabel: 'Abrir la aplicación →',

  // Features-page catalog search (CatalogView)
  catalogSearchLabel: 'Buscar una función',
  catalogSearchPlaceholder: 'Busca entre {{count}} funciones…',
  catalogSearchStatus: 'Mostrando {{count}} de {{total}}',
  catalogSearchClear: 'Borrar búsqueda',
  catalogSearchEmpty: 'Ninguna función coincide con «{{query}}».',

  // FrontPageSettingsPanel — superadmin front-page editor
  eyebrow: 'Contenido',
  title: 'Página de inicio',
  ledeDenied: 'La página de inicio pública en /.',
  lede: 'La página de inicio pública mostrada en / a los visitantes anónimos. Los usuarios con sesión iniciada siempre obtienen la aplicación.',
  homePageSaved: 'Página de inicio guardada.',
  saveFailed: 'No se ha podido guardar.',
  saving: 'Guardando…',
  savePublish: 'Guardar y publicar',
  deniedNotice: 'Editar la página de inicio requiere un principal <0>superadministrador</0> (un inquilino en <1>OPENWOP_SUPERADMIN_TENANTS</1>, o la clave de portador de administrador).',
  frontPageToggle: '<0>Mostrar la página de inicio</0> en <1>/</1> (desactivado ⇒ <2>/</2> es la aplicación para todos)',
  pageTitleLabel: 'Título de la página (pestaña del navegador / SEO)',
  sectionsHeading: 'Secciones',
  previewHeading: 'Vista previa',
  addSectionToPreview: 'Añada una sección para la vista previa.',
} as const;
