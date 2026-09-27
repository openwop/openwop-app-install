/**
 * `twin` namespace — user-facing copy for the digital-twin feature
 * (agent twin grants + recall). Auto-registered by the i18n catalog glob.
 * One `key: 'value',` per line, 2-space indent.
 */
export const messages = {
  // ProfileTwinGrantsTab — "Who can recall my memory"
  grantsIntro: 'Agents que vous avez autorisés à rappeler votre corpus en tant que votre <0>jumeau numérique</0>. La révocation arrête aussitôt tout rappel ultérieur — y compris au milieu d’un tour déjà en cours. Elle ne peut pas reprendre ce qui a déjà été rappelé : le contenu rappelé plus tôt dans ce même tour y reste, et elle ne peut pas effacer ce qu’un agent a déjà écrit dans une conversation antérieure. Le rappel ne répond qu’à vous : quand quelqu’un d’autre — un collègue, ou une automatisation non attribuée — s’adresse à votre jumeau, il n’obtient rien de votre mémoire. Dans un appel vocal en direct, le contenu composé au début de l’appel reste disponible pour cet appel jusqu’à sa fin.',
  failedToLoadGrants: 'Échec du chargement des autorisations.',
  recallRevokedEverywhere: 'Rappel révoqué. Plus aucun rappel à partir de maintenant.',
  revokeFailed: 'Échec de la révocation.',
  loading: 'Chargement…',
  noAgentTitle: 'Aucun agent ne peut rappeler votre mémoire',
  noAgentBody: 'Ouvrez l’<0>onglet Intégrations</0> d’un agent pour en faire votre jumeau et autoriser le rappel. Il apparaîtra ensuite ici.',
  noScopes: 'aucune portée',
  identityUnknown: 'Impossible de confirmer quel profil est le vôtre : nous ne pouvons donc pas dire si ce jumeau vous est lié. Les réglages de rappel restent masqués tant que ce n’est pas établi — ce n’est pas une confirmation qu’aucun rappel n’est accordé.',
  twinOfUnknown: 'Jumeau de (propriétaire non confirmé)',
  agentNamesUnavailable: 'Les noms des agents n’ont pas pu être chargés : les autorisations ci-dessous affichent des identifiants bruts. La révocation fonctionne toujours.',
  revoke: 'Révoquer',
  revokeNothingToRevoke: 'Rien à révoquer — cet accès avait déjà pris fin.',
  scopeUnknown: 'un type d’accès non reconnu',
  // TWIN-UX-4 — visibilité d’usage sur les cartes de consentement
  failedToLoadRecalls: 'Impossible de charger l’activité de rappel.',
  recallsUnavailable: 'L’activité de rappel n’a pas pu être chargée — c’est une lecture en échec, pas la confirmation que rien n’a été rappelé.',
  lastRecalled_one: 'Dernier rappel : {{date}} · {{count}} fois',
  lastRecalled_other: 'Dernier rappel : {{date}} · {{count}} fois',
  neverRecalled: 'Encore aucun rappel.',
  deniedRecallAttempts_one: '{{count}} tentative d’une autre personne refusée',
  deniedRecallAttempts_other: '{{count}} tentatives d’autres personnes refusées',

  // AgentTwinPanel — "Twin of …" affordance
  digitalTwin: 'Jumeau numérique',
  panelIntro: 'Liez {{persona}} à une personne afin qu’il puisse agir comme son jumeau numérique. L’agent ne peut rappeler la mémoire ou les connaissances de cette personne <0>qu’après qu’elle l’a autorisé</0> — un lien seul n’accorde rien.',
  failedToLoadTwinLink: 'Échec du chargement du lien de jumeau.',
  twinLoadFailedBody: "Impossible de lire le lien de jumeau de {{persona}}. Il s'agit d'une lecture en échec, pas d'une réponse : cela ne signifie pas que {{persona}} n'est lié à personne, l'action de liaison est donc retenue jusqu'à réussite.",
  twinRetry: 'Réessayer',
  actionFailed: 'Échec de l’action.',
  notTwinYet: '{{persona}} n’est encore le jumeau de personne.',
  nowYourTwin: '{{persona}} est désormais votre jumeau.',
  makeTwinOfMe: 'Faire de {{persona}} un jumeau de moi',
  twinOfYou: 'Jumeau de <0>vous</0>',
  twinOfPerson: 'Jumeau de',
  twinLinkRemoved: 'Lien de jumeau supprimé.',
  unlink: 'Délier',
  unlinkConfirmTitle: 'Délier {{persona}} de cette personne ?',
  unlinkConfirmBody: 'Cela supprime le lien de jumeau ET révoque le consentement de {{name}} autorisant {{persona}} à rappeler sa mémoire ou ses connaissances. Cette personne n’est pas prévenue. Elle pourra l’accorder de nouveau après une nouvelle association.',
  unlinkConfirmBodySelf: 'Cela supprime le lien de jumeau ET révoque votre consentement autorisant {{persona}} à rappeler votre mémoire ou vos connaissances. Vous pourrez l’accorder de nouveau après une nouvelle association.',
  unlinkNothingRemoved: 'Il n’y avait aucun lien de jumeau à supprimer.',
  allowRecallHeading: 'Autoriser {{persona}} à rappeler votre…',
  scopeMemory: 'mémoire',
  scopeKnowledge: 'connaissances',
  recallConsentSaved: 'Consentement de rappel enregistré.',
  updateConsent: 'Mettre à jour le consentement',
  allowRecall: 'Autoriser le rappel',
  recallRevoked: 'Rappel révoqué.',
  revokeRecall: 'Révoquer le rappel',
  recallActive: 'Actif — {{persona}} peut rappeler votre {{scopes}}. La révocation arrête aussitôt tout rappel ultérieur ; le contenu déjà rappelé — même plus tôt dans le même tour — reste, et elle ne peut pas effacer ce que {{persona}} a déjà écrit. Le rappel n’a lieu que lorsque c’est vous-même qui lui parlez — personne d’autre n’obtient quoi que ce soit.',
  recallActiveNothing: 'rien',
  recallActiveEmpty: 'Actif, mais sans portée sélectionnée — {{persona}} ne peut rien lire. Choisissez mémoire ou connaissances ci-dessus.',
  noRecallGranted: 'Aucun rappel accordé pour l’instant — {{persona}} ne peut pas lire votre mémoire ni vos connaissances.',
  onlyLinkedCanAllow: 'Seul {{name}} peut autoriser {{persona}} à rappeler sa mémoire ou ses connaissances.',
  grantsLoadFailedTitle: "Impossible de charger les accès des agents",
  grantsLoadFailedBody: "C’est une lecture en échec, pas une liste vide : cela ne veut pas dire qu’aucun agent n’a accès à vous.",
  grantsRetry: "Réessayer",

  // ProfilePage — l’onglet jumeau quand la LECTURE du réglage de fonctionnalité a échoué
  toggleReadFailedTitle: 'Impossible de vérifier si le rappel du jumeau est activé ici',
  toggleReadFailedBody: 'La vérification de la fonctionnalité a échoué : nous ne pouvons donc pas afficher votre tableau de consentement. C’est une lecture en échec, pas une confirmation que le rappel est désactivé ni qu’aucun agent n’a accès à vous.',
} as const;
