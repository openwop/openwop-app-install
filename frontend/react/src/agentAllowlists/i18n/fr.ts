/**
 * `agentAllowlists` namespace — éditeur des listes d’outils d’agents (ADR 0104).
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
  usingManifest: 'Valeur du pack + outils de plateforme',
  explainer: 'Les outils cochés sont proposés à cet agent. Six outils de plateforme sont activés par défaut pour chaque agent (étiquetés « activé par défaut ») ; en décocher un le révoque pour cet agent, en cocher un autre l’accorde. Un outil non installé n’est proposé qu’une fois son pack monté.',
  toolChecklistLabel: 'Outils pour {{label}}',
  defaultOnTag: 'activé par défaut',
  manifestTag: 'valeur du pack',
  notMountedTag: 'non monté',
  resetToManifest: 'Réinitialiser au pack',
  saveOverride: 'Enregistrer le remplacement',
  pinWarning: 'Enregistrer fige cet agent sur les outils cochés ici. Il ne recevra plus automatiquement les nouveaux outils activés par défaut jusqu’à ce que vous réinitialisiez à la valeur du pack.',
  saving: 'Enregistrement…',
  loadFailedTitle: "Impossible de charger les listes d’outils autorisés",
  loadFailedBody: "C’est une lecture en échec, pas une liste vide : la liste de chaque agent est inchangée.",
  retry: "Réessayer",
} as const;
