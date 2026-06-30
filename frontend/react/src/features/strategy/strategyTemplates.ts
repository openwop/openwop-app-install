/**
 * Strategy create-form templates (ADR 0080 Phase E). PURE client presets that
 * PRE-FILL the existing create flow — no new entity, store, or schema. A template
 * is a `Partial<CreateStrategyInput>` skeleton (horizon + objective/key-result/
 * initiative scaffolds); all user-facing text is an i18n KEY resolved at pick-time
 * so en + native-reviewed pt-BR both ship. The backend re-validates everything on
 * create — a template is a suggestion, never an authority.
 */
import type { PlanningHorizon } from './strategyClient.js';

/** A scaffold objective/KR/initiative carrying i18n keys (resolved at pick-time). */
export interface StrategyTemplateScaffold {
  horizon: PlanningHorizon;
  summaryKey: string;
  rationaleKey?: string;
  objectives: Array<{ titleKey: string; keyResults: Array<{ titleKey: string }> }>;
  initiatives: Array<{ titleKey: string }>;
}

export interface StrategyTemplate {
  id: string;
  /** i18n keys (strategy namespace) for the picker chip + its hint. */
  labelKey: string;
  descKey: string;
  scaffold: StrategyTemplateScaffold;
}

/** The four presets. Keys live under `tpl_<id>_*` in the strategy catalogs. */
export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    id: 'okr',
    labelKey: 'tpl_okr_label',
    descKey: 'tpl_okr_desc',
    scaffold: {
      horizon: 'quarter',
      summaryKey: 'tpl_okr_summary',
      objectives: [
        { titleKey: 'tpl_okr_obj1', keyResults: [{ titleKey: 'tpl_okr_obj1_kr1' }, { titleKey: 'tpl_okr_obj1_kr2' }] },
        { titleKey: 'tpl_okr_obj2', keyResults: [{ titleKey: 'tpl_okr_obj2_kr1' }] },
      ],
      initiatives: [{ titleKey: 'tpl_okr_init1' }],
    },
  },
  {
    id: 'annual-operating-plan',
    labelKey: 'tpl_aop_label',
    descKey: 'tpl_aop_desc',
    scaffold: {
      horizon: 'annual',
      summaryKey: 'tpl_aop_summary',
      rationaleKey: 'tpl_aop_rationale',
      objectives: [
        { titleKey: 'tpl_aop_obj1', keyResults: [{ titleKey: 'tpl_aop_obj1_kr1' }] },
        { titleKey: 'tpl_aop_obj2', keyResults: [{ titleKey: 'tpl_aop_obj2_kr1' }] },
        { titleKey: 'tpl_aop_obj3', keyResults: [{ titleKey: 'tpl_aop_obj3_kr1' }] },
      ],
      initiatives: [{ titleKey: 'tpl_aop_init1' }, { titleKey: 'tpl_aop_init2' }],
    },
  },
  {
    id: 'portfolio-bet',
    labelKey: 'tpl_bet_label',
    descKey: 'tpl_bet_desc',
    scaffold: {
      horizon: 'multi-year',
      summaryKey: 'tpl_bet_summary',
      rationaleKey: 'tpl_bet_rationale',
      objectives: [
        { titleKey: 'tpl_bet_obj1', keyResults: [{ titleKey: 'tpl_bet_obj1_kr1' }, { titleKey: 'tpl_bet_obj1_kr2' }] },
      ],
      initiatives: [{ titleKey: 'tpl_bet_init1' }],
    },
  },
  {
    id: 'working-backwards',
    labelKey: 'tpl_wb_label',
    descKey: 'tpl_wb_desc',
    scaffold: {
      horizon: 'half-year',
      summaryKey: 'tpl_wb_summary',
      rationaleKey: 'tpl_wb_rationale',
      objectives: [
        { titleKey: 'tpl_wb_obj1', keyResults: [{ titleKey: 'tpl_wb_obj1_kr1' }] },
      ],
      initiatives: [{ titleKey: 'tpl_wb_init1' }],
    },
  },
];
