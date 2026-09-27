/**
 * System site (ADR 0027) — the host-level homepage, modeled the MyndHyve way: a
 * GLOBAL page edited by the host-level role (super admin), NOT by tenant
 * membership. MyndHyve keeps the homepage in a global `cms_pages/home` (no
 * `ownerId`) gated by `isSuperAdmin()`; openwop-app's CMS is org-scoped, so the
 * equivalent is a RESERVED org in a reserved tenant that no real principal can
 * ever hold (`host:`-prefixed), holding a normal CMS page.
 *
 * This is NOT a parallel page system: the page is a real `cmsService` page in a
 * real `accessControl` org — both primitives are instantiated, not shadowed. The
 * only new thing is the AUTHORITY: super-admin (host-level) instead of org-scoped
 * RBAC (`requireOrgScope`), which stays untouched for every real tenant. The
 * reserved tenant is unreachable by auth, so the page is invisible to and
 * uneditable by normal callers — only a super admin reaches it, editing it
 * through the standard CMS routes on this org via `requireCmsScope` (ADR 0027:
 * "Front page" collapsed into the CMS Page Builder).
 */
import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import { getOrg, createOrg } from './accessControlService.js';
import {
  createPage, getPage, listPages, transitionPage, updatePage,
  type Page, type Section,
} from '../features/cms/cmsService.js';

const log = createLogger('host.systemSite');

/** Reserved ids. `host:` is a tenant prefix no auth path mints (users get
 *  `user:` / `anon:` / `ws:`), so this org is invisible to every real caller. */
export const SYSTEM_SITE_TENANT = 'host:site';
export const SYSTEM_SITE_ORG = 'host-site';
export const SYSTEM_SITE_SLUG = 'home';
/** Deterministic page id ⇒ the seed is idempotent even across a concurrent
 *  multi-instance first boot (no `home` + `home-2` duplicate). */
const SYSTEM_SITE_PAGE_ID = 'page:host-site-home';
const SYSTEM_ACTOR = 'system';
/** Bump when DEFAULT_SECTIONS changes — a redeploy then refreshes the live page
 *  IF it has never been human-edited (see `doEnsure`). */
const SEED_VERSION = 7;

/**
 * The built-in default home page (ADR 0027) — a real, brand-aware marketing page
 * authored in the typed-section model, telling the front-page story: the run is
 * where AI work happens, and OpenWOP opens it. A super
 * admin edits it at Admin → Content → "Front page"; once edited, it is frozen
 * (this default never clobbers a human's edits).
 */
/**
 * The default home page's hero headings, per locale.
 *
 * Named and exported because they are ASSERTED values: `cms-nodes` and
 * `cms-content-delivery` both check that the delivery path returns the right
 * heading per locale, and both had RE-TYPED these strings as their own
 * constants. When the copy was refreshed in `3080f2f24` the source moved and
 * the copies did not, so `origin/main` went red on a marketing edit — four
 * spellings of one string, and the SSoT was outvoted. `047a7c4df` repaired the
 * symptom by re-typing the new values; this removes the generator.
 *
 * The tests are about LOCALE BEHAVIOUR — negotiation, overlay merge, per-locale
 * withholding, base fallback — not about the wording. Importing these keeps
 * that true without pinning copy a marketing edit is free to change.
 */
export const DEFAULT_HERO_HEADINGS = {
  en: 'AI work happens in the run. Now the run is open.',
  es: 'El trabajo de la IA ocurre en la ejecución. Ahora la ejecución es abierta.',
  fr: 'Le travail de l’IA se joue pendant l’exécution. Désormais, l’exécution est ouverte.',
  'pt-BR': 'O trabalho da IA acontece na execução. Agora a execução é aberta.',
} as const;

/**
 * The story sections. `docs/site/front-page-story.sections.json` is this
 * constant's operator-publishable twin (for installs whose home page a human
 * has edited, which this seed no longer refreshes), and the SPA fallback in
 * `features/site/FrontPage.tsx` renders the same story from `site:` i18n.
 * `front-page-story-sections.test.ts` pins the JSON to this constant and
 * proves it survives `validateSections` (this seed skips validation at apply
 * time); `check-default-page-drift` pins the hero to the SPA copy.
 */
export const DEFAULT_SECTIONS: Section[] = [
  {
    sectionId: 'sec:story-hero',
    type: 'hero',
    data: {
      visual: 'run',
      heading: DEFAULT_HERO_HEADINGS.en,
      subheading: 'Agents don’t follow a script. They decide while they work: which tool to call, what to hand off, when to stop and ask you. OpenWOP is an open protocol for that run, and this is where you can build one, watch it, and take it with you.',
      ctaLabel: 'Start building — no sign-up',
      ctaUrl: '/chat',
      ctaLabel2: 'Read the protocol',
      ctaUrl2: 'https://openwop.dev',
    },
    localizations: {
      es: {
        heading: DEFAULT_HERO_HEADINGS.es,
        subheading: 'Los agentes no siguen un guion. Deciden mientras trabajan: qué herramienta usar, qué delegar, cuándo detenerse a preguntarte. OpenWOP es un protocolo abierto para esa ejecución, y aquí puedes crear una, observarla y llevártela contigo.',
        ctaLabel: 'Empieza a crear, sin registro',
        ctaLabel2: 'Leer el protocolo',
        ctaUrl: '/chat',
        ctaUrl2: 'https://openwop.dev',
      },
      fr: {
        heading: DEFAULT_HERO_HEADINGS.fr,
        subheading: 'Les agents ne suivent pas de script. Ils décident en travaillant : quel outil appeler, quoi déléguer, quand s’arrêter pour vous demander. OpenWOP est un protocole ouvert pour cette exécution, et c’est ici que vous pouvez en créer une, la suivre et l’emporter avec vous.',
        ctaLabel: 'Commencer, sans inscription',
        ctaLabel2: 'Lire le protocole',
        ctaUrl: '/chat',
        ctaUrl2: 'https://openwop.dev',
      },
      'pt-BR': {
        heading: DEFAULT_HERO_HEADINGS['pt-BR'],
        subheading: 'Agentes não seguem um roteiro. Eles decidem enquanto trabalham: qual ferramenta chamar, o que repassar, quando parar e perguntar a você. OpenWOP é um protocolo aberto para essa execução, e aqui você pode criar uma, acompanhá-la e levá-la com você.',
        ctaLabel: 'Comece a criar, sem cadastro',
        ctaLabel2: 'Ler o protocolo',
        ctaUrl: '/chat',
        ctaUrl2: 'https://openwop.dev',
      },
    },
  },
  {
    sectionId: 'sec:story-shift',
    type: 'richText',
    data: {
      heading: 'Software used to do exactly what it was told.',
      text: 'For decades, software did what someone wrote, line by line. Agents are different: they make decisions *during the run*. So the run is now where the value gets made, where things go wrong, and where someone has to answer for the result.\n\nToday every platform builds that run its own way, and none of them agree. The work your agents do belongs to whichever vendor happens to host it.',
    },
    localizations: {
      es: {
        heading: 'El software solía hacer exactamente lo que se le decía.',
        text: 'Durante décadas, el software hizo lo que alguien escribió, línea por línea. Los agentes son distintos: toman decisiones *durante la ejecución*. Así que la ejecución es ahora donde se crea el valor, donde las cosas fallan y donde alguien tiene que responder por el resultado.\n\nHoy cada plataforma construye esa ejecución a su manera, y ninguna coincide. El trabajo de tus agentes pertenece al proveedor que lo aloja.',
      },
      fr: {
        heading: 'Le logiciel faisait exactement ce qu’on lui disait.',
        text: 'Pendant des décennies, le logiciel a fait ce que quelqu’un avait écrit, ligne par ligne. Les agents sont différents : ils prennent des décisions *pendant l’exécution*. L’exécution est donc désormais l’endroit où la valeur se crée, où les choses tournent mal et où quelqu’un doit répondre du résultat.\n\nAujourd’hui, chaque plateforme construit cette exécution à sa façon, et aucune ne s’accorde avec les autres. Le travail de vos agents appartient au fournisseur qui l’héberge.',
      },
      'pt-BR': {
        heading: 'O software costumava fazer exatamente o que mandavam.',
        text: 'Por décadas, o software fez o que alguém escreveu, linha por linha. Agentes são diferentes: eles tomam decisões *durante a execução*. Então a execução passou a ser onde o valor é criado, onde as coisas dão errado e onde alguém precisa responder pelo resultado.\n\nHoje cada plataforma constrói essa execução do seu jeito, e nenhuma concorda com a outra. O trabalho dos seus agentes pertence a quem os hospeda.',
      },
    },
  },
  {
    sectionId: 'sec:story-history',
    type: 'richText',
    data: {
      heading: 'We’ve seen how this goes.',
      text: 'Workflow standards like BPMN and BPEL agreed on how a process is *drawn*. Running it stayed proprietary, so the drawings never really traveled. Email and the web went the other way: SMTP and HTTP standardized the *conversation* between machines, and everyone could build on it.\n\nOpenWOP makes the same bet for AI work. Don’t standardize the diagram. Standardize the run.',
    },
    localizations: {
      es: {
        heading: 'Ya sabemos cómo termina esto.',
        text: 'Estándares de flujos de trabajo como BPMN y BPEL acordaron cómo se *dibuja* un proceso. Ejecutarlo siguió siendo propietario, así que los diagramas nunca viajaron de verdad. El correo electrónico y la web hicieron lo contrario: SMTP y HTTP estandarizaron la *conversación* entre máquinas, y todos pudieron construir sobre ella.\n\nOpenWOP hace la misma apuesta para el trabajo con IA. No estandarices el diagrama. Estandariza la ejecución.',
      },
      fr: {
        heading: 'On sait comment cela se termine.',
        text: 'Des standards de workflow comme BPMN et BPEL se sont accordés sur la façon de *dessiner* un processus. Son exécution est restée propriétaire, et les schémas n’ont jamais vraiment voyagé. L’e-mail et le web ont pris le chemin inverse : SMTP et HTTP ont standardisé la *conversation* entre machines, et tout le monde a pu bâtir dessus.\n\nOpenWOP fait le même pari pour le travail de l’IA. Ne standardisez pas le schéma. Standardisez l’exécution.',
      },
      'pt-BR': {
        heading: 'Já vimos como isso termina.',
        text: 'Padrões de fluxo de trabalho como BPMN e BPEL chegaram a um acordo sobre como um processo é *desenhado*. Executá-lo continuou proprietário, e os desenhos nunca viajaram de fato. O e-mail e a web foram pelo caminho oposto: SMTP e HTTP padronizaram a *conversa* entre máquinas, e todo mundo pôde construir em cima disso.\n\nO OpenWOP faz a mesma aposta para o trabalho com IA. Não padronize o diagrama. Padronize a execução.',
      },
    },
  },
  {
    sectionId: 'sec:story-open',
    type: 'columns',
    data: {
      heading: 'What changes when the run is open',
      layout: 'rows',
      columns: [
        {
          title: 'You can leave.',
          text: 'Move your agents, packs, and workflows to another compliant host. Secrets are rebound on the new host, never copied across.',
        },
        {
          title: 'You can see why.',
          text: 'Every decision, tool call, and handoff is an event in one shared vocabulary, readable by any tool — not only the one that ran it.',
        },
        {
          title: 'A person decides the irreversible part.',
          text: 'Approval is part of the protocol, not a plugin. The run stops and waits wherever you say it must.',
        },
        {
          title: 'Nothing runs unbounded.',
          text: 'Loop caps and budgets are part of the contract, and untrusted tool output can’t push an approval through.',
        },
        {
          title: 'Anyone can replay it.',
          text: 'An auditor can fork any run from any point, with side effects suppressed, and see exactly what happened and why.',
        },
      ],
    },
    localizations: {
      es: {
        heading: 'Qué cambia cuando la ejecución es abierta',
        columns: [
          {
            title: 'Puedes irte.',
            text: 'Lleva tus agentes, paquetes y flujos de trabajo a otro host compatible. Los secretos se vuelven a vincular en el nuevo host; nunca se copian.',
          },
          {
            title: 'Puedes ver por qué.',
            text: 'Cada decisión, llamada a herramienta y traspaso es un evento en un vocabulario compartido, legible por cualquier herramienta, no solo por la que lo ejecutó.',
          },
          {
            title: 'Una persona decide lo irreversible.',
            text: 'La aprobación es parte del protocolo, no un complemento. La ejecución se detiene y espera donde tú digas.',
          },
          {
            title: 'Nada se ejecuta sin límites.',
            text: 'Los topes de iteraciones y los presupuestos forman parte del contrato, y la salida no confiable de una herramienta no puede forzar una aprobación.',
          },
          {
            title: 'Cualquiera puede reproducirla.',
            text: 'Un auditor puede bifurcar cualquier ejecución desde cualquier punto, sin efectos secundarios, y ver exactamente qué pasó y por qué.',
          },
        ],
      },
      fr: {
        heading: 'Ce qui change quand l’exécution est ouverte',
        columns: [
          {
            title: 'Vous pouvez partir.',
            text: 'Déplacez vos agents, packs et workflows vers un autre hôte conforme. Les secrets sont réassociés sur le nouvel hôte, jamais copiés.',
          },
          {
            title: 'Vous voyez pourquoi.',
            text: 'Chaque décision, appel d’outil et passage de relais est un événement dans un vocabulaire commun, lisible par n’importe quel outil, pas seulement celui qui l’a exécuté.',
          },
          {
            title: 'Une personne décide de l’irréversible.',
            text: 'L’approbation fait partie du protocole, ce n’est pas un plugin. L’exécution s’arrête et attend là où vous l’exigez.',
          },
          {
            title: 'Rien ne tourne sans limite.',
            text: 'Les plafonds de boucle et les budgets font partie du contrat, et la sortie non fiable d’un outil ne peut pas forcer une approbation.',
          },
          {
            title: 'Tout le monde peut la rejouer.',
            text: 'Un auditeur peut repartir de n’importe quel point d’une exécution, effets de bord neutralisés, et voir exactement ce qui s’est passé et pourquoi.',
          },
        ],
      },
      'pt-BR': {
        heading: 'O que muda quando a execução é aberta',
        columns: [
          {
            title: 'Você pode sair.',
            text: 'Leve seus agentes, pacotes e fluxos de trabalho para outro host compatível. Os segredos são vinculados de novo no host novo, nunca copiados.',
          },
          {
            title: 'Você vê o porquê.',
            text: 'Cada decisão, chamada de ferramenta e repasse é um evento em um vocabulário compartilhado, legível por qualquer ferramenta, não só pela que executou.',
          },
          {
            title: 'Uma pessoa decide o que não tem volta.',
            text: 'A aprovação faz parte do protocolo, não é um plugin. A execução para e espera onde você mandar.',
          },
          {
            title: 'Nada roda sem limite.',
            text: 'Limites de repetição e orçamentos fazem parte do contrato, e a saída não confiável de uma ferramenta não consegue forçar uma aprovação.',
          },
          {
            title: 'Qualquer um pode reproduzir.',
            text: 'Um auditor pode ramificar qualquer execução a partir de qualquer ponto, com efeitos colaterais suprimidos, e ver exatamente o que aconteceu e por quê.',
          },
        ],
      },
    },
  },
  {
    sectionId: 'sec:story-proof',
    type: 'richText',
    data: {
      heading: 'One workflow. Two languages. The same run.',
      text: 'The OpenWOP paper reports that one workflow definition, run on a TypeScript host and on a Python host, ends in the same terminal state with the same event-log structure. The run is defined by the protocol, not by whoever hosts it.\n\nIt’s early, and you don’t have to take our word for it. Run something here, open its event log, and check.\n\nThe full method and results are in [the paper](https://doi.org/10.5281/zenodo.20576239).',
    },
    localizations: {
      es: {
        heading: 'Un flujo de trabajo. Dos lenguajes. La misma ejecución.',
        text: 'El artículo de OpenWOP informa que una misma definición de flujo de trabajo, ejecutada en un host de TypeScript y en uno de Python, llega al mismo estado final con la misma estructura de registro de eventos. La ejecución la define el protocolo, no quien la aloja.\n\nEs pronto, y no tienes que creernos. Ejecuta algo aquí, abre su registro de eventos y compruébalo.\n\nEl método y los resultados completos están en [el artículo](https://doi.org/10.5281/zenodo.20576239).',
      },
      fr: {
        heading: 'Un workflow. Deux langages. La même exécution.',
        text: 'L’article OpenWOP rapporte qu’une même définition de workflow, exécutée sur un hôte TypeScript et sur un hôte Python, aboutit au même état final avec la même structure de journal d’événements. L’exécution est définie par le protocole, pas par celui qui l’héberge.\n\nC’est encore tôt, et vous n’avez pas à nous croire sur parole. Lancez quelque chose ici, ouvrez son journal d’événements et vérifiez.\n\nLa méthode et les résultats complets sont dans [l’article](https://doi.org/10.5281/zenodo.20576239).',
      },
      'pt-BR': {
        heading: 'Um fluxo de trabalho. Duas linguagens. A mesma execução.',
        text: 'O artigo do OpenWOP relata que uma mesma definição de fluxo de trabalho, executada em um host TypeScript e em um host Python, chega ao mesmo estado final com a mesma estrutura de log de eventos. A execução é definida pelo protocolo, não por quem a hospeda.\n\nAinda é cedo, e você não precisa acreditar na nossa palavra. Execute algo aqui, abra o log de eventos e confira.\n\nO método e os resultados completos estão [no artigo](https://doi.org/10.5281/zenodo.20576239).',
      },
    },
  },
  {
    sectionId: 'sec:story-try',
    type: 'columns',
    data: {
      heading: 'Try it here, today.',
      layout: 'steps',
      columns: [
        {
          title: 'Build',
          text: 'Sketch an agent or a workflow on the visual canvas, or describe it in chat.',
        },
        {
          title: 'Run',
          text: 'Run it on the published `core.openwop.*` packs and watch every event arrive live.',
        },
        {
          title: 'Decide',
          text: 'When the run stops to ask, answer the approval card. It waits for you.',
        },
        {
          title: 'Replay',
          text: 'Open any finished run, fork it from a step, and see what would change.',
        },
      ],
    },
    localizations: {
      es: {
        heading: 'Pruébalo aquí, hoy.',
        columns: [
          {
            title: 'Crear',
            text: 'Dibuja un agente o un flujo de trabajo en el lienzo visual, o descríbelo en el chat.',
          },
          {
            title: 'Ejecutar',
            text: 'Ejecútalo con los paquetes `core.openwop.*` publicados y mira llegar cada evento en directo.',
          },
          {
            title: 'Decidir',
            text: 'Cuando la ejecución se detiene a preguntar, responde la tarjeta de aprobación. Te espera.',
          },
          {
            title: 'Reproducir',
            text: 'Abre cualquier ejecución terminada, bifúrcala desde un paso y mira qué cambiaría.',
          },
        ],
      },
      fr: {
        heading: 'Essayez-le ici, dès aujourd’hui.',
        columns: [
          {
            title: 'Créer',
            text: 'Esquissez un agent ou un workflow sur le canevas visuel, ou décrivez-le dans le chat.',
          },
          {
            title: 'Exécuter',
            text: 'Lancez-le avec les packs `core.openwop.*` publiés et regardez chaque événement arriver en direct.',
          },
          {
            title: 'Décider',
            text: 'Quand l’exécution s’arrête pour demander, répondez à la carte d’approbation. Elle vous attend.',
          },
          {
            title: 'Rejouer',
            text: 'Ouvrez n’importe quelle exécution terminée, repartez d’une étape et voyez ce qui changerait.',
          },
        ],
      },
      'pt-BR': {
        heading: 'Experimente aqui, hoje.',
        columns: [
          {
            title: 'Criar',
            text: 'Desenhe um agente ou fluxo de trabalho no canvas visual, ou descreva-o no chat.',
          },
          {
            title: 'Executar',
            text: 'Execute com os pacotes `core.openwop.*` publicados e veja cada evento chegar ao vivo.',
          },
          {
            title: 'Decidir',
            text: 'Quando a execução parar para perguntar, responda o cartão de aprovação. Ele espera por você.',
          },
          {
            title: 'Reproduzir',
            text: 'Abra qualquer execução concluída, ramifique a partir de um passo e veja o que mudaria.',
          },
        ],
      },
    },
  },
  {
    sectionId: 'sec:story-cta',
    type: 'cta',
    data: {
      heading: 'Build a run you can take with you.',
      subheading: 'No sign-up needed. Bring your own model keys whenever you’re ready.',
      label: 'Start building',
      url: '/chat',
    },
    localizations: {
      es: {
        heading: 'Crea una ejecución que puedas llevarte.',
        subheading: 'Sin registro. Usa tus propias claves de modelo cuando quieras.',
        label: 'Empieza a crear',
      },
      fr: {
        heading: 'Créez une exécution que vous pouvez emporter.',
        subheading: 'Sans inscription. Apportez vos propres clés de modèle quand vous voulez.',
        label: 'Commencer',
      },
      'pt-BR': {
        heading: 'Crie uma execução que você pode levar com você.',
        subheading: 'Sem cadastro. Traga suas próprias chaves de modelo quando quiser.',
        label: 'Comece a criar',
      },
    },
  },
];

export interface SystemSite { tenantId: string; orgId: string; pageId: string; slug: string }

const seedMarker = new DurableCollection<{ id: 'seed'; version: number }>('system-site-seed', (m) => m.id);

/** Run-once-per-process: dedupes concurrent callers within an instance (the
 *  common race). A cross-instance first-boot race is benign — the fixed org id
 *  upserts, and a duplicate draft page would never be the published one. */
let ensuring: Promise<SystemSite> | null = null;

async function findHomePage(): Promise<Page | null> {
  const pages = await listPages(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG);
  return pages.find((p) => p.slug === SYSTEM_SITE_SLUG) ?? null;
}

/** Apply DEFAULT_SECTIONS to the live page + republish (system authority). Keeps
 *  `updatedBy = system` so the page stays "unedited". DEFAULT_SECTIONS is static,
 *  in-repo, and known-valid, so this skips validation — it cannot fail
 *  `validateSections` (a human edit through CMS is validated by the CMS routes).
 *  The only failure
 *  mode is a storage error mid-sequence, which self-heals: the page is left
 *  `draft` and the next `doEnsure` (same SEED_VERSION mismatch) re-publishes it. */
async function applyDefault(): Promise<void> {
  const p = await getPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, SYSTEM_SITE_PAGE_ID);
  if (!p) return;
  if (p.status === 'published' || p.status === 'archived') {
    await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, SYSTEM_SITE_PAGE_ID, 'unpublish', SYSTEM_ACTOR);
  }
  await updatePage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, SYSTEM_SITE_PAGE_ID, { title: 'Home', sections: DEFAULT_SECTIONS }, SYSTEM_ACTOR);
  await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, SYSTEM_SITE_PAGE_ID, 'publish', SYSTEM_ACTOR);
}

/** Ensure the reserved host-site org exists (fixed id ⇒ idempotent upsert; no owner
 *  member — host-level). The SINGLE owner of this reserved-org creation: both the
 *  system site (home page) and the system brand (ADR 0170) call it, so neither
 *  duplicates the create nor couples to the other's seeding. */
export async function ensureSystemSiteOrg(): Promise<void> {
  if (!(await getOrg(SYSTEM_SITE_ORG))) {
    await createOrg({ tenantId: SYSTEM_SITE_TENANT, orgId: SYSTEM_SITE_ORG, createdBy: SYSTEM_ACTOR, name: 'OpenWOP Site' });
    log.info('system_site_org_created', { orgId: SYSTEM_SITE_ORG });
  }
}

async function doEnsure(): Promise<SystemSite> {
  // 1. The reserved org (shared helper — single owner of the create).
  await ensureSystemSiteOrg();
  // 2. The home page (seeded + published) if absent.
  let page = await findHomePage();
  if (!page) {
    page = await createPage({
      tenantId: SYSTEM_SITE_TENANT, orgId: SYSTEM_SITE_ORG, pageId: SYSTEM_SITE_PAGE_ID,
      title: 'Home', slug: SYSTEM_SITE_SLUG, sections: DEFAULT_SECTIONS, createdBy: SYSTEM_ACTOR,
    });
    const published = await transitionPage(SYSTEM_SITE_TENANT, SYSTEM_SITE_ORG, page.pageId, 'publish', SYSTEM_ACTOR);
    page = published ?? page;
    await seedMarker.put({ id: 'seed', version: SEED_VERSION });
    log.info('system_site_home_seeded', { pageId: page.pageId, seedVersion: SEED_VERSION });
  } else if (page.updatedBy === SYSTEM_ACTOR) {
    // 3. Refresh the built-in default on a redeploy with newer seed content —
    //    BUT only while the page has never been human-edited (a real edit sets
    //    updatedBy to the super-admin principal and freezes the page forever).
    const marker = await seedMarker.get('seed');
    if (marker?.version !== SEED_VERSION) {
      await applyDefault();
      await seedMarker.put({ id: 'seed', version: SEED_VERSION });
      log.info('system_site_default_refreshed', { from: marker?.version ?? null, to: SEED_VERSION });
    }
  }
  return { tenantId: SYSTEM_SITE_TENANT, orgId: SYSTEM_SITE_ORG, pageId: SYSTEM_SITE_PAGE_ID, slug: SYSTEM_SITE_SLUG };
}

/** Ensure the reserved system site org + a published home page exist (idempotent). */
export function ensureSystemSite(): Promise<SystemSite> {
  if (!ensuring) ensuring = doEnsure().catch((err) => { ensuring = null; throw err; });
  return ensuring;
}

/**
 * The current system home page (working copy). Still used by the example-data
 * seeders to detect/report the seeded homepage. Editing the front page is now
 * done through the standard CMS routes on the reserved `host-site` org (a super
 * admin reaches them via `requireCmsScope`) — the bespoke edit path was retired
 * when "Front page" collapsed into the CMS Page Builder (ADR 0027).
 */
export async function getSystemHomePage(): Promise<Page> {
  const site = await ensureSystemSite();
  const page = await getPage(site.tenantId, site.orgId, site.pageId);
  if (!page) throw new Error('system home page missing after ensure');
  return page;
}
