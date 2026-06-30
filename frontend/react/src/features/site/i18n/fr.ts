/**
 * `site` namespace — user-facing copy for the site front page.
 * Feature-self-contained: every site string lives here. Generic actions/states
 * are reused from the `common` namespace via `t('common:…')` and are NOT duplicated.
 */
export const messages = {
  // Default hero section
  heroEyebrow: 'Un standard ouvert pour les agents et workflows IA',
  heroHeading: 'Des collègues IA qui font un vrai travail — et qui restent les vôtres.',
  heroSubheading: 'Créez des agents IA et des workflows automatisés qui gèrent de vraies tâches, puis exécutez-les partout — parce que ce que vous créez est portable, et non verrouillé chez un seul fournisseur.',
  heroCtaLabel: 'Lancer l\'application',
  heroCtaLabel2: 'Découvrir le standard ouvert',

  // Default "how it works" columns section
  columnsEyebrow: 'Comment ça marche',
  columnsHeading: 'Créez-le. Exécutez-le. Gardez le contrôle.',
  columnBuildTitle: 'Créer',
  columnBuildText: 'Concevez un agent ou un workflow sur un canevas visuel — ou partez d\'un modèle prêt à l\'emploi.',
  columnRunTitle: 'Exécuter',
  columnRunText: 'Regardez-le travailler en temps réel. Chaque exécution est reproductible et vérifiable.',
  columnControlTitle: 'Gardez le contrôle',
  columnControlText: 'Vous décidez de ce qui s\'exécute tout seul et de ce qui nécessite votre validation — avec vos propres clés pour les applications connectées.',

  // Default "open standard" rich-text section (markdown emphasis + link)
  introEyebrow: 'Le standard ouvert',
  introHeading: 'Créez-le une fois. Exécutez-le partout.',
  introText: 'OpenWOP est un **standard ouvert** — comme l\'e-mail ou le web — que tout fournisseur peut prendre en charge, de sorte que les agents et workflows que vous créez ne sont pas verrouillés chez un seul fournisseur. Lisez le standard complet sur [openwop.dev](https://openwop.dev).',

  // Default closing CTA section
  ctaHeading: 'Voyez par vous-même.',
  ctaLabel: 'Ouvrir l\'application →',

  // Features-page catalog search (CatalogView)
  catalogSearchLabel: 'Trouver une fonctionnalité',
  catalogSearchPlaceholder: 'Rechercher parmi {{count}} fonctionnalités…',
  catalogSearchStatus: 'Affichage de {{count}} sur {{total}}',
  catalogSearchClear: 'Effacer la recherche',
  catalogSearchEmpty: 'Aucune fonctionnalité ne correspond à « {{query}} ».',

  // FrontPageSettingsPanel — superadmin front-page editor
  eyebrow: 'Contenu',
  title: 'Page d\'accueil',
  ledeDenied: 'La page d\'accueil publique à /.',
  lede: 'La page d\'accueil publique affichée à / pour les visiteurs anonymes. Les utilisateurs connectés obtiennent toujours l\'application.',
  homePageSaved: 'Page d\'accueil enregistrée.',
  saveFailed: 'Échec de l\'enregistrement.',
  saving: 'Enregistrement…',
  savePublish: 'Enregistrer et publier',
  deniedNotice: 'Modifier la page d\'accueil requiert un principal <0>superadmin</0> (un locataire dans <1>OPENWOP_SUPERADMIN_TENANTS</1>, ou la clé bearer admin).',
  frontPageToggle: '<0>Afficher la page d\'accueil</0> à <1>/</1> (désactivé ⇒ <2>/</2> est l\'application pour tout le monde)',
  pageTitleLabel: 'Titre de la page (onglet du navigateur / SEO)',
  sectionsHeading: 'Sections',
  previewHeading: 'Aperçu',
  addSectionToPreview: 'Ajoutez une section à prévisualiser.',
} as const;
