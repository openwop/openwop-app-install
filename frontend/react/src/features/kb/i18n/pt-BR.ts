/**
 * `kb` namespace — Knowledge Base / RAG feature copy (ADR 0011).
 * Feature-specific strings; generic actions/states reuse `common:`.
 */
export const messages = {
  // Page header
  eyebrow: 'Plataforma',
  title: 'Base de Conhecimento',
  lede: 'Dê à sua IA uma biblioteca dos seus próprios documentos para consultar — ela encontra os trechos mais relevantes e os cita nas respostas.',
  // Feature gate / empty states
  disabledTitle: 'A Base de Conhecimento não está ativada',
  disabledBody: 'Peça a um administrador para ativar o recurso Base de Conhecimento para este tenant.',
  noOrgsTitle: 'Nenhuma organização',
  noOrgsBody: 'Crie uma organização primeiro — as coleções pertencem a uma organização.',
  selectCollectionTitle: 'Selecione uma coleção',
  selectCollectionBody: 'Escolha uma coleção à esquerda ou crie uma — depois adicione documentos e busque.',
  // Org picker
  organizationLabel: 'Organização',
  // Collections panel
  collectionsHeading: 'Coleções',
  noCollections: 'Nenhuma coleção ainda.',
  documentsTooltip: 'documentos',
  deleteCollection: 'Excluir coleção',
  newCollectionPlaceholder: 'Nova coleção',
  createCollection: 'Criar coleção',
  // Search panel
  searchHeading: 'Buscar “{{name}}”',
  searchPlaceholder: 'Faça uma pergunta…',
  retrievalModeLabel: 'Recuperação',
  retrievalModeDense: 'Padrão (semântica)',
  retrievalModeHybrid: 'Híbrida (palavras-chave + semântica)',
  retrievalModeRerank: 'Melhor correspondência (híbrida + reordenação)',
  retrievalModeFailed: 'Não foi possível atualizar o modo de recuperação.',
  noMatches: 'Nenhum resultado — adicione documentos ou tente uma pergunta diferente.',
  cosineScoreTooltip: 'pontuação de cosseno',
  // Ingest panel
  addDocumentHeading: 'Adicionar um documento',
  titlePlaceholder: 'Título (opcional)',
  ingestPlaceholder: 'Cole o texto para dividir em chunks + incorporar nesta coleção…',
  untitled: 'Sem título',
  ingest: 'Ingerir',
  // Documents panel
  documentsHeading: 'Documentos',
  noDocuments: 'Nenhum documento ainda.',
  noDocumentsTitle: 'Sem documentos',
  chunksTooltip: 'chunks',
  chunkCount_one: '{{count}} chunk',
  chunkCount_other: '{{count}} chunks',
  deleteDocument: 'Excluir documento',
  // Procedência do documento (chip + sublinha da visualização)
  sourceText: 'Texto colado',
  sourceMedia: 'Importação de mídia',
  // Filtro da lista de documentos + visualização grade/lista (cânone §4.5)
  docFilterGroup: 'Filtrar documentos',
  docFilterPlaceholder: 'Filtrar documentos…',
  docFilterAria: 'Filtrar documentos por título',
  docNoMatchTitle: 'Nenhum documento correspondente',
  docNoMatchBody: 'Nenhum documento corresponde à sua busca. Tente outro termo.',
  clearDocSearch: 'Limpar busca',
  // Toast errors
  loadCollectionsFailed: 'Falha ao carregar as coleções.',
  loadOrgsFailed: 'Falha ao carregar as organizações.',
  loadDocumentsFailed: 'Falha ao carregar os documentos.',
  createFailed: 'Falha ao criar.',
  deleteFailed: 'Falha ao excluir.',
  ingestFailed: 'Falha ao ingerir.',
  uploadFileLabel: 'Enviar um arquivo',
  uploadFileHint: 'PDF, DOCX ou texto — extraído e adicionado a esta coleção.',
  documentAdded: 'Documento adicionado.',
  fileTooLarge: 'Esse arquivo é muito grande (máx. {{max}} MB).',
  uploading: 'Enviando…',
  searchFailed: 'Falha na busca.',
  managedBadge: 'Sincronizado',
  managedTitle: 'Sincronizado automaticamente de {{source}} — somente leitura aqui',
  managedNotice: 'Esta coleção é mantida em sincronia com seus itens de {{source}}. Gerencie-os naquela página; os documentos aqui são somente leitura.',
  managedSource_strategy: 'Estratégia',
  'managedSource_priority-matrix': 'Matriz de Prioridades',
} as const;
