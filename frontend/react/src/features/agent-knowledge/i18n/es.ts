/**
 * `agent-knowledge` namespace — user-facing copy for the Agent Knowledge & Memory
 * feature (ADR 0038 / ADR 0041). Feature-self-contained: every agent-knowledge
 * string lives here. Generic actions/states are reused from the `common`
 * namespace via `t('common:…')` and are NOT duplicated. Plural keys use
 * i18next `_one`/`_other` suffixes (Intl.PluralRules).
 */
export const messages = {
  // Panel loading / chrome
  loadingKnowledge: 'Cargando conocimiento…',
  intro: 'Dé a {{persona}} su propio conocimiento: <1>documentos</1> que puede citar y <3>notas y datos</3> privados que recuerda en cada turno. Configuración local del host — no es el manifiesto de protocolo del agente.',

  // Run notices (success)
  collectionCreated: 'Colección creada y vinculada.',
  documentIngested: 'Documento incorporado.',
  importedFromDrive: 'Importado de Google Drive.',
  collectionUnbound: 'Colección desvinculada.',
  documentRemoved: 'Documento eliminado.',
  curatedNotesEnabled: 'Notas curadas activadas.',
  curatedNotesDisabled: 'Notas curadas desactivadas.',

  // Documents section
  documentsTitle: 'Documentos',
  documentsHint: 'Colecciones de conocimiento vinculadas — fragmentadas, incrustadas y citadas al recuperarlas.',
  documentsCreateOrgFirst: 'Cree primero una organización para alojar los documentos de este agente.',
  organizationLabel: 'Organización',
  newCollectionNameLabel: 'Nombre de la nueva colección',
  newCollectionNamePlaceholder: 'Manual de la cuenta',
  createCollection: 'Crear colección',
  noDocumentsBound: 'Aún no hay documentos vinculados. Cree una colección y luego añada un documento abajo.',

  // Collection card
  docCount_one: '{{count}} documento',
  docCount_other: '{{count}} documentos',
  unbind: 'Desvincular',
  unbindConfirm: '¿Desvincular "{{name}}" de este agente? La colección en sí se conserva.',
  externalUnverified: 'Externo · sin verificar',
  externalUnverifiedTitle: 'Importado de una fuente externa (p. ej. Google Drive o un disparador). Se trata como no fiable — se aísla cuando el agente lo lee, nunca se sigue como instrucciones (ADR 0038 §C).',
  chunkCount_one: '· {{count}} fragmento',
  chunkCount_other: '· {{count}} fragmentos',
  removeDocumentLabel: 'Eliminar {{title}}',
  removeDocumentTitle: 'Eliminar documento',
  removeDocumentConfirm: '¿Eliminar "{{title}}"?',
  documentTitleLabel: 'Título del documento',
  documentTitlePlaceholder: 'Notas de la cuenta del T3',
  documentTextLabel: 'Texto del documento',
  documentTextHelp: 'El texto pegado se fragmenta e incrusta para una recuperación con citas.',
  documentTextPlaceholder: 'Pegue el contenido del documento…',
  untitledDocument: 'Sin título',
  addDocument: 'Añadir documento',
  importFromDriveLabel: 'Importar de Google Drive',
  importFromDrivePlaceholder: 'https://docs.google.com/document/d/…',
  importFromDrive: 'Importar de Drive',
  importFromDriveHint: 'Pegue un enlace de Drive/Docs — se importa con cita. Requiere una cuenta de Google conectada.',

  // Notes section
  notesTitle: 'Notas y datos',
  notesHint: 'Privadas de este agente; se recuerdan automáticamente en cada turno (no se citan).',
  allowCuratedNotes: 'Permitir notas curadas para este agente',
  enabled: 'activadas',
  disabled: 'desactivadas',
  notesStored_one: '{{count}} recuerdo almacenado — explórelos, añádalos y elimínelos en la pestaña <1>Memoria</1>.',
  notesStored_other: '{{count}} recuerdos almacenados — explórelos, añádalos y elimínelos en la pestaña <1>Memoria</1>.',
  notesEnablePrompt: 'Active las notas curadas y luego añada datos privados que este agente recordará en la pestaña <1>Memoria</1>.',

  // Retrieve preview
  retrieveTitle: 'Pruebe una recuperación',
  retrieveHint: 'Previsualice lo que {{persona}} recordaría para una consulta.',
  queryLabel: 'Consulta',
  queryPlaceholder: '¿Qué sabemos sobre la cuenta?',
  retrieve: 'Recuperar',
  retrieveNoteChip: 'nota',
  retrieveExternalChip: 'externo',
  retrieveExternalTitle: 'Contenido externo no fiable — se aísla cuando el agente lo lee (ADR 0038 §C).',
  retrieveNoMatches: 'Sin coincidencias — añada documentos o notas arriba.',

  // Memory tab (ADR 0041)
  memoryFailedToLoadSettings: 'No se han podido cargar los ajustes de memoria.',
  memoryFailedToEnable: 'No se han podido activar los recuerdos curados.',
  memoryIntro: 'La memoria a largo plazo de {{persona}} — datos y preferencias que recuerda cuando son relevantes. Duradera; privada de este agente.',
  memoryCuratedOff: 'Los recuerdos curados están desactivados para este agente. <1>Actívelos</1> para añadir datos que recordará.',
  memoryAddPlaceholder: 'El director financiero prefiere las actualizaciones de estado los viernes.',
  memoryEmptyBody: 'Añada datos que {{persona}} debería recordar; se recuerdan cuando son relevantes.',
} as const;
