/**
 * `peers` namespace — user-facing copy for the A2A peers panel
 * (spec/v1/a2a-integration.md), currently a not-yet-advertised placeholder.
 */
export const messages = {
  title: 'Pares A2A',
  specRef: '(spec/v1/a2a-integration.md)',
  introLead: 'La composición Agent2Agent (A2A) permite que un host openwop aparezca ante los llamantes remotos como un agente A2A (cada Workflow se convierte en un',
  introAgentSkill: 'AgentSkill',
  introMid: '; cada ejecución se convierte en una',
  introTask: 'Task',
  introTail: ') y permite que los workflows se distribuyan hacia pares A2A remotos.',
  notAdvertised: 'No anunciado por este host.',
  statusLead: 'La composición A2A está documentada como',
  statusStable: 'estable',
  statusMid1: 'en',
  statusMid2: 'pero la forma del anuncio de capacidad sigue siendo candidata (la forma principal es',
  statusMid3: ') y',
  statusMid4: 'aún no define un bloque',
  statusBlock: 'capabilities.a2a',
  statusTail:
    '. El host de referencia no se expone a sí mismo como un agente A2A y no hay ningún',
  statusNodeModule: 'NodeModule registrado, por lo que un navegador de pares no tiene nada que enumerar hoy.',
  pathForwardLead: 'Camino a seguir — publicado como',
  pathForwardMid: '§3: un host no administrador que publique una AgentCard A2A (MyndHyve ya hace referencia a pares A2A desde',
  pathForwardAnd: 'y',
  pathForwardTail:
    ') convergería en una forma',
  pathForwardShape: 'capabilities.a2a',
  pathForwardEnd:
    'concreta y desbloquearía este panel, momento en el que este marcador de posición se convierte en el navegador de pares real (obtención de la Agent Card → lista de Skills → CTA «soltar un',
  pathForwardNode: 'a2a.dispatch',
  pathForwardCta: 'nodo configurado con este Skill»).',
} as const;
