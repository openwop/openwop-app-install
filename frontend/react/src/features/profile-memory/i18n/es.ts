/**
 * `profile-memory` namespace — user-facing copy for the personal Memory (ADR 0041)
 * and personal Knowledge (ADR 0042) profile tabs. Both tabs and their clients share
 * this one catalog. Generic actions/states are reused from `common` via `t('common:…')`.
 */
export const messages = {
  // Knowledge tab (ProfileKnowledgeTab) — <Trans> intro with <strong> markup
  knowledgeIntro:
    'Adjunte <0>documentos</0> a su perfil: fuentes en las que su gemelo digital puede basarse, junto a los datos de su pestaña de Memoria.',
  knowledgeAudience:
    'Los documentos se guardan en su espacio de trabajo, no en un almacén privado: cualquiera que pueda leer ese espacio puede abrirlos. Las notas de su Memoria son distintas: esas siguen siendo suyas.',
  knowledgeEmptyBody: 'Cree una fuente arriba y luego añada documentos que su gemelo pueda citar.',
  knowledgeSearchTitle: 'Busque en su conocimiento',
  knowledgeSearchPlaceholder: '¿Qué recordaría su gemelo?',

  // Memory tab (ProfileMemoryTab) — <Trans> intro with <strong> markup
  memoryIntro:
    'Entrene su perfil con memorias personales: datos, preferencias y contexto sobre cómo trabaja. Con el tiempo, esto se convierte en un <0>gemelo digital</0> de usted. Duradero y solo suyo, salvo que conceda a un agente permiso para recordarlas.',
  memoryAddPlaceholder: 'Prefiero las actualizaciones asíncronas a las reuniones; mis horas de concentración son de 9 a 11 h.',
  memoryEmptyBody: 'Empiece a entrenar a su gemelo: añada un dato o una preferencia sobre cómo trabaja.',

  // Consentimiento de extracción automática (ADR 0120)
  consentLabel: 'Aprender automáticamente datos duraderos de mis chats',
  consentHint: 'Cuando está activado, su asistente puede guardar datos duraderos que aprende durante los chats. Los datos aprendidos aparecen abajo, marcados como «Aprendida automáticamente», y puede eliminarlos. Desactivarlo detiene el aprendizaje futuro, pero no elimina lo ya aprendido. Desactivado por defecto.',
  erasureScopeNote: 'Eliminar los datos de su cuenta borra su memoria personal. No alcanza lo que un agente compartido del espacio de trabajo recuerda de sus conversaciones con él: esa memoria pertenece al espacio de trabajo. Pida a un administrador que borre la memoria del agente desde su pestaña Memoria.',
  consentError: 'No se pudo actualizar la opción de aprendizaje de memoria.',
  consentLoadFailed: 'No se pudo leer si el aprendizaje de memoria está activado. Puede estar ACTIVADO: esto no confirma que esté desactivado.',
  consentRetry: 'Reintentar',
} as const;
