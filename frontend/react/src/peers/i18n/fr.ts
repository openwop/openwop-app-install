/**
 * `peers` namespace — the A2A peers panel: an honest not-yet-available state
 * (contributor context lives in the component’s comment, not user copy).
 */
export const messages = {
  title: 'Pairs A2A',
  notAvailableTitle: 'Les connexions agent-à-agent ne sont pas encore disponibles sur cet hôte',
  notAvailableBody: 'Agent2Agent (A2A) permet aux workflows de cet hôte d’être appelés par des plateformes d’agents distantes — et d’y déléguer. Ce déploiement n’annonce pas encore la capacité ; les pairs apparaîtront ici dès que ce sera le cas.',
} as const;
