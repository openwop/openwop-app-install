/**
 * `discovery` namespace — user-facing copy for the Host capabilities page
 * (CapabilitiesPanel): coverage, host surfaces, envelope discipline, model
 * capabilities, input modalities, conformance & profiles.
 */
export const messages = {
  eyebrow: 'Descubrimiento',
  title: 'Capacidades del host',
  lede: 'Lo que este host puede y no puede ejecutar — para que sepas qué flujos de trabajo funcionarán aquí y por qué algunos están bloqueados.',
  explainTitle: 'Cómo leer esta página',
  explainBody: 'Empieza por arriba: «Cobertura de paquetes» muestra cuántos bloques instalados puede ejecutar este host y cuáles están bloqueados y por qué. Todo lo demás —superficies del host, sobres, capacidades del modelo— es el anuncio de protocolo detallado del host, útil para diagnosticar la conformidad.',

  // Pack coverage
  packCoverage: 'Cobertura de paquetes',
  packCoverageHelpPrefix: 'El único número que responde a "¿puede este host ejecutar mi flujo de trabajo?": los nodos ejecutables sobre el catálogo instalado completo. Active ',
  packCoverageHelpBlocked: 'Bloqueado',
  packCoverageHelpSuffix: ' para limitar la tabla únicamente a las superficies que están bloqueando la ejecución.',
  coverageAriaLabel: 'Cobertura de paquetes',
  figureRunnable: 'Ejecutables',
  figureTotalNodes: 'Total de nodos',
  figureBlocked: 'Bloqueados',
  blockedTableCaption: 'Nodos bloqueados por superficie',
  colBlockedBySurface: 'Bloqueado por superficie',
  colNodes: 'Nodos',
  allRunnableClearPrefix: 'Los {{count}} nodos ejecutables superan todas las superficies requeridas. Seleccione ',
  allRunnableClearBlocked: 'Bloqueado',
  allRunnableClearSuffix: ' para ver los {{blocked}} que no lo hacen.',
  everyNodeRunnableTitle: 'Todos los nodos instalados son ejecutables aquí',
  everyNodeRunnableBody:
    'A ningún nodo del catálogo le falta una superficie del host: este host puede ejecutar el conjunto completo de paquetes.',

  // Host surfaces
  hostSurfaces: 'Superficies del host',
  hostSurfacesHelpPrefix: 'Representación en directo de ',
  hostSurfacesHelpImplLead: '. La columna',
  hostSurfacesHelpImplEm: 'implementación',
  hostSurfacesHelpImplMid: ' le indica qué respalda cada superficie; valores como ',
  hostSurfacesHelpImplOr: ' o ',
  hostSurfacesHelpImplTail: ' significan que la superficie no es duradera. La fase 6 los sustituye por adaptadores de backend reales de ',
  hostSurfacesHelpEnd: '.',
  surfacesTableCaption: 'Superficies del host',
  noSurfacesTitle: 'No se anuncian superficies del host',
  noSurfacesBodyPrefix: 'El ',
  noSurfacesBodySuffix: ' de este host está vacío.',
  colSurface: 'Superficie',
  colSupported: 'Compatible',
  colImplementation: 'Implementación',
  colNote: 'Nota',

  // Envelope discipline
  envelopeDiscipline: 'Disciplina de sobres',
  envelopeHelp:
    'Lo que este host promete sobre los sobres de emisión del LLM: la forma de la carga útil entrante que cada nodo de IA introduce en la ejecución. Cuando una fila muestra —, el host aún no ha anunciado esa superficie.',
  envelopeHelp2:
    'Cuando los eventos de fiabilidad de más abajo se producen en una ejecución, aparecen en directo en el chat de IA como chips en línea dentro de la burbuja del asistente (reintentos, rechazos, truncamientos, sustituciones de modelo, coerciones de prosa a JSON, recuperaciones de carga útil parcial).',
  envelopeTableCaption: 'Disciplina de sobres',
  colValue: 'Valor',
  envReasoningSupportedNoteLead: 'opcional',
  envReasoningSupportedNoteTail: 'cadena en las cargas útiles del sobre',
  envReasoningDirectiveNote: 'con cuánta insistencia el host pide al modelo que la rellene',
  envTierOneNote: 'la postura del host sobre el subconjunto de esquema OpenAI ∩ Anthropic ∩ Gemini',
  envReliabilitySupportedNote: 'el host emite eventos de reintento / rechazo / truncamiento',
  envReliabilityEventsNote: 'qué tipos de evento de fiabilidad emite realmente este host',
  envTruncationNote: 'el host ramifica la estrategia de reintento entre truncamiento y violación de esquema',
  envTruncationBudgetNote: 'cuánto presupuesto de salida adicional da el host en un reintento por truncamiento',

  // Model capabilities
  modelCapabilities: 'Capacidades del modelo',
  modelCapabilitiesHelpPrefix:
    'Lo que cada proveedor/modelo instalado puede hacer (llamada a funciones, visión, streaming, etc.) y si este host sustituirá silenciosamente por un modelo de reserva cuando el flujo de trabajo solicite una capacidad de la que carece el modelo configurado. La sustitución es observable mediante el evento ',
  modelCapabilitiesHelpSuffix: '.',
  advertised: 'Anunciado',
  notAdvertised: 'No anunciado',
  substitutionOn: 'Sustitución activada',
  substitutionOff: 'Sustitución desactivada',
  declaredCount: '{{count}} declarados',
  modelCapsNotAdvertisedTitle: 'Capacidades del modelo no anunciadas',
  modelCapsNotAdvertisedBodyPrefix: 'Este host aún no declara ',
  modelCapsNotAdvertisedBodySuffix: ', por lo que se desconoce el comportamiento de sustitución de capacidades.',

  // Input modalities
  inputModalities: 'Modalidades de entrada',
  inputModalitiesHelpPrefix: 'Las modalidades de percepción que este host acepta como ',
  inputModalitiesHelpMid: ' ContentParts. ',
  inputModalitiesHelpTextEm: 'texto',
  inputModalitiesHelpAfterText: ' siempre es válido; una modalidad que no sea texto solo se acepta cuando se anuncia aquí, de lo contrario la llamada se rechaza con ',
  inputModalitiesHelpSuffix: '.',
  noModalitiesTitle: 'No se anuncian modalidades distintas de texto',
  noModalitiesBodyPrefix: 'Este host aún no declara ',
  noModalitiesBodyMid: ' todavía: solo se aceptan ',
  noModalitiesBodySuffix: ' ContentParts.',

  // Raw advertisement
  rawAdvertisement: 'Anuncio sin procesar',
  rawAdvertisementHelpPrefix: 'Carga útil completa de ',
  rawAdvertisementHelpSuffix: '.',
  rawCapsAriaLabel: 'JSON de capacidades sin procesar',

  // Conformance & profiles
  conformanceAndProfiles: 'Conformidad y perfiles',
  conformanceHelpPrefix: 'La identidad del host conectado y todos los perfiles que anuncia a través de ',
  conformanceHelpAnd: ' y ',
  conformanceHelpMid: ': las superficies en las que un implementador externo puede confiar. Consulte la ',
  conformanceLeaderboardLink: 'clasificación de conformidad',
  conformanceHelpSuffix: ' para ver la matriz de tasa de aprobación entre hosts.',
  implementationLabel: 'Implementación',
  versionPrefix: 'v{{version}}',
  vendorPrefix: '· {{vendor}}',
  profilesClaimed: 'Perfiles declarados ({{count}})',
  noneAdvertised: 'ninguno anunciado',
  referenceHostBadge: 'Insignia de host de referencia',
  badgeAlt: 'Insignia de conformidad de {{label}}',
  noBadgePrefix:
    'No hay insignia publicada para esta implementación. Los hosts que coinciden con una referencia (in-memory, sqlite, postgres, python) obtienen una en línea; consulte la ',
  leaderboard: 'clasificación',
  noBadgeSuffix: ' para ver todos los hosts publicados.',
  emDash: '—',

  // Badge host labels
  badgePostgres: 'Host de referencia Postgres',
  badgeSqlite: 'Host de referencia SQLite',
  badgePython: 'Host de referencia Python en memoria',
  badgeInMemory: 'Host de referencia en memoria',
} as const;
