/**
 * `agentAllowlists` namespace — éditeur des listes d'outils d'agents (ADR 0104).
 * French (fr).
 */
export const messages = {
  eyebrow: 'Plateforme',
  title: 'Listes d’outils des agents',
  lede: 'Accordez ou révoquez les outils proposés à un agent, sans modifier un pack. Les remplacements s’appliquent par espace de travail et prennent effet à la prochaine exécution.',
  loading: 'Chargement des agents…',
  loadFailed: 'Échec du chargement des agents.',
  saveFailed: 'Échec de l’enregistrement du remplacement.',
  resetFailed: 'Échec de la réinitialisation à la valeur du pack.',
  noAgentsTitle: 'Aucun agent trouvé',
  noAgentsBody: 'Aucun agent exécutable n’est installé pour cet espace de travail.',
  agentListLabel: 'Agents',
  overriddenChip: 'remplacement',
  pickAgentTitle: 'Choisissez un agent',
  pickAgentBody: 'Choisissez un agent à gauche pour voir et modifier les outils qui lui sont proposés.',
  agentIdChip: 'id : {{id}}',
  usingOverride: 'Remplacement ({{n}} outils)',
  usingManifest: 'Valeur du pack',
  explainer: 'Les outils cochés sont proposés à cet agent. Décocher un outil du pack le révoque ; en cocher un autre l’accorde. Un outil non installé n’est proposé qu’une fois son pack monté.',
  toolChecklistLabel: 'Outils pour {{label}}',
  manifestTag: 'valeur du pack',
  notMountedTag: 'non monté',
  resetToManifest: 'Réinitialiser au pack',
  saveOverride: 'Enregistrer le remplacement',
  saving: 'Enregistrement…',
} as const;
