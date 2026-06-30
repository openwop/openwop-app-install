/** Espace de noms `usage-analytics` (ADR 0118) — tableau d'usage/coûts LLM. */
export const messages = {
  eyebrow: 'Espace',
  title: 'Usage LLM',
  lede: "Usage de jetons par modèle dans cet espace. Lecture seule ; nombres de jetons uniquement.",
  org: 'Espace',
  colProvider: 'Fournisseur',
  colModel: 'Modèle',
  colInput: "Jetons d'entrée",
  colOutput: 'Jetons de sortie',
  colCalls: 'Appels',
  empty: "Aucun usage enregistré pour l'instant.",
  emptyHint: "L'usage apparaît ici lorsque des conversations s'exécutent sur un fournisseur configuré.",
  loadError: "Impossible de charger l'usage.",
  disabled: "L'analyse d'usage est désactivée pour cet espace.",
  colCost: 'Coût est.',
} as const;
