import type { NodeCategory } from '../schema/workflow.js';

/** i18n key (builder namespace) for each palette group's name. One map for the
 *  palette headings and the canvas badge's screen-reader name (grade-ux U-5). */
export const CATEGORY_LABEL_KEYS: Record<NodeCategory, string> = {
  flow: 'paletteCategoryFlow',
  data: 'paletteCategoryData',
  ai: 'paletteCategoryAi',
  control: 'paletteCategoryControl',
  integration: 'paletteCategoryIntegration',
  journey: 'paletteCategoryJourney',
};
