/**
 * `settings` namespace — user-facing strings for the Settings area
 * (`src/settings/`). FLAT camelCase keys, one per line (ADR 0065). Plural keys
 * use i18next `_one`/`_other` suffixes (Intl.PluralRules) with `{{count}}`.
 */
export const messages = {
  // AdminOverviewPage
  adminEyebrow: 'Administración',
  adminTitle: 'Resumen',
  adminLede: 'Configuración de la plataforma y superficies de consola. El trabajo del día a día reside en el panel del espacio de trabajo; todo lo que configura el despliegue reside aquí.',

  // ExampleDataPage — header
  exampleDataEyebrow: 'Ajustes',
  exampleDataTitle: 'Datos de ejemplo',
  exampleDataLede: 'Cargue datos de muestra para que los paneles tengan algo que mostrar: agentes, plantillas de personal y su historial. Todo aquí es explícito y claramente datos de ejemplo; una instalación limpia empieza vacía.',

  // ExampleDataPage — types list
  typesHeading: 'Tipos de datos de ejemplo',
  typesIntro: 'Idempotente y no destructivo: cada tipo se crea solo donde falta, por lo que la carga nunca duplica ni toca los datos que creó usted mismo. Limitado a su inquilino.',
  noTypesTitle: 'No hay tipos de datos de ejemplo registrados',
  noTypesBody: 'Este host no anuncia datos de ejemplo cargables.',
  selectAria: 'Seleccionar {{label}}',
  countPresent: '{{n}} presentes',

  // ExampleDataPage — actions
  dryRunLabel: 'Simulación (vista previa)',
  loadAllExampleData: 'Cargar todos los datos de ejemplo',
  loadSelected: 'Cargar seleccionados ({{n}})',
  clearExampleData: 'Borrar datos de ejemplo',
  clearTitle: 'Eliminar entidades de ejemplo (sus propios agentes no se tocan)',
  clearing: 'Borrando…',
  clearConfirm: '¿Borrar {{label}}? Esto elimina las entidades de ejemplo de su inquilino (sus propios agentes no se tocan).',
  clearAllFallback: 'todos los datos de ejemplo',

  // ExampleDataPage — results
  dryRunNotice: 'Simulación: no se ha escrito nada.',
  summaryCreated_one: '{{n}} creado',
  summaryCreated_other: '{{n}} creados',
  summaryCleared_one: '{{n}} borrado',
  summaryCleared_other: '{{n}} borrados',
  summarySkipped_one: '{{n}} omitido',
  summarySkipped_other: '{{n}} omitidos',
  summaryErrors_one: '{{n}} error',
  summaryErrors_other: '{{n}} errores',

  // ExampleDataPage — per-step action labels
  actionCreated: 'creado',
  actionCleared: 'borrado',
  actionError: 'error',
  actionSkipped: 'omitido',
} as const;
