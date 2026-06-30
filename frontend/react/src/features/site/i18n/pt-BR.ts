/**
 * `site` namespace — user-facing copy for the site front page.
 * Feature-self-contained: every site string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Default hero section
  heroEyebrow: 'Um padrão aberto para agentes de IA e workflows',
  heroHeading: 'Colegas de IA que fazem trabalho de verdade — e continuam seus.',
  heroSubheading: 'Crie agentes de IA e workflows automatizados que cuidam de tarefas reais, depois execute-os em qualquer lugar — porque o que você cria é portável, não preso a um único fornecedor.',
  heroCtaLabel: 'Abrir o app',
  heroCtaLabel2: 'Ver o padrão aberto',

  // Default "how it works" columns section
  columnsEyebrow: 'Como funciona',
  columnsHeading: 'Crie. Execute. Mantenha o controle.',
  columnBuildTitle: 'Criar',
  columnBuildText: 'Projete um agente ou um workflow em um canvas visual — ou comece a partir de um template pronto.',
  columnRunTitle: 'Executar',
  columnRunText: 'Veja-o trabalhar em tempo real. Toda execução é repetível e revisável.',
  columnControlTitle: 'Mantenha o controle',
  columnControlText: 'Você decide o que roda sozinho e o que precisa da sua aprovação — com suas próprias chaves para os apps conectados.',

  // Default "open standard" rich-text section (markdown emphasis + link)
  introEyebrow: 'O padrão aberto',
  introHeading: 'Crie uma vez. Execute em qualquer lugar.',
  introText: 'O OpenWOP é um **padrão aberto** — como o e-mail ou a web — que qualquer provedor pode suportar, então os agentes e workflows que você cria não ficam presos a um único fornecedor. Leia o padrão completo em [openwop.dev](https://openwop.dev).',

  // Default closing CTA section
  ctaHeading: 'Veja por si mesmo.',
  ctaLabel: 'Abrir o app →',

  // Features-page catalog search (CatalogView)
  catalogSearchLabel: 'Encontrar um recurso',
  catalogSearchPlaceholder: 'Buscar entre {{count}} recursos…',
  catalogSearchStatus: 'Mostrando {{count}} de {{total}}',
  catalogSearchClear: 'Limpar busca',
  catalogSearchEmpty: 'Nenhum recurso corresponde a “{{query}}”.',

  // FrontPageSettingsPanel — superadmin front-page editor
  eyebrow: 'Conteúdo',
  title: 'Página inicial',
  ledeDenied: 'A página inicial pública em /.',
  lede: 'A página inicial pública exibida em / para visitantes anônimos. Usuários autenticados sempre veem o aplicativo.',
  homePageSaved: 'Página inicial salva.',
  saveFailed: 'Falha ao salvar.',
  saving: 'Salvando…',
  savePublish: 'Salvar + publicar',
  deniedNotice: 'Editar a página inicial exige um principal <0>superadmin</0> (um tenant em <1>OPENWOP_SUPERADMIN_TENANTS</1>, ou a chave bearer de administrador).',
  frontPageToggle: '<0>Mostrar a página inicial</0> em <1>/</1> (desativado ⇒ <2>/</2> é o aplicativo para todos)',
  pageTitleLabel: 'Título da página (aba do navegador / SEO)',
  sectionsHeading: 'Seções',
  previewHeading: 'Pré-visualização',
  addSectionToPreview: 'Adicione uma seção para pré-visualizar.',
} as const;
