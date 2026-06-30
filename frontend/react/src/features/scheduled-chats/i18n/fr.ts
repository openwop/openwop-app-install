/** `scheduled-chats` namespace (ADR 0125). */
export const messages = {
  eyebrow: 'Plateforme',
  title: 'Chats planifiés',
  lede: "Faites exécuter un chat par un agent selon un calendrier (un récapitulatif quotidien, un rapport du lundi) et publiez le résultat dans une conversation.",
  org: 'Espace',
  colAgent: 'Agent',
  colSchedule: 'Planification',
  colStatus: 'Statut',
  delete: 'Supprimer',
  active: 'Actif',
  inert: 'Inerte',
  empty: 'Aucun chat planifié pour le moment.',
  emptyHint: "Créez un chat planifié pour exécuter un agent via cron.",
  loadError: 'Impossible de charger les chats planifiés.',
  disabled: 'Les chats planifiés sont désactivés pour cet espace.',
  colNextRun: 'Prochaine exécution',
} as const;
