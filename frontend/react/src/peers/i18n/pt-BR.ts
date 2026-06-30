/**
 * `peers` namespace — user-facing copy for the A2A peers panel
 * (spec/v1/a2a-integration.md), currently a not-yet-advertised placeholder.
 */
export const messages = {
  title: 'Peers A2A',
  specRef: '(spec/v1/a2a-integration.md)',
  introLead: 'A composição Agent2Agent (A2A) permite que um host openwop apareça para chamadores remotos como um agente A2A (cada Workflow vira um',
  introAgentSkill: 'AgentSkill',
  introMid: '; cada execução vira uma',
  introTask: 'Task',
  introTail: ') e permite que workflows despachem para peers A2A remotos.',
  notAdvertised: 'Não anunciado por este host.',
  statusLead: 'A composição A2A está documentada como',
  statusStable: 'estável',
  statusMid1: 'em',
  statusMid2: 'mas o formato de anúncio de capacidade ainda é um candidato (o formato principal é',
  statusMid3: ') e',
  statusMid4: 'ainda não define um bloco',
  statusBlock: 'capabilities.a2a',
  statusTail:
    '. O host de referência não se expõe como um agente A2A e nenhum',
  statusNodeModule: 'NodeModule está registrado, então um navegador de peers não tem nada para enumerar hoje.',
  pathForwardLead: 'Caminho a seguir — publicado como',
  pathForwardMid: '§3: um host não administrador publicando um AgentCard A2A (o MyndHyve já referencia peers A2A a partir de',
  pathForwardAnd: 'e',
  pathForwardTail:
    ') convergiria um formato concreto de',
  pathForwardShape: 'capabilities.a2a',
  pathForwardEnd:
    'e desbloquearia este painel — momento em que este placeholder se torna o navegador de peers de fato (busca do Agent Card → lista de Skills → CTA "soltar um',
  pathForwardNode: 'a2a.dispatch',
  pathForwardCta: 'node configurado com esta Skill").',
} as const;
