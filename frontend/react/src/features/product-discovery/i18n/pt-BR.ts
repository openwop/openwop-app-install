/** `discovery` namespace — Brazilian Portuguese (ADR 0275 / MERCH-C). */
export const messages = {
  // The feature-specific REASON an organization is needed — a capitalised
  // sentence minus its stop, which `ui:orgStateEmptyBody` supplies. The frame
  // carries no instruction (that is the CTA's) and no noun, so this clause is
  // the one place the noun appears: say "organization", never "org".
  orgsEmptyClause: 'As coleções e as regras de merchandising pertencem a uma organização',
  orgsFailedClause: 'As coleções e as regras de merchandising nunca chegaram a ser solicitadas',
  orgsRetry: 'Tentar novamente',
  rowsFailedTitle: 'Não foi possível carregar as coleções',
  rowsFailedBody: 'É uma leitura com falha, não uma lista vazia: não significa que não existam coleções.',
  rulesFailedTitle: 'Não conseguimos carregar as regras desta loja',
  rulesFailedBody: 'É uma leitura que falhou, não uma lista vazia — ela não diz se alguma regra está escondendo produtos da sua vitrine.',
  hiddenByRules_one: 'Suas regras esconderam {{formatted}} produto desta prévia.',
  hiddenByRules_other: 'Suas regras esconderam {{formatted}} produtos desta prévia.',
  eyebrow: 'Negócios',
  title: 'Descoberta',
  lede: 'Coleções, busca por facetas e regras de merchandising para sua loja.',

  notEnabledTitle: 'A descoberta não está ativada',
  notEnabledBody: 'Peça a um administrador para ativar o recurso Descoberta em Admin → Interruptores de recurso.',
  noCollectionsTitle: 'Ainda não há coleções',
  noCollectionsBody: 'Adicione uma coleção acima — uma dinâmica se preenche por categoria, uma manual é curada à mão.',

  captionCollections: 'Coleções',
  captionRules: 'Regras de merchandising',
  colName: 'Nome',
  colType: 'Tipo',
  colDetail: 'Conteúdo',
  colScope: 'Escopo',
  colHoldout: 'Reserva',
  itemsCount_one: '{{count}} item',
  itemsCount_other: '{{count}} itens',

  fieldCollectionName: 'Nome da coleção',
  fieldType: 'Tipo',
  fieldCategory: 'Categoria',
  fieldRuleName: 'Nome da regra',
  fieldHideCategory: 'Ocultar categoria',
  fieldSearch: 'Buscar',
  collectionPlaceholder: 'ex. Seleção de verão',
  categoryPlaceholder: 'ex. foto',
  rulePlaceholder: 'ex. Ocultar liquidação',
  searchPlaceholder: 'Buscar produtos…',

  rulesTitle: 'Adicionar uma regra de merchandising (ocultar uma categoria)',
  addCollection: 'Adicionar coleção',
  addRule: 'Adicionar regra',
  runSearch: 'Buscar',
  searchEmpty: 'Nenhum produto correspondeu.',

  type_dynamic: 'Dinâmica (por categoria)',
  type_manual: 'Manual (curada)',

  deleteRowLabel: 'Excluir {{name}}',
  deleteCollectionConfirm: 'Excluir a coleção "{{name}}"?',
  deleteRuleConfirm: 'Excluir a regra "{{name}}"?',

  collectionAdded: 'Coleção adicionada.',
  collectionDeleted: 'Coleção excluída.',
  ruleAdded: 'Regra adicionada.',
  ruleDeleted: 'Regra excluída.',
  loadFailed: 'Falha ao carregar a descoberta.',
  addFailed: 'Falha ao adicionar.',
  deleteFailed: 'Falha ao excluir.',
  searchFailed: 'A busca falhou.',
  searchFailedPersistent: "A busca falhou — isto não são resultados da sua consulta. Tente novamente para obter uma resposta.",
  noRulesTitle: "Sem regras de merchandising",
  noRulesBody: "As regras ocultam produtos da sua loja. Nenhuma está ativa, então os compradores veem tudo.",
  productsTruncated: "Mostrando os primeiros {{shown}} de {{total}} resultados.",
  facetsTruncated: "Os {{shown}} principais valores de {{total}} por faceta.",
  fieldCategoryHelp: "Os produtos desta categoria entram na coleção automaticamente.",
  fieldHideCategoryHelp: "Os produtos desta categoria deixam de aparecer na sua loja enquanto esta regra estiver ativa.",
} as const;
