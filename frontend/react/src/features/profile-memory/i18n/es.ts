/**
 * `profile-memory` namespace — user-facing copy for the personal Memory (ADR 0041)
 * and personal Knowledge (ADR 0042) profile tabs. Both tabs and their clients share
 * this one catalog. Generic actions/states are reused from `common` via `t('common:…')`.
 */
export const messages = {
  // Knowledge tab (ProfileKnowledgeTab) — <Trans> intro with <strong> markup
  knowledgeIntro:
    'Adjunte <0>documentos</0> a su perfil: fuentes citadas en las que su gemelo digital puede basarse, junto a los datos de su pestaña de Memoria. Privados para usted.',
  knowledgeEmptyBody: 'Cree una fuente arriba y luego añada documentos que su gemelo pueda citar.',
  knowledgeSearchTitle: 'Busque en su conocimiento',
  knowledgeSearchPlaceholder: '¿Qué recordaría su gemelo?',

  // Memory tab (ProfileMemoryTab) — <Trans> intro with <strong> markup
  memoryIntro:
    'Entrene su perfil con memorias personales: datos, preferencias y contexto sobre cómo trabaja. Con el tiempo, esto se convierte en un <0>gemelo digital</0> de usted. Duradero y privado para usted.',
  memoryAddPlaceholder: 'Prefiero las actualizaciones asíncronas a las reuniones; mis horas de concentración son de 9 a 11 h.',
  memoryEmptyBody: 'Empiece a entrenar a su gemelo: añada un dato o una preferencia sobre cómo trabaja.',

  // Consentimiento de extracción automática (ADR 0120)
  consentLabel: 'Aprender automáticamente datos duraderos de mis chats',
  consentHint: 'Cuando está activado, su asistente puede guardar como memorias los datos duraderos que aprende durante los chats — que puede revisar y eliminar cuando quiera. Desactivado por defecto.',
  consentError: 'No se pudo actualizar la opción de aprendizaje de memoria.',
} as const;
