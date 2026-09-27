/**
 * `consent` namespace — user-facing copy for the Consent feature (ADR 0020).
 * Feature-self-contained: every consent string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  orgsEmptyClause: 'A política de consentimento pertence a uma organização',
  orgsFailedClause: 'A política de consentimento nunca chegou a ser solicitada',
  // Page chrome
  eyebrow: 'Espaço de trabalho',
  title: 'Consentimento',
  lede: 'Política de consentimento por região + ferramentas de titular de dados (LGPD/GDPR).',

  // Gating / empty states
  notEnabledTitle: 'O consentimento não está ativado',
  notEnabledBody: 'Enquanto o consentimento está desativado, o consentimento de marketing não é aplicado — apenas a supressão e a exclusão são. Peça a um administrador para ativar o recurso de Consentimento para este tenant.',

  // aria-labels
  orgPickerLabel: 'Organização',

  // Policy form
  regulatedRegionsLabel: 'Regiões reguladas (separadas por vírgula)',
  regulatedRegionsNotEnforced: 'Apenas informativo — nenhum caminho de aplicação lê esta lista. A aplicação vem do modo padrão e do consentimento registrado de cada titular.',
  channel_email: 'E-mail',
  channel_sms: 'SMS',
  channel_push: 'Push',
  channel_whatsapp: 'WhatsApp',
  sourceLine: 'Capturado via {{source}}',
  legalBasisLine: 'Base: {{basis}}',
  purposesLine: 'Finalidades: {{purposes}}',
  receiptFailedFeatures: 'Sistemas com falha: {{features}}.',
  regulatedRegionsPlaceholder: 'UE, CA',
  defaultModeLabel: 'Modo padrão',
  defaultModeOptInLabel: 'consentimento explícito (recusa por padrão)',
  defaultModeOptOutLabel: 'cancelamento voluntário',
  savePolicy: 'Salvar política',

  // Data subject (GDPR)
  dataSubjectTitle: 'Titular de dados (LGPD/GDPR)',
  subjectKeyLabel: 'Chave do titular',
  subjectKeyPlaceholder: 'cookie do visitante / id do usuário',
  lookup: 'Consultar',
  erase: 'Apagar',
  eraseConfirm: 'Apagar todos os dados do titular "{{subjectKey}}"? Exclusão de titular de dados (LGPD/GDPR) — não pode ser desfeita.',
  lookupNoRecord: 'Nenhum registro de consentimento para esse titular — os dados a jusante (se houver) ainda são apagados.',

  legalHoldTitle: 'Este espa\u00e7o de trabalho est\u00e1 sob reten\u00e7\u00e3o legal',
  legalHoldBody: 'A exclus\u00e3o est\u00e1 bloqueada enquanto a reten\u00e7\u00e3o estiver em vigor: uma a\u00e7\u00e3o judicial ou obriga\u00e7\u00e3o de guarda prevalece sobre o direito \u00e0 elimina\u00e7\u00e3o. Motivo: {{reason}}. Em vigor desde {{since}}. Um superadministrador precisa levantar a reten\u00e7\u00e3o antes que qualquer exclus\u00e3o de titular de dados possa ser executada.',
  legalHoldEraseDisabled: 'A exclus\u00e3o est\u00e1 bloqueada por uma reten\u00e7\u00e3o legal neste espa\u00e7o de trabalho.',
  eraseFailedHeld: 'Exclus\u00e3o recusada: este espa\u00e7o de trabalho est\u00e1 sob reten\u00e7\u00e3o legal.',
  retryErasure: 'Tentar a exclus\u00e3o novamente',
  lookupResultFor: 'Consentimento de \u201c{{subjectKey}}\u201d',
  lookupFailedTitle: 'N\u00e3o foi poss\u00edvel ler o consentimento deste titular',
  lookupFailedBody: 'A leitura de \u201c{{subjectKey}}\u201d falhou, ent\u00e3o ainda n\u00e3o se sabe nada sobre esta pessoa. Isso n\u00e3o \u00e9 o mesmo que n\u00e3o haver registro de consentimento \u2014 tente novamente antes de concluir qualquer coisa.',
  // Category chips
  categoryAnalytics: 'análise',
  categoryMarketing: 'marketing',
  categoryNecessaryOnly: 'somente necessários',

  // Consent records
  recordsTitle: 'Registros de consentimento',
  noRecords: 'Nenhum registro de consentimento ainda.',

  // Toasts — success
  policySaved: 'Política salva',
  eraseConfirmBody: 'Todos os reposit\u00f3rios de funcionalidades registrados s\u00e3o percorridos, em todas as chaves de identidade vinculadas deste titular. Nem tudo \u00e9 destru\u00eddo: os dados pr\u00f3prios dele s\u00e3o EXCLU\u00cdDOS; as linhas de que o espa\u00e7o de trabalho ainda precisa (participa\u00e7\u00f5es de acesso, vers\u00f5es de documentos, tarefas agendadas) s\u00e3o ANONIMIZADAS no lugar \u2014 a linha permanece com os identificadores e o texto do titular sobrescritos; e os registros que a lei exige manter, como pedidos e notas fiscais, s\u00e3o RETIDOS com as partes pessoais suprimidas (valores, identificadores e regi\u00e3o aproximada permanecem). A exclusão também bloqueia permanentemente os envios de marketing e toda reinscrição pública deste titular até que um administrador o readmita. N\u00e3o pode ser desfeito.',
  receiptOk: 'Exclus\u00e3o conclu\u00edda para "{{subjectKey}}" em {{keys}} chave(s) de identidade vinculada(s); todos os {{total}} reposit\u00f3rio(s) relataram sucesso \u2014 dados exclu\u00eddos ou anonimizados no lugar, com os registros de reten\u00e7\u00e3o legal (pedidos, notas fiscais) mantidos de forma suprimida. Os envios de marketing e toda reinscrição pública deste titular ficam agora bloqueados permanentemente até que um administrador o readmita.',
  receiptPartial: 'Exclusão parcial de "{{subjectKey}}": {{failed}} passo(s) de exclusão falharam (entre {{total}} repositórios + a resolução de vínculos de identidade) — os dados deste titular PODEM persistir.',
  receiptFoundNothing: 'A exclusão de "{{subjectKey}}" foi executada sem erros, mas NÃO encontrou nada para excluir neste espaço de trabalho ({{keys}} chave(s) de identidade vinculada(s) verificadas em {{total}} repositórios). A exclusão alcança apenas os dados deste espaço de trabalho — se esta pessoa existir em outro lugar, os dados pessoais dela podem estar no espaço de trabalho pessoal dela; execute a exclusão lá também. Os envios de marketing e toda reinscrição pública deste titular ficam agora bloqueados aqui permanentemente até que um administrador o readmita.',
  receiptHadRecord: 'Havia um registro de consentimento e ele foi removido.',
  receiptNoRecord: 'Não havia registro de consentimento.',
  receiptRetry: 'A exclusão é idempotente — execute novamente; se continuar falhando, escale antes de dar a solicitação como concluída.',
  receiptMissing: 'Esperados, mas não registrados neste host: {{features}}.',
  receiptRowsTouched: '{{count}} linha(s) excluída(s) ou limpa(s).',
  eraseRefusedHeldTitle: 'Exclusão recusada — retenção legal',
  eraseRefusedHeldBody: 'A exclusão de "{{subjectKey}}" foi recusada: este espaço de trabalho está sob retenção legal. Nada foi excluído. Um superadministrador do espaço de trabalho precisa suspender a retenção antes que esta solicitação possa ser executada.',
  readmitButton: 'Readmitir titular',
  readmitHintAfterErasure: 'Se esta pessoa pedir para voltar mais tarde, um administrador pode readmiti-la. Isso apenas remove o bloqueio: nenhum consentimento é concedido até que ela opte por participar novamente.',
  readmitHintNoRecord: 'Se esta pessoa foi excluída e pediu para voltar, um administrador pode readmiti-la. Isso apenas remove o bloqueio: nenhum consentimento é concedido até que ela opte por participar novamente.',
  readmitDialogTitle: 'Readmitir “{{subjectKey}}”?',
  readmitDialogBody: 'Isso remove o bloqueio da exclusão sobre os envios de marketing e a reinscrição pública deste titular. Por si só não concede nada: nenhum consentimento é registrado; a próxima aceitação afirmativa dele é o que o concede novamente. Sua declaração abaixo é o seu atestado de que a pessoa pediu para voltar, e ela é gravada no registro de auditoria.',
  readmitAttestationLabel: 'Sua declaração de que esta pessoa pediu para voltar',
  readmitAttestationPlaceholder: 'ex.: Pediu por e-mail em 11 de set. para voltar a receber nossa newsletter; chamado nº 4821.',
  readmitAttestationHint: '{{count}} de pelo menos {{min}} caracteres',
  readmitConfirm: 'Readmitir',
  readmitDone: '“{{subjectKey}}” foi readmitido(a). Nenhum consentimento foi concedido — a próxima aceitação afirmativa dele(a) o concede novamente.',
  readmitNotErased: '“{{subjectKey}}” não está excluído(a) neste host — não havia bloqueio a remover.',
  readmitFailed: 'A readmissão falhou.',
  readmitForbidden: 'Somente um administrador do espaço de trabalho pode readmitir um titular.',
  readmitAttestationTooShort: 'A declaração precisa ter pelo menos {{min}} caracteres.',

  // Toasts / errors
  loadPolicyFailed: 'Falha ao carregar a política.',
  policyLoadRetry: 'Tentar novamente',
  policyLoadFailedTitle: 'Não foi possível carregar a política de consentimento',
  saveFailed: 'Falha ao salvar.',
  lookupFailed: 'Falha na consulta.',
  eraseFailed: 'Falha ao apagar.',
  // §4.5 collection kit — records filtering + designed empty/zero-match states
  recordsFilterGroup: 'Filtrar',
  recordsSearchPlaceholder: 'Buscar por titular…',
  recordsSearchAria: 'Buscar registros de consentimento por titular',
  categoryFacetAria: 'Filtrar por categoria',
  categoryAll: 'Todas as categorias',
  regionFacetAria: 'Filtrar por região',
  regionAll: 'Todas as regiões',
  noRecordsTitle: 'Ainda não há registros de consentimento',
  recordsLoadFailedTitle: 'Não foi possível carregar os registros de consentimento',
  recordsLoadFailedBody: 'A leitura dos registros falhou — esta lista NÃO está vazia até que uma leitura bem-sucedida confirme.',
  unsavedChanges: 'Alterações não salvas',
  nothingToSave: 'Nenhuma alteração para salvar',
  discardEditsTitle: 'Descartar alterações de política não salvas?',
  discardEditsBody: 'Trocar de espaço de trabalho descartará suas edições não salvas da política de consentimento.',
  discardEditsConfirm: 'Descartar e trocar',
  recordsNoMatchTitle: 'Nenhuma correspondência',
  recordsNoMatchBody: 'Nenhum registro de consentimento corresponde aos filtros atuais.',
  recordsClearFilters: 'Limpar filtros',
} as const;
