/**
 * `peers` namespace — user-facing copy for the A2A peers panel
 * (spec/v1/a2a-integration.md), currently a not-yet-advertised placeholder.
 */
export const messages = {
  title: 'Pairs A2A',
  specRef: '(spec/v1/a2a-integration.md)',
  introLead: 'La composition Agent2Agent (A2A) permet à un hôte openwop d\'apparaître aux appelants distants comme un agent A2A (chaque Workflow devient une',
  introAgentSkill: 'AgentSkill',
  introMid: '; chaque exécution devient une',
  introTask: 'Task',
  introTail: ') et permet aux workflows d\'envoyer des requêtes vers des pairs A2A distants.',
  notAdvertised: 'Non annoncé par cet hôte.',
  statusLead: 'La composition A2A est documentée comme',
  statusStable: 'stable',
  statusMid1: 'dans',
  statusMid2: 'mais la forme de l\'annonce de capacité est encore une candidate (la forme dominante est',
  statusMid3: ') et',
  statusMid4: 'ne définit pas encore de bloc',
  statusBlock: 'capabilities.a2a',
  statusTail:
    '. L\'hôte de référence ne s\'expose pas comme un agent A2A et aucun',
  statusNodeModule: 'NodeModule n\'est enregistré, de sorte qu\'un navigateur de pairs n\'a rien à énumérer aujourd\'hui.',
  pathForwardLead: 'Voie à suivre — publiée comme',
  pathForwardMid: '§3 : un hôte non gardien publiant une AgentCard A2A (MyndHyve référence déjà des pairs A2A depuis',
  pathForwardAnd: 'et',
  pathForwardTail:
    ') convergerait vers une forme concrète',
  pathForwardShape: 'capabilities.a2a',
  pathForwardEnd:
    'et débloquerait ce panneau — moment auquel cet espace réservé devient le véritable navigateur de pairs (récupération de l\'Agent Card → liste de Skills → CTA « déposer un',
  pathForwardNode: 'a2a.dispatch',
  pathForwardCta: 'nœud configuré avec ce Skill »).',
} as const;
