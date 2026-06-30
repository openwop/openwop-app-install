/**
 * `agent-knowledge` namespace — user-facing copy for the Agent Knowledge & Memory
 * feature (ADR 0038 / ADR 0041). Feature-self-contained: every agent-knowledge
 * string lives here. Generic actions/states are reused from the `common`
 * namespace via `t('common:…')` and are NOT duplicated. Plural keys use
 * i18next `_one`/`_other` suffixes (Intl.PluralRules).
 */
export const messages = {
  // Panel loading / chrome
  loadingKnowledge: 'Carregando conhecimento…',
  intro: 'Dê a {{persona}} seu próprio conhecimento: <1>documentos</1> que ela pode citar e <3>notas &amp; fatos</3> privados que ela recupera a cada turno. Config local do host — não o manifesto de protocolo do agente.',

  // Run notices (success)
  collectionCreated: 'Coleção criada e vinculada.',
  documentIngested: 'Documento ingerido.',
  importedFromDrive: 'Importado do Google Drive.',
  collectionUnbound: 'Coleção desvinculada.',
  documentRemoved: 'Documento removido.',
  curatedNotesEnabled: 'Notas curadas habilitadas.',
  curatedNotesDisabled: 'Notas curadas desabilitadas.',

  // Documents section
  documentsTitle: 'Documentos',
  documentsHint: 'Coleções de conhecimento vinculadas — fragmentadas, incorporadas e citadas quando recuperadas.',
  documentsCreateOrgFirst: 'Crie uma organização primeiro para guardar os documentos deste agente.',
  organizationLabel: 'Organização',
  newCollectionNameLabel: 'Nome da nova coleção',
  newCollectionNamePlaceholder: 'Playbook da conta',
  createCollection: 'Criar coleção',
  noDocumentsBound: 'Nenhum documento vinculado ainda. Crie uma coleção e depois adicione um documento abaixo.',

  // Collection card
  docCount_one: '{{count}} doc',
  docCount_other: '{{count}} docs',
  unbind: 'Desvincular',
  unbindConfirm: 'Desvincular "{{name}}" deste agente? A coleção em si é mantida.',
  externalUnverified: 'Externo · não verificado',
  externalUnverifiedTitle: 'Importado de uma fonte externa (por exemplo, Google Drive ou um trigger). Tratado como não confiável — isolado quando o agente o lê, nunca seguido como instruções (ADR 0038 §C).',
  chunkCount_one: '· {{count}} fragmento',
  chunkCount_other: '· {{count}} fragmentos',
  removeDocumentLabel: 'Remover {{title}}',
  removeDocumentTitle: 'Remover documento',
  removeDocumentConfirm: 'Remover "{{title}}"?',
  documentTitleLabel: 'Título do documento',
  documentTitlePlaceholder: 'Notas da conta do T3',
  documentTextLabel: 'Texto do documento',
  documentTextHelp: 'O texto colado é fragmentado + incorporado para recuperação com citação.',
  documentTextPlaceholder: 'Cole o conteúdo do documento…',
  untitledDocument: 'Sem título',
  addDocument: 'Adicionar documento',
  importFromDriveLabel: 'Importar do Google Drive',
  importFromDrivePlaceholder: 'https://docs.google.com/document/d/…',
  importFromDrive: 'Importar do Drive',
  importFromDriveHint: 'Cole um link do Drive/Docs — importado com citação. Requer uma conta Google conectada.',

  // Notes section
  notesTitle: 'Notas & fatos',
  notesHint: 'Privado para este agente; recuperado automaticamente a cada turno (não citado).',
  allowCuratedNotes: 'Permitir notas curadas para este agente',
  enabled: 'habilitado',
  disabled: 'desabilitado',
  notesStored_one: '{{count}} memória armazenada — navegue, adicione e remova-as na aba <1>Memória</1>.',
  notesStored_other: '{{count}} memórias armazenadas — navegue, adicione e remova-as na aba <1>Memória</1>.',
  notesEnablePrompt: 'Habilite as notas curadas e depois adicione fatos privados que este agente recuperará na aba <1>Memória</1>.',

  // Retrieve preview
  retrieveTitle: 'Experimente uma recuperação',
  retrieveHint: 'Pré-visualize o que {{persona}} recuperaria para uma consulta.',
  queryLabel: 'Consulta',
  queryPlaceholder: 'O que sabemos sobre a conta?',
  retrieve: 'Recuperar',
  retrieveNoteChip: 'nota',
  retrieveExternalChip: 'externo',
  retrieveExternalTitle: 'Conteúdo externo não confiável — isolado quando o agente o lê (ADR 0038 §C).',
  retrieveNoMatches: 'Nenhuma correspondência — adicione documentos ou notas acima.',

  // Memory tab (ADR 0041)
  memoryFailedToLoadSettings: 'Falha ao carregar as configurações de memória.',
  memoryFailedToEnable: 'Falha ao habilitar as memórias curadas.',
  memoryIntro: 'A memória de longo prazo de {{persona}} — fatos e preferências que ela recupera quando relevante. Durável; privada para este agente.',
  memoryCuratedOff: 'As memórias curadas estão desativadas para este agente. <1>Habilite-as</1> para adicionar fatos que ela recuperará.',
  memoryAddPlaceholder: 'O CFO prefere atualizações de status às sextas-feiras.',
  memoryEmptyBody: 'Adicione fatos que {{persona}} deve lembrar; eles são recuperados quando relevantes.',
} as const;
