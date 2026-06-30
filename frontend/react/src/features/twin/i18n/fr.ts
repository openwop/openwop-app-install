/**
 * `twin` namespace — user-facing copy for the digital-twin feature
 * (agent twin grants + recall). Auto-registered by the i18n catalog glob.
 * One `key: 'value',` per line, 2-space indent.
 */
export const messages = {
  // ProfileTwinGrantsTab — "Who can recall my memory"
  grantsIntro: 'Agents que vous avez autorisés à rappeler votre corpus en tant que votre <0>jumeau numérique</0>. La révocation prend effet immédiatement — y compris sur toute exécution déjà en cours.',
  failedToLoadGrants: 'Échec du chargement des autorisations.',
  recallRevokedEverywhere: 'Rappel révoqué — effet immédiat, partout.',
  revokeFailed: 'Échec de la révocation.',
  loading: 'Chargement…',
  noAgentTitle: 'Aucun agent ne peut rappeler votre mémoire',
  noAgentBody: 'Lorsque vous faites d\'un agent votre jumeau et autorisez le rappel (sur le profil de l\'agent), il apparaît ici.',
  noScopes: 'aucune portée',
  revoke: 'Révoquer',

  // AgentTwinPanel — "Twin of …" affordance
  digitalTwin: 'Jumeau numérique',
  panelIntro: 'Liez {{persona}} à une personne afin qu\'il puisse agir comme son jumeau numérique. L\'agent ne peut rappeler la mémoire ou les connaissances de cette personne <0>qu\'après qu\'elle l\'a autorisé</0> — un lien seul n\'accorde rien.',
  failedToLoadTwinLink: 'Échec du chargement du lien de jumeau.',
  actionFailed: 'Échec de l\'action.',
  notTwinYet: '{{persona}} n\'est encore le jumeau de personne.',
  nowYourTwin: '{{persona}} est désormais votre jumeau.',
  makeTwinOfMe: 'Faire de {{persona}} un jumeau de moi',
  twinOfYou: 'Jumeau de <0>vous</0>',
  twinOfPerson: 'Jumeau de',
  twinLinkRemoved: 'Lien de jumeau supprimé.',
  unlink: 'Délier',
  allowRecallHeading: 'Autoriser {{persona}} à rappeler votre…',
  scopeMemory: 'mémoire',
  scopeKnowledge: 'connaissances',
  recallConsentSaved: 'Consentement de rappel enregistré.',
  updateConsent: 'Mettre à jour le consentement',
  allowRecall: 'Autoriser le rappel',
  recallRevoked: 'Rappel révoqué.',
  revokeRecall: 'Révoquer le rappel',
  recallActive: 'Actif — {{persona}} peut rappeler votre {{scopes}}. La révocation est immédiate, partout.',
  recallActiveNothing: 'rien',
  noRecallGranted: 'Aucun rappel accordé pour l\'instant — {{persona}} ne peut pas lire votre mémoire ni vos connaissances.',
  onlyLinkedCanAllow: 'Seul {{name}} peut autoriser {{persona}} à rappeler sa mémoire ou ses connaissances.',
} as const;
