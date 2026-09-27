/** `discovery` namespace — Spanish (ADR 0275 / MERCH-C). */
export const messages = {
  // The feature-specific REASON an organization is needed — a capitalised
  // sentence minus its stop, which `ui:orgStateEmptyBody` supplies. The frame
  // carries no instruction (that is the CTA's) and no noun, so this clause is
  // the one place the noun appears: say "organization", never "org".
  orgsEmptyClause: 'Las colecciones y las reglas de merchandising pertenecen a una organización',
  orgsFailedClause: 'Las colecciones y las reglas de merchandising nunca llegaron a solicitarse',
  orgsRetry: 'Reintentar',
  rowsFailedTitle: 'No se han podido cargar las colecciones',
  rowsFailedBody: 'Es una lectura fallida, no una lista vacía: no significa que no existan colecciones.',
  rulesFailedTitle: 'No pudimos cargar las reglas de esta tienda',
  rulesFailedBody: 'Es una lectura fallida, no una lista vacía: no te dice si hay reglas ocultando productos de tu tienda.',
  hiddenByRules_one: 'Tus reglas ocultaron {{formatted}} producto de esta vista previa.',
  hiddenByRules_other: 'Tus reglas ocultaron {{formatted}} productos de esta vista previa.',
  eyebrow: 'Negocio',
  title: 'Descubrimiento',
  lede: 'Colecciones, búsqueda por facetas y reglas de comercialización para tu tienda.',

  notEnabledTitle: 'El descubrimiento no está activado',
  notEnabledBody: 'Pide a un administrador que active la función Descubrimiento en Admin → Interruptores de función.',
  noCollectionsTitle: 'Aún no hay colecciones',
  noCollectionsBody: 'Añade una colección arriba: una dinámica se completa por categoría, una manual se cura a mano.',

  captionCollections: 'Colecciones',
  captionRules: 'Reglas de comercialización',
  colName: 'Nombre',
  colType: 'Tipo',
  colDetail: 'Contenido',
  colScope: 'Alcance',
  colHoldout: 'Reserva',
  itemsCount_one: '{{count}} artículo',
  itemsCount_other: '{{count}} artículos',

  fieldCollectionName: 'Nombre de la colección',
  fieldType: 'Tipo',
  fieldCategory: 'Categoría',
  fieldRuleName: 'Nombre de la regla',
  fieldHideCategory: 'Ocultar categoría',
  fieldSearch: 'Buscar',
  collectionPlaceholder: 'p. ej. Selección de verano',
  categoryPlaceholder: 'p. ej. foto',
  rulePlaceholder: 'p. ej. Ocultar liquidación',
  searchPlaceholder: 'Buscar productos…',

  rulesTitle: 'Añadir una regla de comercialización (ocultar una categoría)',
  addCollection: 'Añadir colección',
  addRule: 'Añadir regla',
  runSearch: 'Buscar',
  searchEmpty: 'Ningún producto coincidió.',

  type_dynamic: 'Dinámica (por categoría)',
  type_manual: 'Manual (curada)',

  deleteRowLabel: 'Eliminar {{name}}',
  deleteCollectionConfirm: '¿Eliminar la colección «{{name}}»?',
  deleteRuleConfirm: '¿Eliminar la regla «{{name}}»?',

  collectionAdded: 'Colección añadida.',
  collectionDeleted: 'Colección eliminada.',
  ruleAdded: 'Regla añadida.',
  ruleDeleted: 'Regla eliminada.',
  loadFailed: 'No se pudo cargar el descubrimiento.',
  addFailed: 'No se pudo añadir.',
  deleteFailed: 'No se pudo eliminar.',
  searchFailed: 'La búsqueda falló.',
  searchFailedPersistent: "La búsqueda falló: esto no son resultados de tu consulta. Reintenta para obtener una respuesta.",
  noRulesTitle: "Sin reglas de merchandising",
  noRulesBody: "Las reglas ocultan productos de tu tienda. No hay ninguna activa, así que los compradores lo ven todo.",
  productsTruncated: "Mostrando las primeras {{shown}} de {{total}} coincidencias.",
  facetsTruncated: "Los {{shown}} valores principales de {{total}} por faceta.",
  fieldCategoryHelp: "Los productos de esta categoría se añaden a la colección automáticamente.",
  fieldHideCategoryHelp: "Los productos de esta categoría dejan de aparecer en tu tienda mientras esta regla esté activa.",
} as const;
