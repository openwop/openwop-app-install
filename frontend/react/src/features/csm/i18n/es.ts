/**
 * `csm` namespace — user-facing copy for the csm feature.
 * Feature-self-contained: every csm string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // The feature-specific REASON an organization is needed — a capitalised
  // sentence minus its stop, which `ui:orgStateEmptyBody` supplies. The frame
  // carries no instruction (that is the CTA's) and no noun, so this clause is
  // the one place the noun appears: say "organization", never "org".
  orgsEmptyClause: 'Los vínculos de CRM pertenecen a una organización',
  orgsFailedClause: 'La lista de empresas nunca llegó a solicitarse',
  // Page chrome
  eyebrow: 'Negocio',
  title: 'CSM',
  lede: 'Cuentas de éxito del cliente, primero las de menor salud.',
  askHealthInsights: 'Consultar insights de salud',
  healthInsightsSeed: 'Revisa mis cuentas de éxito del cliente e indícame cuáles están en riesgo y por qué. Lee primero el registro de cuentas, luego resume los factores de salud y sugiere próximos pasos.',

  // Gating / empty states
  notEnabledTitle: 'CSM no está habilitado',
  notEnabledBody: 'Pida a un administrador que active la función CSM en Administración → Conmutadores de funciones.',
  noAccountsTitle: 'Aún no hay cuentas',
  noAccountsBody: 'Añada su primera cuenta de cliente con el formulario de arriba; la de menor salud se ordena primero.',

  // Table
  captionAccounts: 'Cuentas',
  colAccount: 'Cuenta',
  colHealth: 'Salud',
  colArr: 'ARR',
  colOwner: 'Responsable',
  companiesLoadFailed: 'Los nombres de empresa no cargaron',
  retryCompaniesLabel: 'Reintentar la carga de nombres de empresa',
  companyNameUnavailable: 'nombre no disponible',
  fieldArrCurrency: 'Moneda',
  arrCurrencyPlaceholder: 'USD',
  filterRenewalLabel: 'Filtrar por renovación',
  allRenewals: 'Todas las renovaciones',
  renewalFacetSoon: 'Renueva en 90 días',
  renewalFacetPast: 'Vencidas',
  scoreOutOfRange: 'La puntuación de salud debe ser un número de 0 a 100.',
  portfolioBandLabel: 'Resumen de cartera',
  portfolioTotalArr: 'ARR total',
  portfolioArrAtRisk: 'ARR en riesgo',
  portfolioRenewals90: 'Renovaciones en 90 días',
  colRenewal: 'Renovación',
  renewalSoon: 'en {{count}} d',
  renewalPast: 'Vencida',
  colLinkedCompany: 'Empresa vinculada',
  colFactors: 'Factores',
  notLinked: 'Sin vincular',
  factorsCount_one: '{{count}} factor',
  factorsCount_other: '{{count}} factores',
  factorHeaderFactor: 'Factor',
  factorHeaderWeight: 'Peso',
  factorHeaderValue: 'Valor',
  computedStamp: 'calculado {{time}}',

  // aria-labels
  deleteRowLabel: 'Eliminar {{name}}',
  linkLabel: 'Vincular {{name}} con una empresa de CRM',
  editLinkLabel: 'Editar el vínculo de CRM de {{name}}',

  // Panel de vínculo con CRM
  linkCompany: 'Vincular empresa',
  editLink: 'Editar vínculo',
  clearLink: 'Quitar vínculo',
  linkPanelTitle: 'Vincular "{{name}}" con una empresa de CRM',
  fieldCompany: 'Empresa',
  selectOrgPlaceholder: 'Seleccione una organización…',
  selectCompanyPlaceholder: 'Seleccione una empresa…',
  linkSaved: 'Empresa vinculada.',
  linkCleared: 'Vínculo eliminado.',
  linkFailed: 'No se pudo actualizar el vínculo de CRM.',

  // Form field labels / placeholders
  fieldAccount: 'Cuenta',
  fieldHealth: 'Salud (0–100)',
  fieldArr: 'ARR',
  fieldRenewal: 'Fecha de renovación',
  fieldOwner: 'Responsable',
  arrPlaceholder: 'Ingresos recurrentes anuales',
  ownerPlaceholder: 'Responsable de la cuenta',
  accountNamePlaceholder: 'Nombre de la cuenta del cliente',

  // Buttons
  addAccount: 'Añadir cuenta',

  // Toasts — success
  accountAdded: 'Cuenta añadida.',

  // Toasts / errors
  loadAccountsFailed: 'No se pudieron cargar las cuentas.',
  addFailed: 'No se pudo añadir.',
  deleteFailed: 'No se pudo eliminar.',
  updateFailed: 'No se pudo actualizar.',
  arrInvalid: 'El ARR debe ser un número igual o mayor que 0.',
  deleteAccountConfirm: '¿Eliminar la cuenta "{{name}}"?',

  // ADR 0582 §6 — mensajes de fallo localizados (antes eran inalcanzables).
  failureForbidden: 'No tienes permiso para hacer eso aquí.',
  failureNotFound: 'Esa cuenta ya no está aquí.',
  failureRejected: 'La cartera de cuentas rechazó ese cambio.',
  failureRateLimited: 'Demasiadas solicitudes: espera un momento e inténtalo de nuevo.',
  failureServer: 'La cartera de cuentas no está disponible en este momento.',
  failureOffline: 'No se pudo contactar con la cartera de cuentas.',
  loadFailedConsequence: 'Esto no es una cartera vacía: no se pudieron leer las cuentas.',
  staleClause: 'Estas cifras son las últimas que se cargaron, no las actuales.',

  // ADR 0582 §4/§6 — estados de medición
  healthUnscored: 'Sin puntuar',
  healthUnscoredHint: 'Todavía no se ha medido la salud',
  companyGone: 'La empresa ya no está en el CRM',
  companyGoneHint: 'Se fusionó o se eliminó: vuelve a vincular esta cuenta para seguir midiendo.',
  healthFailedSince: 'Con fallos desde {{date}}',
  healthFailedRelink: 'Volver a vincular empresa',
  healthMeasureFailed: 'Falló la medición',
  healthStalePrevious: 'último valor conocido {{score}}',
  healthOptionalPlaceholder: 'opcional',
  fieldHealthHint: 'Déjalo vacío para añadir la cuenta sin puntuar.',
  fieldHealthEditHint: 'Vacía el campo para retirar la puntuación y su desglose.',
  portfolioUnmeasured: 'Salud sin medir',
  portfolioUnmeasuredCount_one: '{{count}} cuenta',
  portfolioUnmeasuredCount_other: '{{count}} cuentas',
  portfolioUnmeasuredArr: '{{arr}} excluidos del ARR en riesgo',

  // ADR 0582 §5 — las dos fórmulas, enunciadas para que el desglose se entienda
  'formula_penalty-sum': 'Puntuación = 100 − suma de (peso × recuento). Más recuentos bajan la puntuación.',
  'formula_weighted-mean': 'Puntuación = suma de (peso × valor) ÷ peso total. Valores más altos suben la puntuación.',
  formulaUnstated: 'Este desglose se registró sin indicar la fórmula.',
  // ADR 0582 §16 — las filas con peso 0 son denominadores de cobertura, no entradas.
  contextRowsNote: 'Las filas con peso 0 son contexto, no se puntúan: muestran qué parte de los datos de origen pudo atribuirse a esta cuenta.',
  factorHeaderCount: 'Recuento',
  noBreakdown: 'Sin desglose',

  // Panel de edición (CSM-UX-5)
  editPanelTitle: 'Editar "{{name}}"',
  editRowLabel: 'Editar {{name}}',
  accountUpdated: 'Cuenta actualizada.',
  accountDeleted: 'Se eliminó "{{name}}".',

  // Collection kit (§4.5 rules 11+13)
  filterGroup: 'Filtros',
  filterAccountsPlaceholder: 'Buscar cuentas…',
  filterAccountsAria: 'Buscar cuentas por nombre o responsable',
  filterHealthLabel: 'Filtrar por salud',
  allHealth: 'Todos los niveles de salud',
  health_healthy: 'Saludable (70+)',
  health_at_risk: 'En riesgo (40–69)',
  health_critical: 'Crítica (menos de 40)',
  health_unscored: 'Sin puntuar',
  noMatchTitle: 'Ninguna cuenta coincide',
  noMatchBody: 'Ninguna cuenta coincide con los filtros actuales.',
  clearFilters: 'Borrar filtros',
  viewTable: 'Tabla',
} as const;
