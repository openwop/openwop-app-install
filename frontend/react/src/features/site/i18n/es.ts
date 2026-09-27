/**
 * `site` namespace — user-facing copy for the site front page.
 * Feature-self-contained: every site string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Default hero — the thesis, beside the run ledger (visual: 'run')
  heroHeading: 'El trabajo de la IA ocurre en la ejecución. Ahora la ejecución es abierta.',
  heroSubheading: 'Los agentes no siguen un guion. Deciden mientras trabajan: qué herramienta usar, qué delegar, cuándo detenerse a preguntarte. OpenWOP es un protocolo abierto para esa ejecución, y aquí puedes crear una, observarla y llevártela contigo.',
  heroCtaLabel: 'Empieza a crear, sin registro',
  heroCtaLabel2: 'Leer el protocolo',

  // The "workflow" hero visual (HeroSchematic) — kept for CMS pages that pick it
  heroVignetteName: 'OpenWOP / flujo de trabajo',
  heroVignetteReady: 'listo para ejecutar',
  heroVignetteContext: '01 · contexto',
  heroVignetteBrief: 'Nueva solicitud',
  heroVignetteCapture: 'Captura el trabajo',
  heroVignetteWorkflow: '02 · flujo de trabajo',
  heroVignetteRoute: 'Enruta y decide',
  heroVignetteTogether: 'Personas e IA juntas',
  heroVignetteRecord: '03 · registro',
  heroVignetteReview: 'Revisa la ejecución',
  heroVignetteReplay: 'Repetible por diseño',
  heroVignetteOpen: 'Estándar abierto',
  heroVignetteInfrastructure: 'Tu infraestructura',

  // The hero run ledger (SectionRenderer HeroRunLedger). Event names are wire
  // literals and stay untranslated; these are their plain-language glosses.
  heroRunName: 'ejecución r-7f3a',
  heroRunLog: 'registro de eventos',
  heroRunStarted: 'La ejecución empieza con tus datos',
  heroRunDecided: 'El agente elige qué herramienta usar',
  heroRunToolReturned: 'La herramienta responde; su salida se marca como no confiable',
  heroRunBudget: 'El gasto se compara con el límite',
  heroRunApprovalRequested: 'El siguiente paso no se puede deshacer, así que la ejecución se detiene',
  heroRunWaiting: 'en pausa por una persona',
  heroRunApprovalGranted: 'Una persona dice que sí',
  heroRunCompleted: 'Terminada, y reproducible desde cualquier paso',
  heroRunFooter: 'Los mismos eventos, en cualquier host compatible',

  // Default story: why the run matters (richText, markdown emphasis)
  shiftHeading: 'El software solía hacer exactamente lo que se le decía.',
  shiftText: 'Durante décadas, el software hizo lo que alguien escribió, línea por línea. Los agentes son distintos: toman decisiones *durante la ejecución*. Así que la ejecución es ahora donde se crea el valor, donde las cosas fallan y donde alguien tiene que responder por el resultado.\n\nHoy cada plataforma construye esa ejecución a su manera, y ninguna coincide. El trabajo de tus agentes pertenece al proveedor que lo aloja.',

  // Default story: the history lesson (richText)
  historyHeading: 'Ya sabemos cómo termina esto.',
  historyText: 'Estándares de flujos de trabajo como BPMN y BPEL acordaron cómo se *dibuja* un proceso. Ejecutarlo siguió siendo propietario, así que los diagramas nunca viajaron de verdad. El correo electrónico y la web hicieron lo contrario: SMTP y HTTP estandarizaron la *conversación* entre máquinas, y todos pudieron construir sobre ella.\n\nOpenWOP hace la misma apuesta para el trabajo con IA. No estandarices el diagrama. Estandariza la ejecución.',

  // Default story: what an open run guarantees (columns, layout 'rows')
  openHeading: 'Qué cambia cuando la ejecución es abierta',
  openLeaveTitle: 'Puedes irte.',
  openLeaveText: 'Lleva tus agentes, paquetes y flujos de trabajo a otro host compatible. Los secretos se vuelven a vincular en el nuevo host; nunca se copian.',
  openSeeTitle: 'Puedes ver por qué.',
  openSeeText: 'Cada decisión, llamada a herramienta y traspaso es un evento en un vocabulario compartido, legible por cualquier herramienta, no solo por la que lo ejecutó.',
  openDecideTitle: 'Una persona decide lo irreversible.',
  openDecideText: 'La aprobación es parte del protocolo, no un complemento. La ejecución se detiene y espera donde tú digas.',
  openBoundTitle: 'Nada se ejecuta sin límites.',
  openBoundText: 'Los topes de iteraciones y los presupuestos forman parte del contrato, y la salida no confiable de una herramienta no puede forzar una aprobación.',
  openReplayTitle: 'Cualquiera puede reproducirla.',
  openReplayText: 'Un auditor puede bifurcar cualquier ejecución desde cualquier punto, sin efectos secundarios, y ver exactamente qué pasó y por qué.',

  // Default story: the evidence + one honest caveat (richText). The paper link
  // is a separate paragraph so white-label installs can drop it (ADR 0196).
  proofHeading: 'Un flujo de trabajo. Dos lenguajes. La misma ejecución.',
  proofText: 'El artículo de OpenWOP informa que una misma definición de flujo de trabajo, ejecutada en un host de TypeScript y en uno de Python, llega al mismo estado final con la misma estructura de registro de eventos. La ejecución la define el protocolo, no quien la aloja.\n\nEs pronto, y no tienes que creernos. Ejecuta algo aquí, abre su registro de eventos y compruébalo.',
  proofPaperLink: 'El método y los resultados completos están en [el artículo](https://doi.org/10.5281/zenodo.20576239).',

  // Default story: what you can do in this app today (columns, layout 'steps' —
  // a real sequence, so the numbering is earned)
  tryHeading: 'Pruébalo aquí, hoy.',
  tryBuildTitle: 'Crear',
  tryBuildText: 'Dibuja un agente o un flujo de trabajo en el lienzo visual, o descríbelo en el chat.',
  tryRunTitle: 'Ejecutar',
  tryRunText: 'Ejecútalo con los paquetes `core.openwop.*` publicados y mira llegar cada evento en directo.',
  tryDecideTitle: 'Decidir',
  tryDecideText: 'Cuando la ejecución se detiene a preguntar, responde la tarjeta de aprobación. Te espera.',
  tryReplayTitle: 'Reproducir',
  tryReplayText: 'Abre cualquier ejecución terminada, bifúrcala desde un paso y mira qué cambiaría.',

  // Default closing CTA section
  ctaHeading: 'Crea una ejecución que puedas llevarte.',
  ctaSubheading: 'Sin registro. Usa tus propias claves de modelo cuando quieras.',
  ctaLabel: 'Empieza a crear',

  // Features-page catalog search (CatalogView)
  catalogSearchLabel: 'Buscar una función',
  catalogSearchPlaceholder: 'Busca entre {{count}} funciones…',
  catalogSearchStatus: 'Mostrando {{count}} de {{total}}',
  catalogSearchClear: 'Borrar búsqueda',
  catalogSearchEmpty: 'Ninguna función coincide con «{{query}}».',

  // ADR 0391 (a) — archivo público del blog + vista de entrada
  blogEyebrow: 'Artículos',
  blogTitle: 'Blog',
  blogSubscribe: 'Fuente RSS',
  blogByline: 'Por {{author}}',
  blogFilterTag: 'Etiquetado «{{value}}»',
  blogFilterCategory: 'Categoría: {{value}}',
  blogFilterAuthor: 'Por {{value}}',
  blogFilterAuthorUnknown: 'De este autor',
  blogClearFilter: 'Quitar filtro',
  blogBackToBlog: '← Todas las entradas',
  blogEmptyTitle: 'Aún no se han publicado artículos',
  blogEmptyBody: 'Empieza con la guía o explora la plataforma mientras esta publicación toma forma.',
  blogEmptyPrimaryCta: 'Leer la guía rápida',
  blogEmptySecondaryCta: 'Explorar funciones',
  blogArchiveEmptyTitle: 'Todavía no hay nada aquí',
  blogArchiveEmptyBody: 'Ninguna entrada coincide con este filtro.',
  blogLoadErrorTitle: 'No se pudo cargar el blog',
  blogLoadErrorBody: 'Ocurrió un error al obtener las entradas. Inténtalo de nuevo.',
  postNotFoundTitle: 'Entrada no encontrada',
  postNotFoundBody: 'Es posible que esta entrada se haya despublicado o movido.',

  // ROUND 2 (UX_UPGRADE-site R2-G1/G2/G3) — honestidad ante fallos
  postLoadErrorTitle: 'No se pudo cargar esta entrada',
  postLoadErrorBody: 'Algo salió mal de nuestro lado — es probable que la entrada siga existiendo.',
  pageNotFoundTitle: 'Página no encontrada',
  pageNotFoundBody: 'Es posible que esta página se haya despublicado o movido.',
  pageLoadErrorTitle: 'No se pudo cargar esta página',
  pageLoadErrorBody: 'Algo salió mal de nuestro lado. Inténtalo de nuevo.',
  backToHome: 'Ir a la página de inicio',
  blogChromeDegraded: 'Algunos detalles del post (autor, fecha, posts relacionados) no se pudieron cargar ahora.',
  pricingWrapperDegraded: 'Parte de esta página no se pudo cargar ahora — los planes de abajo están actualizados.',
  // UX_UPGRADE-site — filtro del blog (G1), tiempo de lectura (G2), ver más (G3),
  // relacionados/paginador (G4) y copiar enlace (G6)
  blogReadingTime: '{{count}} min de lectura',
  blogSearchLabel: 'Filtrar entradas',
  blogSearchPlaceholder: 'Filtrar {{count}} entradas…',
  blogSearchStatus: 'Mostrando {{count}} de {{total}}',
  blogSearchClear: 'Borrar filtro',
  blogSearchEmptyTitle: 'Ninguna entrada coincide con «{{query}}»',
  blogSearchEmptyBody: 'Prueba con otra palabra o borra el filtro para verlo todo.',
  blogSearchShowAll: 'Ver todas las entradas',
  blogShowMore: 'Ver {{count}} más',
  blogShownCount: 'Mostrando {{count}} de {{total}} entradas',
  blogPagerLabel: 'Entradas cercanas',
  blogOlderPost: 'Entrada anterior',
  blogNewerPost: 'Entrada siguiente',
  blogRelatedTitle: 'Lecturas relacionadas',
  blogMoreTitle: 'Más entradas',
  blogCopyLink: 'Copiar enlace',
  blogTocTitle: 'En esta página',
  blogShareLabel: 'Compartir esta entrada',
  blogShareX: 'Compartir en X',
  blogShareLinkedIn: 'Compartir en LinkedIn',
  blogShareEmail: 'Correo',
  blogSearchShortcutHint: 'Ctrl K',
  blogSearchShortcutHintMac: '⌘K',
  blogCopied: 'Copiado',

  // ADR 0391 (b) — página pública de precios (alternativa cuando no hay página CMS)
  pricingTitle: 'Precios',
  pricingEyebrow: 'Planes',
  pricingHeading: 'Planes de esta implementación',
  pricingBlurb: 'El operador de esta implementación configura los detalles de cada plan. Explora qué incluye cada uno y abre el espacio de trabajo cuando estés listo para empezar.',

  editThisPage: 'Editar esta p\u00e1gina',

  openApp: 'Abrir la aplicaci\u00f3n',
} as const;
