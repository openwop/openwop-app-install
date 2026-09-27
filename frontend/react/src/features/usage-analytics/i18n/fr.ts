/** Espace de noms `usage-analytics` (ADR 0118) — tableau d’usage/coûts LLM. */
export const messages = {
  // The feature-specific REASON an organization is needed — a capitalised
  // sentence minus its stop, which `ui:orgStateEmptyBody` supplies. The frame
  // carries no instruction (that is the CTA's) and no noun, so this clause is
  // the one place the noun appears: say "organization", never "org".
  orgsEmptyClause: 'L’usage des modèles appartient à une organisation',
  orgsFailedClause: 'Le récapitulatif d’utilisation n’a jamais été demandé',
  eyebrow: 'Espace',
  title: 'Usage LLM',
  lede: "Usage de jetons par modèle dans cet espace. Lecture seule ; nombres de jetons uniquement.",
  colProvider: 'Fournisseur',
  colModel: 'Modèle',
  colInput: "Jetons d’entrée",
  colOutput: 'Jetons de sortie',
  colCalls: 'Appels',
  empty: "Aucun usage enregistré pour l’instant.",
  emptyHint: "L’usage apparaît ici lorsque des conversations s’exécutent sur un fournisseur configuré.",
  loadError: "Impossible de charger l’usage.",
  loadFailedTitle: "Impossible de charger l’usage",
  loadRetry: 'Réessayer',
  disabled: "L’analyse d’usage est désactivée pour cet espace.",
  colCost: 'Coût est.',

  // §4.5 collection kit — usage filter
  filterGroup: 'Filtres',
  filterPlaceholder: "Rechercher l’usage…",
  filterAria: 'Rechercher l’usage par fournisseur ou modèle',
  filterProviderLabel: 'Filtrer par fournisseur',
  allProviders: 'Tous les fournisseurs',
  noMatchTitle: 'Aucune correspondance',
  noMatchBody: 'Rien ne correspond aux filtres actuels.',
  clearFilters: 'Effacer les filtres',
  costUnpriced: "—",
  costUnpricedHint: "Aucun tarif enregistré pour ce modèle : son coût est inconnu, pas nul.",
  costIncomplete: "{{count}} modèle(s) n’ont pas de tarif enregistré : leur coût est inconnu et les totaux ici sont incomplets.",
} as const;
